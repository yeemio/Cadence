/**
 * 审批行 <-> 领域形状映射测试（纯函数，零活库；行形状经 prisma generate 后
 * 由 typecheck 钉死）。往返合同：PG 行 → engine-flow 冻结领域对象（record/
 * event 经 makeApprovalRecord/makeApprovalEvent 构造即校验），案件行 →
 * application ApprovalCase（品牌化 id 还原）。
 */
import { describe, expect, it } from 'vitest';
import { EventId, TenantId, UserId } from '@smes/business-core';
import {
  rowToApprovalCase,
  rowToApprovalEvent,
  rowToApprovalRecordEntry,
} from '../src/approval/pg-approval-stores.js';

describe('approval 行映射（纯函数）', () => {
  it('案件行 → ApprovalCase（品牌化还原 + subjectRef 重组 + ISO 时间）', () => {
    const view = rowToApprovalCase({
      id: 'case-1',
      tenantId: 't1',
      flowConfigId: 'general-approval',
      state: 'in_review',
      objectVersion: 3,
      subjectType: 'item',
      subjectId: 'item-9',
      submitterId: 'bob',
      createdAt: new Date('2026-10-25T08:00:00.250Z'),
      updatedAt: new Date('2026-10-25T08:00:01Z'),
    });
    expect(view.id).toBe('case-1');
    expect(view.tenant).toBe(TenantId.create('t1'));
    expect(view.submitter).toBe(UserId.create('bob'));
    expect(view.subjectRef).toEqual({ type: 'item', id: 'item-9' });
    expect(view.state).toBe('in_review');
    expect(view.objectVersion).toBe(3);
    expect(view.createdAt).toBe('2026-10-25T08:00:00.250Z');
  });

  it('决策记录行 → engine ApprovalRecordStoreEntry（经 makeApprovalRecord 校验冻结）', () => {
    const entry = rowToApprovalRecordEntry({
      id: 'rec-1',
      aggregateId: 'case-1',
      aggregateType: 'approval-case',
      reviewerId: 'alice',
      decision: 'approve',
      reason: '同意',
      evidence: [{ kind: 'doc', ref: 'doc-1' }],
      objectVersion: 3,
      decidedAt: new Date('2026-10-25T09:00:00Z'),
    });
    expect(entry.aggregate).toEqual({ id: 'case-1', type: 'approval-case' });
    expect(entry.record.reviewer).toBe(UserId.create('alice'));
    expect(entry.record.decision).toBe('approve');
    expect(entry.record.evidence).toEqual([{ kind: 'doc', ref: 'doc-1' }]);
    expect(Object.isFrozen(entry.record)).toBe(true); // 构造即冻结（append-only 账本纪律）
  });

  it('决策记录行 evidence 非数组（历史脏数据防御）→ 空集收口', () => {
    const entry = rowToApprovalRecordEntry({
      id: 'rec-2',
      aggregateId: 'case-1',
      aggregateType: 'approval-case',
      reviewerId: 'alice',
      decision: 'reject',
      reason: '否',
      evidence: null,
      objectVersion: 3,
      decidedAt: new Date('2026-10-25T09:00:00Z'),
    });
    expect(entry.record.evidence).toEqual([]);
  });

  it('事件行 → engine ApprovalEvent（经 makeApprovalEvent 校验冻结，payload 原样）', () => {
    const payload = {
      flowId: 'general-approval',
      from: 'in_review',
      to: 'approved',
      event: 'APPROVE',
      objectVersion: 4,
      actor: 'alice',
      reason: '同意',
    };
    const event = rowToApprovalEvent({
      seq: 7n,
      eventId: 'evt-1',
      eventType: 'smes.general-approval.v1.approved',
      aggregateId: 'case-1',
      aggregateType: 'approval-case',
      aggregateRevision: 4,
      occurredAt: new Date('2026-10-25T09:00:01Z'),
      payload,
    });
    expect(event.eventId).toBe(EventId.create('evt-1'));
    expect(event.aggregate.revision).toBe(4);
    expect(event.payload.to).toBe('approved');
    expect(Object.isFrozen(event)).toBe(true);
  });
});
