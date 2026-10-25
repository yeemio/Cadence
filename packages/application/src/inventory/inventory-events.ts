/**
 * inventory 域事件（M2-W5，07-inventory.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据七公共列在持久化层补齐）。命名空间：smes.inventory.v1.<过去式动作>；
 * 事件清单（合同最小集 5 个）：
 *   StockReceived / StockIssued（→齐套与缺口重算信号——workorder 齐套与
 *     listing 缺口核查经可用量端口消费重算）
 *   StockTransferred（调拨/移库台账事实）
 *   StocktakeAdjusted（盘点调账审计留痕）
 *   ShippingConfirmed（→workorder 待发货→已发货联动锚点）
 * 入库/出库/调拨按命令逐条发事件（StockReceived 载荷携三类来源 kind 区分；
 * 调拨发一条 StockTransferred 承载双仓换位而非两条 Received/Issued——合同
 * 词汇面最小化，调拨双流水由 movement 账本承载）。
 *
 * 与 engine-flow 机器事件账本的分工：机器事件（ApprovalEvent 形状）是盘点/
 * 发货两台状态机的**重放事实源**（乐观锁与对账口径）；本文件域事件是对外
 * **发布事实**（Outbox / workorder / costing / engine-reporting 消费）。两层
 * 各自 append-only，同一命令产出时先账本后发布。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { ReceiptSourceKind, StockMovementKind } from './inventory-config.js';
import type { StockAdjustLine, ShippingLine } from './inventory-stores.js';

// ---- 聚合类型（机器账本与域事件共用锚定词汇） ----

export const STOCK_MOVEMENT_AGGREGATE_TYPE = 'stock-movement';
export const STOCKTAKE_AGGREGATE_TYPE = 'stocktake';
export const SHIPPING_ORDER_AGGREGATE_TYPE = 'shipping-order';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns provenance 口径）。 */
export interface InventoryEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

export function provenanceOf(
  operationId: string,
  command: string,
  actor: string,
): InventoryEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名 ----

export const INVENTORY_EVENT_TYPES = {
  stockReceived: 'smes.inventory.v1.stock-received',
  stockIssued: 'smes.inventory.v1.stock-issued',
  stockTransferred: 'smes.inventory.v1.stock-transferred',
  stocktakeAdjusted: 'smes.inventory.v1.stocktake-adjusted',
  shippingConfirmed: 'smes.inventory.v1.shipping-confirmed',
} as const;

// ---- 载荷形状 ----

/** 入库事实载荷（三类来源 kind 区分；放行/收货单引用为 opaque）。 */
export interface StockReceivedPayload {
  /** 对应流水 kind（purchase-in / inspection-in / production-in）。 */
  readonly movementKind: Extract<StockMovementKind, `${string}-in`>;
  /** 三类来源：质检放行 / 采购收货 / 完工入库。 */
  readonly source: ReceiptSourceKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly workOrderId: string | null;
  /** 来源单据引用（质检单/采购订单/完工报工单；opaque）。 */
  readonly sourceRefId: string | null;
  /** 幂等键回声（receiptKey 命中时 duplicate=true——不重复入账）。 */
  readonly receiptKey: string | null;
  readonly duplicate: boolean;
  /** 入账后现存量（恒等式对账锚点：可用量=总量−预占）。 */
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly actor: string;
}

/** 出库事实载荷（issue / shipping 两处出库共用；核销预占量随行）。 */
export interface StockIssuedPayload {
  readonly movementKind: 'issue-out' | 'shipping-out';
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  /** 出库目的（production/parts/manual；shipping 出库=purpose 值 shipping）。 */
  readonly purpose: string;
  readonly workOrderId: string | null;
  /** 核销的预占（有则先释放预占再出库——可用量不变；null=直扣可用量）。 */
  readonly reservationKey: string | null;
  readonly consumedReservationQty: number;
  readonly shipmentId: string | null;
  readonly issueKey: string | null;
  readonly duplicate: boolean;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly actor: string;
}

/** 调拨/移库事实载荷（两流水共用 transferId；仓内移库 from==to 仓库）。 */
export interface StockTransferredPayload {
  readonly transferId: string;
  readonly itemId: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly quantity: number;
  /** 仓内移库 = true（只换库位分布，仓库总量不变）。 */
  readonly intraWarehouse: boolean;
  readonly actor: string;
}

/** 盘点调账审计载荷（盘盈/盘亏行集；调账后账面=实盘）。 */
export interface StocktakeAdjustedPayload {
  readonly stocktakeId: string;
  readonly warehouseId: string;
  /** 调账行（差异≠0 的行；差异行生成盘盈/盘亏流水）。 */
  readonly adjustments: readonly StockAdjustLine[];
  /** 调账前账面总量 → 调账后账面总量（= Σ countedQty）。 */
  readonly totalBefore: number;
  readonly totalAfter: number;
  readonly objectVersion: number;
  readonly actor: string;
}

/** 发货确认载荷（workorder 待发货→已发货联动的消费锚点）。 */
export interface ShippingConfirmedPayload {
  readonly shippingOrderId: string;
  readonly workOrderId: string | null;
  readonly lines: readonly ShippingLine[];
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: InventoryEventProvenance;
}

export function makeStockReceivedEvent(
  base: DomainEventInput,
  payload: StockReceivedPayload,
  movementId: string,
): BusinessEvent<StockReceivedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INVENTORY_EVENT_TYPES.stockReceived,
    tenantId: base.tenant,
    aggregate: { id: movementId, type: STOCK_MOVEMENT_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeStockIssuedEvent(
  base: DomainEventInput,
  payload: StockIssuedPayload,
  movementId: string,
): BusinessEvent<StockIssuedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INVENTORY_EVENT_TYPES.stockIssued,
    tenantId: base.tenant,
    aggregate: { id: movementId, type: STOCK_MOVEMENT_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeStockTransferredEvent(
  base: DomainEventInput,
  payload: StockTransferredPayload,
): BusinessEvent<StockTransferredPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INVENTORY_EVENT_TYPES.stockTransferred,
    tenantId: base.tenant,
    aggregate: { id: payload.transferId, type: STOCK_MOVEMENT_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeStocktakeAdjustedEvent(
  base: DomainEventInput,
  payload: StocktakeAdjustedPayload,
): BusinessEvent<StocktakeAdjustedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INVENTORY_EVENT_TYPES.stocktakeAdjusted,
    tenantId: base.tenant,
    aggregate: { id: payload.stocktakeId, type: STOCKTAKE_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeShippingConfirmedEvent(
  base: DomainEventInput,
  payload: ShippingConfirmedPayload,
  shippingOrderId: string,
): BusinessEvent<ShippingConfirmedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INVENTORY_EVENT_TYPES.shippingConfirmed,
    tenantId: base.tenant,
    aggregate: { id: shippingOrderId, type: SHIPPING_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

/** 盘点/发货详情视图的里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface InventoryMachineMilestone {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly objectVersion: number;
}
