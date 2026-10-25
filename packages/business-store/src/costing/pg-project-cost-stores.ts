/**
 * costing U7 项目成本三端口的 PG 实现（A5 六块成本：段事实 + 六块快照 + 录入
 * 价格）。体例同 pg-costing-stores：经本包 `./costing` 子路径导出；RLS session
 * 接线与既有 costing 五端口同源（connectCostingStore 一并装配）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId } from '@smes/business-core';
import {
  CostingConflictError,
  type AppendCostProjectEntryInput,
  type AppendCostProjectSnapshotInput,
  type CostPriceEntryRow,
  type CostPriceEntryStore,
  type CostProjectEntryRow,
  type CostProjectEntryStore,
  type CostProjectSnapshotRow,
  type CostProjectSnapshotStore,
  type ListCostProjectEntriesFilter,
  type UpsertCostPriceEntryInput,
} from '@smes/application';
import type { ProjectCostBlock, ProjectCostSegment, ProjectCostTotals } from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new CostingConflictError(message);
  }
  return error;
}

function isoToDate(value: string | undefined | null): Date | undefined {
  return value === undefined || value === null ? undefined : new Date(value);
}

// ---- 段事实 ----

type CostProjectEntryDbRow = {
  id: string;
  tenantId: string;
  seq: bigint;
  workOrderId: string;
  block: string;
  segment: string | null;
  lineKind: string | null;
  amountMinor: number | null;
  quantity: number | null;
  trade: string | null;
  supplierRef: string | null;
  equipmentRef: string | null;
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

function toProjectEntryRow(row: CostProjectEntryDbRow): CostProjectEntryRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    workOrderId: row.workOrderId,
    block: row.block as ProjectCostBlock,
    segment: row.segment as ProjectCostSegment | null,
    lineKind: (row.lineKind as CostProjectEntryRow['lineKind']) ?? null,
    amountMinor: row.amountMinor,
    quantity: row.quantity,
    trade: row.trade,
    supplierRef: row.supplierRef,
    equipmentRef: row.equipmentRef,
    sourceType: row.sourceType as CostProjectEntryRow['sourceType'],
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

export class PgCostProjectEntryStore implements CostProjectEntryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendCostProjectEntryInput): Promise<CostProjectEntryRow> {
    try {
      const row = await this.prisma.costProjectEntryRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          block: input.block,
          segment: input.segment,
          lineKind: input.lineKind,
          amountMinor: input.amountMinor,
          quantity: input.quantity,
          trade: input.trade,
          supplierRef: input.supplierRef,
          equipmentRef: input.equipmentRef,
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
          ...(input.provenance === undefined
            ? {}
            : { provenance: input.provenance as Prisma.InputJsonObject }),
          businessTime: isoToDate(input.businessTime) ?? null,
          ...(input.availableTime === undefined ? {} : { availableTime: isoToDate(input.availableTime) ?? null }),
        },
      });
      return toProjectEntryRow(row);
    } catch (error) {
      throw toConflict(error, `项目成本段事实 sourceKey '${input.sourceKey}' 已落账（联动幂等锚点）`);
    }
  }

  async find(tenant: TenantId, id: string): Promise<CostProjectEntryRow | null> {
    const row = await this.prisma.costProjectEntryRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : toProjectEntryRow(row);
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostProjectEntryRow | null> {
    const row = await this.prisma.costProjectEntryRecord.findFirst({ where: { tenantId: tenant, sourceKey } });
    return row === null ? null : toProjectEntryRow(row);
  }

  async listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostProjectEntryRow[]> {
    const rows = await this.prisma.costProjectEntryRecord.findMany({
      where: { tenantId: tenant, OR: [{ sourceKey: baseSourceKey }, { deltaOf: baseSourceKey }] },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toProjectEntryRow(row));
  }

  async list(tenant: TenantId, filter?: ListCostProjectEntriesFilter): Promise<readonly CostProjectEntryRow[]> {
    const rows = await this.prisma.costProjectEntryRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter === undefined
          ? {}
          : {
              ...(filter.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
              ...(filter.block === undefined ? {} : { block: filter.block }),
              ...(filter.segment === undefined ? {} : { segment: filter.segment }),
            }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => toProjectEntryRow(row));
  }
}

// ---- 六块快照 ----

type CostProjectSnapshotDbRow = {
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

function toProjectSnapshotRow(row: CostProjectSnapshotDbRow): CostProjectSnapshotRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    modelCode: row.modelCode,
    modelVersion: row.modelVersion,
    totals: row.totals as ProjectCostTotals,
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

export class PgCostProjectSnapshotStore implements CostProjectSnapshotStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendCostProjectSnapshotInput): Promise<CostProjectSnapshotRow> {
    try {
      const row = await this.prisma.costProjectSnapshotRecord.create({
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
          ...(input.provenance === undefined
            ? {}
            : { provenance: input.provenance as Prisma.InputJsonObject }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toProjectSnapshotRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `项目成本快照 ${input.workOrderId}@${input.modelCode}v${input.modelVersion} 版本 ${input.objectVersion} 唯一约束冲突（并发重算竞态或 supersedes 链分叉）`,
      );
    }
  }

  async chain(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    modelVersion: number,
  ): Promise<readonly CostProjectSnapshotRow[]> {
    const rows = await this.prisma.costProjectSnapshotRecord.findMany({
      where: { tenantId: tenant, workOrderId, modelCode, modelVersion },
      orderBy: { objectVersion: 'asc' },
    });
    return rows.map((row) => toProjectSnapshotRow(row));
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostProjectSnapshotRow[]> {
    const rows = await this.prisma.costProjectSnapshotRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ modelCode: 'asc' }, { modelVersion: 'asc' }, { objectVersion: 'asc' }],
    });
    return rows.map((row) => toProjectSnapshotRow(row));
  }
}

// ---- 录入价格（运营投影 upsert） ----

type CostPriceEntryDbRow = {
  id: string;
  tenantId: string;
  workOrderId: string;
  recordId: string;
  taskLineId: string;
  kind: string;
  sourceLineId: string | null;
  reservedQty: number;
  unitPriceMinor: number | null;
  totalMinor: number | null;
  amountManual: boolean;
  recordedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toPriceEntryRow(row: CostPriceEntryDbRow): CostPriceEntryRow {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    recordId: row.recordId,
    taskLineId: row.taskLineId,
    kind: row.kind as CostPriceEntryRow['kind'],
    sourceLineId: row.sourceLineId,
    reservedQty: row.reservedQty,
    unitPriceMinor: row.unitPriceMinor,
    totalMinor: row.totalMinor,
    amountManual: row.amountManual,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgCostPriceEntryStore implements CostPriceEntryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertCostPriceEntryInput): Promise<CostPriceEntryRow> {
    const existing = await this.find(input.tenant, input.workOrderId, input.recordId, input.taskLineId);
    if (existing !== null) {
      const row = await this.prisma.costPriceEntryRecord.update({
        where: { id: existing.id },
        data: {
          kind: input.kind,
          sourceLineId: input.sourceLineId,
          reservedQty: input.reservedQty,
          unitPriceMinor: input.unitPriceMinor,
          totalMinor: input.totalMinor,
          amountManual: input.amountManual,
          recordedBy: input.recordedBy,
        },
      });
      return toPriceEntryRow(row);
    }
    const row = await this.prisma.costPriceEntryRecord.create({
      data: {
        id: uuidv7(),
        tenantId: input.tenant,
        workOrderId: input.workOrderId,
        recordId: input.recordId,
        taskLineId: input.taskLineId,
        kind: input.kind,
        sourceLineId: input.sourceLineId,
        reservedQty: input.reservedQty,
        unitPriceMinor: input.unitPriceMinor,
        totalMinor: input.totalMinor,
        amountManual: input.amountManual,
        recordedBy: input.recordedBy,
      },
    });
    return toPriceEntryRow(row);
  }

  async find(tenant: TenantId, workOrderId: string, recordId: string, taskLineId: string): Promise<CostPriceEntryRow | null> {
    const row = await this.prisma.costPriceEntryRecord.findFirst({
      where: { tenantId: tenant, workOrderId, recordId, taskLineId },
    });
    return row === null ? null : toPriceEntryRow(row);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostPriceEntryRow[]> {
    const rows = await this.prisma.costPriceEntryRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ recordId: 'asc' }, { taskLineId: 'asc' }],
    });
    return rows.map((row) => toPriceEntryRow(row));
  }
}

// ---- 组合根装配（RLS session 同 connectCostingStore；三端口并入同一 Prisma 客户端形态） ----

/** U7 三端口的独立装配（与既有 costing 五端口分客户端形态；惰性连接）。 */
export function connectProjectCostStore(options: { readonly datasourceUrl?: string } = {}): {
  readonly projectEntryStore: CostProjectEntryStore;
  readonly projectSnapshotStore: CostProjectSnapshotStore;
  readonly priceEntryStore: CostPriceEntryStore;
  disconnect(): Promise<void>;
} {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    projectEntryStore: new PgCostProjectEntryStore(client),
    projectSnapshotStore: new PgCostProjectSnapshotStore(client),
    priceEntryStore: new PgCostPriceEntryStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
