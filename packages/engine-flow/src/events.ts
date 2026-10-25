/**
 * 审批事件：每次状态迁移产出一个，append-only（ADR-0003 #4/#5）。
 *
 * 形状取舍：独立定义、对齐 BusinessEvent 的"精简子集"——保留 eventId /
 * eventType / aggregate / occurredAt / payload 五个核心字段与同一 eventType
 * 命名空间规则（smes.<flowId>.v1.<过去式动作>）；不带 tenantId / businessTime /
 * availableTime / provenance——那些是持久化与传输口径，由后续 business-store
 * 适配层在入账时补齐（toBusinessEventInput 即该适配的形状证明）。
 * 引擎是纯域，不持有租户与出站上下文，这是不直接复用 BusinessEvent 的原因。
 */
import {
  EventId,
  type BusinessEventInput,
  type EventAggregateRef,
  type TenantId,
  type UserIdType,
} from '@smes/business-core';
import { deepFreeze } from './internal/freeze.js';
import type { ApprovalRecord } from './record.js';

/** 与 business-core EVENT_TYPE_PATTERN 同形（其未导出，按零件各造镜像）。 */
const APPROVAL_EVENT_TYPE_PATTERN = /^smes\.[a-z0-9-]+\.v\d+\.[a-z0-9-]+$/;

export interface ApprovalEventPayload {
  readonly flowId: string;
  readonly from: string;
  readonly to: string;
  /** 触发迁移的命令动词（SCREAMING_SNAKE_CASE，来自配置）。 */
  readonly event: string;
  /** 迁移后对象版本。 */
  readonly objectVersion: number;
  /** 动作人（提交命令的人，品牌化）。 */
  readonly actor: UserIdType;
  /** 命令理由（审计）。 */
  readonly reason: string;
  /** 决策类迁移附带的审批记录（非决策迁移无此字段）。 */
  readonly record?: ApprovalRecord;
}

export interface ApprovalEvent {
  readonly eventId: EventId;
  readonly eventType: string;
  readonly aggregate: EventAggregateRef;
  /** ISO 8601，迁移时刻。 */
  readonly occurredAt: string;
  readonly payload: ApprovalEventPayload;
}

export interface ApprovalEventInput {
  readonly eventId: EventId;
  readonly eventType: string;
  readonly aggregate: EventAggregateRef;
  readonly occurredAt: string;
  readonly payload: ApprovalEventPayload;
}

/** 构造审批事件：校验后深冻结返回。 */
export function makeApprovalEvent(input: ApprovalEventInput): ApprovalEvent {
  const { eventId, eventType, aggregate, occurredAt, payload } = input;

  if (!EventId.is(eventId)) {
    throw new Error('invalid event identity: eventId must be a valid branded id');
  }
  if (typeof eventType !== 'string' || !APPROVAL_EVENT_TYPE_PATTERN.test(eventType) || eventType.length > 128) {
    throw new Error(`invalid eventType: expected smes.<flowId>.v<n>.<past-action>, got "${String(eventType)}"`);
  }
  if (
    typeof aggregate?.id !== 'string' ||
    aggregate.id.length === 0 ||
    typeof aggregate?.type !== 'string' ||
    aggregate.type.length === 0
  ) {
    throw new Error('invalid aggregate: id and type must be non-empty strings');
  }
  if (!Number.isInteger(aggregate.revision) || aggregate.revision < 1) {
    throw new Error('invalid aggregate.revision: expected an integer >= 1');
  }
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error('invalid occurredAt: expected an ISO 8601 date-time string');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error('invalid payload: expected an object');
  }

  return deepFreeze<ApprovalEvent>({ eventId, eventType, aggregate, occurredAt, payload });
}

/**
 * 适配器：审批事件 → BusinessEventInput（补 tenantId 即可入 business-core 事件账本）。
 * 后续 business-store 持久化 increment 的形状契约由本函数固定，防两端各自漂移。
 */
export function toBusinessEventInput(
  event: ApprovalEvent,
  identity: { readonly tenantId: TenantId },
): BusinessEventInput<ApprovalEventPayload> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    tenantId: identity.tenantId,
    aggregate: event.aggregate,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}
