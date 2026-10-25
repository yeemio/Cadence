/**
 * SessionStore 端口 + 内存实现（M1 收尾波-③）。
 *
 * 与 UserStore 同一模式：端口在本包定义，内存实现先行，PG adapter 由
 * business-store `./org` 子路径接入。sessions 是轻量运营状态（可撤销、
 * 可 UPDATE），非业务事实——不套证据公共列、不设 append-only 触发器。
 *
 * 撤销语义（写明）：revoke = 软撤销（revokedAt 置时），不删行——审计可
 * 追溯"何时被撤销"；判定侧（resolveSession/refresh）对 revokedAt 非空一
 * 律拒绝。明文 token 绝不进本端口任何形状（见 token.ts 注释）。
 */
import { TenantId, UserId } from '@smes/business-core';

/** 会话行（存储视图；tokenDigest 是 sha256 摘要，非明文）。 */
export interface SessionRecord {
  readonly id: string;
  readonly tenant: TenantId;
  readonly userId: UserId;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  /** 访问有效期（签发时刻 + tokenTtl；AuthGuard 按此判定）。 */
  readonly expiresAt: Date;
  /** 可续期窗口上界（首签时刻 + refreshWindow；refresh 按此判定，绝对上限不随续期滑动）。 */
  readonly refreshExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly tenant: TenantId;
  readonly userId: UserId;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
}

/** 会话存储端口。实现方保证：revoke / revokeAllForUser 幂等（不存在或已撤销 = 零行）。 */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<void>;
  findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null>;
  /** 按会话 id 撤销（logout / refresh 换新）。 */
  revoke(id: string): Promise<void>;
  /** 撤销某用户在租户内的全部会话（users.active 停用时的"写时全端下线"）。 */
  revokeAllForUser(tenant: TenantId, userId: UserId): Promise<void>;
}

/** 组织模块对会话撤销的最小依赖（避免 org 域反向依赖完整会话端口形状）。 */
export type SessionRevoker = Pick<SessionStore, 'revokeAllForUser'>;

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>(); // key: id

  async create(input: CreateSessionInput): Promise<void> {
    this.sessions.set(input.id, { ...input, revokedAt: null });
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    for (const record of this.sessions.values()) {
      if (record.tokenDigest === tokenDigest) {
        return record;
      }
    }
    return null;
  }

  async revoke(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (record !== undefined && record.revokedAt === null) {
      this.sessions.set(id, { ...record, revokedAt: new Date() });
    }
  }

  async revokeAllForUser(tenant: TenantId, userId: UserId): Promise<void> {
    const revokedAt = new Date();
    for (const [id, record] of this.sessions) {
      if (record.tenant === tenant && record.userId === userId && record.revokedAt === null) {
        this.sessions.set(id, { ...record, revokedAt });
      }
    }
  }
}
