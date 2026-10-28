/**
 * inspection 存储端口的内存先行实现（M2-W4）。
 *
 * 重启即失；PG 实现在 business-store（`./inspection` 子路径，总控合流接线）。
 * 与 InMemoryWorkOrderStore 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance/
 * updateJudgment 带乐观版本检查、record 带幂等检查（与 PG 实现同一合同）。
 * 机器事件账本不复刻——直接用 engine-flow 的 createInMemoryApprovalEventStore
 * （见 inspection.module.ts）。
 */
import {
  InspectionId,
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import type { InspectionKind, InspectionSourceType, NonconformDisposal } from './inspection-config.js';
import { InspectionConflictError } from './inspection-errors.js';
import type {
  CreateInspectionInput,
  CreateNonconformInput,
  InspectionDomainEventStore,
  InspectionOperationStore,
  InspectionOrder,
  InspectionOrderStore,
  JudgmentFields,
  ListInspectionsFilter,
  ListNonconformsFilter,
  Nonconform,
  NonconformAdvanceExtra,
  NonconformStore,
  OperationRecord,
} from './inspection-stores.js';

// ---- 质检单投影 ----

interface InspectionRow {
  readonly tenant: string;
  readonly id: string;
  flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly kind: InspectionKind;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  passedQty: number | null;
  failedQty: number | null;
  judgeRemark: string | null;
  judgedBy: string | null;
  judgedAt: string | null;
  closeDueAt: string | null;
  overdueNotifiedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toOrder(row: InspectionRow): InspectionOrder {
  return {
    id: InspectionId.create(row.id),
    tenant: TenantId.create(row.tenant),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceRefId: row.sourceRefId,
    itemId: row.itemId,
    drawingNo: row.drawingNo,
    quantity: row.quantity,
    passedQty: row.passedQty,
    failedQty: row.failedQty,
    judgeRemark: row.judgeRemark,
    judgedBy: row.judgedBy === null ? null : UserId.create(row.judgedBy),
    judgedAt: row.judgedAt,
    closeDueAt: row.closeDueAt,
    overdueNotifiedAt: row.overdueNotifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function applyJudgment(row: InspectionRow, fields: JudgmentFields): void {
  if (fields.itemId !== undefined) row.itemId = fields.itemId;
  row.passedQty = fields.passedQty;
  row.failedQty = fields.failedQty;
  row.judgeRemark = fields.judgeRemark;
  row.judgedBy = fields.judgedBy;
  row.judgedAt = fields.judgedAt;
  row.closeDueAt = fields.closeDueAt;
}

export class InMemoryInspectionOrderStore implements InspectionOrderStore {
  private readonly rows = new Map<string, InspectionRow>(); // key: `${tenant}|${id}`

  async create(input: CreateInspectionInput): Promise<InspectionOrder> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new InspectionConflictError(`质检单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: InspectionRow = {
      tenant: input.tenant,
      id: input.id,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      kind: input.kind,
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId,
      itemId: input.itemId,
      drawingNo: input.drawingNo,
      quantity: input.quantity,
      passedQty: null,
      failedQty: null,
      judgeRemark: null,
      judgedBy: null,
      judgedAt: null,
      closeDueAt: null,
      overdueNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toOrder(row);
  }

  async find(tenant: TenantId, id: InspectionId): Promise<InspectionOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toOrder(row);
  }

  async findBySourceRef(
    tenant: TenantId,
    sourceType: InspectionSourceType,
    sourceRefId: string,
  ): Promise<InspectionOrder | null> {
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.tenant === tenant &&
        candidate.sourceType === sourceType &&
        candidate.sourceRefId === sourceRefId,
    );
    return row === undefined ? null : toOrder(row);
  }

  async list(tenant: TenantId, filter?: ListInspectionsFilter): Promise<readonly InspectionOrder[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.kind === undefined || row.kind === filter.kind) &&
          (filter?.state === undefined || row.state === filter.state),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toOrder);
  }

  async advance(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: JudgmentFields,
  ): Promise<InspectionOrder> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new InspectionConflictError(
        `质检单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra !== undefined) applyJudgment(row, extra);
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }

  async updateJudgment(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    fields: JudgmentFields,
  ): Promise<InspectionOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      if (row === undefined) return null; // 404 语义由用例层翻译
      throw new InspectionConflictError(
        `质检单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row.objectVersion}`,
      );
    }
    applyJudgment(row, fields);
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }

  async markOverdueNotified(
    tenant: TenantId,
    id: InspectionId,
    notifiedAt: string,
  ): Promise<InspectionOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    row.overdueNotifiedAt = notifiedAt;
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }

  async revertJudgment(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<InspectionOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null; // 404 语义由用例层翻译
    if (row.objectVersion !== expectedObjectVersion) {
      throw new InspectionConflictError(
        `质检单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row.objectVersion}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    row.passedQty = null;
    row.failedQty = null;
    row.judgeRemark = null;
    row.judgedBy = null;
    row.judgedAt = null;
    row.closeDueAt = null;
    row.overdueNotifiedAt = null; // 点名标记随判定清空（再判不合格重新起时限）
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }
}

// ---- 不合格处置投影 ----

interface NonconformRow {
  readonly tenant: string;
  readonly id: string;
  readonly inspectionId: string;
  flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly itemId: string | null;
  readonly quantity: number;
  reason: string | null;
  disposal: string | null;
  disposeRemark: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  closeRemark: string | null;
  closedBy: string | null;
  closedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toNonconform(row: NonconformRow): Nonconform {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    inspectionId: InspectionId.create(row.inspectionId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    reason: row.reason,
    disposal: row.disposal as NonconformDisposal | null,
    disposeRemark: row.disposeRemark,
    disposedBy: row.disposedBy === null ? null : UserId.create(row.disposedBy),
    disposedAt: row.disposedAt,
    closeRemark: row.closeRemark,
    closedBy: row.closedBy === null ? null : UserId.create(row.closedBy),
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryNonconformStore implements NonconformStore {
  private readonly rows = new Map<string, NonconformRow>(); // key: `${tenant}|${id}`

  async create(input: CreateNonconformInput): Promise<Nonconform> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new InspectionConflictError(`不合格处置 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: NonconformRow = {
      tenant: input.tenant,
      id: input.id,
      inspectionId: input.inspectionId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      itemId: input.itemId,
      quantity: input.quantity,
      reason: null,
      disposal: null,
      disposeRemark: null,
      disposedBy: null,
      disposedAt: null,
      closeRemark: null,
      closedBy: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toNonconform(row);
  }

  async find(tenant: TenantId, id: string): Promise<Nonconform | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toNonconform(row);
  }

  async list(tenant: TenantId, filter?: ListNonconformsFilter): Promise<readonly Nonconform[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.inspectionId === undefined || row.inspectionId === filter.inspectionId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toNonconform);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: NonconformAdvanceExtra,
  ): Promise<Nonconform> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new InspectionConflictError(
        `不合格处置 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.disposal !== undefined) row.disposal = extra.disposal;
    if (extra?.reason !== undefined) row.reason = extra.reason;
    if (extra?.disposeRemark !== undefined) row.disposeRemark = extra.disposeRemark;
    if (extra?.disposedBy !== undefined) row.disposedBy = extra.disposedBy;
    if (extra?.disposedAt !== undefined) row.disposedAt = extra.disposedAt;
    if (extra?.closeRemark !== undefined) row.closeRemark = extra.closeRemark;
    if (extra?.closedBy !== undefined) row.closedBy = extra.closedBy;
    if (extra?.closedAt !== undefined) row.closedAt = extra.closedAt;
    row.updatedAt = new Date().toISOString();
    return toNonconform(row);
  }
}

// ---- 命令幂等记账 ----

export class InMemoryInspectionOperationStore implements InspectionOperationStore {
  private readonly recorded = new Map<string, OperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: OperationRecord): Promise<OperationRecord | null> {
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

export class InMemoryInspectionDomainEventStore implements InspectionDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new InspectionConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
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
