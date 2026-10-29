/**
 * ColumnPreferenceStore 的 PG 实现 + 组合根装配工厂（fix-wave-6 6b-3，A14 /
 * RREQ-INT-032，经本包 `./column-preferences` 子路径导出——与 `./menu-config`
 * 同模式）。
 *
 * 启动零 DB 依赖：connectColumnPreferenceStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * 幂等 upsert：三元组 UNIQUE（tenant_id + user_id + page_key + table_key）作
 * Prisma upsert 唯一 where——与源文档"先查再插/更"语义等价但并发安全（取舍
 * 见 schema.prisma 分节注释）。hiddenProps 以 JSONB 整数组存取（归一在
 * application 输入解析层，本适配层只搬运）。
 */
import { PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId } from '@smes/business-core';
import type {
  ColumnPreferenceRecord,
  ColumnPreferenceStore,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

type Row = {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly pageKey: string;
  readonly tableKey: string;
  readonly hiddenProps: unknown;
  readonly updatedAt: Date;
};

function toRecord(row: Row): ColumnPreferenceRecord {
  return {
    tenant: TenantId.create(row.tenantId),
    userId: UserId.create(row.userId),
    pageKey: row.pageKey,
    tableKey: row.tableKey,
    // JSONB 列即端口形状（写入方为 application 已归一数组；读出按端口类型透传）
    hiddenProps: row.hiddenProps as readonly string[],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgColumnPreferenceStore implements ColumnPreferenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listForPage(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
  ): Promise<readonly ColumnPreferenceRecord[]> {
    const rows = await this.prisma.columnPreferenceRecord.findMany({
      where: { tenantId: tenant, userId, pageKey },
      orderBy: [{ updatedAt: 'asc' }, { tableKey: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async upsert(
    tenant: TenantId,
    userId: UserId,
    pageKey: string,
    tableKey: string,
    hiddenProps: readonly string[],
  ): Promise<ColumnPreferenceRecord> {
    const row = await this.prisma.columnPreferenceRecord.upsert({
      where: {
        tenantId_userId_pageKey_tableKey: {
          tenantId: tenant,
          userId,
          pageKey,
          tableKey,
        },
      },
      create: {
        id: uuidv7(), // 应用侧权威生成（本包 id 策略）
        tenantId: tenant,
        userId,
        pageKey,
        tableKey,
        hiddenProps: [...hiddenProps],
      },
      update: { hiddenProps: [...hiddenProps] },
    });
    return toRecord(row);
  }
}

export interface ColumnPreferenceStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：列显隐偏好端口实现 + 优雅断连。 */
export interface ColumnPreferenceStoreHandle {
  readonly columnPreferenceStore: ColumnPreferenceStore;
  disconnect(): Promise<void>;
}

/** 构造列显隐偏好 PG 存储装配（惰性连接：见文件头）。 */
export function connectColumnPreferenceStore(
  options: ColumnPreferenceStoreOptions = {},
): ColumnPreferenceStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    columnPreferenceStore: new PgColumnPreferenceStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
