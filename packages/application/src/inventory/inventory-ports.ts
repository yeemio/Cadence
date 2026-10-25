/**
 * inventory 跨模块端口（M2-W5，07-inventory.md §4）。
 *
 * 本模块是四个兄弟端口的**实现方**（In 方向无兄弟端口依赖——放行事实走
 * 本模块 ReleaseFactStore 登记）：适配器把 InventoryService 的公开方法面
 * 包装成各兄弟模块已导出的端口接口形状（模块间互调一律经 application 层
 * 端口，ADR-0011 / 通用合同纪律 6），组合根合流时直接注入：
 *  - workorder InventoryAvailabilityPort（齐套供给）+ PartsIssuePort（配件出库）
 *  - listing   InventoryReceiptPort（采购收货入库，receiptKey 幂等）
 *  - inspection StockReleasePort（放行事实登记——recordRelease 直连通道）
 *
 * 另定义本模块对外的预占端口 StockReservationPort（dispatch 派工/发料任务
 * 创建即预占的 reserve/release 语义，07-inventory.md §2 预占规则）——
 * InventoryService 实现该接口，组合根注入消费方。
 *
 * 端口方法一律异步；全部按租户收口。
 */
import type { TenantId } from '@smes/business-core';
import type { PartsIssuePort } from '../workorder/workorder-ports.js';
import type { InventoryReceiptPort } from '../listing/listing-ports.js';
import type { StockReleasePort } from '../inspection/inspection-ports.js';

// ---- 可用量供给面（workorder 齐套 / listing 缺口核查共用） ----

/**
 * 可用量供给源（InventoryService 的方法面）：跨仓汇总 Σ max(0, 总量−预占)
 * ——恒等式口径（07-inventory.md §1）。
 */
export interface InventoryAvailabilitySource {
  availableQtyOf(tenant: TenantId, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

/** 可用量适配器：实现 workorder-ports / listing-ports 的 InventoryAvailabilityPort（结构同形）。 */
export function createInventoryAvailabilityAdapter(
  source: InventoryAvailabilitySource,
): {
  availableQty(tenant: TenantId, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
} {
  return { availableQty: (tenant, itemIds) => source.availableQtyOf(tenant, itemIds) };
}

// ---- 采购收货入库面（listing purchase.order.receive 联动） ----

/** 收货入库指令的服务面（receiptKey 幂等去重——Wave-2 验收低危 #4 兑现点）。 */
export interface InventoryPurchaseReceiptSurface {
  receivePurchaseStock(
    tenant: TenantId,
    command: {
      readonly receiptKey: string;
      readonly purchaseOrderId: string;
      readonly itemId: string;
      readonly quantity: number;
      /** 收货仓（缺省 = 服务选项 defaultWarehouseId）。 */
      readonly warehouseId?: string;
    },
  ): Promise<{ readonly received: boolean; readonly refusedReason?: string; readonly duplicate?: boolean }>;
}

/** listing InventoryReceiptPort 适配器：拒绝则 listing 整单 rejected 不落账（端口合同）。 */
export function createInventoryReceiptAdapter(
  surface: InventoryPurchaseReceiptSurface,
): InventoryReceiptPort {
  return {
    receivePurchase: (tenant, command) => surface.receivePurchaseStock(tenant, command),
  };
}

// ---- 配件出库面（workorder parts.ship 联动） ----

/** 配件出库指令的服务面（requestId 幂等——重试不重复扣减）。 */
export interface InventoryPartsIssueSurface {
  issuePartsStock(
    tenant: TenantId,
    command: {
      readonly requestId: string;
      readonly workOrderId: string;
      readonly itemId: string;
      readonly quantity: number;
      /** 发料仓（缺省 = 服务选项 defaultWarehouseId）。 */
      readonly warehouseId?: string;
    },
  ): Promise<{ readonly issued: boolean; readonly refusedReason?: string; readonly duplicate?: boolean }>;
}

/** workorder PartsIssuePort 适配器：requestId 作 issueKey（movement.sourceKey 幂等锚点）。 */
export function createPartsIssueAdapter(surface: InventoryPartsIssueSurface): PartsIssuePort {
  return {
    issueParts: (tenant, command) => surface.issuePartsStock(tenant, command),
  };
}

// ---- 放行事实登记面（inspection → inventory 直连通道） ----

/**
 * 放行事实登记的服务面：inspection passed 判定后 recordRelease 落本模块
 * ReleaseFactStore（stock.receive 校验源）。通知式合同（实现方不抛错——
 * inspection 侧判定已落账，失败不回滚；事件通道为最终一致兜底）。
 */
export interface InspectionReleaseSink {
  recordInspectionRelease(
    tenant: TenantId,
    fact: {
      readonly inspectionId: string;
      readonly kind: string;
      readonly itemId: string | null;
      readonly drawingNo: string | null;
      readonly quantity: number;
      readonly sourceType: string | null;
      readonly sourceRefId: string | null;
      readonly releasedAt: string;
    },
  ): Promise<void>;
}

/**
 * inspection StockReleasePort 适配器。幂等锚点 = (tenant, inspectionId,
 * phase)：fact 无 phase 词汇（直连通知不带判定阶段），落账 phase 取
 * `direct@${releasedAt}`——同轮通知重试（同 releasedAt）幂等返回既有行；
 * 复检再放行（新 releasedAt）记新行，放行总量累加（宁记多次不丢放行）。
 */
export function createStockReleaseRecorder(sink: InspectionReleaseSink): StockReleasePort {
  return {
    recordRelease: (tenant, fact) =>
      sink.recordInspectionRelease(tenant, {
        inspectionId: fact.inspectionId,
        kind: fact.kind,
        itemId: fact.itemId,
        drawingNo: fact.drawingNo,
        quantity: fact.quantity,
        sourceType: fact.sourceType,
        sourceRefId: fact.sourceRefId,
        releasedAt: fact.releasedAt,
      }),
  };
}

// ---- 预占端口（dispatch 派工 / 发料任务创建即预占——07-inventory.md §2） ----

/** 预占指令（幂等键 = reservationKey：重复指令幂等返回首次结果，不重复预占）。 */
export interface StockReserveCommand {
  readonly reservationKey: string;
  readonly itemId: string;
  /** 缺省 = 服务选项 defaultWarehouseId（未配置则拒绝）。 */
  readonly warehouseId?: string;
  readonly quantity: number;
  /** 占用方单据引用（dispatch 派工单/配件申请/发料任务）。 */
  readonly refType: string;
  readonly refId: string;
}

/** 预占回执：reserved=false 携拒绝原因（可用量不足等）。 */
export interface StockReserveReceipt {
  readonly reserved: boolean;
  readonly refusedReason?: string;
  readonly duplicate?: boolean;
}

/** 释放指令：quantity=null = 全量释放。 */
export interface StockReleaseCommand {
  readonly reservationKey: string;
  readonly quantity: number | null;
}

/**
 * 预占端口：reserve（派工/发料创建即预占——扣可用量不扣总量）、release
 * （未用退回）。InventoryService 实现本接口；dispatch/workorder 合流时经
 * 组合根注入消费。可用量恒等式（可用量=总量−预占）全程机器校验。
 */
export interface StockReservationPort {
  reserve(tenant: TenantId, command: StockReserveCommand): Promise<StockReserveReceipt>;
  release(tenant: TenantId, command: StockReleaseCommand): Promise<{ released: boolean; refusedReason?: string }>;
}

// ---- 待办联动来源码（预留：本模块 v1 不产待办——合同事件面无待办词汇） ----

/** 待办联动来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const INVENTORY_TODO_SOURCE = 'inventory';

/** 发货任务聚合类型（ShippingConfirmed 事件 aggregate.type 共用词汇）。 */
export const SHIPPING_TODO_REF_TYPE = 'shipping-order';
