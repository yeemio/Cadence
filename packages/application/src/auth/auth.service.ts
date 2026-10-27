/**
 * AuthService —— 真实认证用例（M1 收尾波-③，core 基础层章程）。
 *
 * 零框架业务类（不 import @nestjs/*）：
 *  - 凭证：UserStore.findByUsername（含 hash）+ scrypt 校验；
 *  - 会话：SessionStore 端口（摘要存储、软撤销）；签发 opaque token；
 *  - 判定：PermissionService.permissionsOfUser（/auth/me 权限投影）。
 *
 * 语义参数（写明，合同 done-when 2）：
 *  - 访问 TTL 8h（SESSION_TOKEN_TTL_MS）：resolveSession 按此刻判定；
 *  - 续期窗口 7d（SESSION_REFRESH_WINDOW_MS）：refresh 的绝对上限，
 *    自**首签**时刻起算不随续期滑动（防无限续期；refresh 换发的新会话
 *    继承旧记录的 refreshExpiresAt）；
 *  - refresh 允许在访问期已过但窗口内使用（这正是续期窗口的意义）；
 *  - refresh 双保险：除写时撤销外，续期时复查用户仍存在且 active——
 *    漏撤销的会话也会在续期口被拦下；
 *  - 登录速率限制（M2 安全前置批 SP-1）：LoginAttemptStore 端口注入，窗口
 *    失败计数 + 锁定（键 = (tenant, username)；锁定期正确口令也拒）；
 *  - 渐进重哈希（SP-2）：登录成功且哈希串参数落后 → 静默重哈希落库。
 */
import { randomUUID } from 'node:crypto';
import type { TenantId, UserId } from '@smes/business-core';
import type { PermissionService } from '../core/auth/permission.service.js';
import type { PermissionCode } from '../core/auth/permission-code.js';
import type { UserAccount, UserStore } from '../org/org-stores.js';
import { AuthCredentialsError, AuthRateLimitError } from './auth-errors.js';
import { parseLoginInput } from './auth-input.js';
import { hashPassword, passwordHashMatchesCurrentParams, verifyPassword } from './password.js';
import type { LoginAttemptStore } from './login-attempt-stores.js';
import { InMemoryLoginAttemptStore } from './login-attempt-stores.js';
import type { SessionStore } from './session-stores.js';
import { digestSessionToken, generateSessionToken } from './token.js';

/** 访问令牌 TTL：8 小时。 */
export const SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
/** 续期窗口：首签后 7 天（绝对上限，不随续期滑动）。 */
export const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 签发结果（明文 token 只在本形状出现一次，绝不落库/进日志）。 */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
  readonly user: UserAccount;
}

/** /auth/me 视图：账户 + 权限投影 + 会话访问期（Web 保活参数的依据）。 */
export interface AuthAccountView {
  readonly user: UserAccount;
  readonly admin: boolean;
  readonly permissions: readonly PermissionCode[];
  readonly expiresAt: Date;
}

export interface AuthServiceOptions {
  /** 覆盖访问 TTL（测试注入用）。 */
  readonly tokenTtlMs?: number;
  /** 覆盖续期窗口（测试注入用）。 */
  readonly refreshWindowMs?: number;
  /**
   * 登录失败计数存储（M2 安全前置批 SP-1）；缺省 = 内存实现（缺省参数
   * 5 次 / 15 分钟窗 / 锁 15 分钟）。组合根注入 PG 实现或带 env 覆写参数
   * 的内存实例（AuthModule.register 选项透传，同 sessionStore 模式）。
   */
  readonly loginAttemptStore?: LoginAttemptStore;
  /** 时钟注入（测试用；缺省系统时钟）。 */
  readonly now?: () => Date;
}

const CREDENTIALS_REJECTED_MESSAGE = '用户名或口令不正确';
const SESSION_REJECTED_MESSAGE = '会话已失效';
/** SP-1 固定文案：不含用户存在性信息（与凭据拒绝路径同态不泄漏）。 */
const LOGIN_RATE_LIMITED_MESSAGE = '登录尝试过于频繁，请稍后再试';

export class AuthService {
  private readonly tokenTtlMs: number;
  private readonly refreshWindowMs: number;
  private readonly loginAttempts: LoginAttemptStore;
  private readonly now: () => Date;

  constructor(
    private readonly users: UserStore,
    private readonly sessions: SessionStore,
    private readonly permissions: PermissionService,
    options: AuthServiceOptions = {},
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? SESSION_TOKEN_TTL_MS;
    this.refreshWindowMs = options.refreshWindowMs ?? SESSION_REFRESH_WINDOW_MS;
    this.loginAttempts = options.loginAttemptStore ?? new InMemoryLoginAttemptStore();
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * 密码登录：active=false / 用户不存在 / 未设口令 / 口令不符——四种拒绝
   * 同一错误同一 message（不泄漏差异）。成功签发新会话。
   *
   * SP-1 速率限制（端口注入，非 HTTP 层）：锁定期内同键一律拒绝——
   * **正确口令也拒**（先于凭据验证，锁不可被探测绕过）；失败计数（键 =
   * (tenant, username)，用户不存在也计——防候选用户名爆破），成功清零。
   * SP-2 渐进重哈希：验证通过且串内参数 ≠ 当前参数 → hashPassword(明文)
   * 重哈希 + UserStore.updatePassword 落库（静默升级：响应不变、不额外撤
   * 会话——登录自然换发；只在登录时升级，未再登录的存量旧参数哈希保持
   * 可用，verify 按串内参数）。
   */
  async login(tenant: TenantId, input: unknown): Promise<IssuedSession> {
    const { username, password } = parseLoginInput(input);
    if (await this.loginAttempts.isLocked(tenant, username, this.now())) {
      throw new AuthRateLimitError(LOGIN_RATE_LIMITED_MESSAGE);
    }
    const found = await this.users.findByUsername(tenant, username);
    const credentialsOk =
      found !== null &&
      found.account.active &&
      found.passwordHash !== null &&
      verifyPassword(password, found.passwordHash);
    if (found === null || !credentialsOk) {
      await this.loginAttempts.registerFailure(tenant, username, this.now());
      throw new AuthCredentialsError(CREDENTIALS_REJECTED_MESSAGE);
    }
    if (
      found.passwordHash !== null &&
      !passwordHashMatchesCurrentParams(found.passwordHash)
    ) {
      await this.users.updatePassword(tenant, found.account.id, hashPassword(password));
    }
    await this.loginAttempts.clear(tenant, username);
    return this.issue(tenant, found.account);
  }

  /** 旧 token 换新：旧会话撤销，新会话继承续期窗口上界。 */
  async refresh(tenant: TenantId, token: string): Promise<IssuedSession> {
    const record = await this.sessions.findByTokenDigest(digestSessionToken(token));
    if (record === null || record.revokedAt !== null || record.tenant !== tenant) {
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    if (this.now().getTime() >= record.refreshExpiresAt.getTime()) {
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    const account = await this.users.find(tenant, record.userId);
    if (account === null || !account.active) {
      // 双保险：停用即全端撤销是主防线；此处拦下任何漏撤销的会话
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    await this.sessions.revoke(record.id);
    return this.issue(tenant, account, record.refreshExpiresAt);
  }

  /** 登出：撤销当前会话（幂等语义由调用方 401 保证——无效 token 先被拒）。 */
  async logout(token: string): Promise<void> {
    const record = await this.sessions.findByTokenDigest(digestSessionToken(token));
    if (record === null || record.revokedAt !== null) {
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    await this.sessions.revoke(record.id);
  }

  /** AuthGuard 判定入口：token → 有效会话（未撤销且未过访问期）→ 身份 + 租户。 */
  async resolveSession(
    token: string,
  ): Promise<{ readonly userId: UserId; readonly tenant: TenantId } | null> {
    const record = await this.sessions.findByTokenDigest(digestSessionToken(token));
    if (record === null || record.revokedAt !== null) {
      return null;
    }
    if (this.now().getTime() >= record.expiresAt.getTime()) {
      return null;
    }
    return { userId: record.userId, tenant: record.tenant };
  }

  /** /auth/me：token 有效性 + 账户 + 权限投影（Web 会话检查与菜单过滤用）。 */
  async currentAccount(tenant: TenantId, token: string): Promise<AuthAccountView> {
    const record = await this.sessions.findByTokenDigest(digestSessionToken(token));
    if (
      record === null ||
      record.revokedAt !== null ||
      record.tenant !== tenant ||
      this.now().getTime() >= record.expiresAt.getTime()
    ) {
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    const account = await this.users.find(tenant, record.userId);
    if (account === null || !account.active) {
      throw new AuthCredentialsError(SESSION_REJECTED_MESSAGE);
    }
    const grants = await this.permissions.permissionsOfUser(tenant, record.userId);
    return {
      user: account,
      admin: grants.admin,
      permissions: grants.permissions,
      expiresAt: record.expiresAt,
    };
  }

  /** 签发新会话行 + 明文 token（refreshCap 续期时继承旧窗口上界）。 */
  private async issue(
    tenant: TenantId,
    account: UserAccount,
    refreshCap?: Date,
  ): Promise<IssuedSession> {
    const now = this.now();
    const refreshExpiresAt =
      refreshCap !== undefined
        ? (refreshCap.getTime() < now.getTime() + this.refreshWindowMs
            ? refreshCap
            : new Date(now.getTime() + this.refreshWindowMs))
        : new Date(now.getTime() + this.refreshWindowMs);
    const token = generateSessionToken();
    await this.sessions.create({
      id: randomUUID(),
      tenant,
      userId: account.id,
      tokenDigest: digestSessionToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.tokenTtlMs),
      refreshExpiresAt,
    });
    return { token, expiresAt: new Date(now.getTime() + this.tokenTtlMs), user: account };
  }
}

/**
 * 测试/种子便利：与 hashPassword 同源（从 seed 到运行时只有一种格式）。
 * 组合根侧种子脚本不 import dist，故 seed.mjs 内联同形状实现（见该文件注释）。
 */
export { hashPassword };
