/**
 * BusinessEvent ↔ 事件表行（event_records）双向映射。
 *
 * 载荷引用 business-core BusinessEvent 形状（不改其公共 API）：
 *   - toBusinessEventRow：领域事件（ISO 字符串）→ DB 行（Date；EventAggregateRef 扁平化为三列）
 *   - fromBusinessEventRow：DB 行 → 领域事件（经 makeBusinessEvent 重新校验 + 深冻结——
 *     读回路径不信任库内数据，与构造路径同一套校验）
 */
import { EventId, makeBusinessEvent, type BusinessEvent, type TenantId } from '@smes/business-core';

/** 事件表行形状（列名与 prisma/schema.prisma BusinessEventRecord 一致，时间为 Date）。 */
export interface BusinessEventRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: TenantId;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly businessTime?: Date;
  readonly availableTime?: Date;
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** JSONB 载荷（任意 JSON 对象） */
  readonly payload: unknown;
}

function isoToDate(value: string, column: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ${column}: expected an ISO 8601 date-time string, got "${value}"`);
  }
  return parsed;
}

/** 领域事件 → 事件表插入行（冻结）。 */
export function toBusinessEventRow(event: BusinessEvent<unknown>): BusinessEventRow {
  return Object.freeze({
    eventId: event.eventId,
    eventType: event.eventType,
    tenantId: event.tenantId,
    aggregateId: event.aggregate.id,
    aggregateType: event.aggregate.type,
    aggregateRevision: event.aggregate.revision,
    occurredAt: isoToDate(event.occurredAt, 'occurredAt'),
    ...(event.businessTime === undefined ? {} : { businessTime: isoToDate(event.businessTime, 'businessTime') }),
    ...(event.availableTime === undefined ? {} : { availableTime: isoToDate(event.availableTime, 'availableTime') }),
    ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
    payload: event.payload,
  });
}

/** 事件表行 → 领域事件（makeBusinessEvent 重新校验并深冻结）。 */
export function fromBusinessEventRow(row: BusinessEventRow): BusinessEvent<unknown> {
  // EventId.is 运行时为非空字符串校验，类型上完成 string → 品牌化窄化
  if (!EventId.is(row.eventId)) {
    throw new Error(`invalid eventId: expected a non-empty string of 1~128 chars`);
  }
  return makeBusinessEvent<Record<string, unknown>>({
    eventId: row.eventId,
    eventType: row.eventType,
    tenantId: row.tenantId,
    aggregate: { id: row.aggregateId, type: row.aggregateType, revision: row.aggregateRevision },
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload as Record<string, unknown>,
    ...(row.businessTime === undefined || row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === undefined || row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
    ...(row.provenance === undefined || row.provenance === null ? {} : { provenance: row.provenance as Record<string, unknown> }),
  });
}
