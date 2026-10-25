/**
 * inventory 存储端口（M2-W5）。体例同 listing-stores：端口在本包定义业务
 * 形状，内存实现先行（in-memory-inventory-stores.ts），PG adapter 由
 * business-store 按 `./inventory` 子路径接入（表结构见 prisma/migrations/
 * *_inventory_module——组合根接线属总控合流）。
 *
 * 表形态取舍（对齐 workorder/listing 既定裁定，依据 evidence-columns.v1 +
 * m2-drafts README 纪律 2）：
 *  - warehouses / warehouse_locations        主数据投影（R4：仓库与库位归本
 *    模块；运营表，不套证据公共列）；
 *  - stock_accounts / stock_location_balances / stock_reservations /
 *    stocktakes / shipping_orders            投影（运营状态/余额，可 UPDATE，
 *    行级条件更新——不套证据公共列；stocktakes.lines / shipping_orders.lines
 *    为 JSONB 载荷，同 purchase_orders.lines 取舍）；
 *  - stock_movements / release_facts         业务事实（append-only，证据七公共
 *    列齐备；sourceKey / (inspection, phase) 幂等锚点）；
 *  - inventory_events                        状态机事件账本（engine-flow
 *    ApprovalEventStore 形状；stocktake / shipping-order 两类聚合共用）；
 *  - inventory_operations                    幂等记账（运营表，同 outbox 取舍
 *    豁免触发器）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建）——本包端口按 BusinessEvent 定形。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type {
  ReceiptSourceKind,
  ReservationStatus,
  StockMovementKind,
} from './inventory-config.js';

// ---- 仓库与库位（主数据，裁决 R4） ----

/** 库位（属于仓库；盘点/移库的物理位锚点）。 */
export interface WarehouseLocation {
  /** loc-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly warehouseId: string;
  /** 租户内仓库内唯一编码。 */
  readonly code: string;
  readonly name: string | null;
  readonly createdAt: string;
}

/** 仓库（(tenant, code) 唯一）。 */
export interface Warehouse {
  /** wh-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  /** 默认库位（收货未指定库位时的落位；define 时第一个库位）。 */
  readonly defaultLocationId: string;
  readonly locations: readonly WarehouseLocation[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DefineWarehouseInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly defaultLocationId: string;
  readonly locations: readonly { readonly id: string; readonly code: string; readonly name: string | null }[];
}

/**
 * 仓库存储端口。实现方保证：create 在 (tenant, code) 重复时抛
 * InventoryConflictError；findLocationsByWarehouse 按 code 升序；读按租户收口。
 */
export interface WarehouseStore {
  create(input: DefineWarehouseInput): Promise<Warehouse>;
  find(tenant: TenantId, id: string): Promise<Warehouse | null>;
  findByCode(tenant: TenantId, code: string): Promise<Warehouse | null>;
  list(tenant: TenantId): Promise<readonly Warehouse[]>;
  findLocation(tenant: TenantId, warehouseId: string, locationId: string): Promise<WarehouseLocation | null>;
}

// ---- 库存账（物料×仓库：现存量与预占——恒等式的两个输入） ----

/** 库存账行（可用量恒等式：可用量 = qtyOnHand − qtyReserved，机器校验全程）。 */
export interface StockAccount {
  /** sa-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly itemId: string;
  readonly warehouseId: string;
  /** 现存量（总量）。 */
  readonly qtyOnHand: number;
  /** 预占量。 */
  readonly qtyReserved: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListStockAccountsFilter {
  readonly warehouseId?: string | undefined;
  readonly itemId?: string | undefined;
}

/** 负库存守卫参数：allowNegativeHand=true 时跳过 qtyOnHand>=0 守卫（合同 §8）。 */
export interface StockAdjustGuard {
  readonly allowNegativeHand?: boolean;
}

/**
 * 库存账存储端口。adjust 为 upsert + 守卫推进：
 *  - 不存在则按 delta 建行（建行结果可为负仅当守卫放开）；
 *  - 守卫（qtyOnHand + onHandDelta >= 0）不满足时抛 InventoryConflictError
 *    （内存/PG 同合同；PG 端用条件 UPDATE 保证原子性）；
 *  - reservedDelta 不设守卫（预占恒等式由 service 层按可用量先行校验）。
 */
export interface StockAccountStore {
  find(tenant: TenantId, itemId: string, warehouseId: string): Promise<StockAccount | null>;
  adjust(
    tenant: TenantId,
    itemId: string,
    warehouseId: string,
    onHandDelta: number,
    reservedDelta: number,
    guard?: StockAdjustGuard,
  ): Promise<StockAccount>;
  list(tenant: TenantId, filter?: ListStockAccountsFilter): Promise<readonly StockAccount[]>;
}

// ---- 库位余额（库位分布投影） ----

/** 库位余额行（(tenant, warehouse, location, item) 唯一）。 */
export interface StockLocationBalance {
  /** lb-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListLocationBalancesFilter {
  readonly warehouseId?: string | undefined;
  readonly itemId?: string | undefined;
}

/**
 * 库位余额存储端口。adjust 同 StockAccountStore 合同（upsert + 守卫
 * qty + delta >= 0；守卫不满足抛 InventoryConflictError）。list 按
 * createdAt 升序（FIFO 扣减的读取序——内存/PG 同口径）。
 */
export interface StockLocationBalanceStore {
  find(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
  ): Promise<StockLocationBalance | null>;
  adjust(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
    delta: number,
    guard?: StockAdjustGuard,
  ): Promise<StockLocationBalance>;
  list(tenant: TenantId, filter?: ListLocationBalancesFilter): Promise<readonly StockLocationBalance[]>;
}

// ---- 出入库流水（append-only 业务事实） ----

/** 出入库流水（append-only；来源单据引用 + 幂等键）。 */
export interface StockMovement {
  /** mv-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial——同毫秒决胜）。 */
  readonly seq: number;
  readonly kind: StockMovementKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  /** 数量（恒正；方向由 kind 推导——movementDirection）。 */
  readonly quantity: number;
  /** 来源单据引用类型（inspection/purchase-order/production/shipping/stocktake/parts-request…）。 */
  readonly sourceRefType: string | null;
  /** 来源单据引用 id（opaque）。 */
  readonly sourceRefId: string | null;
  /** 幂等键（receiptKey/issueKey/requestId——(tenant, source_key) 唯一，可空）。 */
  readonly sourceKey: string | null;
  /** 调拨关联（transfer-out/transfer-in 两流水共用 trf-id）。 */
  readonly transferId: string | null;
  readonly workOrderId: string | null;
  readonly remark: string | null;
  readonly occurredAt: string;
  readonly recordedBy: UserId;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export interface AppendStockMovementInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly kind: StockMovementKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly sourceRefType: string | null;
  readonly sourceRefId: string | null;
  readonly sourceKey: string | null;
  readonly transferId: string | null;
  readonly workOrderId: string | null;
  readonly remark: string | null;
  readonly occurredAt: string;
  readonly recordedBy: UserId;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/** append 回执：duplicate=true = sourceKey 幂等命中既有行（不重复入账）。 */
export interface StockMovementAppendReceipt {
  readonly movement: StockMovement;
  readonly duplicate: boolean;
}

export interface ListStockMovementsFilter {
  readonly itemId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly kind?: StockMovementKind | undefined;
  readonly workOrderId?: string | undefined;
  readonly sourceRefId?: string | undefined;
}

/**
 * 出入库流水存储端口：append-only；sourceKey 非空且 (tenant, sourceKey) 已
 * 存在 → 不追加、返回既有行 + duplicate=true（receiptKey/issueKey 幂等去重
 * 的存储面锚点）；list 按插入序（seq）升序。
 */
export interface StockMovementStore {
  append(input: AppendStockMovementInput): Promise<StockMovementAppendReceipt>;
  find(tenant: TenantId, id: string): Promise<StockMovement | null>;
  findBySourceKey(tenant: TenantId, sourceKey: string): Promise<StockMovement | null>;
  list(tenant: TenantId, filter?: ListStockMovementsFilter): Promise<readonly StockMovement[]>;
}

// ---- 预占（reserve/release 语义的投影账） ----

/** 预占行（(tenant, reservationKey) 唯一；remaining=未核销量）。 */
export interface StockReservation {
  /** rsv-<uuidv7>（生成器见 in-memory 实现头部注——id 不进合同词汇面）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly reservationKey: string;
  readonly itemId: string;
  readonly warehouseId: string;
  /** 预占总量。 */
  readonly quantity: number;
  /** 剩余未核销量。 */
  readonly remaining: number;
  /** active=占用中；consumed=已核销；released=已释放。 */
  readonly status: ReservationStatus;
  /** 占用方单据引用（dispatch 派工/配件申请/发料任务；refType+refId）。 */
  readonly refType: string;
  readonly refId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateStockReservationInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly reservationKey: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: number;
  readonly refType: string;
  readonly refId: string;
}

/** create 回执：duplicate=true = 同 reservationKey 已有 active 预占（幂等返回）。 */
export interface StockReservationCreateReceipt {
  readonly reservation: StockReservation;
  readonly duplicate: boolean;
}

/**
 * 预占存储端口。实现方保证：
 *  - create 在 (tenant, reservationKey) 已有 active 行时返回既有行 + duplicate
 *    （幂等不重复预占）；已 consumed/released 的 key 再 create 抛 InventoryConflictError；
 *  - consume/releaseBy 为条件推进：active 且 remaining 足额才写（不足/不存在/
 *    非 active 返回 null——service 翻 rejected）。
 */
export interface StockReservationStore {
  create(input: CreateStockReservationInput): Promise<StockReservationCreateReceipt>;
  findByKey(tenant: TenantId, reservationKey: string): Promise<StockReservation | null>;
  list(tenant: TenantId, filter?: { readonly status?: ReservationStatus }): Promise<readonly StockReservation[]>;
  /** 核销：remaining -= quantity，减到 0 → consumed。命中失败返回 null。 */
  consume(tenant: TenantId, reservationKey: string, quantity: number): Promise<StockReservation | null>;
  /** 释放：quantity=null = 全量释放；减到 0 → released。命中失败返回 null。 */
  releaseBy(tenant: TenantId, reservationKey: string, quantity: number | null): Promise<StockReservation | null>;
}

// ---- 盘点（投影 + 行载荷 JSONB） ----

/** 盘点行（开单快照 systemQty；实盘 countedQty 可空——多轮录入回填）。 */
export interface StocktakeLine {
  readonly itemId: string;
  /** 开单时账面量（快照，不变）。 */
  readonly systemQty: number;
  /** 实盘量（null=未盘）。 */
  readonly countedQty: number | null;
  readonly countedAt: string | null;
  readonly countedBy: string | null;
}

/** 盘点差异行（approve-adjust 时计算；差异≠0 的行生成调账流水）。 */
export interface StockAdjustLine {
  readonly itemId: string;
  readonly systemQty: number;
  readonly countedQty: number;
  /** counted − system（>0 盘盈；<0 盘亏）。 */
  readonly diffQty: number;
}

/** 调拨两腿（事件/流水共用的只读形状）。 */
export interface TransferLeg {
  readonly warehouseId: string;
  readonly locationId: string | null;
}

/** 盘点单（四态机投影；lines = scope 内物料的快照+实盘行）。 */
export interface Stocktake {
  /** st-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly warehouseId: string;
  readonly flowConfigId: string;
  /** draft/counting/reconciled/adjusted。 */
  readonly state: string;
  /** 状态机版本：创建+START = 2，此后每次迁移 +1；record 录行不推版本。 */
  readonly objectVersion: number;
  readonly lines: readonly StocktakeLine[];
  readonly openedBy: UserId;
  readonly approvedBy: UserId | null;
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateStocktakeInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly warehouseId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: readonly StocktakeLine[];
  readonly openedBy: UserId;
  readonly remark: string | null;
}

/**
 * 盘点存储端口（租户收口 + 乐观 advance；updateLines 为行载荷条件写：
 * 仅当 objectVersion === expectedObjectVersion 时写 lines、不推版本——
 * record 录行用，零行命中返回 null）。
 */
export interface StocktakeStore {
  create(input: CreateStocktakeInput): Promise<Stocktake>;
  find(tenant: TenantId, id: string): Promise<Stocktake | null>;
  list(tenant: TenantId, filter?: { readonly state?: string }): Promise<readonly Stocktake[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly approvedBy?: UserId; readonly remark?: string | null },
  ): Promise<Stocktake>;
  updateLines(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    lines: readonly StocktakeLine[],
  ): Promise<Stocktake | null>;
}

// ---- 发货任务（投影 + 行载荷 JSONB） ----

/** 发货行（执行时出库的物料×数量×仓）。 */
export interface ShippingLine {
  readonly itemId: string;
  readonly quantity: number;
  readonly warehouseId: string;
  readonly locationId: string | null;
  /** 核销的预占键（发料任务创建即预占的核销锚点；可空）。 */
  readonly reservationKey: string | null;
}

/** 发货任务（三态机投影：draft→executing→shipped）。 */
export interface ShippingOrder {
  /** ship-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  /** draft/executing/shipped。 */
  readonly state: string;
  /** 状态机版本：创建+EXECUTE = 2，CONFIRM 后 = 3。 */
  readonly objectVersion: number;
  readonly lines: readonly ShippingLine[];
  /** 物流信息（confirm 时补全/回填）。 */
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly executedBy: UserId;
  readonly confirmedBy: UserId | null;
  readonly confirmedAt: string | null;
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateShippingOrderInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: readonly ShippingLine[];
  readonly executedBy: UserId;
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly remark: string | null;
}

/** 发货任务存储端口（租户收口 + 乐观 advance；advance 可回填物流/确认列）。 */
export interface ShippingOrderStore {
  create(input: CreateShippingOrderInput): Promise<ShippingOrder>;
  find(tenant: TenantId, id: string): Promise<ShippingOrder | null>;
  list(tenant: TenantId, filter?: { readonly state?: string; readonly workOrderId?: string }): Promise<readonly ShippingOrder[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly carrier?: string | null;
      readonly trackingNo?: string | null;
      readonly confirmedBy?: UserId;
      readonly confirmedAt?: string;
    },
  ): Promise<ShippingOrder>;
}

// ---- 放行事实（inspection → inventory 的登记账；stock.receive 校验源） ----

/**
 * 放行事实行（inspection passed 判定后 recordRelease 登记；同 inspection
 * 多轮放行（judge/recheck）按 phase 幂等——(tenant, inspection_id, phase) 唯一）。
 * receive(kind=inspection) 校验口径：该 inspectionId 全部放行行 Σquantity
 * − 已入量 ≥ 本次入量。
 */
export interface ReleaseFact {
  /** rel-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly inspectionId: string;
  /** 放行阶段（judge/recheck——inspection InspectionJudgePhase 词汇镜像）。 */
  readonly phase: string;
  readonly kind: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: string;
  readonly recordedAt: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export interface AppendReleaseFactInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly inspectionId: string;
  readonly phase: string;
  readonly kind: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: string;
}

/** 放行事实存储端口：append-only；(tenant, inspectionId, phase) 幂等（重复通知返回既有行）。 */
export interface ReleaseFactStore {
  append(input: AppendReleaseFactInput): Promise<ReleaseFact>;
  listByInspection(tenant: TenantId, inspectionId: string): Promise<readonly ReleaseFact[]>;
}

// ---- 命令幂等记账 ----

export interface InventoryOperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（stock / stocktake / shipping / warehouse 命名族）。 */
  readonly command: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3）。record 在**命令成功提交前**
 * 调用：已存在 → 返回 null（用例层翻 rejected）；不存在 → 记账并返回记账行。
 */
export interface InventoryOperationStore {
  record(entry: InventoryOperationRecord): Promise<InventoryOperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → InventoryConflictError（幂等去重）。PG 侧
 * 映射既有 event_records / outbox_records 两表（M1 已建）。
 */
export interface InventoryDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；跨事件类型混排——发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}

/** 流水 audit_status 合法值（模块 schema v1）：recorded=已入账。 */
export const STOCK_MOVEMENT_AUDIT_STATUS = 'recorded';

/** 放行事实 audit_status 合法值（模块 schema v1）：recorded=已登记。 */
export const RELEASE_FACT_AUDIT_STATUS = 'recorded';

/** 三类入库来源在 receive 载荷里的来源引用字段名（解析器口径）。 */
export type ReceiptSourceRef = { readonly kind: ReceiptSourceKind } & {
  readonly inspectionId?: string;
  readonly purchaseOrderId?: string;
};
