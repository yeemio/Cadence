/**
 * issue 存储端口（U1）。体例同 listing/dispatch：端口在本包定义业务形状，
 * 内存实现先行（in-memory-issue-stores.ts），PG adapter 由 business-store 按
 * `./issue` 子路径接入（表结构见 prisma/migrations/*_issue_module——子路径
 * 导出登记归总控合流）。
 *
 * 表形态取舍（对齐 business-store README 纪律 + shipping_orders/purchase_orders
 * 先例）：
 *  - issue_tasks / issue_task_lines / issue_expresses / issue_records 是**投影**
 *    （运营状态，可 UPDATE / 可 DELETE，行级或整行乐观版本）——不套证据公共列：
 *    发料记录是"确认瞬间的快照 + 撤销态"运营单据（撤销 = state 迁移 revoked +
 *    已发累计退出，legacy 的 is_deleted 逻辑删除语义），不可变事实由域事件
 *    （event_records）承载；
 *  - issue_records.lines 为 JSONB 载荷（明细快照 + 库位分配 + 预占扣减回执快照，
 *    同 purchase_orders.lines / shipping_orders.lines）；
 *  - issue_operations 是**幂等记账**（运营表，同 outbox 取舍豁免触发器）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records。
 *
 * 维度唯一性（文档 1.2：工作令 + 设备 + 派工类型；归拢 = 工作令一条）：
 * PG 侧 (tenant, dimension_key) 唯一（dimension_key = 工作令|派工类型|归拢|设备
 * 引用，应用侧拼键——归拢行设备维为空也收敛进唯一键）；内存侧同键去重。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type {
  IssueDispatchKind,
  IssueLineKind,
  IssueRecordState,
  IssueTaskState,
} from './issue-config.js';

// ---- 发料任务（投影；状态为汇总推导） ----

/**
 * 触发来源锚点（关联派工单展示用；任务不与派工单做外键绑定——文档 3.3）。
 */
export interface IssueTriggerRef {
  readonly type: string;
  readonly id: string;
}

/** 发料任务主行。 */
export interface IssueTask {
  /** itk-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 任务号（ISS-ASM-/ISS-ELEC-/ISS-ASM-ROLLUP- 前缀 + uuidv7 尾段）。 */
  readonly taskNo: string;
  /** 所属工作令（跨模块 opaque id）。 */
  readonly workOrderId: string;
  /** 工作令展示名快照（可空）。 */
  readonly workOrderLabel: string | null;
  /** 触发派工类型：assembly / electrical。 */
  readonly dispatchKind: IssueDispatchKind;
  /** 整线装配外购设备归拢（一工作令一条，equipmentRef 为空）。 */
  readonly rollup: boolean;
  /** 工作令设备维（opaque；归拢任务为 null）。 */
  readonly equipmentRef: string | null;
  /** not-started / issuing / done（汇总推导，refreshSummary 迁移）。 */
  readonly state: IssueTaskState;
  /** 汇总刷新版本：创建 = 1，每次 refreshSummary +1。 */
  readonly objectVersion: number;
  /** 计划开工/完工时刻快照（可空）。 */
  readonly plannedStartAt: string | null;
  readonly plannedEndAt: string | null;
  /** 操作工人快照（展示用）。 */
  readonly operators: readonly string[];
  /** 触发来源锚点集（关联派工单展示）。 */
  readonly triggerRefs: readonly IssueTriggerRef[];
  /** 总需求量合计（全部有效明细行；冗余汇总，refreshSummary 重算）。 */
  readonly totalRequiredQty: number;
  /** 已发数量合计（有效记录累计；冗余汇总，refreshSummary 重算）。 */
  readonly totalIssuedQty: number;
  /** 完成时刻（state 迁入 done 时落）。 */
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateIssueTaskInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: IssueDispatchKind;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly plannedStartAt: string | null;
  readonly plannedEndAt: string | null;
  readonly operators: readonly string[];
  readonly triggerRefs: readonly IssueTriggerRef[];
}

export interface ListIssueTasksFilter {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly dispatchKind?: string | undefined;
  readonly equipmentRef?: string | undefined;
  readonly rollup?: boolean | undefined;
}

/** 汇总刷新载荷（state/进度由 service 推导后整块写入）。 */
export interface RefreshIssueTaskSummaryInput {
  readonly state: IssueTaskState;
  readonly totalRequiredQty: number;
  readonly totalIssuedQty: number;
  readonly finishedAt: string | null;
}

/**
 * 任务存储端口。实现方保证：
 *  - create 同维度（租户 + 工作令 + 派工类型 + 归拢 + 设备维）重复抛
 *    IssueConflictError；
 *  - findByDimension 命中唯一任务（含归拢：equipmentRef null + rollup true）；
 *  - list 按 createdAt 降序（新的在前）；
 *  - refreshSummary 为乐观写入：objectVersion 不符返回 null；
 *  - delete 连带删行（投影清理；无有效发料记录是 service 前置）。
 */
export interface IssueTaskStore {
  create(input: CreateIssueTaskInput): Promise<IssueTask>;
  find(tenant: TenantId, id: string): Promise<IssueTask | null>;
  findByDimension(
    tenant: TenantId,
    dimension: {
      readonly workOrderId: string;
      readonly dispatchKind: IssueDispatchKind;
      readonly rollup: boolean;
      readonly equipmentRef: string | null;
    },
  ): Promise<IssueTask | null>;
  list(tenant: TenantId, filter?: ListIssueTasksFilter): Promise<readonly IssueTask[]>;
  refreshSummary(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    summary: RefreshIssueTaskSummaryInput,
  ): Promise<IssueTask | null>;
  delete(tenant: TenantId, id: string): Promise<boolean>;
}

// ---- 任务明细行（投影；按 (taskId, sourceLineId) 幂等补全） ----

/** 发料任务明细行（业务字段仅落库：模块/名称/图号/总需求量——文档 1.2）。 */
export interface IssueTaskLine {
  /** itl-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly taskId: string;
  /** 任务内 1 起递增行号。 */
  readonly lineNo: number;
  readonly kind: IssueLineKind;
  /** 来源清单行（listing 行 opaque id；归拢 equipment 行 = 设备采购清单行 id）。 */
  readonly sourceLineId: string;
  /** 确认物料 id（标准件/电气件库位发料必需；可空）。 */
  readonly itemId: string | null;
  readonly moduleName: string | null;
  readonly name: string | null;
  /** 图号/型号规格。 */
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly createdAt: string;
}

export interface AppendIssueTaskLineInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly taskId: string;
  readonly lineNo: number;
  readonly kind: IssueLineKind;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly moduleName: string | null;
  readonly name: string | null;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
}

/** 补全结果：appended = 本次新落行；all = 补全后全量行集。 */
export interface AppendIssueTaskLinesResult {
  readonly appended: readonly IssueTaskLine[];
  readonly all: readonly IssueTaskLine[];
}

/**
 * 任务行存储端口。实现方保证：
 *  - appendMissing 按 (tenant, taskId, sourceLineId) 去重落整批（既有行不动，
 *    行号续排），返回本次新落行 + 全量行集（syncMissingLines 口径）；
 *  - listByTask 按 lineNo 升序；
 *  - deleteByTask 连带清理（任务投影删除时）。
 */
export interface IssueTaskLineStore {
  appendMissing(
    tenant: TenantId,
    taskId: string,
    lines: readonly AppendIssueTaskLineInput[],
  ): Promise<AppendIssueTaskLinesResult>;
  listByTask(tenant: TenantId, taskId: string): Promise<readonly IssueTaskLine[]>;
  deleteByTask(tenant: TenantId, taskId: string): Promise<number>;
}

// ---- 发料记录（投影：快照载荷 + 撤销态） ----

/** 库位分配行（standard/electrical 确认发料的库位出库明细 + 扣减回执快照）。 */
export interface IssueLocationAllocation {
  readonly locationId: string;
  /** 该库位本次出库数量。 */
  readonly quantity: number;
  /** 是否推荐库位。 */
  readonly recommended: boolean;
  /** 预占核销量（回执快照；撤销原路回滚的依据）。 */
  readonly reservedConsumedQty: number;
  /** 可用量扣减（回执快照）。 */
  readonly availableConsumedQty: number;
}

/** 发料记录明细行快照（确认瞬间写入；不以后续实时库存反改）。 */
export interface IssueRecordLineSnapshot {
  /** 关联任务明细行 id。 */
  readonly taskLineId: string;
  readonly kind: IssueLineKind;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly moduleName: string | null;
  readonly name: string | null;
  readonly drawingNo: string | null;
  /** 总需求量快照。 */
  readonly requiredQty: number;
  /** 已预占库存快照（发料前）。 */
  readonly reservedBeforeQty: number;
  /** 发料前已发数量。 */
  readonly issuedBeforeQty: number;
  /** 本次发料数量（standard/electrical = 库位合计）。 */
  readonly thisQty: number;
  /** 发料后已发数量（= issuedBeforeQty + thisQty）。 */
  readonly issuedAfterQty: number;
  /** 发料后待发数量（= max(requiredQty − issuedAfterQty, 0)）。 */
  readonly pendingAfterQty: number;
  /** 发料前当前可发数量快照。 */
  readonly availableBeforeQty: number;
  /** 本次预占核销合计（part：剩余预占冲减；standard/electrical：Σ allocation 预占核销；equipment：0）。 */
  readonly reservedConsumedQty: number;
  /** equipment 专用：本次利用库存冲减（采购入库份不落库——文档 1.4.1）。 */
  readonly useInventoryConsumedQty: number;
  /** 库存联动幂等锚点（standard/electrical：撤销按此原路回滚）；其余类别 null。 */
  readonly issueKey: string | null;
  /** standard/electrical 库位分配集（含扣减回执快照）；其余类别空数组。 */
  readonly allocations: readonly IssueLocationAllocation[];
}

/** 发料记录主行（一条记录一种 lineKind——与当次提交页签一致）。 */
export interface IssueRecord {
  /** irc-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 记录号（ISS-REC- 前缀）。 */
  readonly recordNo: string;
  readonly taskId: string;
  /** 任务号快照。 */
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: IssueDispatchKind;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly lineKind: IssueLineKind;
  readonly issuedAt: string;
  readonly issuedBy: UserId;
  /** 本次发料数量合计。 */
  readonly totalQty: number;
  /** 快递单（发货头）id；无发货头为 null。 */
  readonly expressId: string | null;
  /** active / revoked（revoked 不计入已发累计）。 */
  readonly state: IssueRecordState;
  readonly revokedAt: string | null;
  readonly revokedBy: UserId | null;
  /** 明细行快照集（JSONB 载荷）。 */
  readonly lines: readonly IssueRecordLineSnapshot[];
  /** 撤销迁移版本：创建 = 1，revoke +1。 */
  readonly objectVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateIssueRecordInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly recordNo: string;
  readonly taskId: string;
  readonly taskNo: string;
  readonly workOrderId: string;
  readonly workOrderLabel: string | null;
  readonly dispatchKind: IssueDispatchKind;
  readonly rollup: boolean;
  readonly equipmentRef: string | null;
  readonly lineKind: IssueLineKind;
  readonly issuedAt: string;
  readonly issuedBy: UserId;
  readonly totalQty: number;
  readonly expressId: string | null;
  readonly lines: readonly IssueRecordLineSnapshot[];
}

export interface ListIssueRecordsFilter {
  readonly taskId?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly state?: string | undefined;
}

/**
 * 记录存储端口。实现方保证：list 按 issuedAt 降序（新的在前）；
 * revoke 为乐观写入（objectVersion 不符返回 null），state active → revoked。
 */
export interface IssueRecordStore {
  create(input: CreateIssueRecordInput): Promise<IssueRecord>;
  find(tenant: TenantId, id: string): Promise<IssueRecord | null>;
  list(tenant: TenantId, filter?: ListIssueRecordsFilter): Promise<readonly IssueRecord[]>;
  revoke(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    revokedAt: string,
    revokedBy: UserId,
  ): Promise<IssueRecord | null>;
}

// ---- 快递单（发货头元数据投影；对象存储零依赖——图片只存引用串） ----

/** 快递单（配件发料发货头：单号/发货人/发货时间/图片引用）。 */
export interface IssueExpress {
  /** iex-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly trackingNo: string;
  readonly shipper: string;
  readonly shipTime: string;
  /** 图片引用集（公用桶直链或对象键，≤6；分号/数组形态由存储定——端口面为数组）。 */
  readonly imageRefs: readonly string[];
  /** 归属工作令（可空）。 */
  readonly workOrderId: string | null;
  /** 首次确认该单号的发料任务。 */
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateIssueExpressInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly trackingNo: string;
  readonly shipper: string;
  readonly shipTime: string;
  readonly imageRefs: readonly string[];
  readonly workOrderId: string | null;
  readonly taskId: string | null;
}

/**
 * 快递单存储端口。实现方保证：create 同 (tenant, workOrderId 空值收敛,
 * trackingNo) 重复抛 IssueConflictError；findByNo 空值收敛匹配；删除为投影行
 * 删除（无未撤销发料记录引用是 service 前置）。
 */
export interface IssueExpressStore {
  create(input: CreateIssueExpressInput): Promise<IssueExpress>;
  find(tenant: TenantId, id: string): Promise<IssueExpress | null>;
  findByNo(tenant: TenantId, workOrderId: string | null, trackingNo: string): Promise<IssueExpress | null>;
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly IssueExpress[]>;
  delete(tenant: TenantId, id: string): Promise<boolean>;
}

// ---- 命令幂等记账 ----

export interface IssueOperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（issue.* 命名族）。 */
  readonly command: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3）。record 在命令成功提交前调用：
 * 已存在 → 返回 null（用例层翻 rejected）；不存在 → 记账并返回记账行。
 */
export interface IssueOperationStore {
  record(entry: IssueOperationRecord): Promise<IssueOperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox；复用既有 event_records/outbox_records） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行。eventId 重复
 * append → IssueConflictError（幂等去重）。
 */
export interface IssueDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}
