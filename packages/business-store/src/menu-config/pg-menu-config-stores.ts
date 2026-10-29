/**
 * MenuConfigStore 的 PG 实现 + 组合根装配工厂（T 波 #98/99，经本包
 * `./menu-config` 子路径导出——与 `./masterdata` 同模式；子路径登记归合流）。
 *
 * 启动零 DB 依赖：connectMenuConfigStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * 表取舍：menu_configs 是配置数据非业务事实——普通 CRUD、不套证据公共列、
 * 不套 append-only 触发器（见 prisma/schema.prisma 分节注释）。节点树以
 * JSONB 整文档存取（树校验在 application 输入解析层，本适配层只搬运）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId } from '@smes/business-core';
import {
  MenuConfigConflictError,
  type CreateMenuConfigInput,
  type MenuConfig,
  type MenuConfigNode,
  type MenuConfigStore,
  type UpdateMenuConfigInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）-> 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new MenuConfigConflictError(message);
  }
  return error;
}

interface MenuConfigDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly nodes: unknown;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toMenuConfig(row: MenuConfigDbRow): MenuConfig {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    // JSONB 列即端口形状（写入方为 application 已校验文档；读出按端口类型透传）
    nodes: row.nodes as readonly MenuConfigNode[],
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgMenuConfigStore implements MenuConfigStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateMenuConfigInput): Promise<MenuConfig> {
    try {
      const row = await this.prisma.menuConfigRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略）
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          nodes: input.nodes as object[],
          active: input.active ?? true,
        },
      });
      return toMenuConfig(row);
    } catch (error) {
      throw toConflict(
        error,
        `配置集 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly MenuConfig[]> {
    const rows = await this.prisma.menuConfigRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toMenuConfig);
  }

  async find(tenant: TenantId, id: string): Promise<MenuConfig | null> {
    const row = await this.prisma.menuConfigRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toMenuConfig(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateMenuConfigInput,
  ): Promise<MenuConfig | null> {
    try {
      const row = await this.prisma.menuConfigRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.nodes !== undefined ? { nodes: input.nodes as object[] } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toMenuConfig(row);
    } catch (error) {
      // update 按 (id, tenantId) 复合 where（无此唯一键时 P2025 = 行不存在）→ null
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

export interface MenuConfigStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：菜单配置端口实现 + 优雅断连。 */
export interface MenuConfigStoreHandle {
  readonly menuConfigStore: MenuConfigStore;
  disconnect(): Promise<void>;
}

/** 构造菜单配置 PG 存储装配（惰性连接：见文件头）。 */
export function connectMenuConfigStore(
  options: MenuConfigStoreOptions = {},
): MenuConfigStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    menuConfigStore: new PgMenuConfigStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
