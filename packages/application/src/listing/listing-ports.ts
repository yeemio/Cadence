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
