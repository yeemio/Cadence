/**
 * hours 四端口的 PG 实现 + 组合根装配工厂（M2-W6，经本包 `./hours` 子路径
 * 导出——与 `./baseline` 等同模式：主入口保持零 @prisma/client 依赖）。
 * 启动零 DB 依赖：connectHoursStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 实现：
 *  - PgLaborEntryStore → 工时条目事实（labor_entries；(tenant, sourceKey)
 *    唯一 = 联动幂等锚点，P2002 → HoursConflictError；seq bigserial）
 *  - PgLaborLedgerMonthStore → 月度归集快照（labor_ledger_months；链线性
 *    不变量由 (tenant, worker, month, trade, version) 与 (tenant, supersedes)
 *    唯一约束背书）
 *  - PgHoursDomainEventStore → 事件 + Outbox 同事务落账（复用 event_records /
 *    outbox_records 与既有行映射；eventId 幂等锚点）
 *  - PgHoursOperationLedger → 命令幂等账本（hours_operations；(tenant,
 *    operationId) 唯一，P2002 = 已落账 → claim false）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, type BusinessEvent } from '@smes/business-core';
import {
  HoursConflictError,
  type HoursDomainEventStore,
  type HoursOperationStore,
  type HoursStores,
  type LaborEntryRow,
  type LaborEntryStore,
  type LaborLedgerMonthRow,
  type LaborLedgerMonthStore,
  type ListLaborEntriesFilter,
  type AppendLaborEntryInput,
  type AppendLaborLedgerMonthInput,
} from '@smes/application';
import type { HoursTrade } from '@smes/application';
import { monthOfDate } from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）→ 域冲突错误；其余原样上抛。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new HoursConflictError(message);
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function jsonInput(value: Readonly<Record<string, unknown>>): Prisma.InputJsonObject {
  return value as unknown as Prisma.InputJsonObject;
}

function isoToDate(value: string | undefined | null): Date | undefined {
  return value === undefined || value === null ? undefined : new Date(value);
}

// ---- 工时条目 ----

type LaborEntryDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  workerId: string;
  workDate: string;
  trade: string;
  processCode: string | null;
  hours: number;
  outputQty: number | null;
  direction: string;
  sourceReportId: string;
  reverses: string | null;
  workOrderId: string | null;
  drawingNo: string | null;
  dispatchId: string | null;
  sourceKey: string;
  remark: string | null;
  occurredAt: Date;
  recordedBy: string;
  objectVersion: number;
  auditStatus: string;
  provenance: unknown;
  supersedes: string | null;
  businessTime: Date | null;
  availableTime: Date | null;
};

function toEntryRow(row: LaborEntryDbRow): LaborEntryRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    workerId: row.workerId,
    workDate: row.workDate,
    trade: row.trade as LaborEntryRow['trade'],
    processCode: row.processCode,
    hours: row.hours,
    outputQty: row.outputQty,
    direction: row.direction as LaborEntryRow['direction'],
    sourceReportId: row.sourceReportId,
    reverses: row.reverses,
    workOrderId: row.workOrderId,
    drawingNo: row.drawingNo,
    dispatchId: row.dispatchId,
    sourceKey: row.sourceKey,
    remark: row.remark,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

export class PgLaborEntryStore implements LaborEntryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendLaborEntryInput): Promise<LaborEntryRow> {
    try {
      const row = await this.prisma.laborEntryRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          workerId: input.workerId,
          workDate: input.workDate,
          trade: input.trade,
          processCode: input.processCode,
          hours: input.hours,
          outputQty: input.outputQty,
          direction: input.direction,
          sourceReportId: input.sourceReportId,
          reverses: input.reverses,
          workOrderId: input.workOrderId,
          drawingNo: input.drawingNo,
          dispatchId: input.dispatchId,
          sourceKey: input.sourceKey,
          remark: input.remark,
          occurredAt: new Date(input.occurredAt),
          recordedBy: input.recordedBy,
          objectVersion: 1,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
          ...(input.availableTime === undefined ? {} : { availableTime: isoToDate(input.availableTime) ?? null }),
        },
      });
      return toEntryRow(row);
    } catch (error) {
      throw toConflict(error, `工时条目 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
  }

  async find(tenant: TenantId, id: string): Promise<LaborEntryRow | null> {
    const row = await this.prisma.laborEntryRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toEntryRow(row);
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<LaborEntryRow | null> {
    const row = await this.prisma.laborEntryRecord.findFirst({ where: { tenantId: tenant, sourceKey } });
    return row === null ? null : toEntryRow(row);
  }

  async list(tenant: TenantId, filter?: ListLaborEntriesFilter): Promise<readonly LaborEntryRow[]> {
    const rows = await this.prisma.laborEntryRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.workerId === undefined ? {} : { workerId: filter.workerId }),
              ...(filter.trade === undefined ? {} : { trade: filter.trade }),
              ...(filter.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
              ...(filter.sourceReportId === undefined ? {} : { sourceReportId: filter.sourceReportId }),
              ...(filter.direction === undefined ? {} : { direction: filter.direction }),
              // month 过滤在应用侧按 workDate 前缀收口（PG text 前缀扫描走索引）
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows
      .map((row) => toEntryRow(row))
      .filter((row) => filter?.month === undefined || monthOfDate(row.workDate) === filter.month);
  }
}

// ---- 月度归集快照 ----

type LedgerMonthDbRow = {
  id: string;
  tenantId: string;
  workerId: string;
  month: string;
  trade: string;
  totalHours: number;
  outputQty: number;
  entryCount: number;
  firstWorkDate: string | null;
  lastWorkDate: string | null;
  rebuiltBy: string;
  rebuiltAt: Date;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toMonthRow(row: LedgerMonthDbRow): LaborLedgerMonthRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workerId: row.workerId,
    month: row.month,
    trade: row.trade as HoursTrade,
    totalHours: row.totalHours,
    outputQty: row.outputQty,
    entryCount: row.entryCount,
    firstWorkDate: row.firstWorkDate,
    lastWorkDate: row.lastWorkDate,
    rebuiltBy: row.rebuiltBy,
    rebuiltAt: row.rebuiltAt.toISOString(),
    objectVersion: row.objectVersion,
    supersedes: row.supersedes,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgLaborLedgerMonthStore implements LaborLedgerMonthStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendLaborLedgerMonthInput): Promise<LaborLedgerMonthRow> {
    try {
      const row = await this.prisma.laborLedgerMonthRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          workerId: input.workerId,
          month: input.month,
          trade: input.trade,
          totalHours: input.totalHours,
          outputQty: input.outputQty,
          entryCount: input.entryCount,
          firstWorkDate: input.firstWorkDate,
          lastWorkDate: input.lastWorkDate,
          rebuiltBy: input.rebuiltBy,
          rebuiltAt: new Date(input.rebuiltAt),
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toMonthRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `月度归集 ${input.workerId} ${input.month} ${input.trade} 版本 ${input.objectVersion} 唯一约束冲突（并发重算竞态或 supersedes 链分叉）`,
      );
    }
  }

  async chain(
    tenant: TenantId,
    workerId: string,
    month: string,
    trade: HoursTrade,
  ): Promise<readonly LaborLedgerMonthRow[]> {
    const rows = await this.prisma.laborLedgerMonthRecord.findMany({
      where: { tenantId: tenant, workerId, month, trade },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toMonthRow(row));
  }

  async listByMonth(tenant: TenantId, month: string, workerId?: string): Promise<readonly LaborLedgerMonthRow[]> {
    const rows = await this.prisma.laborLedgerMonthRecord.findMany({
      where: { tenantId: tenant, month, ...(workerId === undefined ? {} : { workerId }) },
      orderBy: [{ workerId: 'asc' }, { trade: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toMonthRow(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgHoursDomainEventStore implements HoursDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<void> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, event.tenantId);
    try {
      // 交互式事务共享 tx 句柄：event+outbox 原子双写（RLS 接管见 rls-session.ts）。
      await this.prisma.$transaction(async (tx) => {
        await tx.businessEventRecord.create({
          data: {
            eventId: row.eventId,
            tenantId: row.tenantId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            aggregateType: row.aggregateType,
            aggregateRevision: row.aggregateRevision,
            occurredAt: row.occurredAt,
            ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
            ...(row.availableTime === undefined ? {} : { availableTime: row.availableTime }),
            ...(row.provenance === undefined ? {} : { provenance: row.provenance as Prisma.InputJsonObject }),
            payload: row.payload as Prisma.InputJsonObject,
          },
        });
        await tx.outboxRecord.create({
          data: { eventId: outbox.eventId, tenantId: outbox.tenantId, createdAt: outbox.createdAt },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HoursConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) =>
      fromBusinessEventRow({
        eventId: row.eventId,
        eventType: row.eventType,
        tenantId: TenantId.create(row.tenantId),
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        aggregateRevision: row.aggregateRevision,
        occurredAt: row.occurredAt,
        ...(row.businessTime === null ? {} : { businessTime: row.businessTime }),
        ...(row.availableTime === null ? {} : { availableTime: row.availableTime }),
        ...(row.provenance === null ? {} : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
        payload: row.payload,
      }),
    );
  }
}

export class PgHoursOperationLedger implements HoursOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.hoursOperationRecord.create({
        data: { id: uuidv7(), tenantId: tenant, operationId, commandKind },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // 已落账 → 幂等拒绝
      throw error;
    }
  }
}

// ---- 组合根装配工厂 ----

export interface HoursStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：四端口实现（可直接喂 HoursModule.register）+ 优雅断连。 */
export interface HoursStoreHandle {
  readonly entryStore: LaborEntryStore;
  readonly monthStore: LaborLedgerMonthStore;
  readonly eventStore: HoursDomainEventStore;
  readonly operationStore: HoursOperationStore;
  readonly stores: HoursStores;
  disconnect(): Promise<void>;
}

/** 构造 hours PG 存储装配（惰性连接：见文件头）。 */
export function connectHoursStore(options: HoursStoreOptions = {}): HoursStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  const stores: HoursStores = {
    entries: new PgLaborEntryStore(client),
    months: new PgLaborLedgerMonthStore(client),
    events: new PgHoursDomainEventStore(client),
    operations: new PgHoursOperationLedger(client),
  };
  return {
    entryStore: stores.entries,
    monthStore: stores.months,
    eventStore: stores.events,
    operationStore: stores.operations,
    stores,
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
