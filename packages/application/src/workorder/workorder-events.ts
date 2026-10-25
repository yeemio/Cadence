/**
 * workorder 域事件（M2-W1，02-workorder.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据列七公共列在持久化层补齐——内存/PG 双实现见 workorder-stores.ts）。
 * 命名空间：smes.workorder.v1.<过去式动作>；事件清单：
 *   WorkOrderCreated（→listing 四类清单导入）、WorkOrderTransitioned（→待办/
 *     IM/报表）、AttachmentAdded、PartsRequested/Approved/Rejected/Shipped、
 *     KitCheckRefreshed（→dispatch 装配派工放行判断）。
 * PartsRejected 为 PartsApproved 的对称补全（合同状态机含 rejected 终态，
 * 决策必须可回溯；模块 schema 版本化，v1 内登记）。
 *
 * 与 engine-flow 机器事件账本的分工：机器事件（ApprovalEvent 形状）是九态/
 * 配件状态机的**重放事实源**（乐观锁与对账口径）；本文件域事件是对外**发布
 * 事实**（Outbox / listing 消费 / 报表上卷）。两层各自 append-only，同一命令
 * 产出时先账本后发布（中断窗口在重放对账处暴露，不静默漂移——取舍同
 * approval 落库顺序注释）。
 */
import {
  EventId,
  TenantId,
  UserId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { EvidenceRef } from '@smes/engine-flow';
import type { ListingKind } from './workorder-config.js';

// ---- 聚合类型（机器账本与域事件共用锚定词汇） ----

export const WORK_ORDER_AGGREGATE_TYPE = 'work-order';
export const WORK_ORDER_ATTACHMENT_AGGREGATE_TYPE = 'work-order-attachment';
export const PARTS_REQUEST_AGGREGATE_TYPE = 'parts-request';
export const KIT_CHECK_AGGREGATE_TYPE = 'kit-check';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns.v1 provenance 口径）。 */
export interface WorkOrderEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

function provenanceOf(
  operationId: string,
  command: string,
  actor: UserId,
): WorkOrderEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名（常量集中，避免字符串散落） ----

export const WORKORDER_EVENT_TYPES = {
  created: 'smes.workorder.v1.created',
  updated: 'smes.workorder.v1.updated',
  transitioned: 'smes.workorder.v1.transitioned',
  attachmentAdded: 'smes.workorder.v1.attachment-added',
  partsRequested: 'smes.workorder.v1.parts-requested',
  partsApproved: 'smes.workorder.v1.parts-approved',
  partsRejected: 'smes.workorder.v1.parts-rejected',
  partsShipped: 'smes.workorder.v1.parts-shipped',
  kitCheckRefreshed: 'smes.workorder.v1.kit-check-refreshed',
} as const;

// ---- 载荷形状 ----

export interface WorkOrderCreatedPayload {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly customerRef: string | null;
  readonly salesRep: string | null;
  readonly manager: string | null;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
  /** 四类清单骨架创建提示（listing 消费方按 kind 各建一张空清单）。 */
  readonly listingKinds: readonly ListingKind[];
  readonly actor: string;
}

export interface WorkOrderUpdatedPayload {
  /** 本次变更的字段名清单（新值 Map；旧值不进事件——append-only 账本可回放）。 */
  readonly changes: Readonly<Record<string, unknown>>;
  readonly actor: string;
}

export interface WorkOrderTransitionedPayload {
  readonly from: string;
  readonly to: string;
  /** 配置迁移命令动词（SCREAMING_SNAKE，重放与对账锚点）。 */
  readonly event: string;
  readonly objectVersion: number;
  readonly remark: string;
  readonly evidence: readonly EvidenceRef[];
  readonly actor: string;
}

export interface AttachmentAddedPayload {
  readonly workOrderId: string;
  readonly name: string;
  readonly kind: string;
  readonly ref: string;
  readonly actor: string;
}

export interface PartsRequestedPayload {
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly remark: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export type PartsDecision = 'approve' | 'reject';

export interface PartsDecidedPayload {
  readonly decision: PartsDecision;
  readonly remark: string;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface PartsShippedPayload {
  readonly shipmentRef: string | null;
  /** inventory 出库端口回执（issued=false 不可能出现——拒绝时命令不落账）。 */
  readonly issue: { readonly issued: boolean; readonly refusedReason?: string };
  readonly objectVersion: number;
  readonly actor: string;
}

export interface KitCheckKindSummaryPayload {
  readonly kind: ListingKind;
  readonly lineCount: number;
  readonly gapLineCount: number;
  readonly complete: boolean;
}

export interface KitCheckLineGapPayload {
  readonly kind: ListingKind;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly availableQty: number;
  readonly gapQty: number;
}

export interface KitCheckRefreshedPayload {
  readonly workOrderId: string;
  readonly kinds: readonly KitCheckKindSummaryPayload[];
  readonly gapLines: readonly KitCheckLineGapPayload[];
  readonly complete: boolean;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: WorkOrderEventProvenance;
}

export function makeWorkOrderCreatedEvent(
  base: DomainEventInput,
  payload: WorkOrderCreatedPayload,
): BusinessEvent<WorkOrderCreatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.created,
    tenantId: base.tenant,
    aggregate: { id: payload.workOrderId, type: WORK_ORDER_AGGREGATE_TYPE, revision: 1 },

    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeWorkOrderUpdatedEvent(
  base: DomainEventInput,
  payload: WorkOrderUpdatedPayload,
  workOrderAggregateId: string,
  currentRevision: number,
): BusinessEvent<WorkOrderUpdatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.updated,
    tenantId: base.tenant,
    aggregate: { id: workOrderAggregateId, type: WORK_ORDER_AGGREGATE_TYPE, revision: currentRevision },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeWorkOrderTransitionedEvent(
  base: DomainEventInput,
  payload: WorkOrderTransitionedPayload,
  workOrderAggregateId: string,
): BusinessEvent<WorkOrderTransitionedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.transitioned,
    tenantId: base.tenant,
    aggregate: { id: workOrderAggregateId, type: WORK_ORDER_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeAttachmentAddedEvent(
  base: DomainEventInput,
  payload: AttachmentAddedPayload,
  attachmentAggregateId: string,
): BusinessEvent<AttachmentAddedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.attachmentAdded,
    tenantId: base.tenant,
    aggregate: { id: attachmentAggregateId, type: WORK_ORDER_ATTACHMENT_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePartsRequestedEvent(
  base: DomainEventInput,
  payload: PartsRequestedPayload,
  partsAggregateId: string,
): BusinessEvent<PartsRequestedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.partsRequested,
    tenantId: base.tenant,
    aggregate: { id: partsAggregateId, type: PARTS_REQUEST_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePartsDecidedEvent(
  base: DomainEventInput,
  payload: PartsDecidedPayload,
  partsAggregateId: string,
): BusinessEvent<PartsDecidedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: payload.decision === 'approve' ? WORKORDER_EVENT_TYPES.partsApproved : WORKORDER_EVENT_TYPES.partsRejected,
    tenantId: base.tenant,
    aggregate: { id: partsAggregateId, type: PARTS_REQUEST_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makePartsShippedEvent(
  base: DomainEventInput,
  payload: PartsShippedPayload,
  partsAggregateId: string,
): BusinessEvent<PartsShippedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.partsShipped,
    tenantId: base.tenant,
    aggregate: { id: partsAggregateId, type: PARTS_REQUEST_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeKitCheckRefreshedEvent(
  base: DomainEventInput,
  payload: KitCheckRefreshedPayload,
  kitCheckAggregateId: string,
): BusinessEvent<KitCheckRefreshedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: WORKORDER_EVENT_TYPES.kitCheckRefreshed,
    tenantId: base.tenant,
    aggregate: { id: kitCheckAggregateId, type: KIT_CHECK_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export { provenanceOf };
