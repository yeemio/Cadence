/**
 * ItemStore / ResourceStore 的 PG 实现 + 组合根装配工厂
 * （M1 增量 4-I，经本包 `./masterdata` 子路径导出——与 `./org` 同模式：
 * 主入口保持零 @prisma/client 依赖，纯数据面测试不触碰 Prisma）。
 *
 * 启动零 DB 依赖：connectMasterdataStore 只构造 PrismaClient（惰性连接——
 * 构造不握手、bootstrap 阶段零查询），首条查询才真正连库；无 DATABASE_URL
 * 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * 主数据表取舍：配置数据非业务事实——普通 CRUD（不套证据公共列、
 * 不套 append-only 触发器，见 prisma/schema.prisma 分节注释）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId } from '@smes/business-core';
import {
  MasterdataConflictError,
  type CreateItemInput,
  type CreateResourceInput,
  type ItemMaster,
  type ItemStore,
  type ResourceMaster,
  type ResourceStore,
  type UpdateItemInput,
  type UpdateResourceInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）-> 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new MasterdataConflictError(message);
  }
  return error;
}

interface ItemDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unit: string | null;
  readonly category: string | null;
  readonly active: boolean;
}

function toItemMaster(row: ItemDbRow): ItemMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    category: row.category,
    active: row.active,
  };
}

export class PgItemStore implements ItemStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateItemInput): Promise<ItemMaster> {
    try {
      const row = await this.prisma.itemRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略）
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          spec: input.spec ?? null,
          unit: input.unit ?? null,
          category: input.category ?? null,
          active: input.active ?? true,
        },
      });
      return toItemMaster(row);
    } catch (error) {
      throw toConflict(
        error,
        `物品 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly ItemMaster[]> {
    const rows = await this.prisma.itemRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toItemMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ItemMaster | null> {
    const row = await this.prisma.itemRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toItemMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateItemInput): Promise<ItemMaster | null> {
    try {
      const row = await this.prisma.itemRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.spec !== undefined ? { spec: input.spec } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toItemMaster(row);
    } catch (error) {
      // update 按 (id, tenantId) 复合 where（@@unique 无此键时 P2025 = 行不存在）→ null
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

interface ResourceDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: string | null;
  readonly active: boolean;
}

function toResourceMaster(row: ResourceDbRow): ResourceMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    type: row.type,
    active: row.active,
  };
}

export class PgResourceStore implements ResourceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateResourceInput): Promise<ResourceMaster> {
    try {
      const row = await this.prisma.resourceRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          type: input.type ?? null,
          active: input.active ?? true,
        },
      });
      return toResourceMaster(row);
    } catch (error) {
      throw toConflict(
        error,
        `资源 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly ResourceMaster[]> {
    const rows = await this.prisma.resourceRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toResourceMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ResourceMaster | null> {
    const row = await this.prisma.resourceRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toResourceMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateResourceInput,
  ): Promise<ResourceMaster | null> {
    try {
      const row = await this.prisma.resourceRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toResourceMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

export interface MasterdataStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：两端口实现 + 优雅断连。 */
export interface MasterdataStoreHandle {
  readonly itemStore: ItemStore;
  readonly resourceStore: ResourceStore;
  disconnect(): Promise<void>;
}

/** 构造基础数据 PG 存储装配（惰性连接：见文件头）。 */
export function connectMasterdataStore(
  options: MasterdataStoreOptions = {},
): MasterdataStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    itemStore: new PgItemStore(client),
    resourceStore: new PgResourceStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
