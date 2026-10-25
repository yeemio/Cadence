/**
 * workorder 存储端口（M2-W1）。
 *
 * 与 ApprovalCaseStore/TodoStore 同一模式：端口在本包定义（业务形状），内存
 * 实现先行（in-memory-workorder-stores.ts），PG adapter 由 business-store 按
 * `./workorder` 子路径接入（表结构见 prisma/migrations/*_workorder_module ——
 * 组合根接线属总控合流）。机器事件账本端口直接采用 engine-flow
 * ApprovalEventStore 形状（ADR-0011：application 可依赖 engine-*；与 approval
 * 模块同一取舍——账本是事实源，投影行是重放快照）。
 *
 * 表形态取舍（对齐 business-store README 纪律）：
 *  - work_orders / parts_requests 是**投影**（运营状态，state 可 UPDATE，
 *    advance 带乐观版本检查）——不套证据公共列；
 *  - work_order_attachments / kit_checks 是**业务事实**（append-only 不可变，
 *    证据七公共列齐备：id/objectVersion/auditStatus/provenance/supersedes/
 *    businessTime/availableTime）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建，见 business-store schema.prisma）——本包端口按 BusinessEvent
 *    定形，Outbox 记账随 append 原子产生。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
  WorkOrderId,
} from '@smes/business-core';
import type {
  KitCheckKindSummaryPayload,
  KitCheckLineGapPayload,
} from './workorder-events.js';

// ---- 工作令投影行 ----

/** 工作令主单据（02-workorder.md §2：客户/项目/销售/项目经理/计划交付/包材到货）。 */
export interface WorkOrder {
  readonly id: WorkOrderId;
  readonly tenant: TenantId;
  /** 九态配置标识（engine-flow config.flowId）。 */
  readonly flowConfigId: string;
  /** 当前状态 id（九态之一）。 */
  readonly state: string;
  /**
   * 状态机版本（乐观锁口径）：创建 = 1，**每次成功迁移 +1**（update/attach/
   * kit.refresh 不推进——状态机版本只由迁移推进，重放对账口径见 service）。
   */
  readonly objectVersion: number;
  /** 客户引用（masterdata 客户 id，opaque；可空）。 */
  readonly customerRef: string | null;
  readonly projectName: string;
  /** 销售（品牌化 UserId，可空）。 */
  readonly salesRep: UserId | null;
  /** 项目经理（品牌化 UserId，可空——待办联动指派对象）。 */
  readonly manager: UserId | null;
  /** 计划交付日期（ISO 8601 date，可空）。 */
  readonly plannedDeliveryAt: string | null;
  /** 包材到货日期（ISO 8601 date，可空）。 */
  readonly packagingArrivalAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkOrderInput {
  readonly tenant: TenantId;
  readonly id: WorkOrderId;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly customerRef: string | null;
  readonly projectName: string;
  readonly salesRep: UserId | null;
  readonly manager: UserId | null;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
}

/** 字段级更新（未提供的键不变；id/版本不在此列——版本只由迁移推进）。 */
export interface UpdateWorkOrderFields {
  readonly customerRef?: string | null;
  readonly projectName?: string;
  readonly salesRep?: UserId | null;
  readonly manager?: UserId | null;
  readonly plannedDeliveryAt?: string | null;
  readonly packagingArrivalAt?: string | null;
}

export interface ListWorkOrdersFilter {
  /** 状态精确过滤（可选；缺省 = 全部状态）。 */
  readonly state?: string | undefined;
}

/**
 * 工作令投影存储端口。实现方保证：
 *  - create/list/find/update 按租户收口；list 按 createdAt 降序（新的在前）；
 *  - create 同租户同 id 冲突 → WorkOrderConflictError；
 *  - update 对不存在 id 返回 null（404 语义由用例层翻译）；
 *  - advance 为乐观推进：仅当 objectVersion === expectedObjectVersion 时写入
 *    next.state 与 next.objectVersion，未命中抛 WorkOrderConflictError。
 */
export interface WorkOrderStore {
  create(input: CreateWorkOrderInput): Promise<WorkOrder>;
  find(tenant: TenantId, id: WorkOrderId): Promise<WorkOrder | null>;
  list(tenant: TenantId, filter?: ListWorkOrdersFilter): Promise<readonly WorkOrder[]>;
  update(tenant: TenantId, id: WorkOrderId, fields: UpdateWorkOrderFields): Promise<WorkOrder | null>;
  advance(
    tenant: TenantId,
    id: WorkOrderId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<WorkOrder>;
}

// ---- 附件（业务事实，append-only） ----

/** 附件事实行（图纸等文件挂接；证据七公共列齐备）。 */
export interface WorkOrderAttachment {
  /** uuidv7（时间有序主键）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: WorkOrderId;
  readonly name: string;
  /** 附件类别（单段小写形状，如 drawing）。 */
  readonly kind: string;
  /** 文件指针（URL / 对象存储键，opaque）。 */
  readonly ref: string;
  readonly attachedBy: UserId;
  readonly attachedAt: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export interface AppendAttachmentInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: WorkOrderId;
  readonly name: string;
  readonly kind: string;
  readonly ref: string;
  readonly attachedBy: UserId;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/** 附件存储端口：append-only（无 update/delete）；listByWorkOrder 按挂接时间升序。 */
export interface WorkOrderAttachmentStore {
  append(input: AppendAttachmentInput): Promise<WorkOrderAttachment>;
  listByWorkOrder(tenant: TenantId, workOrderId: WorkOrderId): Promise<readonly WorkOrderAttachment[]>;
  find(tenant: TenantId, id: string): Promise<WorkOrderAttachment | null>;
}

// ---- 配件申请投影行 ----

/** 配件申请（售后配件申请→审批→发货闭环，P1）。 */
export interface PartsRequest {
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: WorkOrderId;
  readonly flowConfigId: string;
  /** 当前状态 id（draft/submitted/approved/rejected/shipped/received）。 */
  readonly state: string;
  /** 状态机版本：建单+提交 = 2，此后每次迁移 +1。 */
  readonly objectVersion: number;
  /** 物料 id（masterdata 物品 id，opaque）。 */
  readonly itemId: string;
  /** 申请数量（正数）。 */
  readonly quantity: number;
  readonly requester: UserId;
  readonly remark: string | null;
  /** 发货单号（parts.ship 后回填；opaque）。 */
  readonly shipmentRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePartsRequestInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: WorkOrderId;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: UserId;
  readonly remark: string | null;
}

export interface ListPartsRequestsFilter {
  /** 状态精确过滤（可选）。 */
  readonly state?: string | undefined;
  /** 按工作令过滤（可选）。 */
  readonly workOrderId?: WorkOrderId | undefined;
}

/** 配件申请存储端口（合同同 WorkOrderStore：租户收口 + 乐观 advance + 降序列表）。 */
export interface PartsRequestStore {
  create(input: CreatePartsRequestInput): Promise<PartsRequest>;
  find(tenant: TenantId, id: string): Promise<PartsRequest | null>;
  list(tenant: TenantId, filter?: ListPartsRequestsFilter): Promise<readonly PartsRequest[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly shipmentRef?: string | null },
  ): Promise<PartsRequest>;
}

// ---- 齐套检查（不可变快照，业务事实） ----

/** 齐套快照（按工作令×三类清单的齐套事实与缺口；每次刷新一条，不修改）。 */
export interface KitCheck {
  /** uuidv7（时间有序主键）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: WorkOrderId;
  readonly kinds: readonly KitCheckKindSummaryPayload[];
  readonly gapLines: readonly KitCheckLineGapPayload[];
  /** 全类目齐套 = true（dispatch 装配派工放行判断的口径）。 */
  readonly complete: boolean;
  readonly refreshedBy: UserId;
  readonly refreshedAt: string;
  // ---- 证据公共列 ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export interface AppendKitCheckInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: WorkOrderId;
  readonly kinds: readonly KitCheckKindSummaryPayload[];
  readonly gapLines: readonly KitCheckLineGapPayload[];
  readonly complete: boolean;
  readonly refreshedBy: UserId;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/**
 * 齐套快照存储端口：append-only；latestByWorkOrder 取该工作令最新一条
 * （refreshedAt 降序）；latestPerTenant 取每工作令最新一条（齐套看板口径）。
 */
export interface KitCheckStore {
  append(input: AppendKitCheckInput): Promise<KitCheck>;
  latestByWorkOrder(tenant: TenantId, workOrderId: WorkOrderId): Promise<KitCheck | null>;
  /** 看板：每工作令最新快照（refreshedAt 降序；含缺口行——下钻数据即载荷）。 */
  latestPerTenant(tenant: TenantId): Promise<readonly KitCheck[]>;
}

// ---- 命令幂等记账 ----

export interface OperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（workorder.*.v1）。 */
  readonly command: string;
  /** 目标聚合（type/id，审计指向）。 */
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3：同一 operationId 只允许落账一次）。
 * record 在**命令成功提交前**调用：已存在 → 返回 null（用例层翻 rejected）；
 * 不存在 → 记账并返回记账行（先记账后落账，中断窗口由 operationId 拒重放兜底）。
 */
export interface WorkOrderOperationStore {
  record(entry: OperationRecord): Promise<OperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → WorkOrderConflictError（幂等去重）。
 * PG 侧映射既有 event_records / outbox_records 两表（business-store M1 已建）。
 */
export interface WorkOrderDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；跨事件类型混排——发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序；投递器与联动验证用）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}
