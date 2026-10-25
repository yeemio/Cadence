import { describe, expect, expectTypeOf, it } from 'vitest';
import { TenantId, UserId, WorkOrderId } from '@smes/business-core';
import {
  EMPTY_PAYROLL_SOURCE,
  EarningsRecordId,
  PayrollRuleId,
  PayRunId,
  type EarningsRecordRow,
  type PayPeriod,
  type PayrollRuleRow,
  type PayrollSource,
  type VerifiedLaborFact,
} from '../src/index.js';

/**
 * 端口形状（类型级）。M3 冻结合同 v1.0 §8 定稿形状：
 * 品牌化 PayrollRuleId/PayRunId/EarningsRecordId（差异表 #2）、量纲冻结
 * rate=分/小时 & amount=分（#4）、工种五词（m2 v1.1）。原 4 用例的断言意图
 * 不变（可构造可冻结 / 品牌隔离 / 事实口径 / 端口异步自洽），仅按定稿形状
 * 最小适配。
 */
describe('payroll 端口形状（类型级）', () => {
  it('PayPeriod / PayrollRuleRow / EarningsRecordRow 可构造、可冻结', () => {
    const period: PayPeriod = Object.freeze({
      periodKey: '2026-10',
      kind: 'month',
      startsOn: '2026-10-01',
      endsOn: '2026-10-31',
    });
    const rule: PayrollRuleRow = Object.freeze({
      id: 'prl-00000000-0000-7000-8000-000000000001',
      tenant: TenantId.create('t-1'),
      ruleId: PayrollRuleId.create('part-hourly'),
      name: '零件时薪',
      basis: 'hours',
      rateMinor: 3500,
      coefficient: 1.5,
      scope: { laborKind: 'part' as const },
      objectVersion: 2,
      supersedes: 'prl-00000000-0000-7000-8000-000000000000',
      auditStatus: 'published',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const record: EarningsRecordRow = Object.freeze({
      id: EarningsRecordId.create('ern-1'),
      tenant: rule.tenant,
      seq: 1,
      personId: UserId.create('user-1'),
      periodKey: period.periodKey,
      ruleId: rule.ruleId,
      ruleVersion: 2,
      basis: 'hours',
      laborKind: 'part',
      quantity: 160,
      rateMinor: 3500,
      coefficient: 1.5,
      amountMinor: 840000, // 160 × 3500 × 1.5 = 840000（分）
      payRunId: PayRunId.create('pr-1'),
      sourceRefs: ['le-1', 'le-2'],
      sourceKey: 'run:pr-1|user-1|part',
      occurredAt: '2026-11-01T00:00:00.000Z',
      recordedBy: 'u-hr-1',
      objectVersion: 1,
      auditStatus: 'computed',
    });
    expect(Object.isFrozen(period)).toBe(true);
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.ruleVersion).toBe(2);
    expectTypeOf(record.sourceRefs).toEqualTypeOf<readonly string[]>();
  });

  it('品牌化身份：ruleId/id 品牌化、personId 是 UserId，不可与其他品牌互赋', () => {
    const record = {} as EarningsRecordRow;
    expectTypeOf(record.personId).toEqualTypeOf<UserId>();
    expectTypeOf(record.ruleId).toEqualTypeOf<PayrollRuleId>();
    expectTypeOf(record.id).toEqualTypeOf<EarningsRecordId>();
    expectTypeOf(record.payRunId).toEqualTypeOf<PayRunId>();
    // @ts-expect-error 裸字符串不能当品牌化 id（编译期拦截；反向——品牌可读作 string）
    const notBranded: PayrollRuleId = 'part-hourly';
    // @ts-expect-error WorkOrderId 不是 UserId（品牌隔离，编译期拦截）
    expectTypeOf<WorkOrderId>().toMatchTypeOf<UserId>();
    expect(notBranded).toBe('part-hourly');
    expect(PayRunId.create('pr-1')).toBe('pr-1');
  });

  it('VerifiedLaborFact 携带 hours 产出口径（人×月×工种五词×净工时×来源）', () => {
    const fact: VerifiedLaborFact = Object.freeze({
      personId: UserId.create('user-1'),
      periodKey: '2026-10',
      laborKind: 'part',
      hours: 160,
      sourceEntryIds: ['le-1'],
    });
    expect(Object.isFrozen(fact)).toBe(true);
    expectTypeOf(fact.personId).toEqualTypeOf<UserId>();
    expectTypeOf(fact.hours).toEqualTypeOf<number>();
  });

  it('PayrollSource 端口可实现并可异步消费（fake 证明形状自洽；缺省空源恒空）', async () => {
    const facts: VerifiedLaborFact[] = [
      { personId: UserId.create('user-1'), periodKey: '2026-10', laborKind: 'part', hours: 8, sourceEntryIds: ['le-1'] },
    ];
    const source: PayrollSource = {
      readVerifiedLabor: async (request) =>
        facts.filter((fact) => fact.periodKey === request.periodKey),
    };
    const out = await source.readVerifiedLabor({ tenantId: 'default' as never, periodKey: '2026-10', personIds: [UserId.create('user-1')] });
    expect(out.length).toBe(1);
    expect(out[0]?.hours).toBe(8);
    expect(await source.readVerifiedLabor({ tenantId: 'default' as never, periodKey: '2026-11' })).toEqual([]);
    // 缺省空源（零接线 boot 语义）：恒空事实集
    expect(await EMPTY_PAYROLL_SOURCE.readVerifiedLabor({ tenantId: 'default' as never, periodKey: '2026-10' })).toEqual([]);
  });
});
