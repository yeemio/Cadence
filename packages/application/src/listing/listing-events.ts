/**
 * listing 域事件（M2-W3，03-listing.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据七公共列在持久化层补齐）。命名空间：smes.listing.v1.<过去式动作>；
 * 事件清单（合同词汇 10 个 + 对称补全 1 个）：
 *   ListingImported / ListingLineValidated / GapChecked / PurchaseRequested /
 *   PurchaseOrderSubmitted|Approved|Issued|Received（→库存入库指令）/
 *   PurchaseReturned / PurchaseOverdue（→待办催货）。
 * ListingLineUpdated 为对称补全（合同命令面含 listing.line.update，行级修订
 * 必须可回溯——取舍同 workorder 的 PartsRejected 补全；模块 schema 版本化，
 * v1 内登记）。
 *
 * 与 engine-flow 机器事件账本的分工：机器事件（ApprovalEvent 形状）是申请/
 * 订单/退货三状态机的**重放事实源**（乐观锁与对账口径）；本文件域事件是对外
 * **发布事实**（Outbox / inspection / inventory / workorder / 报表消费）。两层
 * 各自 append-only，同一命令产出时先账本后发布。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type {
  ListingKind,
  PurchaseRequestKind,
} from './listing-config.js';
import type {
  GapKindSummary,
  GapLine,
  ListingRowIssue,
  PurchaseOrderLine,
  PurchaseRequest,
  PurchaseReturnLine,
} from './listing-stores.js';

// ---- 聚合类型 ----

export const LISTING_SHEET_AGGREGATE_TYPE = 'listing-sheet';
export const LISTING_LINE_AGGREGATE_TYPE = 'listing-line';
export const GAP_CHECK_AGGREGATE_TYPE = 'gap-check';
export const PURCHASE_REQUEST_AGGREGATE_TYPE = 'purchase-request';
export const PURCHASE_ORDER_AGGREGATE_TYPE = 'purchase-order';
export const PURCHASE_RETURN_AGGREGATE_TYPE = 'purchase-return';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns provenance 口径）。 */
export interface ListingEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

function provenanceOf(operationId: string, command: string, actor: string): ListingEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名 ----

export const LISTING_EVENT_TYPES = {
  listingImported: 'smes.listing.v1.listing-imported',
  listingLineValidated: 'smes.listing.v1.listing-line-validated',
  listingLineUpdated: 'smes.listing.v1.listing-line-updated',
  gapChecked: 'smes.listing.v1.gap-checked',
  purchaseRequested: 'smes.listing.v1.purchase-requested',
  purchaseOrderSubmitted: 'smes.listing.v1.purchase-order-submitted',
  purchaseOrderApproved: 'smes.listing.v1.purchase-order-approved',
  purchaseOrderIssued: 'smes.listing.v1.purchase-order-issued',
  purchaseOrderReceived: 'smes.listing.v1.purchase-order-received',
  purchaseReturned: 'smes.listing.v1.purchase-returned',
  purchaseOverdue: 'smes.listing.v1.purchase-overdue',
} as const;

// ---- 载荷形状 ----

export interface ListingImportedPayload {
  readonly workOrderId: string;
  readonly kind: ListingKind;
  readonly sheetId: string;
  /** workorder=骨架生成（sourceEventId=消费的 WorkOrderCreated 事件）；excel=行导入。 */
  readonly source: 'workorder' | 'excel';
  readonly sourceEventId: string | null;
  /** 导入前行数（骨架=0）。 */
  readonly previousLineCount: number;
  readonly importedLineCount: number;
  /** 错误行提示（excel 源被跳过的行；骨架为空）。 */
  readonly rowIssues: readonly ListingRowIssue[];
  readonly actor: string;
}

export interface ListingLineValidatedLinePayload {
  readonly lineId: string;
  readonly lineNo: number;
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
  readonly judgment: 'matched' | 'suspected' | 'unmatched';
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  readonly similarity: number;
  readonly basis: string;
}

export interface ListingLineValidatedPayload {
  readonly workOrderId: string;
  readonly kind: ListingKind;
  readonly sheetId: string;
  readonly summary: { readonly total: number; readonly matched: number; readonly suspected: number; readonly unmatched: number };
  readonly lines: readonly ListingLineValidatedLinePayload[];
  readonly actor: string;
}

export interface ListingLineUpdatedPayload {
  /** 本次变更的字段名清单（新值 Map；旧值不进事件——账本可回放）。 */
  readonly changes: Readonly<Record<string, unknown>>;
  /** 校验状态是否被重置（物料三要素变更 → pending）。 */
  readonly validationReset: boolean;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface GapCheckedPayload {
  readonly workOrderId: string;
  readonly kinds: readonly GapKindSummary[];
  readonly gapLines: readonly GapLine[];
  readonly complete: boolean;
  readonly actor: string;
}

export interface PurchaseRequestedPayload {
  readonly workOrderId: string | null;
  readonly kind: PurchaseRequestKind;
  readonly itemId: string;
  readonly quantity: number;
  readonly source: PurchaseRequest['source'];
  readonly remark: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseOrderSubmittedPayload {
  readonly workOrderId: string | null;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  readonly lines: readonly PurchaseOrderLine[];
  readonly requestIds: readonly string[];
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseOrderApprovedPayload {
  readonly remark: string;
  /** 随订单批准推进的申请 id 集（draft→approved）。 */
  readonly requestsApproved: readonly string[];
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseOrderIssuedPayload {
  readonly remark: string | null;
  /** 随订单下发转单完成的申请 id 集（approved→converted）。 */
  readonly requestsConverted: readonly string[];
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseOrderReceivedPayload {
  readonly lines: readonly { readonly lineNo: number; readonly itemId: string; readonly receivedQty: number }[];
  readonly receiptRef: string | null;
  /** 入库指令端口回执（received=false 不可能出现——拒绝时命令不落账）。 */
  readonly receipts: readonly { readonly receiptKey: string; readonly received: boolean }[];
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseReturnedPayload {
  readonly purchaseOrderId: string;
  readonly lines: readonly PurchaseReturnLine[];
  /** 订单回退落点（received→issued）；初版口径：全额/部分退货均回退可重收。 */
  readonly orderRolledBackTo: string;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PurchaseOverduePayload {
  readonly workOrderId: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  /** 已逾期天数（正数 = 逾期 N 天）。 */
  readonly daysOverdue: number;
  readonly state: string;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: ListingEventProvenance;
}

export function makeListingImportedEvent(
  base: DomainEventInput,
  payload: ListingImportedPayload,
): BusinessEvent<ListingImportedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.listingImported,
    tenantId: base.tenant,
    aggregate: { id: payload.sheetId, type: LISTING_SHEET_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeListingLineValidatedEvent(
  base: DomainEventInput,
  payload: ListingLineValidatedPayload,
): BusinessEvent<ListingLineValidatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.listingLineValidated,
    tenantId: base.tenant,
    aggregate: { id: payload.sheetId, type: LISTING_SHEET_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeListingLineUpdatedEvent(
  base: DomainEventInput,
  payload: ListingLineUpdatedPayload,
  lineId: string,
): BusinessEvent<ListingLineUpdatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.listingLineUpdated,
    tenantId: base.tenant,
    aggregate: { id: lineId, type: LISTING_LINE_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeGapCheckedEvent(
  base: DomainEventInput,
  payload: GapCheckedPayload,
  gapCheckId: string,
): BusinessEvent<GapCheckedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.gapChecked,
    tenantId: base.tenant,
    aggregate: { id: gapCheckId, type: GAP_CHECK_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePurchaseRequestedEvent(
  base: DomainEventInput,
  payload: PurchaseRequestedPayload,
  requestId: string,
): BusinessEvent<PurchaseRequestedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.purchaseRequested,
    tenantId: base.tenant,
    aggregate: { id: requestId, type: PURCHASE_REQUEST_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePurchaseOrderTransitionedEvent(
  base: DomainEventInput,
  payload:
    | PurchaseOrderSubmittedPayload
    | PurchaseOrderApprovedPayload
    | PurchaseOrderIssuedPayload
    | PurchaseOrderReceivedPayload,
  orderId: string,
): BusinessEvent<typeof payload> {
  const eventType =
    'supplierRef' in payload
      ? LISTING_EVENT_TYPES.purchaseOrderSubmitted
      : 'receipts' in payload
        ? LISTING_EVENT_TYPES.purchaseOrderReceived
        : 'requestsApproved' in payload
          ? LISTING_EVENT_TYPES.purchaseOrderApproved
          : LISTING_EVENT_TYPES.purchaseOrderIssued;
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType,
    tenantId: base.tenant,
    aggregate: { id: orderId, type: PURCHASE_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePurchaseReturnedEvent(
  base: DomainEventInput,
  payload: PurchaseReturnedPayload,
  returnId: string,
): BusinessEvent<PurchaseReturnedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.purchaseReturned,
    tenantId: base.tenant,
    aggregate: { id: returnId, type: PURCHASE_RETURN_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePurchaseOverdueEvent(
  base: DomainEventInput,
  payload: PurchaseOverduePayload,
  orderId: string,
): BusinessEvent<PurchaseOverduePayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: LISTING_EVENT_TYPES.purchaseOverdue,
    tenantId: base.tenant,
    aggregate: { id: orderId, type: PURCHASE_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

/** 订单详情视图的里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface ListingMachineMilestone {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly objectVersion: number;
}

export { provenanceOf };
