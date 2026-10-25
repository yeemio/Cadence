import { describe, expect, it } from 'vitest';
import { UserId, type UserIdType } from '@smes/business-core';
import { makeApprovalRecord, type ApprovalRecordInput } from '../src/index.js';

const reviewer: UserIdType = UserId.create('user-001');

function baseInput(): ApprovalRecordInput {
  return {
    reviewer,
    decision: 'approve',
    reason: '对照放行标准通过',
    evidence: [{ kind: 'inspection', ref: 'insp-001' }],
    objectVersion: 3,
    decidedAt: '2026-10-25T10:00:00.000Z',
  };
}

describe('ApprovalRecord（DomainReview 对齐形状）', () => {
  it('构造合法记录：reviewer 品牌化 / 四值决策 + 理由 / evidence 引用 / objectVersion', () => {
    const record = makeApprovalRecord(baseInput());
    expect(record.reviewer).toBe('user-001');
    expect(record.decision).toBe('approve');
    expect(record.reason).toBe('对照放行标准通过');
    expect(record.evidence).toEqual([{ kind: 'inspection', ref: 'insp-001' }]);
    expect(record.objectVersion).toBe(3);
  });

  it('构造即深冻结（记录与 evidence 均不可变）', () => {
    const record = makeApprovalRecord(baseInput());
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.evidence)).toBe(true);
    expect(Object.isFrozen(record.evidence[0])).toBe(true);
    expect(() => {
      (record as { decision: string }).decision = 'reject';
    }).toThrow();
  });

  it('evidence 缺省为空冻结数组', () => {
    const input = baseInput();
    delete (input as { evidence?: unknown }).evidence;
    const record = makeApprovalRecord(input);
    expect(record.evidence).toEqual([]);
    expect(Object.isFrozen(record.evidence)).toBe(true);
  });

  it('拒绝：空/非字符串 reviewer（品牌纪律是类型级，运行时校验字符串形状）/ 越集 decision / 空理由 / 坏 evidence / 版本<1 / 非法时间', () => {
    expect(() => makeApprovalRecord({ ...baseInput(), reviewer: '' as UserIdType })).toThrow(/reviewer/);
    expect(() => makeApprovalRecord({ ...baseInput(), reviewer: 123 as unknown as UserIdType })).toThrow(/reviewer/);
    expect(() => makeApprovalRecord({ ...baseInput(), decision: 'sign' as never })).toThrow(/decision/);
    expect(() => makeApprovalRecord({ ...baseInput(), reason: '   ' })).toThrow(/reason/);
    expect(() => makeApprovalRecord({ ...baseInput(), evidence: [{ kind: '', ref: 'x' }] })).toThrow(/evidence/);
    expect(() => makeApprovalRecord({ ...baseInput(), evidence: [{ kind: 'k', ref: '' }] })).toThrow(/evidence/);
    expect(() => makeApprovalRecord({ ...baseInput(), objectVersion: 0 })).toThrow(/objectVersion/);
    expect(() => makeApprovalRecord({ ...baseInput(), decidedAt: 'someday' })).toThrow(/decidedAt/);
  });
});
