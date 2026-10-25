/**
 * dispatch 域事件（M2-W6，04-dispatch.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据七公共列在持久化层补齐）。命名空间：smes.dispatch.v1.<过去式动作>；
 * 事件清单（合同词汇 6 个）：
 *   DispatchCreated / DispatchAssigned（→待办推送执行人）/ DispatchStarted /
 *   DispatchCompleted（外协单含回厂质检回执）/ DispatchCancelled（→reporting
 *   侧禁止再报）/ OutsourcingPriced（→costing 重算信号）。
 *
 * 与 engine-flow 机器事件账本的分工：机器事件（ApprovalEvent 形状）是派工单
 * 状态机的**重放事实源**（乐观锁与对账口径）；本文件域事件是对外**发布事实**
 * （Outbox / workorder 进度上卷 / reporting / inspection / costing 消费）。两层
 * 各自 append-only，同一命令产出时先账本后发布。
 *
 * 进度上卷：DispatchStarted / DispatchCompleted 的载荷携带 workorder
 * ProgressFact 同形的进度事实（stage 映射见 dispatch-config）——workorder 订阅
 * 域事件上卷，dispatch 不直接写他域（合同 §4）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { DispatchKind } from './dispatch-config.js';
import type { OutsourcingLine } from './dispatch-stores.js';

// ---- 聚合类型 ----

export const DISPATCH_ORDER_AGGREGATE_TYPE = 'dispatch-order';
export const OUTSOURCING_LINE_AGGREGATE_TYPE = 'outsourcing-line';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns provenance 口径）。 */
export interface DispatchEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

function provenanceOf(operationId: string, command: string, actor: string): DispatchEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名 ----

export const DISPATCH_EVENT_TYPES = {
  dispatchCreated: 'smes.dispatch.v1.dispatch-created',
  dispatchAssigned: 'smes.dispatch.v1.dispatch-assigned',
  dispatchStarted: 'smes.dispatch.v1.dispatch-started',
  dispatchCompleted: 'smes.dispatch.v1.dispatch-completed',
  dispatchCancelled: 'smes.dispatch.v1.dispatch-cancelled',
  outsourcingPriced: 'smes.dispatch.v1.outsourcing-priced',
} as const;

// ---- 进度事实（workorder ProgressFact 同形镜像——上卷载荷） ----

/** 进度事实（stage/drawingNo/operationId/doneQty/totalQty/status；词汇以 workorder-ports 为准）。 */
export interface DispatchProgressFactPayload {
  readonly stage: 'machining' | 'assembly';
  readonly drawingNo: string | null;
  readonly operationId: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

// ---- 载荷形状 ----

export interface DispatchCreatedPayload {
  readonly workOrderId: string | null;
  readonly kind: DispatchKind;
  readonly title: string;
  /** 零件单工艺属性快照（随单；其余 kind 为 null）。 */
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly material: string | null;
  readonly sizeSpec: string | null;
  readonly quantity: number;
  readonly dueAt: string | null;
  /** 齐套放行证据（装配/电气被拦截校验时携带：放行的核查快照 id + 刷新时刻；其余 kind null）。 */
  readonly kitCheck: { readonly kitCheckId: string; readonly refreshedAt: string } | null;
  /** 外协明细行集（kind=outsourcing 时非空；含实时取价结果）。 */
  readonly outsourcingLines: readonly {
    readonly lineId: string;
    readonly lineNo: number;
    readonly processCode: string;
    readonly supplierRef: string;
    readonly quantity: number;
    readonly unitPriceMinor: number | null;
    readonly priceSource: string | null;
    readonly marginPermyriad: number | null;
    readonly promisedAt: string | null;
  }[];
  readonly objectVersion: number;
  readonly actor: string;
}

export interface DispatchAssignedPayload {
  readonly assignee: string;
  readonly remark: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface DispatchStartedPayload {
  readonly assignee: string | null;
  /** 进度事实（上卷载荷；stage 映射见 dispatch-config——不进上卷的 kind 不发事件）。 */
  readonly progress: DispatchProgressFactPayload | null;
  readonly objectVersion: number;
  readonly actor: string;
}

/** inspection 来源入口回执的载荷镜像（结构化提取；词汇以 inspection-ports 为准）。 */
export interface InspectionIntakeReceiptPayload {
  readonly inspectionId: string | null;
  readonly created: boolean;
  readonly reason: string | null;
}

export interface DispatchCompletedPayload {
  readonly doneQty: number;
  readonly quantity: number;
  readonly assignee: string | null;
  readonly progress: DispatchProgressFactPayload | null;
  /** 外协回厂触发回执（kind=outsourcing 时非空；未接线 = created:false + 原因）。 */
  readonly inspectionIntake: InspectionIntakeReceiptPayload | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface DispatchCancelledPayload {
  /** 撤销来源态（draft/assigned；reporting 侧据本事件禁止再报）。 */
  readonly fromState: string;
  readonly remark: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface OutsourcingPricedPayload {
  readonly dispatchId: string;
  readonly lineNo: number;
  readonly processCode: string;
  readonly supplierRef: string;
  /** 补录前单价（null = 此前未定价）。 */
  readonly previousUnitPriceMinor: number | null;
  readonly unitPriceMinor: number;
  /** 行数量（costing 归集口径：金额 = unitPriceMinor × quantity）。 */
  readonly quantity: number;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: DispatchEventProvenance;
}

export function makeDispatchCreatedEvent(
  base: DomainEventInput,
  payload: DispatchCreatedPayload,
  dispatchId: string,
): BusinessEvent<DispatchCreatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.dispatchCreated,
    tenantId: base.tenant,
    aggregate: { id: dispatchId, type: DISPATCH_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeDispatchAssignedEvent(
  base: DomainEventInput,
  payload: DispatchAssignedPayload,
  dispatchId: string,
): BusinessEvent<DispatchAssignedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.dispatchAssigned,
    tenantId: base.tenant,
    aggregate: { id: dispatchId, type: DISPATCH_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeDispatchStartedEvent(
  base: DomainEventInput,
  payload: DispatchStartedPayload,
  dispatchId: string,
): BusinessEvent<DispatchStartedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.dispatchStarted,
    tenantId: base.tenant,
    aggregate: { id: dispatchId, type: DISPATCH_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeDispatchCompletedEvent(
  base: DomainEventInput,
  payload: DispatchCompletedPayload,
  dispatchId: string,
): BusinessEvent<DispatchCompletedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.dispatchCompleted,
    tenantId: base.tenant,
    aggregate: { id: dispatchId, type: DISPATCH_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeDispatchCancelledEvent(
  base: DomainEventInput,
  payload: DispatchCancelledPayload,
  dispatchId: string,
): BusinessEvent<DispatchCancelledPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.dispatchCancelled,
    tenantId: base.tenant,
    aggregate: { id: dispatchId, type: DISPATCH_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeOutsourcingPricedEvent(
  base: DomainEventInput,
  payload: OutsourcingPricedPayload,
  lineId: string,
): BusinessEvent<OutsourcingPricedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: DISPATCH_EVENT_TYPES.outsourcingPriced,
    tenantId: base.tenant,
    aggregate: { id: lineId, type: OUTSOURCING_LINE_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

/** 派工单详情视图的里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface DispatchMachineMilestone {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly objectVersion: number;
}

/** 域事件载荷的外协行打印投影（打印数据查询的行形状复用 OutsourcingLine 全量行）。 */
export type OutsourcingPrintLine = OutsourcingLine;

export { provenanceOf };
