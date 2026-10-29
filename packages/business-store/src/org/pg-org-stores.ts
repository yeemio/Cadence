/**
 * PolicyStore / UserStore / RoleStore 的 PG 实现 + 组合根装配工厂
 * （M1 增量 3-D，经本包 `./org` 子路径导出——主入口保持零 @prisma/client
 * 依赖，纯数据面测试不触碰 Prisma）。
 *
 * 启动零 DB 依赖：connectBusinessStore 只构造 PrismaClient（惰性连接——
 * 构造不握手、bootstrap 阶段零查询），首条查询才真正连库；无 DATABASE_URL
 * 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * append/remove 幂等：append 走 createMany skipDuplicates（rule_key 主键
 * 冲突即跳过）；remove 走 deleteMany 按规范键精确删除（不存在即零行）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId, UserId } from '@smes/business-core';
import {
  OrgConflictError,
  type CreateDepartmentInput,
  type CreatePositionInput,
  type CreateSessionInput,
  type DepartmentMaster,
  type DepartmentStore,
  type LoginAttemptStore,
  type LoginAttemptStoreParams,
  type PolicyRule,
  type PolicyStore,
  type PositionMaster,
  type PositionStore,
  type RoleDefinition,
  type RoleName,
  type RoleStore,
  type SessionRecord,
  type SessionStore,
  type UpdateDepartmentInput,
  type UpdatePositionInput,
  type UserAccount,
  type UserCredentials,
  type UserStore,
} from '@smes/application';
import type {
  CreateRoleInput,
  CreateUserInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';
import { rlsSessionEnabled, setRlsTenantOn, withRlsTenantSession } from '../rls-session.js';
import { policyRuleKey, policyRuleToRow, policyRowToRule } from './policy-mapping.js';

/** 唯一键冲突（P2002）-> 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toOrgConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new OrgConflictError(message);
  }
  return error;
}

export class PgPolicyStore implements PolicyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(): Promise<readonly PolicyRule[]> {
    const rows = await this.prisma.policyRecord.findMany({ orderBy: { ruleKey: 'asc' } });
    return rows.map(policyRowToRule);
  }

  async append(rules: readonly PolicyRule[]): Promise<void> {
    if (rules.length === 0) return;
    await this.prisma.policyRecord.createMany({
      data: rules.map(policyRuleToRow),
      skipDuplicates: true,
    });
  }

  async remove(rules: readonly PolicyRule[]): Promise<void> {
    if (rules.length === 0) return;
    await this.prisma.policyRecord.deleteMany({
      where: { ruleKey: { in: rules.map(policyRuleKey) } },
    });
  }
}

interface UserDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly passwordHash: string | null;
}

function toUserAccount(row: UserDbRow): UserAccount {
  return {
    id: UserId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    username: row.username,
    displayName: row.displayName,
    active: row.active,
    // D-2 P3 只读投影：从行内哈希派生存在性，哈希本体不出账户视图（与内存实现同形）。
    hasPassword: row.passwordHash !== null,
  };
}

export class PgUserStore implements UserStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateUserInput): Promise<UserAccount> {
    try {
      const row = await this.prisma.userRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略；种子/演示身份的固定 id 由 seed 显式传入）
          tenantId: input.tenant,
          username: input.username,
          displayName: input.displayName,
          active: input.active ?? true,
          passwordHash: input.passwordHash ?? null, // 组织端点创建 = 未设口令，不能登录
        },
      });
      return toUserAccount(row);
    } catch (error) {
      throw toOrgConflict(
        error,
        `用户名 '${input.username}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly UserAccount[]> {
    const rows = await this.prisma.userRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { username: 'asc' },
    });
    return rows.map(toUserAccount);
  }

  async find(tenant: TenantId, id: UserId): Promise<UserAccount | null> {
    const row = await this.prisma.userRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toUserAccount(row);
  }

  async findByUsername(tenant: TenantId, username: string): Promise<UserCredentials | null> {
    const row = await this.prisma.userRecord.findFirst({
      where: { tenantId: tenant, username },
    });
    return row === null ? null : { account: toUserAccount(row), passwordHash: row.passwordHash };
  }

  async updateStatus(tenant: TenantId, id: UserId, active: boolean): Promise<UserAccount | null> {
    // updateMany 按复合条件收口（tenant + id），零行 = 目标不存在（用例层转 404）
    await this.prisma.userRecord.updateMany({
      where: { tenantId: tenant, id },
      data: { active },
    });
    return this.find(tenant, id);
  }

  async updatePassword(
    tenant: TenantId,
    id: UserId,
    passwordHash: string,
  ): Promise<UserAccount | null> {
    // 同 updateStatus 形态：复合 where 收口 + 零行 = 目标不存在（用例层转 404）
    await this.prisma.userRecord.updateMany({
      where: { tenantId: tenant, id },
      data: { passwordHash },
    });
    return this.find(tenant, id);
  }
}

interface SessionDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly revokedAt: Date | null;
}

function toSessionRecord(row: SessionDbRow): SessionRecord {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    userId: UserId.create(row.userId),
    tokenDigest: row.tokenDigest,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    revokedAt: row.revokedAt,
  };
}

/** 会话存储 PG 实现（M1 收尾波-③）：软撤销（revoked_at 置时），幂等。 */
export class PgSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSessionInput): Promise<void> {
    await this.prisma.sessionRecord.create({
      data: {
        id: input.id, // 应用侧权威生成（auth.service 用 randomUUID）
        tenantId: input.tenant,
        userId: input.userId,
        tokenDigest: input.tokenDigest,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
      },
    });
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    const row = await this.prisma.sessionRecord.findUnique({
      where: { tokenDigest },
    });
    return row === null ? null : toSessionRecord(row);
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.sessionRecord.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(tenant: TenantId, userId: UserId): Promise<void> {
    await this.prisma.sessionRecord.updateMany({
      where: { tenantId: tenant, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// 登录失败计数/锁定 PG 实现（M2 安全前置批 SP-1）——语义与 InMemoryLoginAttemptStore
// 逐位一致（窗口滑动按最近一次失败起算、锁定到期后重新起算、成功清零删行）。
// 计数自增走**单语句原子 upsert**（INSERT ... ON CONFLICT DO UPDATE，CASE 与
// 当前行值比较——行级原子，防并发爆破漏计）；raw 写经交互式事务 SET
// app.current_tenant 后同句柄执行（D-14 收口体例，rls-session.ts 已知边界）。
// ---------------------------------------------------------------------------

/** 登录限流参数（与 application 端口 LoginAttemptStoreParams 同形状）。 */
export type PgLoginAttemptStoreParams = LoginAttemptStoreParams;

export class PgLoginAttemptStore implements LoginAttemptStore {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    params: PgLoginAttemptStoreParams = {},
  ) {
    this.maxFailures = params.maxFailures ?? 5;
    this.windowMs = params.windowMs ?? 15 * 60 * 1000;
    this.lockMs = params.lockMs ?? 15 * 60 * 1000;
  }

  async isLocked(tenant: TenantId, username: string, now: Date): Promise<boolean> {
    const row = await this.prisma.loginAttemptRecord.findFirst({
      where: { tenantId: tenant, username, lockedUntil: { not: null, gt: now } },
    });
    return row !== null;
  }

  async registerFailure(tenant: TenantId, username: string, now: Date): Promise<void> {
    // 日期参数以 ISO-8601（含时区后缀）字符串 + ::timestamptz 显式转型传入——
    // 不依赖会话时钟的 timestamp→timestamptz 隐式解释，任何 TZ 配置下同义。
    const nowIso = now.toISOString();
    const lockUntilIso = new Date(now.getTime() + this.lockMs).toISOString();
    const windowStartIso = new Date(now.getTime() - this.windowMs).toISOString();
    // INSERT 分支的锁定判定（首败即锁 = maxFailures ≤ 1 的退化配置；常态 null）
    const insertLockedUntil = this.maxFailures <= 1 ? lockUntilIso : null;
    const maxFailures = this.maxFailures;
    await this.prisma.$transaction(async (tx) => {
      await setRlsTenantOn(tx);
      await tx.$executeRaw`
        INSERT INTO "login_attempts" ("id", "tenant_id", "username", "failure_count", "last_failure_at", "locked_until", "updated_at")
        VALUES (${uuidv7()}::text, ${String(tenant)}::text, ${username}::text, 1, ${nowIso}::timestamptz, ${insertLockedUntil}::timestamptz, ${nowIso}::timestamptz)
        ON CONFLICT ("tenant_id", "username") DO UPDATE SET
          "failure_count" = CASE
            WHEN "login_attempts"."locked_until" > ${nowIso}::timestamptz THEN "login_attempts"."failure_count"
            WHEN "login_attempts"."locked_until" IS NOT NULL OR "login_attempts"."last_failure_at" < ${windowStartIso}::timestamptz THEN 1
            ELSE "login_attempts"."failure_count" + 1
          END,
          "locked_until" = CASE
            WHEN "login_attempts"."locked_until" > ${nowIso}::timestamptz THEN "login_attempts"."locked_until"
            WHEN (CASE
              WHEN "login_attempts"."locked_until" > ${nowIso}::timestamptz THEN "login_attempts"."failure_count"
              WHEN "login_attempts"."locked_until" IS NOT NULL OR "login_attempts"."last_failure_at" < ${windowStartIso}::timestamptz THEN 1
              ELSE "login_attempts"."failure_count" + 1
            END) >= ${maxFailures}::int THEN ${lockUntilIso}::timestamptz
            ELSE NULL
          END,
          "last_failure_at" = ${nowIso}::timestamptz,
          "updated_at" = ${nowIso}::timestamptz`;
    });
  }

  async clear(tenant: TenantId, username: string): Promise<void> {
    await this.prisma.loginAttemptRecord.deleteMany({
      where: { tenantId: tenant, username },
    });
  }
}

interface RoleDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly displayName: string;
}

function toRoleDefinition(row: RoleDbRow): RoleDefinition {
  return {
    tenant: TenantId.create(row.tenantId),
    name: row.name as RoleName, // 入库前经 roleName() 校验（应用层端口合同）
    displayName: row.displayName,
  };
}

export class PgRoleStore implements RoleStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateRoleInput): Promise<RoleDefinition> {
    try {
      const row = await this.prisma.roleRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          name: input.name,
          displayName: input.displayName,
        },
      });
      return toRoleDefinition(row);
    } catch (error) {
      throw toOrgConflict(error, `角色 '${input.name}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly RoleDefinition[]> {
    const rows = await this.prisma.roleRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { name: 'asc' },
    });
    return rows.map(toRoleDefinition);
  }

  async find(tenant: TenantId, name: RoleName): Promise<RoleDefinition | null> {
    const row = await this.prisma.roleRecord.findFirst({
      where: { tenantId: tenant, name },
    });
    return row === null ? null : toRoleDefinition(row);
  }
}

// ---------------------------------------------------------------------------
// 机构/岗位主数据 PG 实现（S1 backfill：0920 #3/#7）——与 PgItemStore 同形态：
// P2002 → OrgConflictError、update 复合 where + P2025 → null（用例层转 404）。
// parent_id/department_ref 不设外键（schema 注释取舍），引用完整性由
// OrgService 守卫；本层只做存取，不带层级语义。
// ---------------------------------------------------------------------------

interface DepartmentDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly active: boolean;
}

function toDepartmentMaster(row: DepartmentDbRow): DepartmentMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    parentId: row.parentId,
    active: row.active,
  };
}

export class PgDepartmentStore implements DepartmentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateDepartmentInput): Promise<DepartmentMaster> {
    try {
      const row = await this.prisma.departmentRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          parentId: input.parentId ?? null,
          active: input.active ?? true,
        },
      });
      return toDepartmentMaster(row);
    } catch (error) {
      throw toOrgConflict(error, `机构 code '${input.code}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly DepartmentMaster[]> {
    const rows = await this.prisma.departmentRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toDepartmentMaster);
  }

  async find(tenant: TenantId, id: string): Promise<DepartmentMaster | null> {
    const row = await this.prisma.departmentRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toDepartmentMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateDepartmentInput,
  ): Promise<DepartmentMaster | null> {
    try {
      const row = await this.prisma.departmentRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toDepartmentMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

interface PositionDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly departmentRef: string | null;
  readonly active: boolean;
}

function toPositionMaster(row: PositionDbRow): PositionMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    departmentRef: row.departmentRef,
    active: row.active,
  };
}

export class PgPositionStore implements PositionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePositionInput): Promise<PositionMaster> {
    try {
      const row = await this.prisma.positionRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          departmentRef: input.departmentRef ?? null,
          active: input.active ?? true,
        },
      });
      return toPositionMaster(row);
    } catch (error) {
      throw toOrgConflict(error, `岗位 code '${input.code}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly PositionMaster[]> {
    const rows = await this.prisma.positionRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toPositionMaster);
  }

  async find(tenant: TenantId, id: string): Promise<PositionMaster | null> {
    const row = await this.prisma.positionRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toPositionMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdatePositionInput,
  ): Promise<PositionMaster | null> {
    try {
      const row = await this.prisma.positionRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.departmentRef !== undefined ? { departmentRef: input.departmentRef } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toPositionMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

export interface BusinessStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
  /**
   * 登录限流参数（M2 安全前置批 SP-1）：组合根按 env 覆写注入（缺省
   * 5 次 / 15 分钟窗 / 锁 15 分钟——与 application 端口缺省同源）。
   */
  readonly loginAttempt?: LoginAttemptStoreParams;
}

/** 组合根装配句柄：七端口实现（users/roles/policies/sessions/login-attempts + S1 机构/岗位）+ 优雅断连。 */
export interface BusinessStoreHandle {
  readonly policyStore: PolicyStore;
  readonly userStore: UserStore;
  readonly roleStore: RoleStore;
  readonly sessionStore: SessionStore;
  /** 登录失败计数/锁定存储（SP-1：AuthService.login 端口注入）。 */
  readonly loginAttemptStore: LoginAttemptStore;
  /** 机构/部门主数据存储（S1 backfill：0920 #3）。 */
  readonly departmentStore: DepartmentStore;
  /** 岗位主数据存储（S1 backfill：0920 #7）。 */
  readonly positionStore: PositionStore;
  disconnect(): Promise<void>;
}

/**
 * 构造 PG 存储装配（惰性连接：见文件头）。
 *
 * RLS session 接线（ADR-0005 M4）：SMES_RLS_SESSION=on 时客户端经
 * withRlsTenantSession 包装——每个模型操作在事务内先 SET app.current_tenant
 * 再执行（机制与取舍见 ../rls-session.ts 文件头，M4 正式线上提包顶层）；缺省不包装，行为与接线前
 * 逐位相同（superuser 形态零开销零变化）。装配面不变：四个 store 收到的仍是
 * PrismaClient 形状句柄，PgXxxStore 构造零改动。
 */
export function connectBusinessStore(options: BusinessStoreOptions = {}): BusinessStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    policyStore: new PgPolicyStore(client),
    userStore: new PgUserStore(client),
    roleStore: new PgRoleStore(client),
    sessionStore: new PgSessionStore(client),
    loginAttemptStore: new PgLoginAttemptStore(client, options.loginAttempt ?? {}),
    departmentStore: new PgDepartmentStore(client),
    positionStore: new PgPositionStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}

/** 行形状重导出（组装/校验工具用）。 */
export type { PolicyRecordDbRow } from './policy-mapping.js';
