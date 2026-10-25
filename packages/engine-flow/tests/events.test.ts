import { describe, expect, it } from 'vitest';
import { EventId, TenantId, UserId, makeBusinessEvent } from '@smes/business-core';
import { makeApprovalEvent, toBusinessEventInput, type ApprovalEventInput } from '../src/index.js';

function baseInput(): ApprovalEventInput {
  return {
    eventId: EventId.create('evt-001'),
    eventType: 'smes.general-approval.v1.approved',
    aggregate: { id: 'wo-001', type: 'workorder', revision: 4 },
    occurredAt: '2026-10-25T10:00:00.000Z',
    payload: {
      flowId: 'general-approval',
      from: 'in_review',
      to: 'approved',
      event: 'APPROVE',
      objectVersion: 4,
      actor: UserId.create('user-001'),
      reason: '对照放行标准通过',
    },
  };
}

describe('ApprovalEvent（BusinessEvent 精简子集）', () => {
  it('构造合法事件：eventType 命名空间 smes.<flowId>.v1.<过去式动作>', () => {
    const event = makeApprovalEvent(baseInput());
    expect(event.eventType).toBe('smes.general-approval.v1.approved');
    expect(event.payload.from).toBe('in_review');
    expect(event.payload.to).toBe('approved');
  });

  it('构造即深冻结', () => {
    const event = makeApprovalEvent(baseInput());
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(() => {
      (event.payload as { to: string }).to = 'rejected';
    }).toThrow();
  });

  it('拒绝：越命名空间 eventType / 坏 aggregate / 非法时间', () => {
    expect(() => makeApprovalEvent({ ...baseInput(), eventType: 'approved' })).toThrow(/eventType/);
    expect(() =>
      makeApprovalEvent({ ...baseInput(), aggregate: { id: '', type: 'workorder', revision: 1 } }),
    ).toThrow(/aggregate/);
    expect(() =>
      makeApprovalEvent({ ...baseInput(), aggregate: { id: 'wo-001', type: 'workorder', revision: 0 } }),
    ).toThrow(/revision/);
    expect(() => makeApprovalEvent({ ...baseInput(), occurredAt: 'now' })).toThrow(/occurredAt/);
  });

  it('toBusinessEventInput 补 tenantId 后可直接进 business-core 事件账本（形状对齐证明）', () => {
    const event = makeApprovalEvent(baseInput());
    const input = toBusinessEventInput(event, { tenantId: TenantId.create('t-001') });
    const businessEvent = makeBusinessEvent(input);
    expect(businessEvent.eventType).toBe('smes.general-approval.v1.approved');
    expect(businessEvent.aggregate.revision).toBe(4);
    expect(businessEvent.payload).toBe(event.payload);
  });
});
