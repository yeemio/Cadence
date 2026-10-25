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
  type CreateSessionInput,
  type PolicyRule,
  type PolicyStore,
  type RoleDefinition,
  type RoleName,
  type RoleStore,
  type SessionRecord,
  type SessionStore,
  type UserAccount,
  type UserCredentials,
  type UserStore,
} from '@smes/application';
import type {
  CreateRoleInput,
  CreateUserInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
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

export interface BusinessStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：四端口实现 + 优雅断连。 */
export interface BusinessStoreHandle {
  readonly policyStore: PolicyStore;
  readonly userStore: UserStore;
  readonly roleStore: RoleStore;
  readonly sessionStore: SessionStore;
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
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    policyStore: new PgPolicyStore(client),
    userStore: new PgUserStore(client),
    roleStore: new PgRoleStore(client),
    sessionStore: new PgSessionStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}

/** 行形状重导出（组装/校验工具用）。 */
export type { PolicyRecordDbRow } from './policy-mapping.js';
