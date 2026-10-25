import { describe, expect, it } from 'vitest';
import {
  makeBusinessEvent,
  isBusinessEvent,
  EventId,
  TenantId,
  type BusinessEventInput,
} from '../src/index.js';

function validInput(): BusinessEventInput<{ qty: number }> {
  return {
    eventId: EventId.create('evt-001'),
    eventType: 'smes.workorder.v1.created',
    tenantId: TenantId.create('t-001'),
    aggregate: { id: 'wo-001', type: 'workorder', revision: 1 },
    occurredAt: '2026-10-24T10:00:00.000Z',
    payload: { qty: 10 },
  };
}

describe('BusinessEvent', () => {
  it('构造合法事件', () => {
    const event = makeBusinessEvent(validInput());
    expect(event.eventType).toBe('smes.workorder.v1.created');
    expect(event.payload.qty).toBe(10);
  });

  it('拒绝不合命名空间规则的 eventType', () => {
    const input = validInput();
    expect(() => makeBusinessEvent({ ...input, eventType: 'workorder.created' })).toThrow();
    expect(() => makeBusinessEvent({ ...input, eventType: 'smes.workorder.created' })).toThrow();
  });

  it('拒绝 revision < 1 与非法时间', () => {
    const input = validInput();
    expect(() => makeBusinessEvent({ ...input, aggregate: { id: 'wo-001', type: 'workorder', revision: 0 } })).toThrow();
    expect(() => makeBusinessEvent({ ...input, occurredAt: 'yesterday' })).toThrow();
    expect(() => makeBusinessEvent({ ...input, businessTime: 'someday' })).toThrow();
  });

  it('payload 深冻结，可变时间戳合法传入后只读', () => {
    const event = makeBusinessEvent({ ...validInput(), businessTime: '2026-10-24T09:00:00.000Z' });
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(event.businessTime).toBe('2026-10-24T09:00:00.000Z');
  });

  it('isBusinessEvent 做结构识别', () => {
    const event = makeBusinessEvent(validInput());
    expect(isBusinessEvent(event)).toBe(true);
    expect(isBusinessEvent({ eventId: 'x' })).toBe(false);
  });
});
