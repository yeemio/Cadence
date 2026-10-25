import { describe, expect, it } from 'vitest';
import { EventId, TenantId, makeBusinessEvent } from '@smes/business-core';
import {
  fromBusinessEventRow,
  initialOutboxRow,
  toBusinessEventRow,
  toOutboxRecord,
  uuidv7,
} from '../src/index.js';

const tenant = TenantId.create('t-001');

function sampleEvent() {
  return makeBusinessEvent<{ qty: number }>({
    eventId: EventId.create(`evt-${uuidv7()}`),
    eventType: 'smes.workorder.v1.created',
    tenantId: tenant,
    aggregate: { id: uuidv7(), type: 'workorder', revision: 1 },
    occurredAt: '2026-10-24T10:00:00.000Z',
    businessTime: '2026-10-24T09:30:00.000Z',
    availableTime: '2026-10-24T10:00:05.000Z',
    provenance: { operationId: 'op-003', source: 'smes' },
    payload: { qty: 10 },
  });
}

describe('BusinessEvent ↔ 事件表行', () => {
  it('toBusinessEventRow：ISO→Date、aggregate 扁平化、冻结', () => {
    const row = toBusinessEventRow(sampleEvent());
    expect(row.occurredAt).toEqual(new Date('2026-10-24T10:00:00.000Z'));
    expect(row.businessTime).toEqual(new Date('2026-10-24T09:30:00.000Z'));
    expect(row.availableTime).toEqual(new Date('2026-10-24T10:00:05.000Z'));
    expect(row.aggregateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.aggregateType).toBe('workorder');
    expect(row.aggregateRevision).toBe(1);
    expect(row.payload).toEqual({ qty: 10 });
    expect(row.tenantId).toBe('t-001');
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('行 → 领域事件往返等值（经 makeBusinessEvent 重新校验 + 深冻结）', () => {
    const event = sampleEvent();
    const roundtrip = fromBusinessEventRow(toBusinessEventRow(event));
    expect(roundtrip).toEqual(event);
    expect(Object.isFrozen(roundtrip)).toBe(true);
    expect(Object.isFrozen(roundtrip.payload)).toBe(true);
  });

  it('可选列缺省时行内省略（往返仍等值）', () => {
    const event = makeBusinessEvent<{ ok: boolean }>({
      eventId: EventId.create(`evt-${uuidv7()}`),
      eventType: 'smes.workorder.v1.revised',
      tenantId: tenant,
      aggregate: { id: uuidv7(), type: 'workorder', revision: 2 },
      occurredAt: '2026-10-24T11:00:00.000Z',
      payload: { ok: true },
    });
    const row = toBusinessEventRow(event);
    expect('businessTime' in row).toBe(false);
    expect('provenance' in row).toBe(false);
    expect(fromBusinessEventRow(row)).toEqual(event);
  });

  it('fromBusinessEventRow 不信任库内数据：被篡改的行按核心校验拒绝', () => {
    const row = toBusinessEventRow(sampleEvent());
    expect(() =>
      fromBusinessEventRow({ ...row, aggregateRevision: 0 }),
    ).toThrow(/aggregate.revision/);
    expect(() => fromBusinessEventRow({ ...row, eventId: '' })).toThrow(/eventId/);
  });
});

describe('Outbox 行构造', () => {
  it('initialOutboxRow：attempts=0、deliveredAt=null、默认 createdAt=now', () => {
    const before = Date.now();
    const row = initialOutboxRow(`evt-${uuidv7()}`, tenant);
    expect(row.attempts).toBe(0);
    expect(row.deliveredAt).toBeNull();
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.tenantId).toBe('t-001');
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('拒绝空 eventId', () => {
    expect(() => initialOutboxRow('', tenant)).toThrow(/eventId/);
  });

  it('toOutboxRecord：行 → 领域 OutboxRecord（ISO、null 语义保留）', () => {
    const eventId = `evt-${uuidv7()}`;
    const created = new Date('2026-10-24T10:00:00.000Z');
    const record = toOutboxRecord(
      initialOutboxRow(eventId, tenant, created),
    );
    expect(record).toEqual({
      eventId,
      createdAt: '2026-10-24T10:00:00.000Z',
      attempts: 0,
      deliveredAt: null,
    });
  });
});
