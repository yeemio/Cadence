/**
 * workorder 存储端口的内存先行实现（M2-W1）。
 *
 * 重启即失；PG 实现在 business-store（`./workorder` 子路径，总控合流接线）。
 * 与 InMemoryApprovalCaseStore 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance/record
 * 带乐观版本或幂等检查（与 PG 实现同一合同）。机器事件账本不复刻——直接用
 * engine-flow 的 createInMemoryApprovalEventStore（见 workorder.module.ts）。
 */
import {
  TenantId,
  UserId,
  WorkOrderId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import { WorkOrderConflictError } from './workorder-errors.js';
import type {
  AppendAttachmentInput,
  AppendKitCheckInput,
  CreatePartsRequestInput,
  CreateWorkOrderInput,
  KitCheck,
  KitCheckStore,
  ListPartsRequestsFilter,
  ListWorkOrdersFilter,
  OperationRecord,
  PartsRequest,
  PartsRequestStore,
  UpdateWorkOrderFields,
  WorkOrder,
  WorkOrderAttachment,
  WorkOrderAttachmentStore,
  WorkOrderDomainEventStore,
  WorkOrderOperationStore,
  WorkOrderStore,
} from './workorder-stores.js';

// ---- 工作令投影 ----

interface WorkOrderRow {
  readonly tenant: string;
  readonly id: string;
  flowConfigId: string;
  state: string;
  objectVersion: number;
  customerRef: string | null;
  projectName: string;
  salesRep: string | null;
  manager: string | null;
  plannedDeliveryAt: string | null;
  packagingArrivalAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    id: WorkOrderId.create(row.id),
    tenant: TenantId.create(row.tenant),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    customerRef: row.customerRef,
    projectName: row.projectName,
    salesRep: row.salesRep === null ? null : UserId.create(row.salesRep),
    manager: row.manager === null ? null : UserId.create(row.manager),
    plannedDeliveryAt: row.plannedDeliveryAt,
    packagingArrivalAt: row.packagingArrivalAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryWorkOrderStore implements WorkOrderStore {
  private readonly rows = new Map<string, WorkOrderRow>(); // key: `${tenant}|${id}`

  async create(input: CreateWorkOrderInput): Promise<WorkOrder> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new WorkOrderConflictError(`工作令 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: WorkOrderRow = {
      tenant: input.tenant,
      id: input.id,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      customerRef: input.customerRef,
      projectName: input.projectName,
      salesRep: input.salesRep,
      manager: input.manager,
      plannedDeliveryAt: input.plannedDeliveryAt,
      packagingArrivalAt: input.packagingArrivalAt,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toWorkOrder(row);
  }

  async find(tenant: TenantId, id: WorkOrderId): Promise<WorkOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toWorkOrder(row);
  }

  async list(tenant: TenantId, filter?: ListWorkOrdersFilter): Promise<readonly WorkOrder[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && (filter?.state === undefined || row.state === filter.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toWorkOrder);
  }

  async update(
    tenant: TenantId,
    id: WorkOrderId,
    fields: UpdateWorkOrderFields,
  ): Promise<WorkOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (fields.customerRef !== undefined) row.customerRef = fields.customerRef;
    if (fields.projectName !== undefined) row.projectName = fields.projectName;
    if (fields.salesRep !== undefined) row.salesRep = fields.salesRep;
    if (fields.manager !== undefined) row.manager = fields.manager;
    if (fields.plannedDeliveryAt !== undefined) row.plannedDeliveryAt = fields.plannedDeliveryAt;
    if (fields.packagingArrivalAt !== undefined) row.packagingArrivalAt = fields.packagingArrivalAt;
    row.updatedAt = new Date().toISOString();
    return toWorkOrder(row);
  }

  async advance(
    tenant: TenantId,
    id: WorkOrderId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<WorkOrder> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new WorkOrderConflictError(
        `工作令 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    row.updatedAt = new Date().toISOString();
    return toWorkOrder(row);
  }
}

// ---- 附件（append-only 事实） ----

/** 附件事实 audit_status 合法值（模块 schema v1）：recorded=已入账。 */
export const ATTACHMENT_AUDIT_STATUS = 'recorded';

function toAttachment(row: WorkOrderAttachment): WorkOrderAttachment {
  return row; // 行即领域形状（构造时已冻结语义由调用方保证）
}

export class InMemoryWorkOrderAttachmentStore implements WorkOrderAttachmentStore {
  private readonly rows: WorkOrderAttachment[] = [];

  async append(input: AppendAttachmentInput): Promise<WorkOrderAttachment> {
    const attachment: WorkOrderAttachment = {
      id: input.id,
      tenant: input.tenant,
      workOrderId: input.workOrderId,
      name: input.name,
      kind: input.kind,
      ref: input.ref,
      attachedBy: input.attachedBy,
      attachedAt: new Date().toISOString(),
      objectVersion: 1,
      auditStatus: ATTACHMENT_AUDIT_STATUS,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    };
    this.rows.push(attachment);
    return toAttachment(attachment);
  }

  async listByWorkOrder(
    tenant: TenantId,
    workOrderId: WorkOrderId,
  ): Promise<readonly WorkOrderAttachment[]> {
    return this.rows
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort((a, b) => a.attachedAt.localeCompare(b.attachedAt)); // 挂接时间升序
  }

  async find(tenant: TenantId, id: string): Promise<WorkOrderAttachment | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }
}

// ---- 配件申请投影 ----

interface PartsRow {
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string;
  flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: string;
  readonly remark: string | null;
  shipmentRef: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toPartsRequest(row: PartsRow): PartsRequest {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: WorkOrderId.create(row.workOrderId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    requester: UserId.create(row.requester),
    remark: row.remark,
    shipmentRef: row.shipmentRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryPartsRequestStore implements PartsRequestStore {
  private readonly rows = new Map<string, PartsRow>(); // key: `${tenant}|${id}`

  async create(input: CreatePartsRequestInput): Promise<PartsRequest> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new WorkOrderConflictError(`配件申请 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: PartsRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      itemId: input.itemId,
      quantity: input.quantity,
      requester: input.requester,
      remark: input.remark,
      shipmentRef: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toPartsRequest(row);
  }

  async find(tenant: TenantId, id: string): Promise<PartsRequest | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toPartsRequest(row);
  }

  async list(tenant: TenantId, filter?: ListPartsRequestsFilter): Promise<readonly PartsRequest[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPartsRequest);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly shipmentRef?: string | null },
  ): Promise<PartsRequest> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new WorkOrderConflictError(
        `配件申请 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.shipmentRef !== undefined) row.shipmentRef = extra.shipmentRef;
    row.updatedAt = new Date().toISOString();
    return toPartsRequest(row);
  }
}

// ---- 齐套快照（append-only 事实） ----

/** 齐套快照 audit_status 合法值（模块 schema v1）：recorded=已入账。 */
export const KIT_CHECK_AUDIT_STATUS = 'recorded';

export class InMemoryKitCheckStore implements KitCheckStore {
  private readonly rows: KitCheck[] = []; // append-only：插入序即刷新序

  async append(input: AppendKitCheckInput): Promise<KitCheck> {
    const snapshot: KitCheck = {
      id: input.id,
      tenant: input.tenant,
      workOrderId: input.workOrderId,
      kinds: input.kinds,
      gapLines: input.gapLines,
      complete: input.complete,
      refreshedBy: input.refreshedBy,
      refreshedAt: new Date().toISOString(),
      objectVersion: 1,
      auditStatus: KIT_CHECK_AUDIT_STATUS,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    };
    this.rows.push(snapshot);
    return snapshot;
  }

  // "最新"口径 = 最近 append 的快照（append-only 存储，插入序即时间序；
  // 同毫秒并列由插入序决胜——毫秒时钟与 uuidv7 随机位都不构成可靠并列序）。
  // PG 适配按 (refreshed_at DESC, seq DESC) 同口径（kit_checks.seq 游标列）。

  async latestByWorkOrder(tenant: TenantId, workOrderId: WorkOrderId): Promise<KitCheck | null> {
    let latest: KitCheck | null = null;
    for (const row of this.rows) {
      if (row.tenant === tenant && row.workOrderId === workOrderId) latest = row;
    }
    return latest;
  }

  async latestPerTenant(tenant: TenantId): Promise<readonly KitCheck[]> {
    const latestByWorkOrder = new Map<string, KitCheck>();
    for (const row of this.rows) {
      if (row.tenant === tenant) latestByWorkOrder.set(row.workOrderId, row); // 后写覆盖 = 最新
    }
    return [...latestByWorkOrder.values()].sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
  }
}

// ---- 命令幂等记账 ----

export class InMemoryWorkOrderOperationStore implements WorkOrderOperationStore {
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

export class InMemoryWorkOrderDomainEventStore implements WorkOrderDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new WorkOrderConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
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
