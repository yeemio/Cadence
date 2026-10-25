/**
 * reporting 存储端口的内存先行实现（M2-W7）。
 *
 * 重启即失；PG 实现在 business-store（`./reporting` 子路径，总控合流接线）。
 * 与 in-memory-dispatch-stores 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance/record
 * 带乐观版本或幂等检查（与 PG 实现同一合同）。机器事件账本不复刻——直接用
 * engine-flow 的 createInMemoryApprovalEventStore（见 reporting.module.ts）。
 */
import {
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import { ReportConflictError } from './reporting-errors.js';
import type {
  CreateWorkReportInput,
  ListWorkReportsFilter,
  ReportAuditRow,
  ReportAuditStore,
  ReportDomainEventStore,
  ReportOperationRecord,
  ReportOperationStore,
  WorkReport,
  WorkReportStore,
} from './reporting-stores.js';

// ---- 报工单（状态机投影 + 修正链；list 链尾口径） ----

interface ReportRow {
  readonly tenant: string;
  readonly id: string;
  readonly dispatchId: string;
  readonly kind: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  doneQty: number;
  laborMinutes: number;
  readonly reporter: UserId;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly supersedes: string | null;
  readonly businessTime: string;
  verifiedBy: UserId | null;
  verifiedAt: string | null;
  revokedBy: UserId | null;
  revokedAt: string | null;
  revokeReason: string | null;
  remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toReport(row: ReportRow): WorkReport {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    dispatchId: row.dispatchId,
    kind: row.kind as WorkReport['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    doneQty: row.doneQty,
    laborMinutes: row.laborMinutes,
    reporter: row.reporter,
    workOrderId: row.workOrderId,
    drawingNo: row.drawingNo,
    operationCode: row.operationCode,
    supersedes: row.supersedes,
    businessTime: row.businessTime,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt,
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryWorkReportStore implements WorkReportStore {
  private readonly rows = new Map<string, ReportRow>(); // key: `${tenant}|${id}`

  async create(input: CreateWorkReportInput): Promise<WorkReport> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new ReportConflictError(`报工单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: ReportRow = {
      tenant: input.tenant,
      id: input.id,
      dispatchId: input.dispatchId,
      kind: input.kind,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      doneQty: input.doneQty,
      laborMinutes: input.laborMinutes,
      reporter: input.reporter,
      workOrderId: input.workOrderId,
      drawingNo: input.drawingNo,
      operationCode: input.operationCode,
      supersedes: input.supersedes,
      businessTime: input.businessTime,
      verifiedBy: null,
      verifiedAt: null,
      revokedBy: null,
      revokedAt: null,
      revokeReason: null,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toReport(row);
  }

  async find(tenant: TenantId, id: string): Promise<WorkReport | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toReport(row);
  }

  async findBySupersedes(tenant: TenantId, supersedesId: string): Promise<readonly WorkReport[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.supersedes === supersedesId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toReport);
  }

  async list(tenant: TenantId, filter?: ListWorkReportsFilter): Promise<readonly WorkReport[]> {
    // 链尾口径（端口合同）：被其他行 supersedes 的行不进活跃视图。
    const superseded = new Set(
      [...this.rows.values()]
        .filter((row) => row.tenant === tenant && row.supersedes !== null)
        .map((row) => row.supersedes as string),
    );
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          !superseded.has(row.id) &&
          (filter?.kind === undefined || row.kind === filter.kind) &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.dispatchId === undefined || row.dispatchId === filter.dispatchId) &&
          (filter?.reporter === undefined || row.reporter === filter.reporter) &&
          (filter?.drawingNo === undefined || row.drawingNo === filter.drawingNo),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toReport);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly verifiedBy?: UserId;
      readonly verifiedAt?: string;
      readonly revokedBy?: UserId;
      readonly revokedAt?: string;
      readonly revokeReason?: string | null;
    },
  ): Promise<WorkReport> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new ReportConflictError(
        `报工单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.verifiedBy !== undefined) row.verifiedBy = extra.verifiedBy;
    if (extra?.verifiedAt !== undefined) row.verifiedAt = extra.verifiedAt;
    if (extra?.revokedBy !== undefined) row.revokedBy = extra.revokedBy;
    if (extra?.revokedAt !== undefined) row.revokedAt = extra.revokedAt;
    if (extra?.revokeReason !== undefined) row.revokeReason = extra.revokeReason;
    row.updatedAt = new Date().toISOString();
    return toReport(row);
  }
}

// ---- 核查留痕（append-only） ----

export class InMemoryReportAuditStore implements ReportAuditStore {
  private readonly rows = new Map<string, ReportAuditRow>(); // key: `${tenant}|${id}`

  async append(row: ReportAuditRow): Promise<ReportAuditRow> {
    const key = `${row.tenant}|${row.id}`;
    if (this.rows.has(key)) {
      throw new ReportConflictError(`核查留痕 '${row.id}' 已存在`);
    }
    this.rows.set(key, row);
    return row;
  }

  async listByReport(tenant: TenantId, reportId: string): Promise<readonly ReportAuditRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.reportId === reportId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}

// ---- 命令幂等记账 ----

export class InMemoryReportOperationStore implements ReportOperationStore {
  private readonly recorded = new Map<string, ReportOperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: ReportOperationRecord): Promise<ReportOperationRecord | null> {
    const key = `${entry.tenant}|${entry.operationId}`;
    if (this.recorded.has(key)) return null;
    this.recorded.set(key, entry);
    return entry;
  }
}

// ---- 域事件（BusinessEvent + Outbox） ----

interface StoredDomainEvent {
  readonly seq: number;
  readonly event: BusinessEvent;
}

export class InMemoryReportDomainEventStore implements ReportDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new ReportConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
    }
    this.events.push({ seq: this.events.length + 1, event });
    const record: OutboxRecord = {
      eventId: event.eventId,
      createdAt: event.occurredAt,
      attempts: 0,
      deliveredAt: null,
    };
    this.outbox.set(event.eventId, record);
    return record;
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter(({ event }) => event.aggregate.id === aggregate.id && event.aggregate.type === aggregate.type)
      .sort((a, b) => a.seq - b.seq)
      .map(({ event }) => event);
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((row) => row.deliveredAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    const row = this.outbox.get(eventId);
    if (row === undefined) return;
    this.outbox.set(eventId, { ...row, deliveredAt });
  }
}
