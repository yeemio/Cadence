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
 *   InspectionConcessionConfirmed（fix-wave-6 6a-2 / RQ-035 特采确认：S5 让步
 *                     接收入库语义的累加记账事实——详见下方"S5 特采与既有
 *                     concession 处置的关系"注）
 *   InspectionJudgedBatch（fix-wave-6 6a-2 / RQ-036 批量质检整批锚事件：
 *                     每单 judged+released 照发，本事件为批次聚合锚）
 *   InspectionRevoked（fix-wave-6 6a-2 / RQ-037 撤销质检：判定回退 + 放行收回
 *                     + 特采清零 + 不合格明细作废的对外发布事实）
 *   NonconformDisposed / NonconformClosed（不合格处置与闭环；Closed 载荷的
 *                     orderClosed 标记"最后一条明细闭环推质检单进 closed"联动）
 *   InspectionOverdue（闭环超时点名 → 待办 + IM）
 *
 * **S5 特采（InspectionConcessionConfirmed）与既有 concession 处置枚举的关系**
 * （17 册 §8-5"让步接收双形态"取舍，本波实施口径）：
 *  - 既有 concession 处置 = 不合格**闭环语义**（dispose 载荷枚举之一，处置
 *    决定留痕，无入库联动）——维持不动，不推翻既有闭环；
 *  - 本事件族 = 源《采购-非标件采购质检》特采确认的 **S5 让步接收入库语义**
 *    （failedQty 余量内累加 concession 数量 + 每次确认**另建**一条特采待入库
 *    行事实，与合格放行 InspectionReleased 分立、不合并）；
 *  - 两套词汇并存：同一次不合格量既可走处置闭环记账、也可走特采入库记账，
 *    双记口径（是否互斥/如何对账）为开放问题回传 Owner 裁定（17 册 §8-5）；
 *  - 待入库行本体归 IV 域（15 册）：本域只发事实事件（inventory 消费锚点），
 *    入库联动未接线——本波"不做"面。
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
/** 批量质检批次锚聚合类型（RQ-036；体例同 reporting report-batch）。 */
export const INSPECTION_BATCH_AGGREGATE_TYPE = 'inspection-order-batch';

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
  judgedBatch: 'smes.inspection.v1.judged-batch',
  released: 'smes.inspection.v1.released',
  concessionConfirmed: 'smes.inspection.v1.concession-confirmed',
  revoked: 'smes.inspection.v1.revoked',
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

/**
 * 特采确认载荷（RQ-035 / S5）：source 形态 = 源 mes_storage_entry
 * `qc_release_kind=2` 特采待入库行（另建、不与合格行合并）——我方以独立事件
 * 类型承载"另建一条特采待入库"事实（lineKind=concession，与合格放行
 * InspectionReleased 分立），消费方（IV 域，未接线）据此另建特采待入库行。
 * quantity=本次特采数量；concessionQuantity=累加后已特采数量；
 * remainingConcessionQty=本次后剩余可特采 = max(0, failedQty − 已特采)。
 * 撤销质检整体回退清零（无独立撤销特采——源口径），由 InspectionRevoked 事件
 * 承载，本事件不冲销。
 */
export interface InspectionConcessionConfirmedPayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 本次特采数量（≥1）。 */
  readonly quantity: number;
  /** 累加后已特采数量。 */
  readonly concessionQuantity: number;
  /** 本次后剩余可特采数量。 */
  readonly remainingConcessionQty: number;
  /** 不合格数量（特采基数，冗余便于消费方对账）。 */
  readonly failedQty: number;
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

/**
 * 批量质检锚载荷（RQ-036）：整批"全部合格"逐单落账（合格=送检量、不合格=0），
 * 每单的 judged/released 事件照常独立发布；本事件挂批次锚聚合（体例同
 * reporting BatchSubmitted）。
 */
export interface InspectionJudgedBatchPayload {
  readonly batchId: string;
  readonly count: number;
  readonly results: ReadonlyArray<{
    readonly inspectionId: string;
    readonly kind: InspectionKind;
    readonly passedQty: number;
    readonly objectVersion: number;
  }>;
  readonly actor: string;
}

/**
 * 撤销质检载荷（RQ-037）：判定回退（passed/failed → pending）的对外事实。
 * releasedQtyRetracted = 撤销前已放行数量（passed 单=原合格数，inventory
 * 消费方据此收回待入库/冲减；failed 单=0）；concessionQuantityCleared =
 * 撤销时清零的已特采数量；nonconformIdsVoided = 随判定作废的不合格明细。
 */
export interface InspectionRevokedPayload {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly fromState: string;
  readonly releasedQtyRetracted: number;
  readonly concessionQuantityCleared: number;
  readonly nonconformIdsVoided: readonly string[];
  readonly remark: string | null;
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

export function makeInspectionConcessionConfirmedEvent(
  base: DomainEventInput,
  payload: InspectionConcessionConfirmedPayload,
): BusinessEvent<InspectionConcessionConfirmedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.concessionConfirmed,
    tenantId: base.tenant,
    aggregate: { id: payload.inspectionId, type: INSPECTION_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeInspectionJudgedBatchEvent(
  base: DomainEventInput,
  payload: InspectionJudgedBatchPayload,
): BusinessEvent<InspectionJudgedBatchPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.judgedBatch,
    tenantId: base.tenant,
    aggregate: { id: payload.batchId, type: INSPECTION_BATCH_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeInspectionRevokedEvent(
  base: DomainEventInput,
  payload: InspectionRevokedPayload,
): BusinessEvent<InspectionRevokedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: INSPECTION_EVENT_TYPES.revoked,
    tenantId: base.tenant,
    aggregate: { id: payload.inspectionId, type: INSPECTION_AGGREGATE_TYPE, revision: payload.objectVersion },
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
