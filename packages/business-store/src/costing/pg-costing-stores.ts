/**
 * costing 五端口的 PG 实现 + 组合根装配工厂（M2-W6，经本包 `./costing` 子路径
 * 导出——与 `./hours` 同模式：主入口保持零 @prisma/client 依赖）。
 *
 * 实现：
 *  - PgCostEntryStore → 成本条目事实（cost_entries；(tenant, sourceKey) 唯一 =
 *    来源幂等锚点；delta 条目 deltaOf 指回基准 sourceKey）
 *  - PgCostingModelStore → 口径版本（costing_models；版本化主数据，链线性
 *    不变量由 (tenant, code, version) 与 (tenant, supersedes) 唯一约束背书）
 *  - PgCostSnapshotStore → 成本快照（cost_snapshots；工作令×口径 链）
 *  - PgCostingDomainEventStore → 事件 + Outbox 同事务（复用 event_records /
 *    outbox_records；eventId 幂等锚点）
 *  - PgCostingOperationLedger → 命令幂等账本（costing_operations）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, type BusinessEvent } from '@smes/business-core';
import {
  CostingConflictError,
  type CostEntryRow,
  type CostEntryStore,
  type CostSnapshotRow,
  type CostSnapshotStore,
  type CostingDomainEventStore,
  type CostingModelRow,
  type CostingModelStore,
  type CostingOperationStore,
  type CostingStores,
  type AppendCostEntryInput,
  type AppendCostSnapshotInput,
  type CreateCostingModelInput,
  type ListCostEntriesFilter,
} from '@smes/application';
import type { CostCategory, CostSourceType, CostTotals } from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new CostingConflictError(message);
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

// ---- 成本条目 ----

type CostEntryDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  workOrderId: string;
  category: string;
  amountMinor: number | null;
  quantity: number | null;
  trade: string | null;
  sourceType: string;
  sourceRefId: string;
  sourceKey: string;
  deltaOf: string | null;
  workDate: string | null;
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

function toCostEntryRow(row: CostEntryDbRow): CostEntryRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    workOrderId: row.workOrderId,
    category: row.category as CostCategory,
    amountMinor: row.amountMinor,
    quantity: row.quantity,
    trade: row.trade,
    sourceType: row.sourceType as CostSourceType,
    sourceRefId: row.sourceRefId,
    sourceKey: row.sourceKey,
    deltaOf: row.deltaOf,
    workDate: row.workDate,
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

export class PgCostEntryStore implements CostEntryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendCostEntryInput): Promise<CostEntryRow> {
    try {
      const row = await this.prisma.costEntryRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          category: input.category,
          amountMinor: input.amountMinor,
          quantity: input.quantity,
          trade: input.trade,
          sourceType: input.sourceType,
          sourceRefId: input.sourceRefId,
          sourceKey: input.sourceKey,
          deltaOf: input.deltaOf,
          workDate: input.workDate,
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
      return toCostEntryRow(row);
    } catch (error) {
      throw toConflict(error, `成本条目 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
  }

  async find(tenant: TenantId, id: string): Promise<CostEntryRow | null> {
    const row = await this.prisma.costEntryRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toCostEntryRow(row);
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostEntryRow | null> {
    const row = await this.prisma.costEntryRecord.findFirst({ where: { tenantId: tenant, sourceKey } });
    return row === null ? null : toCostEntryRow(row);
  }

  async listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostEntryRow[]> {
    const rows = await this.prisma.costEntryRecord.findMany({
      where: { tenantId: tenant, OR: [{ sourceKey: baseSourceKey }, { deltaOf: baseSourceKey }] },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toCostEntryRow(row));
  }

  async list(tenant: TenantId, filter?: ListCostEntriesFilter): Promise<readonly CostEntryRow[]> {
    const rows = await this.prisma.costEntryRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
              ...(filter.category === undefined ? {} : { category: filter.category }),
              ...(filter.sourceType === undefined ? {} : { sourceType: filter.sourceType }),
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toCostEntryRow(row));
  }
}

// ---- 口径版本（版本化主数据） ----

type CostingModelDbRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string | null;
  definition: unknown;
  status: string;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toModelRow(row: CostingModelDbRow): CostingModelRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    definition: row.definition,
    status: row.status === 'draft' ? 'draft' : 'active',
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

export class PgCostingModelStore implements CostingModelStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreateCostingModelInput): Promise<CostingModelRow> {
    try {
      const row = await this.prisma.costingModelRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          definition: input.definition as Prisma.InputJsonObject,
          status: input.status,
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toModelRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `口径版本 '${input.code}' 版本 ${input.objectVersion} 唯一约束冲突（并发写入竞态或 supersedes 链分叉）`,
      );
    }
  }

  async versions(tenant: TenantId, code: string): Promise<readonly CostingModelRow[]> {
    const rows = await this.prisma.costingModelRecord.findMany({
      where: { tenantId: tenant, code },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toModelRow(row));
  }

  async listAll(tenant: TenantId): Promise<readonly CostingModelRow[]> {
    const rows = await this.prisma.costingModelRecord.findMany({
      where: { tenantId: tenant },
      orderBy: [{ code: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toModelRow(row));
  }
}

// ---- 成本快照 ----

type CostSnapshotDbRow = {
  id: string;
  tenantId: string;
  workOrderId: string;
  modelCode: string;
  modelVersion: number;
  totals: unknown;
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

function toSnapshotRow(row: CostSnapshotDbRow): CostSnapshotRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    modelCode: row.modelCode,
    modelVersion: row.modelVersion,
    totals: row.totals as CostTotals,
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

export class PgCostSnapshotStore implements CostSnapshotStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendCostSnapshotInput): Promise<CostSnapshotRow> {
    try {
      const row = await this.prisma.costSnapshotRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          modelCode: input.modelCode,
          modelVersion: input.modelVersion,
          totals: input.totals as unknown as Prisma.InputJsonObject,
          rebuiltBy: input.rebuiltBy,
          rebuiltAt: new Date(input.rebuiltAt),
          objectVersion: input.objectVersion,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toSnapshotRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 版本 ${input.objectVersion} 唯一约束冲突（并发重算竞态或 supersedes 链分叉）`,
      );
    }
  }

  async chain(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    modelVersion: number,
  ): Promise<readonly CostSnapshotRow[]> {
    const rows = await this.prisma.costSnapshotRecord.findMany({
      where: { tenantId: tenant, workOrderId, modelCode, modelVersion },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toSnapshotRow(row));
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostSnapshotRow[]> {
    const rows = await this.prisma.costSnapshotRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ modelCode: 'asc' }, { modelVersion: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toSnapshotRow(row));
  }
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgCostingDomainEventStore implements CostingDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<void> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, event.tenantId);
    try {
      await this.prisma.$transaction([
        this.prisma.businessEventRecord.create({
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
        }),
        this.prisma.outboxRecord.create({
          data: { eventId: outbox.eventId, tenantId: outbox.tenantId, createdAt: outbox.createdAt },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CostingConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

export class PgCostingOperationLedger implements CostingOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.costingOperationRecord.create({
        data: { id: uuidv7(), tenantId: tenant, operationId, commandKind },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

// ---- 组合根装配工厂 ----

export interface CostingStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：五端口实现（可直接喂 CostingModule.register）+ 优雅断连。 */
export interface CostingStoreHandle {
  readonly entryStore: CostEntryStore;
  readonly modelStore: CostingModelStore;
  readonly snapshotStore: CostSnapshotStore;
  readonly eventStore: CostingDomainEventStore;
  readonly operationStore: CostingOperationStore;
  readonly stores: CostingStores;
  disconnect(): Promise<void>;
}

/** 构造 costing PG 存储装配（惰性连接）。 */
export function connectCostingStore(options: CostingStoreOptions = {}): CostingStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  const stores: CostingStores = {
    entries: new PgCostEntryStore(client),
    models: new PgCostingModelStore(client),
    snapshots: new PgCostSnapshotStore(client),
    events: new PgCostingDomainEventStore(client),
    operations: new PgCostingOperationLedger(client),
  };
  return {
    entryStore: stores.entries,
    modelStore: stores.models,
    snapshotStore: stores.snapshots,
    eventStore: stores.events,
    operationStore: stores.operations,
    stores,
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
