/**
 * listing 存储端口的内存先行实现（M2-W3）。
 *
 * 重启即失；PG 实现在 business-store（`./listing` 子路径，总控合流接线）。
 * 与 in-memory-workorder-stores 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；advance/update/
 * record 带乐观版本或幂等检查（与 PG 实现同一合同）。机器事件账本不复刻——
 * 直接用 engine-flow 的 createInMemoryApprovalEventStore（见 listing.module.ts）。
 */
import {
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import { LISTING_KINDS } from './listing-config.js';
import { ListingConflictError } from './listing-errors.js';
import type {
  AppendGapCheckInput,
  AppendListingLineInput,
  CreateListingSheetInput,
  CreatePurchaseOrderInput,
  CreatePurchaseRequestInput,
  CreatePurchaseReturnInput,
  GapCheck,
  GapCheckStore,
  ListingDomainEventStore,
  ListingLine,
  ListingLineStore,
  ListingOperationRecord,
  ListingOperationStore,
  ListingSheet,
  ListingSheetStore,
  ListPurchaseOrdersFilter,
  ListPurchaseRequestsFilter,
  PurchaseOrder,
  PurchaseOrderStore,
  PurchaseRequest,
  PurchaseRequestStore,
  PurchaseReturn,
  PurchaseReturnStore,
  UpdateListingLineFields,
} from './listing-stores.js';

// ---- 清单单据头（投影） ----

interface SheetRow {
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toSheet(row: SheetRow): ListingSheet {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: row.workOrderId,
    kind: row.kind as ListingSheet['kind'],
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryListingSheetStore implements ListingSheetStore {
  private readonly rows = new Map<string, SheetRow>(); // key: `${tenant}|${id}`

  async create(input: CreateListingSheetInput): Promise<ListingSheet> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new ListingConflictError(`清单 '${input.id}' 已存在`);
    }
    const duplicate = [...this.rows.values()].some(
      (row) => row.tenant === input.tenant && row.workOrderId === input.workOrderId && row.kind === input.kind,
    );
    if (duplicate) {
      throw new ListingConflictError(
        `工作令 '${input.workOrderId}' 的 ${input.kind} 清单已存在（(tenant, workOrderId, kind) 唯一）`,
      );
    }
    const now = new Date().toISOString();
    const row: SheetRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      kind: input.kind,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toSheet(row);
  }

  async find(tenant: TenantId, id: string): Promise<ListingSheet | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toSheet(row);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingSheet[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort((a, b) => {
        const indexA = (LISTING_KINDS as readonly string[]).indexOf(a.kind);
        const indexB = (LISTING_KINDS as readonly string[]).indexOf(b.kind);
        return indexA - indexB; // kind 声明序（未知名排尾）
      })
      .map(toSheet);
  }
}

// ---- 清单行（投影，乐观更新） ----

interface LineRow {
  readonly tenant: string;
  readonly id: string;
  readonly sheetId: string;
  readonly workOrderId: string;
  readonly kind: string;
  lineNo: number;
  drawingNo: string | null;
  code: string | null;
  name: string | null;
  spec: string | null;
  itemId: string | null;
  requiredQty: number;
  neededBy: string | null;
  validationStatus: ListingLine['validationStatus'];
  candidateItemId: string | null;
  candidateItemCode: string | null;
  similarity: number;
  basis: ListingLine['basis'];
  readonly source: ListingLine['source'];
  objectVersion: number;
  readonly createdAt: string;
  updatedAt: string;
}

function toLine(row: LineRow): ListingLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    sheetId: row.sheetId,
    workOrderId: row.workOrderId,
    kind: row.kind as ListingLine['kind'],
    lineNo: row.lineNo,
    drawingNo: row.drawingNo,
    code: row.code,
    name: row.name,
    spec: row.spec,
    itemId: row.itemId,
    requiredQty: row.requiredQty,
    neededBy: row.neededBy,
    validationStatus: row.validationStatus,
    candidateItemId: row.candidateItemId,
    candidateItemCode: row.candidateItemCode,
    similarity: row.similarity,
    basis: row.basis,
    source: row.source,
    objectVersion: row.objectVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryListingLineStore implements ListingLineStore {
  private readonly rows = new Map<string, LineRow>(); // key: `${tenant}|${id}`

  async appendLines(inputs: readonly AppendListingLineInput[]): Promise<readonly ListingLine[]> {
    const appended: ListingLine[] = [];
    for (const input of inputs) {
      const key = `${input.tenant}|${input.id}`;
      if (this.rows.has(key)) {
        throw new ListingConflictError(`清单行 '${input.id}' 已存在`);
      }
      const duplicateLineNo = [...this.rows.values()].some(
        (row) =>
          row.tenant === input.tenant && row.sheetId === input.sheetId && row.lineNo === input.lineNo,
      );
      if (duplicateLineNo) {
        throw new ListingConflictError(
          `清单 '${input.sheetId}' 行号 ${input.lineNo} 已存在（同清单行号唯一）`,
        );
      }
      const now = new Date().toISOString();
      const row: LineRow = {
        tenant: input.tenant,
        id: input.id,
        sheetId: input.sheetId,
        workOrderId: input.workOrderId,
        kind: input.kind,
        lineNo: input.lineNo,
        drawingNo: input.drawingNo,
        code: input.code,
        name: input.name,
        spec: input.spec,
        itemId: input.itemId,
        requiredQty: input.requiredQty,
        neededBy: input.neededBy,
        validationStatus: input.validationStatus,
        candidateItemId: input.candidateItemId,
        candidateItemCode: input.candidateItemCode,
        similarity: input.similarity,
        basis: input.basis,
        source: input.source,
        objectVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(key, row);
      appended.push(toLine(row));
    }
    return appended;
  }

  async nextLineNo(tenant: TenantId, sheetId: string): Promise<number> {
    const used = [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.sheetId === sheetId)
      .map((row) => row.lineNo);
    return used.length === 0 ? 1 : Math.max(...used) + 1;
  }

  async find(tenant: TenantId, id: string): Promise<ListingLine | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toLine(row);
  }

  async listBySheet(tenant: TenantId, sheetId: string): Promise<readonly ListingLine[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.sheetId === sheetId)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(toLine);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingLine[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.workOrderId === workOrderId)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.lineNo - b.lineNo)
      .map(toLine);
  }

  /** A9 下图统计：part 行按 createdAt 日部闭区间计数（投影行即有效行——本模块无行级逻辑删除面）。 */
  async countPartLinesCreatedBetween(
    tenant: TenantId,
    range?: { readonly fromDay?: string; readonly toDay?: string },
  ): Promise<number> {
    const from = range?.fromDay;
    const to = range?.toDay;
    return [...this.rows.values()].filter((row) => {
      if (row.tenant !== tenant || row.kind !== 'part') return false;
      const day = row.createdAt.slice(0, 10);
      if (day.length !== 10) return false; // create_time 为空/形状异常不计入（口径同开发文档）
      if (from !== undefined && day < from) return false;
      if (to !== undefined && day > to) return false;
      return true;
    }).length;
  }

  async update(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: UpdateListingLineFields,
  ): Promise<ListingLine | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    if (fields.drawingNo !== undefined) row.drawingNo = fields.drawingNo;
    if (fields.code !== undefined) row.code = fields.code;
    if (fields.name !== undefined) row.name = fields.name;
    if (fields.spec !== undefined) row.spec = fields.spec;
    if (fields.itemId !== undefined) row.itemId = fields.itemId;
    if (fields.requiredQty !== undefined) row.requiredQty = fields.requiredQty;
    if (fields.neededBy !== undefined) row.neededBy = fields.neededBy;
    if (fields.validationStatus !== undefined) row.validationStatus = fields.validationStatus;
    if (fields.candidateItemId !== undefined) row.candidateItemId = fields.candidateItemId;
    if (fields.candidateItemCode !== undefined) row.candidateItemCode = fields.candidateItemCode;
    if (fields.similarity !== undefined) row.similarity = fields.similarity;
    if (fields.basis !== undefined) row.basis = fields.basis;
    row.objectVersion += 1;
    row.updatedAt = new Date().toISOString();
    return toLine(row);
  }
}

// ---- 缺口核查快照（append-only 事实） ----

/** 缺口快照 audit_status 合法值（模块 schema v1）：recorded=已入账。 */
export const GAP_CHECK_AUDIT_STATUS = 'recorded';

export class InMemoryGapCheckStore implements GapCheckStore {
  private readonly rows: GapCheck[] = []; // append-only：插入序即核查序

  async append(input: AppendGapCheckInput): Promise<GapCheck> {
    const snapshot: GapCheck = {
      id: input.id,
      tenant: input.tenant,
      workOrderId: input.workOrderId,
      kinds: input.kinds,
      gapLines: input.gapLines,
      complete: input.complete,
      checkedBy: input.checkedBy,
      checkedAt: new Date().toISOString(),
      objectVersion: 1,
      auditStatus: GAP_CHECK_AUDIT_STATUS,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    };
    this.rows.push(snapshot);
    return snapshot;
  }

  // "最新"口径 = 最近 append 的快照（插入序即时间序；同毫秒并列由插入序决胜）。
  // PG 适配按 (checked_at DESC, seq DESC) 同口径（gap_checks.seq 游标列）。

  async find(tenant: TenantId, id: string): Promise<GapCheck | null> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id) ?? null;
  }

  async latestByWorkOrder(tenant: TenantId, workOrderId: string): Promise<GapCheck | null> {
    let latest: GapCheck | null = null;
    for (const row of this.rows) {
      if (row.tenant === tenant && row.workOrderId === workOrderId) latest = row;
    }
    return latest;
  }
}

// ---- 采购申请（投影，乐观 advance） ----

interface RequestRow {
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly kind: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: string;
  readonly remark: string | null;
  readonly source: PurchaseRequest['source'];
  purchaseOrderId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toRequest(row: RequestRow): PurchaseRequest {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: row.workOrderId,
    kind: row.kind as PurchaseRequest['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    requester: UserId.create(row.requester),
    remark: row.remark,
    source: row.source,
    purchaseOrderId: row.purchaseOrderId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryPurchaseRequestStore implements PurchaseRequestStore {
  private readonly rows = new Map<string, RequestRow>(); // key: `${tenant}|${id}`

  async create(input: CreatePurchaseRequestInput): Promise<PurchaseRequest> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new ListingConflictError(`采购申请 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: RequestRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      kind: input.kind,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      itemId: input.itemId,
      quantity: input.quantity,
      requester: input.requester,
      remark: input.remark,
      source: input.source,
      purchaseOrderId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toRequest(row);
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseRequest | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toRequest(row);
  }

  async list(tenant: TenantId, filter?: ListPurchaseRequestsFilter): Promise<readonly PurchaseRequest[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId) &&
          (filter?.purchaseOrderId === undefined || row.purchaseOrderId === filter.purchaseOrderId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toRequest);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly purchaseOrderId?: string | null },
  ): Promise<PurchaseRequest> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new ListingConflictError(
        `采购申请 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.purchaseOrderId !== undefined) row.purchaseOrderId = extra.purchaseOrderId;
    row.updatedAt = new Date().toISOString();
    return toRequest(row);
  }

  async linkOrder(tenant: TenantId, requestIds: readonly string[], purchaseOrderId: string): Promise<void> {
    for (const requestId of requestIds) {
      const row = this.rows.get(`${tenant}|${requestId}`);
      if (row === undefined) continue;
      row.purchaseOrderId = purchaseOrderId;
      row.updatedAt = new Date().toISOString();
    }
  }
}

// ---- 采购订单（投影，乐观 advance，lines/receiptRef 可回填） ----

interface OrderRow {
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  lines: PurchaseOrder['lines'];
  readonly requestIds: readonly string[];
  readonly buyer: string | null;
  readonly remark: string | null;
  receiptRef: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toOrder(row: OrderRow): PurchaseOrder {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: row.workOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    supplierRef: row.supplierRef,
    supplierName: row.supplierName,
    promisedAt: row.promisedAt,
    lines: row.lines,
    requestIds: row.requestIds,
    buyer: row.buyer === null ? null : UserId.create(row.buyer),
    remark: row.remark,
    receiptRef: row.receiptRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryPurchaseOrderStore implements PurchaseOrderStore {
  private readonly rows = new Map<string, OrderRow>(); // key: `${tenant}|${id}`

  async create(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new ListingConflictError(`采购订单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: OrderRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      supplierRef: input.supplierRef,
      supplierName: input.supplierName,
      promisedAt: input.promisedAt,
      lines: input.lines,
      requestIds: input.requestIds,
      buyer: input.buyer,
      remark: input.remark,
      receiptRef: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toOrder(row);
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toOrder(row);
  }

  async list(tenant: TenantId, filter?: ListPurchaseOrdersFilter): Promise<readonly PurchaseOrder[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toOrder);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly lines?: PurchaseOrder['lines'];
      readonly receiptRef?: string | null;
    },
  ): Promise<PurchaseOrder> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new ListingConflictError(
        `采购订单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.lines !== undefined) row.lines = extra.lines;
    if (extra?.receiptRef !== undefined) row.receiptRef = extra.receiptRef;
    row.updatedAt = new Date().toISOString();
    return toOrder(row);
  }
}

// ---- 退货单（投影，乐观 advance） ----

interface ReturnRow {
  readonly tenant: string;
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  readonly lines: PurchaseReturn['lines'];
  readonly returnedBy: string;
  readonly remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toReturn(row: ReturnRow): PurchaseReturn {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    purchaseOrderId: row.purchaseOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines,
    returnedBy: UserId.create(row.returnedBy),
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryPurchaseReturnStore implements PurchaseReturnStore {
  private readonly rows = new Map<string, ReturnRow>(); // key: `${tenant}|${id}`

  async create(input: CreatePurchaseReturnInput): Promise<PurchaseReturn> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new ListingConflictError(`退货单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: ReturnRow = {
      tenant: input.tenant,
      id: input.id,
      purchaseOrderId: input.purchaseOrderId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      lines: input.lines,
      returnedBy: input.returnedBy,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toReturn(row);
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseReturn | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toReturn(row);
  }

  async listByOrder(tenant: TenantId, purchaseOrderId: string): Promise<readonly PurchaseReturn[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.purchaseOrderId === purchaseOrderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toReturn);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<PurchaseReturn> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new ListingConflictError(
        `退货单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    row.updatedAt = new Date().toISOString();
    return toReturn(row);
  }
}

// ---- 命令幂等记账 ----

export class InMemoryListingOperationStore implements ListingOperationStore {
  private readonly recorded = new Map<string, ListingOperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: ListingOperationRecord): Promise<ListingOperationRecord | null> {
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

export class InMemoryListingDomainEventStore implements ListingDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new ListingConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
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
