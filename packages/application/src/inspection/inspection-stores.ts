/**
 * inspection 存储端口（M2-W4）。
 *
 * 与 workorder 存储端口同一模式：端口在本包定义（业务形状），内存实现先行
 * （in-memory-inspection-stores.ts），PG adapter 由 business-store 按
 * `./inspection` 子路径接入（表结构见 prisma/migrations/*_inspection_module——
 * 组合根接线属总控合流）。机器事件账本端口直接采用 engine-flow
 * ApprovalEventStore 形状（ADR-0011：application 可依赖 engine-*；质检单与
 * 不合格处置两类聚合共用一个账本端口，aggregate.type 区分）。
 *
 * 表形态取舍（对齐 business-store README 纪律）：
 *  - inspections / nonconformities 是**投影**（运营状态，state 可 UPDATE，
 *    advance 带乐观版本检查）——不套证据公共列；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建）——本包端口按 BusinessEvent 定形，Outbox 记账随 append 原子产生；
 *  - 检验记录事实（判定/复检数量+备注）由机器事件账本（判定迁移的决策记录
 *    随事件 payload 留痕）+ 域事件（judged/released）双重承载，投影行只存
 *    当前值（重放可重建）。
 */
import type {
  BusinessEvent,
  EventId,
  InspectionId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type {
  InspectionKind,
  InspectionSourceType,
  NonconformDisposal,
} from './inspection-config.js';

// ---- 判定数量口径（judge / recheck 命令共用） ----

/**
 * 检验记录字段（判定与复检都写全套——投影行当前值；历史值在事件账本）。
 * closeDueAt 仅 failed 分支非空（判定时刻 + 闭环超时阈值；复检仍失败时刷新）。
 */
export interface JudgmentFields {
  readonly passedQty: number;
  readonly failedQty: number;
  readonly judgeRemark: string | null;
  readonly judgedBy: UserId;
  readonly judgedAt: string;
  readonly closeDueAt: string | null;
}

// ---- 质检单投影行 ----

/** 质检单（06-inspection.md §2：kind 四类、来源对象引用、合格/不合格数量）。 */
export interface InspectionOrder {
  readonly id: InspectionId;
  readonly tenant: TenantId;
  /** 状态机配置标识（engine-flow config.flowId）。 */
  readonly flowConfigId: string;
  /** 当前状态 id（pending/passed/failed/closed）。 */
  readonly state: string;
  /**
   * 状态机版本（乐观锁口径）：创建 = 1，**每次成功迁移 +1**（判定 PASS/FAIL、
   * 复检合格 RECHECK_PASS、闭环 CLOSE；复检仍失败无迁移不推进——updateJudgment）。
   */
  readonly objectVersion: number;
  /** 四类质检 kind。 */
  readonly kind: InspectionKind;
  /** 来源类型（report/dispatch/receipt；手工建单 null）。 */
  readonly sourceType: InspectionSourceType | null;
  /** 来源对象 id（报工单/外协单/收货单；手工建单 null）。 */
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 送检数量（正数）。 */
  readonly quantity: number;
  /** 判定结果（判定前 null）。 */
  readonly passedQty: number | null;
  readonly failedQty: number | null;
  readonly judgeRemark: string | null;
  readonly judgedBy: UserId | null;
  readonly judgedAt: string | null;
  /** 闭环时限（failed 判定时定；超时点名锚点）。 */
  readonly closeDueAt: string | null;
  /** 闭环超时点名时刻（一次点名；null = 未点名）。 */
  readonly overdueNotifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateInspectionInput {
  readonly tenant: TenantId;
  readonly id: InspectionId;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly kind: InspectionKind;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
}

export interface ListInspectionsFilter {
  /** kind 精确过滤（可选；四类质检队列的队列键）。 */
  readonly kind?: InspectionKind | undefined;
  /** 状态精确过滤（可选）。 */
  readonly state?: string | undefined;
}

/**
 * 质检单投影存储端口。实现方保证：
 *  - create/find/list 按租户收口；list 按 createdAt 降序（新的在前）；
 *  - create 同租户同 id 冲突 → InspectionConflictError；
 *  - findBySourceRef 是来源幂等键（同租户同来源对象只生成一张待检单）；
 *  - advance 为乐观推进：仅当 objectVersion === expectedObjectVersion 时写入
 *    next.state、next.objectVersion 与 extra 判定字段，未命中抛 InspectionConflictError；
 *  - updateJudgment 同乐观检查（复检仍失败路径：无迁移不推进版本，404 返回 null）；
 *  - markOverdueNotified 为点名幂等标记（运营字段 UPDATE，404 返回 null）。
 */
export interface InspectionOrderStore {
  create(input: CreateInspectionInput): Promise<InspectionOrder>;
  find(tenant: TenantId, id: InspectionId): Promise<InspectionOrder | null>;
  findBySourceRef(
    tenant: TenantId,
    sourceType: InspectionSourceType,
    sourceRefId: string,
  ): Promise<InspectionOrder | null>;
  list(tenant: TenantId, filter?: ListInspectionsFilter): Promise<readonly InspectionOrder[]>;
  advance(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: JudgmentFields,
  ): Promise<InspectionOrder>;
  updateJudgment(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    fields: JudgmentFields,
  ): Promise<InspectionOrder | null>;
  markOverdueNotified(tenant: TenantId, id: InspectionId, notifiedAt: string): Promise<InspectionOrder | null>;
}

// ---- 不合格处置投影行 ----

/** 不合格处置随迁移回填的字段（dispose / close 各写所需）。 */
export interface NonconformAdvanceExtra {
  readonly disposal?: NonconformDisposal;
  readonly reason?: string;
  readonly disposeRemark?: string | null;
  readonly disposedBy?: UserId;
  readonly disposedAt?: string;
  readonly closeRemark?: string | null;
  readonly closedBy?: UserId;
  readonly closedAt?: string;
}

/** 不合格处置（06-inspection.md §2：原因/处置枚举/闭环状态）。 */
export interface Nonconform {
  readonly id: string;
  readonly tenant: TenantId;
  readonly inspectionId: InspectionId;
  readonly flowConfigId: string;
  /** 当前状态 id（open/disposed/closed）。 */
  readonly state: string;
  /** 状态机版本：创建 = 1（judge 不合格分支），dispose = 2，close = 3。 */
  readonly objectVersion: number;
  readonly itemId: string | null;
  /** 不合格数量。 */
  readonly quantity: number;
  /** 不合格原因（dispose 时必填留痕；open 态 null）。 */
  readonly reason: string | null;
  /** 处置枚举（rework/concession/scrap；open 态 null）。 */
  readonly disposal: NonconformDisposal | null;
  readonly disposeRemark: string | null;
  readonly disposedBy: UserId | null;
  readonly disposedAt: string | null;
  readonly closeRemark: string | null;
  readonly closedBy: UserId | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateNonconformInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly inspectionId: InspectionId;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string | null;
  readonly quantity: number;
}

export interface ListNonconformsFilter {
  /** 状态精确过滤（可选；闭环追踪的队列键）。 */
  readonly state?: string | undefined;
  /** 按质检单过滤（可选）。 */
  readonly inspectionId?: InspectionId | undefined;
}

/** 不合格处置存储端口（合同同 InspectionOrderStore：租户收口 + 乐观 advance + 降序列表）。 */
export interface NonconformStore {
  create(input: CreateNonconformInput): Promise<Nonconform>;
  find(tenant: TenantId, id: string): Promise<Nonconform | null>;
  list(tenant: TenantId, filter?: ListNonconformsFilter): Promise<readonly Nonconform[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: NonconformAdvanceExtra,
  ): Promise<Nonconform>;
}

// ---- 命令幂等记账 ----

export interface OperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（inspection 系与 nonconform 系 .v1 命令）。 */
  readonly command: string;
  /** 目标聚合（type/id，审计指向）。 */
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3：同一 operationId 只允许落账一次）。
 * record 在**命令成功提交前**调用：已存在 → 返回 null（用例层翻 rejected）。
 */
export interface InspectionOperationStore {
  record(entry: OperationRecord): Promise<OperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → InspectionConflictError（幂等去重）。
 * PG 侧映射既有 event_records / outbox_records 两表（business-store M1 已建）。
 */
export interface InspectionDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序；投递器与联动验证用）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}
