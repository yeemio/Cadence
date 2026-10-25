/**
 * 业务事件基类（ADR-0003 #4 / #5）
 *
 * append-only 事件表的载荷形状。事件一旦构造即深冻结；
 * 持久化公共列（objectVersion / audit_status / provenance / supersedes /
 * business_time / available_time）见 evidence-columns.v1.md 与 evidence/evidence-columns.ts。
 */
import { EventId, TenantId } from '../ids.js';
import { deepFreeze } from '../internal/freeze.js';

const EVENT_TYPE_PATTERN = /^smes\.[a-z0-9-]+\.v\d+\.[a-z0-9-]+$/;

export interface EventAggregateRef {
  readonly id: string;
  readonly type: string;
  readonly revision: number;
}

export interface BusinessEvent<P = unknown> {
  readonly eventId: EventId;
  /** 命名空间形式：smes.<环节>.v<n>.<过去式动作>，如 smes.workorder.v1.created */
  readonly eventType: string;
  readonly tenantId: TenantId;
  readonly aggregate: EventAggregateRef;
  /** ISO 8601，事件发生时刻 */
  readonly occurredAt: string;
  /** 业务时间（可补录，口径见证据标准合同） */
  readonly businessTime?: string;
  /** 可用时间（对账 / 连接器口径） */
  readonly availableTime?: string;
  /** JSONB 溯源（operationId、命令信封摘要等） */
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly payload: P;
}

export interface BusinessEventInput<P> {
  readonly eventId: EventId;
  readonly eventType: string;
  readonly tenantId: TenantId;
  readonly aggregate: EventAggregateRef;
  readonly occurredAt: string;
  readonly payload: P;
  readonly businessTime?: string;
  readonly availableTime?: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export function isBusinessEvent(value: unknown): value is BusinessEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === 'string' &&
    typeof candidate.eventType === 'string' &&
    EVENT_TYPE_PATTERN.test(candidate.eventType) &&
    typeof candidate.tenantId === 'string' &&
    typeof candidate.occurredAt === 'string'
  );
}

export function makeBusinessEvent<P extends object>(input: BusinessEventInput<P>): BusinessEvent<P> {
  const { eventId, eventType, tenantId, aggregate, occurredAt, payload } = input;

  if (!EventId.is(eventId) || !TenantId.is(tenantId)) {
    throw new Error('invalid event identity: eventId / tenantId must be valid branded ids');
  }

  if (typeof eventType !== 'string' || !EVENT_TYPE_PATTERN.test(eventType) || eventType.length > 128) {
    throw new Error(`invalid eventType: expected smes.<module>.v<n>.<past-action>, got "${String(eventType)}"`);
  }
  if (typeof aggregate.id !== 'string' || aggregate.id.length === 0 || typeof aggregate.type !== 'string' || aggregate.type.length === 0) {
    throw new Error('invalid aggregate: id and type must be non-empty strings');
  }
  if (!Number.isInteger(aggregate.revision) || aggregate.revision < 1) {
    throw new Error('invalid aggregate.revision: expected an integer >= 1');
  }
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error('invalid occurredAt: expected an ISO 8601 date-time string');
  }
  if (input.businessTime !== undefined) {
    if (Number.isNaN(Date.parse(input.businessTime))) {
      throw new Error('invalid businessTime: expected an ISO 8601 date-time string');
    }
  }
  if (input.availableTime !== undefined) {
    if (Number.isNaN(Date.parse(input.availableTime))) {
      throw new Error('invalid availableTime: expected an ISO 8601 date-time string');
    }
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error('invalid payload: expected an object');
  }

  return deepFreeze<BusinessEvent<P>>({
    eventId,
    eventType,
    tenantId,
    aggregate,
    occurredAt,
    ...(input.businessTime === undefined ? {} : { businessTime: input.businessTime }),
    ...(input.availableTime === undefined ? {} : { availableTime: input.availableTime }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    payload,
  });
}
