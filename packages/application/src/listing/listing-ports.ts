/**
 * listing 跨模块端口（M2-W3，03-listing.md §4"依赖 M2"与"被依赖"）。
 *
 * 只定义接口（模块间互调一律经 application 层端口，ADR-0011 / 通用合同纪律
 * 6）。实现方：内存/测试 = testkit 夹具 + 本文件缺省实现（零接线 boot 语义
 * 完整）；真实联动 = 兄弟模块在合流时提供，经 ListingModule.register 注入。
 *
 * 端口方法一律异步；全部按租户收口。workorder 侧事件形状（WorkOrderCreated）
 * 与 inventory 端口词汇均以**本地镜像结构类型**承载（与 workorder-ports.ts
 * 互为同形合同，避免跨模块类型依赖——取舍同 testkit 夹具）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { BaselineCommandEnvelope } from '../baseline/baseline-input.js';
import type { MaterialValidationExecutor } from '../baseline/baseline.service.js';
import type { InspectionKind } from '../inspection/inspection-config.js';
import type { InspectionIntakePort } from '../inspection/inspection-ports.js';
import type { ListingKind } from './listing-config.js';

// ---- workorder 端口：WorkOrderCreated 事件订阅（清单骨架生成源） ----

/** WorkOrderCreated 载荷镜像（字段口径以 workorder/workorder-events.ts 为准）。 */
export interface WorkOrderCreatedEventShape {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly customerRef: string | null;
  readonly salesRep: string | null;
  readonly manager: string | null;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
  /** 四类清单骨架创建提示（listing 消费方按 kind 各建一张空清单）。 */
  readonly listingKinds: readonly string[];
  readonly actor: string;
}

/** 订阅消息（域事件的最小消费面：eventId + 时刻 + 载荷）。 */
export interface WorkOrderCreatedEventMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly payload: WorkOrderCreatedEventShape;
}

/**
 * workorder 创建事件订阅端口。实现方读 workorder 域事件账本
 * （smes.workorder.v1.created）并维护消费位；缺省空实现 = 零接线 boot
 * （listing.import source=workorder 时按四类缺省骨架生成，见 service 注释）。
 */
export interface WorkOrderCreatedFeedPort {
  /** 拉取该租户未确认的 WorkOrderCreated 事件（occurredAt 升序）。 */
  pendingCreatedEvents(tenant: TenantId): Promise<readonly WorkOrderCreatedEventMessage[]>;
  /** 确认消费（幂等：重复确认无副作用）。 */
  acknowledge(eventId: string): Promise<void>;
}

export const EMPTY_WORK_ORDER_CREATED_FEED: WorkOrderCreatedFeedPort = {
  pendingCreatedEvents: async () => [],
  acknowledge: async () => {},
};

// ---- inventory 端口：可用量（缺口核查供给侧） ----

/**
 * inventory 可用量端口（与 workorder-ports.ts 的同名端口合同同形——结构化
 * 兼容；组合根可注入同一实例）。返回 Map：请求的 itemId → 可用量；缺项 = 0。
 */
export interface InventoryAvailabilityPort {
  availableQty(
    tenant: TenantId,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
}

export const LISTING_EMPTY_INVENTORY_PORT: InventoryAvailabilityPort = {
  availableQty: async () => new Map<string, number>(),
};

// ---- inventory 端口：收货入库指令（purchase.order.receive 联动） ----

/** 入库指令（幂等键 = receiptKey：实现方须按 receiptKey 去重，重试不重复入库）。 */
export interface InventoryReceiptCommand {
  /** 幂等键（调用方约定 `${purchaseOrderId}#${lineNo}`）。 */
  readonly receiptKey: string;
  readonly purchaseOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
  /** 收货仓（可选；缺省回落 inventory 服务选项 defaultWarehouseCode（租户内按 code 解析）——D-15/D-16）。 */
  readonly warehouseId?: string;
}

/** 入库回执：received=false 携拒绝原因——命令以 rejected 收场，不落账。 */
export interface InventoryReceiptResult {
  readonly received: boolean;
  readonly refusedReason?: string;
}

/** inventory 端口：采购收货入库指令（收货确认后放行入库）。 */
export interface InventoryReceiptPort {
  receivePurchase(tenant: TenantId, command: InventoryReceiptCommand): Promise<InventoryReceiptResult>;
}

/** 缺省入库端口：恒放行（无 inventory 接线时收货不阻塞；合流时替换）。 */
export const LISTING_NOOP_RECEIPT_PORT: InventoryReceiptPort = {
  receivePurchase: async () => ({ received: true }),
};

// ---- inventory 端口：利库预占（gap.check 确认 → 预占创建联动） ----

/**
 * 利库预占单行回执（多仓拆分 = 多键；键约定归适配器——消费面按锚点归并，
 * 与 IssueMaterialPort 预占核销同锚）。
 */
export interface InventoryUseReserveLineReceipt {
  readonly itemId: string;
  /** 本次实际新建预占数量（锚点既有活跃预占已覆盖 / 幂等命中 = 0）。 */
  readonly quantity: number;
  /** 本次新建预占的键集（追溯锚：键内嵌 gapCheckId）。 */
  readonly reservationKeys: readonly string[];
}

/** 利库预占回执：reserved=false 携拒绝原因——gap.check 整单 rejected 不落账。 */
export interface InventoryUseReserveReceipt {
  readonly reserved: boolean;
  readonly refusedReason?: string;
  readonly created?: readonly InventoryUseReserveLineReceipt[];
}

/** 利库预占指令（quantity = 目标预占总量；适配方按锚点既有活跃预占折差新建）。 */
export interface InventoryUseReserveCommand {
  readonly equipmentRef?: string | null;
  readonly workOrderId: string;
  readonly itemId: string;
  /** 目标预占总量（= min(Σ 需求, 利库供给基数)；≤ 需求且 ≤ 供给——不超占）。 */
  readonly quantity: number;
  /** 本次核查快照 id（预占键追溯锚——同批键唯一，重核查折差不复用键）。 */
  readonly gapCheckId: string;
}

/**
 * inventory 利库预占端口（缺口核查确认联动，PRD 14 RREQ-LP-021 库存联动的
 * Cadence 统一快照面形态）：
 *  - reservedForWorkOrder：本工作令在 issue 订单级锚的活跃预占（利库供给基数
 *    的自有部分——重复核查不自我挤占；口径镜像 IssueMaterialPort.reservedQtyOf
 *    的 equipmentRef 空锚）；
 *  - reserveForWorkOrder：利库预占创建（幂等收敛：目标量 ≤ 既有活跃预占时
 *    新建 0；拒绝则核查整单 rejected）。
 * 预占的消费面 = 发料核销（IssueMaterialPort issueStock——同锚 FIFO）；
 * 齐套判定的 reserved 数据源同账（可用量恒等式 可用量=总量−预占）。
 */
export interface InventoryUseReservationPort {
  reservedForWorkOrder(
    tenant: TenantId,
    workOrderId: string,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  reserveForWorkOrder(
    tenant: TenantId,
    command: InventoryUseReserveCommand,
  ): Promise<InventoryUseReserveReceipt>;
}

/** 缺省利库预占端口（零接线 boot）：自有预占恒 0、创建恒空——核查行为同旧。 */
export const LISTING_NOOP_USE_RESERVATION_PORT: InventoryUseReservationPort = {
  reservedForWorkOrder: async (_tenant, _workOrderId, itemIds) =>
    new Map(itemIds.map((itemId) => [itemId, 0])),
  reserveForWorkOrder: async () => ({ reserved: true, created: [] }),
};

// ---- inspection 端口：收货→三类采购质检来源投递（17 册 RQ-019） ----

/** 缺省收货质检投递端口：未接线不投递（回执 created:false 不报错——零接线 boot 语义完整）。 */
export const LISTING_NOOP_INSPECTION_INTAKE: InspectionIntakePort = {
  receiveSourceFact: async () => ({
    inspectionId: null,
    created: false,
    reason: 'inspection intake 端口未接线：listing 收货触发需组合根注入 InspectionService',
  }),
};

/**
 * 采购申请 kind → 采购质检 kind 映射（RQ-019 三类采购质检；PRD 14 §6"收货事实
 * 携带 kind 显式"——kind 由收货侧经申请链推导后显式给 inspection）。
 */
export const REQUEST_KIND_TO_INSPECTION_KIND: Readonly<Record<string, InspectionKind>> = {
  nonstandard: 'nonstandard_purchase',
  standard: 'standard_purchase',
  equipment: 'equipment_purchase',
};

// ---- baseline 端口：物料校验执行（接口只 import 不实现） ----

export type { MaterialValidationExecutor } from '../baseline/baseline.service.js';

/**
 * 缺省物料校验执行端口：未接线时**显式拒绝**（不静默跳过校验——跳过会让
 * 未校验行混进缺口核查，语义不诚实）。组合根注入 BaselineService 实例即接通。
 */
export const LISTING_UNWIRED_MATERIAL_VALIDATION: MaterialValidationExecutor = {
  execute: async () => ({
    status: 'rejected',
    reason: '物料校验端口未接线：listing 导入需组合根注入 baseline MaterialValidationExecutor（BaselineService 默认实现）',
  }),
};

/** 物料校验子信封的 operationId 派生（同 listing operationId 确定性后缀——重试不重复落 baseline 账）。 */
export function materialValidationOperationId(operationId: string): string {
  const base = operationId.length > 112 ? operationId.slice(0, 112) : operationId;
  return `${base}#material`;
}

// ---- 被依赖面：workorder 齐套消费清单需求行 ----

/** 清单需求行投影（workorder ListingRequirementPort 的载荷镜像词汇）。 */
export interface ListingRequirementSnapshotLine {
  readonly kind: ListingKind;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly neededBy: string | null;
}

/** 需求行提供方（service.requirementLines 的函数面）。 */
export interface ListingRequirementSource {
  requirementLines(tenant: TenantId, workOrderId: string): Promise<readonly ListingRequirementSnapshotLine[]>;
}

/**
 * workorder 齐套端口适配器（被依赖面）：把 listing 需求行投影成 workorder
 * ListingRequirementPort 合同形状（结构化兼容——组合根直接注入 workorder 模块）。
 */
export function createListingRequirementAdapter(source: ListingRequirementSource): {
  requirementLines(tenant: TenantId, workOrderId: string): Promise<readonly ListingRequirementSnapshotLine[]>;
} {
  return { requirementLines: (tenant, workOrderId) => source.requirementLines(tenant, workOrderId) };
}

// ---- 待办联动来源码 ----

/** 待办联动来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const LISTING_TODO_SOURCE = 'listing';

/** 采购订单聚合类型（待办 refType / 事件 aggregate.type 共用词汇）。 */
export const PURCHASE_ORDER_TODO_REF_TYPE = 'purchase-order';

/** 逾期催货待办指派对象兜底（订单无 buyer 时不派待办——见 service）。 */
export type PurchaseTodoAssignee = UserId;
