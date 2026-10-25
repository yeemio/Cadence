/**
 * inspection 域事件（M2-W4，06-inspection.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据列七公共列在持久化层补齐——内存/PG 双实现见 stores/pg 适配）。命名空间：
 * smes.inspection.v1.<过去式动作>；事件清单（合同最小集）：
 *   InspectionCreated（四类来源/手工建单）
 *   InspectionJudged（判定合格/不合格数量——复检共用本类型，payload.phase 区分；
 *                     合格分支随即发 InspectionReleased，不合格分支创建不合格明细）
 *   InspectionReleased（放行事实：passed 后 inventory 才可入库——合同 §2 放行规则，
 *                     inventory 消费的锚点事件）
 *   NonconformDisposed / NonconformClosed（不合格处置与闭环；Closed 载荷的
 *                     orderClosed 标记"最后一条明细闭环推质检单进 closed"联动）
 *   InspectionOverdue（闭环超时点名 → 待办 + IM）
 *
 * 与 engine-flow 机器事件账本的分工（同 workorder 头注取舍）：机器事件
 * （ApprovalEvent 形状）是质检单/不合格处置两台状态机的**重放事实源**（乐观锁
 * 与对账口径，判定迁移的决策记录随其 payload 留痕=检验记录）；本文件域事件是
 * 对外**发布事实**（Outbox / inventory 消费 / 报表上卷）。两层各自 append-only。
 */
import {
  EventId,
  TenantId,
  UserId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type {
  InspectionKind,
  InspectionSourceType,
  NonconformDisposal,
} from './inspection-config.js';

// ---- 聚合类型（机器账本与域事件共用锚定词汇） ----

export const INSPECTION_AGGREGATE_TYPE = 'inspection-order';
export const NONCONFORM_AGGREGATE_TYPE = 'nonconform';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns.v1 provenance 口径）。 */
export interface InspectionEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

function provenanceOf(
  operationId: string,
  command: string,
  actor: UserId,
): InspectionEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名（常量集中，避免字符串散落） ----

export const INSPECTION_EVENT_TYPES = {
  created: 'smes.inspection.v1.created',
  judged: 'smes.inspection.v1.judged',
  released: 'smes.inspection.v1.released',
  nonconformDisposed: 'smes.inspection.v1.nonconform-disposed',
  nonconformClosed: 'smes.inspection.v1.nonconform-closed',
  overdue: 'smes.inspection.v1.overdue',
} as const;

// ---- 载荷形状 ----

export interface InspectionCreatedPayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  /** 来源对象引用（报工单/外协单/收货单；手工建单为 null）。 */
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 送检数量（正数）。 */
  readonly quantity: number;
  readonly actor: string;
}

/** 判定/复检阶段标记：judge=首次判定（pending 起），recheck=复检（failed 起）。 */
export type InspectionJudgePhase = 'judge' | 'recheck';

export interface InspectionJudgedPayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly phase: InspectionJudgePhase;
  /** 判定后状态：passed / failed / 仍 failed（复检未通过，无迁移）。 */
  readonly outcome: 'passed' | 'failed' | 'still_failed';
  readonly passedQty: number;
  readonly failedQty: number;
  readonly remark: string | null;
  /** 不合格分支自动创建的不合格明细 id（合格分支为 null）。 */
  readonly nonconformId: string | null;
  /** 闭环时限（仅 failed 分支：判定时刻 + 闭环超时阈值）。 */
  readonly closeDueAt: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

/**
 * 放行事实载荷：inventory 入库许可的锚点（合同 §2——passed 才放行）。
 * quantity = 本次放行数量（判定/复检合格数量）。
 */
export interface InspectionReleasedPayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly phase: InspectionJudgePhase;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface NonconformDisposedPayload {
  readonly nonconformId: string;
  readonly inspectionId: string;
  readonly disposal: NonconformDisposal;
  /** 处置原因（不合格原因判定，必填留痕）。 */
  readonly reason: string;
  readonly remark: string | null;
  /** 返工处置要求必要复检（复检合格方可闭环）。 */
  readonly recheckRequired: boolean;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface NonconformClosedPayload {
  readonly nonconformId: string;
  readonly inspectionId: string;
  readonly disposal: NonconformDisposal;
  readonly remark: string | null;
  /** 联动标记：本条闭环后该质检单全部明细已闭环，单已推进 closed。 */
  readonly orderClosed: boolean;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface InspectionOverduePayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly failedQty: number;
  readonly judgedAt: string;
  readonly dueAt: string;
  readonly notifiedAt: string;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: InspectionEventProvenance;
}

export function makeInspectionCreatedEvent(
  base: DomainEventInput,
  payload: InspectionCreatedPayload,
): BusinessEvent<InspectionCreatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.created,
    tenantId: base.tenant,
    aggregate: { id: payload.inspectionId, type: INSPECTION_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeInspectionJudgedEvent(
  base: DomainEventInput,
  payload: InspectionJudgedPayload,
): BusinessEvent<InspectionJudgedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.judged,
    tenantId: base.tenant,
    aggregate: { id: payload.inspectionId, type: INSPECTION_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeInspectionReleasedEvent(
  base: DomainEventInput,
  payload: InspectionReleasedPayload,
  inspectionAggregateId: string,
): BusinessEvent<InspectionReleasedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.released,
    tenantId: base.tenant,
    aggregate: { id: inspectionAggregateId, type: INSPECTION_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeNonconformDisposedEvent(
  base: DomainEventInput,
  payload: NonconformDisposedPayload,
): BusinessEvent<NonconformDisposedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.nonconformDisposed,
    tenantId: base.tenant,
    aggregate: { id: payload.nonconformId, type: NONCONFORM_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeNonconformClosedEvent(
  base: DomainEventInput,
  payload: NonconformClosedPayload,
): BusinessEvent<NonconformClosedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.nonconformClosed,
    tenantId: base.tenant,
    aggregate: { id: payload.nonconformId, type: NONCONFORM_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeInspectionOverdueEvent(
  base: DomainEventInput,
  payload: InspectionOverduePayload,
): BusinessEvent<InspectionOverduePayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.overdue,
    tenantId: base.tenant,
    aggregate: { id: payload.inspectionId, type: INSPECTION_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export { provenanceOf };
