/**
 * dispatch 存储端口的内存先行实现（M2-W6）。
 *
 * 重启即失；PG 实现在 business-store（`./dispatch` 子路径，总控合流接线）。
 * 与 in-memory-listing-stores 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance/
 * backfillPrice/record 带乐观版本或幂等检查（与 PG 实现同一合同）。机器事件
 * 账本不复刻——直接用 engine-flow 的 createInMemoryApprovalEventStore（见
 * dispatch.module.ts）。
 */
import {
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import { DispatchConflictError } from './dispatch-errors.js';
import type {
  AppendOutsourcingLineInput,
  BackfillOutsourcingPriceFields,
  CreateDispatchOrderInput,
  DispatchDomainEventStore,
  DispatchOperationRecord,
  DispatchOperationStore,
  DispatchOrder,
  DispatchOrderStore,
  ListDispatchOrdersFilter,
  OutsourcingLine,
  OutsourcingLineStore,
} from './dispatch-stores.js';

// ---- 派工单（投影，乐观 advance） ----

interface OrderRow {
  readonly equipmentRefs?: readonly string[];
  readonly rollup?: boolean;
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly kind: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly title: string;
  readonly drawingNo: string | null;
  operationCode: string | null;
  readonly material: string | null;
  readonly sizeSpec: string | null;
  readonly quantity: number;
  doneQty: number;
  assignee: UserId | null;
  readonly dueAt: string | null;
  readonly remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toOrder(row: OrderRow): DispatchOrder {
  return {
    ...(row.equipmentRefs === undefined ? {} : { equipmentRefs: [...row.equipmentRefs] }),
    ...(row.rollup === undefined ? {} : { rollup: row.rollup }),
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: row.workOrderId,
    kind: row.kind as DispatchOrder['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    title: row.title,
    drawingNo: row.drawingNo,
    operationCode: row.operationCode,
    material: row.material,
    sizeSpec: row.sizeSpec,
    quantity: row.quantity,
    doneQty: row.doneQty,
    assignee: row.assignee,
    dueAt: row.dueAt,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryDispatchOrderStore implements DispatchOrderStore {
  private readonly rows = new Map<string, OrderRow>(); // key: `${tenant}|${id}`

  async create(input: CreateDispatchOrderInput): Promise<DispatchOrder> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new DispatchConflictError(`派工单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: OrderRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      kind: input.kind,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      title: input.title,
      ...(input.equipmentRefs === undefined ? {} : { equipmentRefs: [...input.equipmentRefs] }),
      ...(input.rollup === undefined ? {} : { rollup: input.rollup }),
      drawingNo: input.drawingNo,
      operationCode: input.operationCode,
      material: input.material,
      sizeSpec: input.sizeSpec,
      quantity: input.quantity,
      doneQty: 0,
      assignee: input.assignee,
      dueAt: input.dueAt,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toOrder(row);
  }

  async find(tenant: TenantId, id: string): Promise<DispatchOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toOrder(row);
  }

  async list(tenant: TenantId, filter?: ListDispatchOrdersFilter): Promise<readonly DispatchOrder[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.kind === undefined || row.kind === filter.kind) &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId) &&
          (filter?.assignee === undefined || row.assignee === filter.assignee),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toOrder);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly doneQty?: number; readonly assignee?: UserId | null },
  ): Promise<DispatchOrder> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new DispatchConflictError(
        `派工单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.doneQty !== undefined) row.doneQty = extra.doneQty;
    if (extra?.assignee !== undefined) row.assignee = extra.assignee;
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }

  /** 转单字段重写（fix-wave-6 6a-1）：不推进版本/状态；乐观条件未命中返回 null。 */
  async transfer(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: { readonly assignee?: UserId | null; readonly operationCode?: string | null },
  ): Promise<DispatchOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    if (fields.assignee !== undefined) row.assignee = fields.assignee;
    if (fields.operationCode !== undefined) row.operationCode = fields.operationCode;
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }
}

// ---- 外协明细（投影，版本化数据——单价补录乐观更新） ----

interface LineRow {
  readonly tenant: string;
  readonly id: string;
  readonly dispatchId: string;
  lineNo: number;
  readonly processCode: string;
  readonly drawingNo: string | null;
  readonly supplierRef: string;
  readonly supplierName: string | null;
  readonly quantity: number;
  unitPriceMinor: number | null;
  priceSource: OutsourcingLine['priceSource'];
  marginPermyriad: number | null;
  promisedAt: string | null;
  readonly sourceListingLineId: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  objectVersion: number;
  readonly createdAt: string;
  updatedAt: string;
}

function toLine(row: LineRow): OutsourcingLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    dispatchId: row.dispatchId,
    lineNo: row.lineNo,
    processCode: row.processCode,
    drawingNo: row.drawingNo,
    supplierRef: row.supplierRef,
    supplierName: row.supplierName,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    priceSource: row.priceSource,
    marginPermyriad: row.marginPermyriad,
    promisedAt: row.promisedAt,
    sourceListingLineId: row.sourceListingLineId,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    objectVersion: row.objectVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryOutsourcingLineStore implements OutsourcingLineStore {
  private readonly rows = new Map<string, LineRow>(); // key: `${tenant}|${id}`

  async appendLines(inputs: readonly AppendOutsourcingLineInput[]): Promise<readonly OutsourcingLine[]> {
    const appended: OutsourcingLine[] = [];
    for (const input of inputs) {
      const key = `${input.tenant}|${input.id}`;
      if (this.rows.has(key)) {
        throw new DispatchConflictError(`外协明细 '${input.id}' 已存在`);
      }
      const duplicateLineNo = [...this.rows.values()].some(
        (row) =>
          row.tenant === input.tenant && row.dispatchId === input.dispatchId && row.lineNo === input.lineNo,
      );
      if (duplicateLineNo) {
        throw new DispatchConflictError(
          `派工单 '${input.dispatchId}' 外协行号 ${input.lineNo} 已存在（同单行号唯一）`,
        );
      }
      const now = new Date().toISOString();
      const row: LineRow = {
        tenant: input.tenant,
        id: input.id,
        dispatchId: input.dispatchId,
        lineNo: input.lineNo,
        processCode: input.processCode,
        drawingNo: input.drawingNo,
        supplierRef: input.supplierRef,
        supplierName: input.supplierName,
        quantity: input.quantity,
        unitPriceMinor: input.unitPriceMinor,
        priceSource: input.priceSource,
        marginPermyriad: input.marginPermyriad,
        promisedAt: input.promisedAt,
        sourceListingLineId: input.sourceListingLineId,
        cancelReason: null,
        cancelledAt: null,
        objectVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(key, row);
      appended.push(toLine(row));
    }
    return appended;
  }

  async find(tenant: TenantId, id: string): Promise<OutsourcingLine | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toLine(row);
  }

  async listByDispatch(tenant: TenantId, dispatchId: string): Promise<readonly OutsourcingLine[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.dispatchId === dispatchId)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(toLine);
  }

  async listBySupplier(tenant: TenantId, supplierRef: string): Promise<readonly OutsourcingLine[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.supplierRef === supplierRef)
      .sort((a, b) => a.dispatchId.localeCompare(b.dispatchId) || a.lineNo - b.lineNo)
      .map(toLine);
  }

  async backfillPrice(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: BackfillOutsourcingPriceFields,
  ): Promise<OutsourcingLine | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    row.unitPriceMinor = fields.unitPriceMinor;
    row.priceSource = fields.priceSource;
    row.marginPermyriad = fields.marginPermyriad;
    if (fields.promisedAt !== undefined) row.promisedAt = fields.promisedAt;
    row.objectVersion += 1;
    row.updatedAt = new Date().toISOString();
    return toLine(row);
  }

  /** 取消外协明细行（fix-wave-6 6a-1）：落取消事实 + 时刻并 +1 版本；乐观未命中 null。 */
  async cancel(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: { readonly cancelReason: string | null; readonly cancelledAt: string },
  ): Promise<OutsourcingLine | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    row.cancelReason = fields.cancelReason;
    row.cancelledAt = fields.cancelledAt;
    row.objectVersion += 1;
    row.updatedAt = new Date().toISOString();
    return toLine(row);
  }
}

// ---- 命令幂等记账 ----

export class InMemoryDispatchOperationStore implements DispatchOperationStore {
  private readonly recorded = new Map<string, DispatchOperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: DispatchOperationRecord): Promise<DispatchOperationRecord | null> {
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

export class InMemoryDispatchDomainEventStore implements DispatchDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new DispatchConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
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
