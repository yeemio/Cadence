/**
 * PayrollService 行为测试（M3，m3-drafts/01-payroll.md v1.0 Done-when 与 §7 对账要点）。
 *
 * 覆盖面（差异表逐行 + 合同冻结语义）：
 *  - #1 scope.personId 维度与匹配优先级（person 精确 > laborKind > 周期兜底）；
 *  - #2 品牌化 ID（ports.test.ts 承担类型级；此处验证行 id 前缀）；
 *  - #3 PayRun 核算批次锚（supersedes 版本链 + 幂等重算零漂移）；
 *  - #4 量纲冻结（rate=分/小时整数、amount=分 half-up）；
 *  - #6 v1 锁 month（非法周期键拒绝）；
 *  - #7 basis=output 拒绝（v1 只接 hours）；
 *  - G1 先解析校验后记账（被拒命令不占用 operationId）；
 *  - EarningsRecord append-only 重写不改原行（costing delta 先例）；
 *  - 导出端口化 json-tables；事件携规则版本集与周期键。
 */
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  InMemoryPayrollDomainEventStore,
  InMemoryPayrollOperationStore,
  InMemoryPayrollRuleStore,
  InMemoryPayRunStore,
  InMemoryEarningsRecordStore,
  PAYROLL_EVENT_TYPES,
  PayrollInputError,
  PayrollService,
  type EarningsRecordRow,
  type PayrollCommandEnvelope,
  type PayrollSource,
  type VerifiedLaborFact,
} from '../src/index.js';

// ---- 测试装配 ----

const TENANT = TenantId.create('t-payroll-test');
const HR = UserId.create('u-hr-1');

/** 可编程工时事实源（PayrollSource 假实现——组合根适配器的测试替身）。 */
class FakePayrollSource {
  readonly facts: VerifiedLaborFact[] = [];
  constructor(...seed: VerifiedLaborFact[]) {
    this.facts.push(...seed);
  }
  async readVerifiedLabor(request: Parameters<PayrollSource['readVerifiedLabor']>[0]): Promise<readonly VerifiedLaborFact[]> {
    return this.facts.filter(
      (fact) =>
        fact.periodKey === request.periodKey &&
        (request.personIds === undefined || request.personIds.some((person) => person === fact.personId)),
    );
  }
}

function fact(personId: string, laborKind: VerifiedLaborFact['laborKind'], hours: number, sourceEntryIds: string[], periodKey = '2026-10'): VerifiedLaborFact {
  return { personId: UserId.create(personId), periodKey, laborKind, hours, sourceEntryIds };
}

interface Harness {
  readonly service: PayrollService;
  readonly source: FakePayrollSource;
  readonly runs: InMemoryPayrunStoreHandle;
}

interface InMemoryPayrunStoreHandle {
  readonly allRuns: () => Promise<readonly { id: string; personId: string; objectVersion: number; supersedes: string | null }[]>;
  readonly allRecords: () => Promise<readonly EarningsRecordRow[]>;
}

function makeHarness(...facts: VerifiedLaborFact[]): Harness {
  const source = new FakePayrollSource(...facts);
  const ruleStore = new InMemoryPayrollRuleStore();
  const runStore = new InMemoryPayRunStore();
  const recordStore = new InMemoryEarningsRecordStore();
  const eventStore = new InMemoryPayrollDomainEventStore();
  const operationStore = new InMemoryPayrollOperationStore();
  const service = new PayrollService(
    { rules: ruleStore, runs: runStore, records: recordStore, events: eventStore, operations: operationStore },
    source,
    undefined,
    { now: () => '2026-11-01T08:00:00.000Z' },
  );
  return {
    service,
    source,
    runs: {
      allRuns: async () =>
        (await runStore.listByPeriod(TENANT, '2026-10')).map((row) => ({
          id: row.id,
          personId: row.personId,
          objectVersion: row.objectVersion,
          supersedes: row.supersedes,
        })),
      allRecords: () => recordStore.list(TENANT),
    },
  };
}

let opCounter = 0;
function envelope(
  kind: PayrollCommandEnvelope['command']['kind'],
  payload: unknown,
  expectedRevision: number | 'initial' = 'initial',
  operationId?: string,
): PayrollCommandEnvelope {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: TENANT,
    issuedBy: HR,
    operationId: OperationId.create(operationId ?? `op-payroll-${String(opCounter).padStart(4, '0')}`),
    expectedRevision,
    issuedAt: '2026-11-01T08:00:00.000Z',
    command: { kind, payload },
  });
}

async function publish(h: Harness, payload: Record<string, unknown>, expectedRevision: number | 'initial' = 'initial', operationId?: string) {
  return h.service.execute(TENANT, envelope('payroll.rule.publish.v1', payload, expectedRevision, operationId));
}

async function runMonth(h: Harness, payload: Record<string, unknown>, operationId?: string) {
  return h.service.execute(TENANT, envelope('payroll.run.month.v1', payload, 'initial', operationId));
}

const BASE_RULES = [
  { ruleId: 'part-hourly', rateMinor: 2000, scope: { laborKind: 'part' as const } },
  { ruleId: 'base-hourly', rateMinor: 1500, scope: {} },
];

async function publishBaseRules(h: Harness): Promise<void> {
  for (const rule of BASE_RULES) {
    const result = await publish(h, { ruleId: rule.ruleId, rateMinor: rule.rateMinor, scope: rule.scope });
    expect(result.status).toBe('committed');
  }
}

// ---- payroll.rule.publish.v1（86 时薪维护面） ----

describe('payroll.rule.publish.v1', () => {
  it('首发 v1 committed + PayrollRulePublished 事件；改价=新版本行（历史可复算）', async () => {
    const h = makeHarness();
    const first = await publish(h, { ruleId: 'part-hourly', rateMinor: 2000, scope: { laborKind: 'part' } });
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') return;
    expect(first.rule?.objectVersion).toBe(1);
    expect(first.rule?.status).toBe('current');
    expect(first.events.map((event) => event.eventType)).toEqual([PAYROLL_EVENT_TYPES.payrollRulePublished]);
    // 改价 = 修订（expectedRevision 乐观锁）→ v2 supersedes v1
    const second = await publish(h, { ruleId: 'part-hourly', rateMinor: 2500, scope: { laborKind: 'part' } }, 1);
    expect(second.status).toBe('committed');
    if (second.status !== 'committed') return;
    expect(second.rule?.objectVersion).toBe(2);
    expect(second.rule?.status).toBe('current');
    // 历史版本仍在（版本列表：当前在前、历史可复算回看）
    const views = await h.service.ruleVersions(TENANT);
    expect(views.map((view) => `${view.ruleId}@v${view.objectVersion}:${view.status}`)).toEqual([
      'part-hourly@v2:current',
      'part-hourly@v1:superseded',
    ]);
  });

  it('scope.personId 维度（差异表 #1：按人定价规则可发布）', async () => {
    const h = makeHarness();
    const result = await publish(h, {
      ruleId: 'u1-premium',
      rateMinor: 5000,
      scope: { personId: 'u-worker-1', laborKind: 'part' },
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.rule?.scope).toEqual({ personId: 'u-worker-1', laborKind: 'part' });
  });

  it('量纲门禁（#4）：rate 非整数/非正拒绝；coefficient 越界拒绝；basis=output 拒绝（#7）', async () => {
    const h = makeHarness();
    await expect(publish(h, { ruleId: 'bad-rate', rateMinor: 20.5 })).rejects.toBeInstanceOf(PayrollInputError);
    await expect(publish(h, { ruleId: 'bad-rate', rateMinor: 0 })).rejects.toBeInstanceOf(PayrollInputError);
    await expect(publish(h, { ruleId: 'bad-coeff', rateMinor: 1000, coefficient: 0 })).rejects.toBeInstanceOf(PayrollInputError);
    await expect(
      publish(h, { ruleId: 'bad-basis', rateMinor: 1000, basis: 'output' }),
    ).rejects.toThrowError(/v1 只接 'hours'/);
    await expect(publish(h, { ruleId: 'Bad_Case', rateMinor: 1000 })).rejects.toThrowError(/kebab-case/);
  });

  it('首发/修订乐观锁：错配 rejected；G1 被拒不占用 operationId（同 id 修正重发成功）', async () => {
    const h = makeHarness();
    await publishBaseRules(h);
    // 已存在却走 initial → rejected
    const rejected = await publish(h, { ruleId: 'part-hourly', rateMinor: 3000 }, 'initial', 'op-g1-fix');
    expect(rejected.status).toBe('rejected');
    // 同 operationId 修正 expectedRevision 重发 → committed（被拒不占用 id）
    const retried = await publish(h, { ruleId: 'part-hourly', rateMinor: 3000 }, 1, 'op-g1-fix');
    expect(retried.status).toBe('committed');
    // 已 committed 的同 id 再发 → 幂等拒绝（不变量 3）
    const replay = await publish(h, { ruleId: 'part-hourly', rateMinor: 3000 }, 2, 'op-g1-fix');
    expect(replay.status).toBe('rejected');
    // 版本错配
    const mismatch = await publish(h, { ruleId: 'part-hourly', rateMinor: 4000 }, 7);
    expect(mismatch.status).toBe('rejected');
    if (mismatch.status === 'rejected') expect(mismatch.reason).toContain('乐观锁冲突');
  });
});

// ---- payroll.run.month.v1（87 月度核算/重算） ----

describe('payroll.run.month.v1', () => {
  it('月度核算：金额 = 净工时 × 时薪 × 系数（对账口径）；sourceRefs 下钻；事件携规则版本集', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1', 'le-2']), fact('u-worker-1', 'oddjob', 40, ['le-3']));
    await publishBaseRules(h);
    const result = await runMonth(h, { periodKey: '2026-10' });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.personsComputed).toBe(1);
    expect(result.runsWritten).toBe(1);
    expect(result.recordsWritten).toBe(2);
    const run = result.runs?.[0];
    expect(run?.objectVersion).toBe(1);
    // part: 160 × 2000 = 320000；oddjob: 40 × 1500（周期兜底）= 60000
    expect(run?.totalAmountMinor).toBe(380000);
    expect(run?.totalQuantity).toBe(200);
    // 下钻：人×月结果带 sourceRefs（→ hours LaborEntry 锚点）
    const views = await h.service.runResults(TENANT, '2026-10');
    expect(views).toHaveLength(1);
    const lines = views[0]!.lines;
    expect(lines.map((line) => `${line.laborKind}:${line.amountMinor}:${line.ruleId}`).sort()).toEqual([
      'oddjob:60000:base-hourly',
      'part:320000:part-hourly',
    ]);
    expect(lines.find((line) => line.laborKind === 'part')?.sourceRefs).toEqual(['le-1', 'le-2']);
    // 事件：PayRunComputed 携规则版本集与周期键
    const events = await h.service.listEvents(TENANT);
    const runEvent = events.find((event) => event.eventType === PAYROLL_EVENT_TYPES.payRunComputed);
    expect(runEvent).toBeDefined();
    const payload = runEvent!.payload as { periodKey: string; ruleVersions: { ruleId: string }[]; changed: boolean };
    expect(payload.periodKey).toBe('2026-10');
    expect(payload.ruleVersions.map((ref) => ref.ruleId).sort()).toEqual(['base-hourly', 'part-hourly']);
    expect(payload.changed).toBe(true);
  });

  it('匹配优先级（#1/§7）：person+工种 > 仅 person > 仅工种 > 周期兜底', async () => {
    const h = makeHarness(
      fact('u-worker-1', 'part', 10, ['le-a']),
      fact('u-worker-1', 'oddjob', 10, ['le-b']),
      fact('u-worker-2', 'part', 10, ['le-c']),
      fact('u-worker-3', 'assembly', 10, ['le-d']),
    );
    await publish(h, { ruleId: 'u1-part-premium', rateMinor: 5000, scope: { personId: 'u-worker-1', laborKind: 'part' } });
    await publish(h, { ruleId: 'u1-any', rateMinor: 4000, scope: { personId: 'u-worker-1' } });
    await publish(h, { ruleId: 'part-hourly', rateMinor: 2000, scope: { laborKind: 'part' } });
    await publish(h, { ruleId: 'base-hourly', rateMinor: 1500, scope: {} });
    const result = await runMonth(h, { periodKey: '2026-10' });
    expect(result.status).toBe('committed');
    const views = await h.service.runResults(TENANT, '2026-10');
    const byPerson = new Map(views.flatMap((view) => view.lines.map((line) => [`${line.personId}:${line.laborKind}`, `${line.ruleId}:${line.amountMinor}`])));
    expect(byPerson.get('u-worker-1:part')).toBe('u1-part-premium:50000'); // tier 1
    expect(byPerson.get('u-worker-1:oddjob')).toBe('u1-any:40000'); // tier 2（仅 person）
    expect(byPerson.get('u-worker-2:part')).toBe('part-hourly:20000'); // tier 3（仅工种）
    expect(byPerson.get('u-worker-3:assembly')).toBe('base-hourly:15000'); // tier 4（兜底）
  });

  it('同档歧义与无规则可匹配均显式拒绝（不静默）', async () => {
    const ambiguous = makeHarness(fact('u-worker-1', 'part', 10, ['le-a']));
    await publish(ambiguous, { ruleId: 'part-a', rateMinor: 2000, scope: { laborKind: 'part' } });
    await publish(ambiguous, { ruleId: 'part-b', rateMinor: 2100, scope: { laborKind: 'part' } });
    const rejected = await runMonth(ambiguous, { periodKey: '2026-10' });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toContain('歧义');

    const noRule = makeHarness(fact('u-worker-1', 'part', 10, ['le-a']));
    await publish(noRule, { ruleId: 'u1-only', rateMinor: 2000, scope: { personId: 'u-worker-9' } });
    const none = await runMonth(noRule, { periodKey: '2026-10' });
    expect(none.status).toBe('rejected');
    if (none.status === 'rejected') expect(none.reason).toContain('无可匹配计薪规则');
  });

  it('未知工种词整批拒绝且不占用 operationId（G1 + 五词门禁）；修好事实源后同 id 重发成功', async () => {
    const h = makeHarness();
    await publishBaseRules(h);
    h.source.facts.push({
      personId: UserId.create('u-worker-1'),
      periodKey: '2026-10',
      laborKind: 'machining' as VerifiedLaborFact['laborKind'],
      hours: 10,
      sourceEntryIds: ['le-1'],
    });
    const rejected = await runMonth(h, { periodKey: '2026-10' }, 'op-vocab-fix');
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toContain('未知工种');
    // 修正事实源（合法五词）后同 operationId 重发 → committed
    h.source.facts.length = 0;
    h.source.facts.push(fact('u-worker-1', 'part', 10, ['le-1']));
    const retried = await runMonth(h, { periodKey: '2026-10' }, 'op-vocab-fix');
    expect(retried.status).toBe('committed');
  });

  it('非法周期键拒绝（#6：v1 锁 month）', async () => {
    const h = makeHarness();
    await expect(runMonth(h, { periodKey: '2026-W44' })).rejects.toBeInstanceOf(PayrollInputError);
    await expect(runMonth(h, { periodKey: '2026-13' })).rejects.toBeInstanceOf(PayrollInputError);
    const locked = await h.service.execute(
      TENANT,
      envelope('payroll.run.month.v1', { periodKey: '2026-10' }, 3),
    );
    expect(locked.status).toBe('rejected');
  });

  it('幂等重算零漂移（#3/§7）：同事实同规则重算不追加新版本行不改记录；快照对比无漂移', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1', 'le-2']));
    await publishBaseRules(h);
    const first = await runMonth(h, { periodKey: '2026-10' });
    expect(first.status).toBe('committed');
    const beforeRuns = await h.runs.allRuns();
    const beforeRecords = await h.runs.allRecords();
    const beforeViews = await h.service.runResults(TENANT, '2026-10');
    const second = await runMonth(h, { periodKey: '2026-10' });
    expect(second.status).toBe('committed');
    if (second.status !== 'committed') return;
    expect(second.runsWritten).toBe(0);
    expect(second.recordsWritten).toBe(0);
    expect(second.runs?.[0]?.changed).toBe(false);
    // 快照对比零漂移：链长不变、记录集不变、视图不变
    expect(await h.runs.allRuns()).toEqual(beforeRuns);
    expect(await h.runs.allRecords()).toEqual(beforeRecords);
    expect(await h.service.runResults(TENANT, '2026-10')).toEqual(beforeViews);
    const events = await h.service.listEvents(TENANT);
    const runEvents = events.filter((event) => event.eventType === PAYROLL_EVENT_TYPES.payRunComputed);
    expect(runEvents).toHaveLength(2);
    expect((runEvents[1]!.payload as { changed: boolean }).changed).toBe(false);
  });

  it('变更重算（改价→v2 新 PayRun 版本 supersedes；EarningsRecord 逐条重写不改原行）', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1', 'le-2']));
    await publishBaseRules(h);
    await runMonth(h, { periodKey: '2026-10' });
    const v1Records = await h.runs.allRecords();
    expect(v1Records).toHaveLength(1);
    const v1RecordId = v1Records[0]!.id;
    const v1RunId = v1Records[0]!.payRunId;
    // 改价 = 发新规则版本（历史核算引用旧版本可复算）
    await publish(h, { ruleId: 'part-hourly', rateMinor: 2500, scope: { laborKind: 'part' } }, 1);
    const recompute = await runMonth(h, { periodKey: '2026-10' });
    expect(recompute.status).toBe('committed');
    if (recompute.status !== 'committed') return;
    expect(recompute.runsWritten).toBe(1);
    expect(recompute.runs?.[0]?.objectVersion).toBe(2);
    expect(recompute.runs?.[0]?.totalAmountMinor).toBe(400000); // 160 × 2500
    // 旧记录不改原行（append-only）：原行仍在且值不变；新行引用新批次
    const allRecords = await h.runs.allRecords();
    expect(allRecords).toHaveLength(2);
    const v1Row = allRecords.find((row) => row.id === v1RecordId)!;
    expect(v1Row.payRunId).toBe(v1RunId);
    expect(v1Row.amountMinor).toBe(320000); // 当时规则版本（v1@2000）快照不变
    const v2Row = allRecords.find((row) => row.id !== v1RecordId)!;
    expect(v2Row.payRunId).not.toBe(v1RunId);
    expect(v2Row.amountMinor).toBe(400000);
    expect(v2Row.ruleVersion).toBe(2);
    // supersedes 链：v2 取代 v1；runResults 只显当前版；历史批次按当时规则版本复算
    const runs = await h.runs.allRuns();
    expect(runs.map((row) => row.objectVersion)).toEqual([1, 2]);
    expect(runs[1]!.supersedes).toBe(runs[0]!.id);
    const views = await h.service.runResults(TENANT, '2026-10');
    expect(views[0]!.payRunId).toBe(runs[1]!.id);
    const history = await h.service.runDetail(TENANT, runs[0]!.id as never);
    expect(history.run.objectVersion).toBe(1);
    expect(history.lines[0]!.amountMinor).toBe(320000);
    expect(history.lines[0]!.ruleVersion).toBe(1);
  });

  it('单人聚焦与零事实语义：聚焦无历史批次不落空行；有历史批次落清零新版本', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1']), fact('u-worker-2', 'part', 80, ['le-2']));
    await publishBaseRules(h);
    const full = await runMonth(h, { periodKey: '2026-10' });
    expect(full.status).toBe('committed');
    if (full.status !== 'committed') return;
    expect(full.personsComputed).toBe(2);
    // 聚焦 u-worker-3（无事实、无历史批次）：不落空行批次
    const empty = await runMonth(h, { periodKey: '2026-10', personId: 'u-worker-3' });
    expect(empty.status).toBe('committed');
    if (empty.status !== 'committed') return;
    expect(empty.personsComputed).toBe(0);
    expect(empty.runsWritten).toBe(0);
    // 聚焦 u-worker-1 且事实清零：期望态清零 → 新版本 v2（lineCount=0）
    h.source.facts.length = 0;
    const cleared = await runMonth(h, { periodKey: '2026-10', personId: 'u-worker-1' });
    expect(cleared.status).toBe('committed');
    if (cleared.status !== 'committed') return;
    expect(cleared.runs?.[0]?.objectVersion).toBe(2);
    expect(cleared.runs?.[0]?.lineCount).toBe(0);
    expect(cleared.runs?.[0]?.totalAmountMinor).toBe(0);
  });

  it('half-up 到分（#4）：乘积落在 .5 上取整（非银行家舍入）', async () => {
    const h = makeHarness(fact('u-worker-9', 'part', 0.5, ['le-x']));
    await publish(h, { ruleId: 'part-hourly', rateMinor: 5, scope: { laborKind: 'part' } });
    const result = await runMonth(h, { periodKey: '2026-10' });
    expect(result.status).toBe('committed');
    const views = await h.service.runResults(TENANT, '2026-10');
    // 0.5 × 5 = 2.5 → half-up → 3（分）
    expect(views[0]!.lines[0]!.amountMinor).toBe(3);
    expect(views[0]!.totalAmountMinor).toBe(3);
  });
});

// ---- 查询与导出 ----

describe('查询面与 payroll.export.v1', () => {
  it('规则版本对比（rate/coefficient/scope 字段级差异）', async () => {
    const h = makeHarness();
    await publish(h, { ruleId: 'part-hourly', rateMinor: 2000, coefficient: 1, scope: { laborKind: 'part' } });
    await publish(h, { ruleId: 'part-hourly', rateMinor: 2500, coefficient: 1.5, scope: { laborKind: 'part' } }, 1);
    const comparison = await h.service.compareRules(TENANT, 'part-hourly' as never, 1, 2);
    expect(comparison.changed.map((diff) => diff.field).sort()).toEqual(['coefficient', 'rateMinor']);
    await expect(h.service.compareRules(TENANT, 'part-hourly' as never, 1, 9)).rejects.toThrowError(/不存在版本 9/);
  });

  it('我的工资（本人数据权限）：只取调用方身份的当前版结果', async () => {
    const h = makeHarness(
      fact('u-worker-1', 'part', 160, ['le-1']),
      fact('u-worker-2', 'part', 80, ['le-2']),
    );
    await publishBaseRules(h);
    await runMonth(h, { periodKey: '2026-10' });
    const mine = await h.service.myPayroll(TENANT, UserId.create('u-worker-1'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.personId).toBe('u-worker-1');
    expect(mine[0]!.totalAmountMinor).toBe(320000);
    const mine2 = await h.service.myPayroll(TENANT, UserId.create('u-worker-2'));
    expect(mine2[0]!.totalAmountMinor).toBe(160000);
    const none = await h.service.myPayroll(TENANT, UserId.create('u-worker-3'));
    expect(none).toHaveLength(0);
  });

  it('来源账目反查（对账锚：hours LaborEntry → 金额行）', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1', 'le-2']));
    await publishBaseRules(h);
    await runMonth(h, { periodKey: '2026-10' });
    const hits = await h.service.earningsBySourceRef(TENANT, 'le-2');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.amountMinor).toBe(320000);
    expect(await h.service.earningsBySourceRef(TENANT, 'le-99')).toHaveLength(0);
  });

  it('payroll.export.v1：json-tables 两表（汇总+明细）；空周期拒绝；读型命令不落事实', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 160, ['le-1']));
    await publishBaseRules(h);
    await runMonth(h, { periodKey: '2026-10' });
    const eventsBefore = (await h.service.listEvents(TENANT)).length;
    const result = await h.service.execute(TENANT, envelope('payroll.export.v1', { periodKey: '2026-10' }));
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.events).toEqual([]); // 读型命令不落事件/事实
    expect(result.export?.kind).toBe('json-tables');
    if (result.export?.kind !== 'json-tables') return;
    const [summary, detail] = result.export.sheets;
    expect(summary?.name).toBe('工资汇总');
    expect(summary?.rows[0]?.[0]).toBe('u-worker-1');
    expect(summary?.rows[0]?.[5]).toBe('320000');
    expect(detail?.name).toBe('工资明细');
    expect(detail?.rows[0]?.[8]).toBe('320000');
    expect(detail?.rows[0]?.[9]).toBe('le-1');
    // 空周期拒绝（显式优于空回声）
    const empty = await h.service.execute(TENANT, envelope('payroll.export.v1', { periodKey: '2026-12' }));
    expect(empty.status).toBe('rejected');
    expect((await h.service.listEvents(TENANT)).length).toBe(eventsBefore);
  });

  it('同 operationId 跨命令重发被拒（信封幂等不变量）', async () => {
    const h = makeHarness(fact('u-worker-1', 'part', 10, ['le-1']));
    await publishBaseRules(h);
    const first = await runMonth(h, { periodKey: '2026-10' }, 'op-dup');
    expect(first.status).toBe('committed');
    const replay = await runMonth(h, { periodKey: '2026-10' }, 'op-dup');
    expect(replay.status).toBe('rejected');
    if (replay.status === 'rejected') expect(replay.reason).toContain('幂等冲突');
  });
});
