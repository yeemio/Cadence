/**
 * MachiningDailyStatsStore 的 PG 实现 + 组合根装配工厂（A8/A10 首波，
 * RREQ-RP-027：每日机加工进度统计日表；端口与冻结公式见 application
 * standardreports/screen/machining-daily-stores.ts）。
 *
 * 表形态：machining_daily_stats 运营快照（存在则更新否则插入——upsert 走
 * (tenant_id, statistics_date) 唯一键的 Prisma upsert；不套证据公共列，
 * 取舍同 cost_price_entries 先例）。启动零 DB 依赖：connectMachiningDailyStore
 * 只构造 PrismaClient（惰性连接），无 DATABASE_URL 时组合根不调用本工厂。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import type {
  MachiningDailyStatsRow,
  MachiningDailyStatsStore,
  UpsertMachiningDailyStatsInput,
} from '@smes/application';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';

interface MachiningDailyDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly statisticsDate: string;
  readonly surfaceTreatmentDrawingCount: number | null;
  readonly pendingMachiningCount: number | null;
  readonly pendingReasons: unknown;
  readonly computedAt: Date;
  readonly computedBy: string;
}

function rowToStats(row: MachiningDailyDbRow): MachiningDailyStatsRow {
  return {
    tenant: TenantId.create(row.tenantId),
    statisticsDate: row.statisticsDate,
    surfaceTreatmentDrawingCount: row.surfaceTreatmentDrawingCount,
    pendingMachiningCount: row.pendingMachiningCount,
    pendingReasons: (row.pendingReasons ?? {}) as Readonly<Record<string, string>>,
    computedAt: row.computedAt.toISOString(),
    computedBy: row.computedBy,
  };
}

export class PgMachiningDailyStatsStore implements MachiningDailyStatsStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertMachiningDailyStatsInput): Promise<MachiningDailyStatsRow> {
    const reasons = input.pendingReasons as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.machiningDailyStatRecord.upsert({
      where: {
        tenantId_statisticsDate: { tenantId: input.tenant, statisticsDate: input.statisticsDate },
      },
      create: {
        tenantId: input.tenant,
        statisticsDate: input.statisticsDate,
        surfaceTreatmentDrawingCount: input.surfaceTreatmentDrawingCount,
        pendingMachiningCount: input.pendingMachiningCount,
        pendingReasons: reasons,
        computedAt: new Date(input.computedAt),
        computedBy: input.computedBy,
      },
      update: {
        surfaceTreatmentDrawingCount: input.surfaceTreatmentDrawingCount,
        pendingMachiningCount: input.pendingMachiningCount,
        pendingReasons: reasons,
        computedAt: new Date(input.computedAt),
        computedBy: input.computedBy,
      },
    });
    return rowToStats(row);
  }

  async find(tenant: TenantId, statisticsDate: string): Promise<MachiningDailyStatsRow | null> {
    const row = await this.prisma.machiningDailyStatRecord.findUnique({
      where: { tenantId_statisticsDate: { tenantId: tenant, statisticsDate } },
    });
    return row === null ? null : rowToStats(row);
  }

  async findLatest(tenant: TenantId): Promise<MachiningDailyStatsRow | null> {
    const rows = await this.listRecent(tenant, 1);
    return rows[0] ?? null;
  }

  async listRecent(tenant: TenantId, days: number): Promise<readonly MachiningDailyStatsRow[]> {
    const rows = await this.prisma.machiningDailyStatRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { statisticsDate: 'desc' },
      take: Math.max(0, Math.trunc(days)),
    });
    return rows.map(rowToStats);
  }
}

export interface MachiningDailyStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄（可直接喂 MachiningDailyStatsService）+ 优雅断连。 */
export interface MachiningDailyStoreHandle {
  readonly dailyStore: MachiningDailyStatsStore;
  disconnect(): Promise<void>;
}

/** 构造机加日统计 PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectMachiningDailyStore(options: MachiningDailyStoreOptions = {}): MachiningDailyStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（同 connectReportingStore 体例）：saas 形态事务内
  // SET app.current_tenant；单机形态原客户端（回落 'default' 与请求租户同值）。
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    dailyStore: new PgMachiningDailyStatsStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
