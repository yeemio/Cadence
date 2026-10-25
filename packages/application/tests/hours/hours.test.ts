/**
 * hours 模块测试（M2-W6，08-hours.md v1.0）：verified 即时入账 / 撤销即时冲销 /
 * 修正联动（冲销 + 重入）/ 月度重算幂等与版本留痕 / 快照↔实时净额对账 /
 * 我的工时（本人）/ 机加工时统计 / 按工作令视图（额定对标端口）/ 幂等与
 * 乐观锁门 / 输入解析 / 模块装配与权限码。零框架直连（内存实现 + 可注入假端口）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { HOURS_EVENT_TYPES } from '../../src/hours/hours-events.js';
import {
  HoursInputError,
  HoursNotFoundError,
} from '../../src/hours/hours-errors.js';
import { minutesToHours } from '../../src/hours/hours-config.js';
import {
  parseHoursAdjustEntryPayload,
  parseHoursIngestPayload,
  parseHoursRebuildMonthPayload,
  parseMonthParam,
  requireHours,
  requireTrade,
} from '../../src/hours/hours-input.js';
import type {
  ReportEventFeedPort,
  ReportEventMessage,
  ReportEventPayloadShape,
  StandardTimePort,
} from '../../src/hours/hours-ports.js';
import {
  createInMemoryHoursStores,
  InMemoryHoursDomainEventStore,
  InMemoryHoursOperationStore,
  InMemoryLaborEntryStore,
  InMemoryLaborLedgerMonthStore,
} from '../../src/hours/in-memory-hours-stores.js';
import { HoursLedgerController } from '../../src/hours/hours.controllers.js';
import { HoursModule } from '../../src/hours/hours.module.js';
import { HoursService, type HoursCommandResult } from '../../src/hours/hours.service.js';
import type { HoursCommand, HoursCommandKind } from '../../src/hours/hours-input.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const w1 = UserId.create('u-worker-01');
const w2 = UserId.create('u-worker-02');
const operator = UserId.create('u-auditor-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版） ----

function verifiedPayload(overrides: Partial<ReportEventPayloadShape> = {}): ReportEventPayloadShape {
  return {
    reportId: 'rpt-0001',
    kind: 'part',
    dispatchId: 'dsp-0001',
    workOrderId: 'wo-0001',
    drawingNo: 'DWG-A',
    processCode: 'P01',
    worker: 'u-worker-01',
    doneQty: 10,
    hours: 8,
    workDate: '2026-10-05',
    revokeReason: null,
    actor: 'u-auditor-01',
    ...overrides,
  };
}

class FakeReportFeed implements ReportEventFeedPort {
  readonly messages: ReportEventMessage[] = [];
  readonly acknowledged: string[] = [];
  private counter = 0;

  seedVerified(payload: ReportEventPayloadShape): string {
    return this.push('ReportVerified', payload);
  }

  seedRevoked(payload: ReportEventPayloadShape): string {
    return this.push('ReportRevoked', payload);
  }

  private push(signal: ReportEventMessage['signal'], payload: ReportEventPayloadShape): string {
    this.counter += 1;
    const eventId = `evt-rpt-fixture-${this.counter}`;
    this.messages.push({ eventId, tenantId: 't1', occurredAt: FIXED_NOW, signal, payload });
    return eventId;
  }

  async pending(tenant: TenantId): Promise<readonly ReportEventMessage[]> {
    return this.messages
      .filter((message) => message.tenantId === tenant && !this.acknowledged.includes(message.eventId))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

class FakeStandardTime implements StandardTimePort {
  readonly table = new Map<string, number>();

  async standardHours(_tenant: TenantId, ref: { drawingNo: string | null; processCode: string | null }): Promise<number | null> {
    return this.table.get(`${ref.drawingNo ?? ''}|${ref.processCode ?? ''}`) ?? null;
  }
}

// ---- 服务装配 ----

interface Harness {
  readonly service: HoursService;
  readonly entries: InMemoryLaborEntryStore;
  readonly months: InMemoryLaborLedgerMonthStore;
  readonly events: InMemoryHoursDomainEventStore;
  readonly operations: InMemoryHoursOperationStore;
  readonly feed: FakeReportFeed;
  readonly standardTime: FakeStandardTime;
}

function harness(): Harness {
  const entries = new InMemoryLaborEntryStore();
  const months = new InMemoryLaborLedgerMonthStore();
  const events = new InMemoryHoursDomainEventStore();
  const operations = new InMemoryHoursOperationStore();
  const feed = new FakeReportFeed();
  const standardTime = new FakeStandardTime();
  const service = new HoursService(
    { entries, months, events, operations },
    { feed, standardTime },
    { now: () => FIXED_NOW },
  );
  return { service, entries, months, events, operations, feed, standardTime };
}

let opCounter = 0;

function envelope(
  kind: HoursCommandKind,
  payload: unknown,
  options: { readonly operationId?: string; readonly expectedRevision?: 'initial' | number; readonly tenant?: TenantId } = {},
): CommandEnvelope<HoursCommand> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: operator,
    operationId: OperationId.create(options.operationId ?? `op-hours-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as HoursCommand,
  });
}

function mustCommit(result: HoursCommandResult) {
  expect(result.status, `命令应 committed，得到 ${JSON.stringify(result)}`).toBe('committed');
  return result as Extract<HoursCommandResult, { status: 'committed' }>;
}

function mustReject(result: HoursCommandResult): string {
  expect(result.status, `命令应 rejected，得到 ${JSON.stringify(result)}`).toBe('rejected');
  return (result as { readonly reason: string }).reason;
}

// ---- 测试 ----

describe('hours 工时账（08-hours.md v1.0）', () => {
  it('verified 报工即时入账：类别→工种映射、事实链携带工作令维度、事件与消费位', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload()); // w1 part 8h qty10 wo-0001 P01
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'assembly', worker: 'u-worker-02', hours: 6, doneQty: 1, workDate: '2026-10-06' }),
    );
    const result = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect(result.ingested).toBe(2);
    expect(result.acknowledged).toBe(2);
    expect(h.feed.acknowledged.length).toBe(2);

    const entries = await h.entries.list(t1);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.direction === 'commit')).toBe(true);
    const first = entries.find((entry) => entry.sourceReportId === 'rpt-0001')!;
    expect(first.trade).toBe('machining'); // part → 机加
    expect(first.workOrderId).toBe('wo-0001');
    expect(first.drawingNo).toBe('DWG-A');
    expect(first.processCode).toBe('P01');
    expect(first.workDate).toBe('2026-10-05');
    expect(first.sourceKey).toBe('report:rpt-0001:c1');
    const second = entries.find((entry) => entry.sourceReportId === 'rpt-0002')!;
    expect(second.trade).toBe('assembly');

    const events = await h.events.list(t1);
    expect(events.filter((event) => event.eventType === HOURS_EVENT_TYPES.laborEntryCommitted)).toHaveLength(2);
  });

  it('同报工重放不重复入账（sourceKey 幂等）+ operationId 幂等拒绝', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    // 新事件 id、同一报工单（事件流重放口径）
    h.feed.seedVerified(verifiedPayload());
    const replay = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect(replay.ingested).toBe(0);
    expect(replay.skipped).toBe(1);
    expect(await h.entries.list(t1)).toHaveLength(1);

    // 同信封重发 → 首发通过、重发 rejected（不变量 3）
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {}, { operationId: 'op-hours-same' })));
    const dup = await h.service.execute(t1, envelope('hours.ingest.v1', {}, { operationId: 'op-hours-same' }));
    expect(dup.status).toBe('rejected');
    expect((dup as { reason: string }).reason).toContain('已落账');
  });

  it('撤销即时冲销：reverse 条目指回原条目、净额归零、LaborEntryReversed 事件', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'assembly', worker: 'u-worker-02', hours: 6, doneQty: 1, workDate: '2026-10-06' }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    h.feed.seedRevoked(verifiedPayload({ revokeReason: '报错工序' }));
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const entries = await h.entries.list(t1);
    expect(entries).toHaveLength(3);
    const reverse = entries.find((entry) => entry.direction === 'reverse')!;
    const commit = entries.find((entry) => entry.sourceKey === 'report:rpt-0001:c1')!;
    expect(reverse.sourceKey).toBe('report:rpt-0001:r1');
    expect(reverse.reverses).toBe(commit.id);
    expect(reverse.remark).toBe('报错工序');

    // 净额：w1 machining = 0；w2 assembly = 6（撤销不影响他人）
    const summary = await h.service.monthSummary(t1, '2026-10');
    const w1Row = summary.find((row) => row.workerId === 'u-worker-01')!;
    expect(w1Row.trade).toBe('machining');
    expect(w1Row.totalHours).toBe(0);
    expect(w1Row.entryCount).toBe(0);
    const w2Row = summary.find((row) => row.workerId === 'u-worker-02')!;
    expect(w2Row.totalHours).toBe(6);

    // 重复撤销事件 → 无可冲销（跳过）
    h.feed.seedRevoked(verifiedPayload());
    const again = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect(again.ingested).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await h.entries.list(t1)).toHaveLength(3);

    const events = await h.events.list(t1);
    expect(events.filter((event) => event.eventType === HOURS_EVENT_TYPES.laborEntryReversed)).toHaveLength(1);
  });

  it('修正联动（hours.adjust-entry correct）：冲销旧值 + 新值重入，净额 = 新值', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const adjusted = mustCommit(
      await h.service.execute(
        t1,
        envelope('hours.adjust-entry.v1', {
          reportId: 'rpt-0001',
          action: 'correct',
          kind: 'part',
          worker: 'u-worker-01',
          workDate: '2026-10-05',
          hours: 7,
          doneQty: 9,
          dispatchId: 'dsp-0001',
          workOrderId: 'wo-0001',
          drawingNo: 'DWG-A',
          processCode: 'P01',
          reason: '数量修正',
        }),
      ),
    );
    expect(adjusted.entries).toHaveLength(2); // 冲销 + 重入
    const entries = await h.entries.list(t1);
    expect(entries).toHaveLength(3);
    const summary = await h.service.monthSummary(t1, '2026-10');
    expect(summary[0]!.totalHours).toBe(7);
    expect(summary[0]!.outputQty).toBe(9);
    expect(summary[0]!.entryCount).toBe(1);
  });

  it('月度重算幂等且版本留痕；快照 = 实时净额（对账要点）', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'assembly', worker: 'u-worker-02', hours: 6, doneQty: 1, workDate: '2026-10-06' }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const first = mustCommit(await h.service.execute(t1, envelope('hours.rebuild-month.v1', { month: '2026-10' })));
    expect(first.rowsWritten).toBe(2);
    expect(first.groups!.every((group) => group.changed)).toBe(true);

    // 幂等重算：值未变 → 不追加新版本行、无漂移
    const second = mustCommit(await h.service.execute(t1, envelope('hours.rebuild-month.v1', { month: '2026-10' })));
    expect(second.rowsWritten).toBe(0);
    expect(second.groups!.every((group) => !group.changed)).toBe(true);
    const ledgers = await h.service.monthLedgers(t1, '2026-10');
    expect(ledgers).toHaveLength(2);
    expect(ledgers.every((row) => row.objectVersion === 1)).toBe(true);
    expect(await h.months.listByMonth(t1, '2026-10')).toHaveLength(2); // 仅 v1 行——重算不产生新行

    // 撤销后重算：w1 machining 出 v2（supersedes v1）——版本留痕
    h.feed.seedRevoked(verifiedPayload());
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    const third = mustCommit(await h.service.execute(t1, envelope('hours.rebuild-month.v1', { month: '2026-10' })));
    expect(third.rowsWritten).toBe(1);
    const chain = await h.service.monthChain(t1, 'u-worker-01', '2026-10', 'machining');
    expect(chain).toHaveLength(2);
    expect(chain[1]!.supersedes).toBe(chain[0]!.id);
    expect(chain[1]!.totalHours).toBe(0);

    // 对账：快照当前版 = 实时净额
    const current = (await h.service.monthLedgers(t1, '2026-10')).find((row) => row.workerId === 'u-worker-01')!;
    const live = (await h.service.monthSummary(t1, '2026-10')).find((row) => row.workerId === 'u-worker-01')!;
    expect(current.totalHours).toBe(live.totalHours);
    expect(current.outputQty).toBe(live.outputQty);
    expect(current.entryCount).toBe(live.entryCount);
  });

  it('月度重算跨租户隔离 + 乐观锁门（expectedRevision 非 initial 拒）', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-t2', worker: 'u-worker-t2' }));
    // t1 订阅端口不吐 t2 消息（租户过滤），t1 重算为空
    const empty = mustCommit(await h.service.execute(t1, envelope('hours.rebuild-month.v1', { month: '2026-10' })));
    expect(empty.rowsWritten).toBe(0);
    expect(empty.groups).toHaveLength(0);

    const gated = await h.service.execute(
      t1,
      envelope('hours.rebuild-month.v1', { month: '2026-10' }, { expectedRevision: 1 }),
    );
    expect(mustReject(gated)).toContain("expectedRevision 须为 'initial'");
  });

  it('我的工时只含本人已审核净额（按日聚合）', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-0002', workDate: '2026-10-05', hours: 2 }));
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0003', worker: 'u-worker-02', hours: 6, workDate: '2026-10-06' }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const mine = await h.service.myHours(t1, w1, '2026-10');
    expect(mine.workerId).toBe('u-worker-01');
    expect(mine.days).toEqual([{ workDate: '2026-10-05', totalHours: 10 }]);
    expect(mine.totalHours).toBe(10);

    const other = await h.service.myHours(t1, w2, '2026-10');
    expect(other.totalHours).toBe(6);
    expect(other.days).toEqual([{ workDate: '2026-10-06', totalHours: 6 }]);
  });

  it('机加工时统计（产出×工时，按工作令；仅机加工种）', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'part', workOrderId: 'wo-0002', drawingNo: 'DWG-B', doneQty: 4, hours: 3, workDate: '2026-10-07' }),
    );
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0003', kind: 'assembly', workOrderId: 'wo-0001', hours: 6, doneQty: 1, workDate: '2026-10-06' }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const stats = await h.service.machiningStats(t1);
    expect(stats).toHaveLength(2);
    const wo1 = stats.find((row) => row.workOrderId === 'wo-0001')!;
    expect(wo1.totalHours).toBe(8);
    expect(wo1.totalOutput).toBe(10);
    const wo2 = stats.find((row) => row.workOrderId === 'wo-0002')!;
    expect(wo2.totalHours).toBe(3);
    expect(wo2.totalOutput).toBe(4);

    // 过滤面：工作令 + 日期区间
    const filtered = await h.service.machiningStats(t1, { workOrderId: 'wo-0001', from: '2026-10-06' });
    expect(filtered).toHaveLength(0);
  });

  it('按工作令视图：工种分组 + 工序分组 + 额定对标端口（缺省空 = null）', async () => {
    const h = harness();
    h.standardTime.table.set('DWG-A|P01', 12); // baseline StandardTime 对标
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'part', processCode: 'P02', workDate: '2026-10-05', hours: 2, doneQty: 2 }),
    );
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0003', kind: 'assembly', workOrderId: 'wo-0001', processCode: null, hours: 6, doneQty: 1, workDate: '2026-10-06' }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const view = await h.service.workOrderHours(t1, 'wo-0001');
    expect(view.totalHours).toBe(16);
    expect(view.entryCount).toBe(3);
    const machining = view.byTrade.find((row) => row.trade === 'machining')!;
    expect(machining.totalHours).toBe(10);
    expect(machining.outputQty).toBe(12);
    const p01 = view.byProcess.find((row) => row.processCode === 'P01')!;
    expect(p01.totalHours).toBe(8);
    expect(p01.standardHours).toBe(12); // 对标端口接线后生效
    const p02 = view.byProcess.find((row) => row.processCode === 'P02')!;
    expect(p02.standardHours).toBeNull(); // 无可用标准 = null（缺省口径）

    // 未关联工作令的条目不出现在该视图
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-0004', workOrderId: null }));
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect((await h.service.workOrderHours(t1, 'wo-0001')).entryCount).toBe(3);
  });

  it('ingest limit 批上界 + 条目下钻读法', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-0002' }));
    const limited = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', { limit: 1 })));
    expect(limited.acknowledged).toBe(1);
    expect((await h.entries.list(t1))).toHaveLength(1);
    // 第二批消费余量
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', { limit: 1 })));
    expect(await h.entries.list(t1)).toHaveLength(2);

    const first = (await h.entries.list(t1))[0]!;
    const detail = await h.service.entry(t1, first.id);
    expect(detail.sourceReportId).toBe(first.sourceReportId);
    await expect(h.service.entry(t1, 'le-none')).rejects.toBeInstanceOf(HoursNotFoundError);
  });

  it('输入解析：月份/工时/工种/adjust 载荷的违规 400 面', () => {
    expect(() => parseMonthParam('2026-13', 'month')).toThrow(HoursInputError);
    expect(() => parseHoursRebuildMonthPayload({ month: '2026-1' })).toThrow(HoursInputError);
    expect(() => parseHoursRebuildMonthPayload({ month: '2026-10', workerId: '' })).toThrow(HoursInputError);
    expect(() => requireHours(0, 'hours')).toThrow(HoursInputError);
    expect(() => requireHours(10_001, 'hours')).toThrow(HoursInputError);
    expect(() => requireTrade('welding', 'trade')).toThrow(HoursInputError);
    expect(requireTrade('machining', 'trade')).toBe('machining');
    expect(parseHoursIngestPayload({})).toEqual({});
    expect(() => parseHoursIngestPayload({ limit: 0 })).toThrow(HoursInputError);
    expect(() => parseHoursAdjustEntryPayload({ reportId: 'r1', action: 'hack', kind: 'part', worker: 'w', workDate: '2026-10-05', hours: 8 })).toThrow(HoursInputError);
    expect(() =>
      parseHoursAdjustEntryPayload({ reportId: 'r1', action: 'revoke', kind: 'part', worker: 'w', workDate: 'bad', hours: 8 }),
    ).toThrow(HoursInputError);
    // 词汇表迁移锚定（Wave-4 中危 #2）：旧词 after-sales 不再合法，新词 aftermarket 放行
    expect(() =>
      parseHoursAdjustEntryPayload({ reportId: 'r1', action: 'verify', kind: 'after-sales', worker: 'w', workDate: '2026-10-05', hours: 8 }),
    ).toThrow(HoursInputError);
    expect(
      parseHoursAdjustEntryPayload({ reportId: 'r1', action: 'verify', kind: 'aftermarket', worker: 'w', workDate: '2026-10-05', hours: 8 }).kind,
    ).toBe('aftermarket');
  });

  it('模块装配缺省（内存回落）+ 路由权限码（08-hours.md §5 最小集）', () => {
    const dynamic = HoursModule.register();
    expect(dynamic.module).toBe(HoursModule);
    expect(dynamic.controllers).toHaveLength(1);
    expect(dynamic.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HoursModule)).toBeUndefined();

    const expected: readonly [object, string, string][] = [
      [HoursLedgerController.prototype, 'ingest', 'hours:rebuild'],
      [HoursLedgerController.prototype, 'rebuildMonth', 'hours:rebuild'],
      [HoursLedgerController.prototype, 'machiningStats', 'hours:read'],
      [HoursLedgerController.prototype, 'monthSummary', 'hours:read'],
      [HoursLedgerController.prototype, 'monthDetail', 'hours:read'],
      [HoursLedgerController.prototype, 'monthLedgers', 'hours:read'],
      [HoursLedgerController.prototype, 'myHours', 'hours:read'],
      [HoursLedgerController.prototype, 'workOrderHours', 'hours:read'],
      [HoursLedgerController.prototype, 'entry', 'hours:read'],
      [HoursLedgerController.prototype, 'events', 'hours:read'],
    ];
    for (const [target, method, code] of expected) {
      expect(
        Reflect.getMetadata(PERMISSION_METADATA_KEY, (target as unknown as Record<string, object>)[method] as object),
        `${String(method)} 权限码`,
      ).toBe(code);
    }
  });

  it('costing 工时源投影（被依赖面）：带符号净额行', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload());
    h.feed.seedVerified(
      verifiedPayload({ reportId: 'rpt-0002', kind: 'part', workOrderId: 'wo-0002', hours: 3, doneQty: 2 }),
    );
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    h.feed.seedRevoked(verifiedPayload({ reportId: 'rpt-0002', workOrderId: 'wo-0002' }));
    mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));

    const lines = await h.service.costingLines(t1, 'wo-0001');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.hours).toBe(8);
    expect(lines[0]!.trade).toBe('machining');
    const revoked = await h.service.costingLines(t1, 'wo-0002');
    expect(revoked.reduce((sum, line) => sum + line.hours, 0)).toBe(0); // commit(+3) + reverse(−3)
  });

  it('内存端口集工厂：四端口齐备可用', async () => {
    const stores = createInMemoryHoursStores();
    expect(stores.entries).toBeDefined();
    expect(stores.months).toBeDefined();
    expect(stores.events).toBeDefined();
    expect(stores.operations).toBeDefined();
  });

  // ---- 词汇表对齐与分钟换算（M2 Wave-4 验收中危 #2 修复锚定） ----

  it('词汇表对齐 reporting：aftermarket→aftercare、oddjob→misc（售后不再误归零工）', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-am', kind: 'aftermarket' }));
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-oj', kind: 'oddjob' }));
    const result = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect(result.ingested).toBe(2);
    const entries = await h.entries.list(t1);
    expect(entries.find((entry) => entry.sourceReportId === 'rpt-am')!.trade).toBe('aftercare');
    expect(entries.find((entry) => entry.sourceReportId === 'rpt-oj')!.trade).toBe('misc');
  });

  it('未知报工类别明确拒绝（不静默归类）：ingest 整批 rejected、零副作用、不确认消费位', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-ok' }));
    // 双段断言：故意注入运行时坏输入（词汇表外的类别），类型层不背书
    h.feed.seedVerified({ ...verifiedPayload({ reportId: 'rpt-bad' }), kind: 'welding' } as unknown as ReportEventPayloadShape);
    const reason = mustReject(await h.service.execute(t1, envelope('hours.ingest.v1', {})));
    expect(reason).toContain('welding');
    expect(reason).toContain('part/assembly/electrical/aftermarket/oddjob');
    // 零副作用：未入账、未确认消费位、不占用 operationId（坏消息保留 pending——
    // 修好生产端后可同 operationId 重发，见下一条口径统一测试）
    expect(await h.entries.list(t1)).toHaveLength(0);
    expect(h.feed.acknowledged).toHaveLength(0);
    expect((await h.feed.pending(t1)).find((message) => message.payload.reportId === 'rpt-bad')).toBeDefined();
    // adjust-entry 载荷面同样不吃未知类别（解析层 400）
    expect(() =>
      parseHoursAdjustEntryPayload({ reportId: 'r1', action: 'verify', kind: 'welding', worker: 'w', workDate: '2026-10-05', hours: 8 }),
    ).toThrow(HoursInputError);
  });

  it('被拒不占用 operationId（口径统一：先解析校验后记账）：整批被拒后修好生产端，同 id 重发 → committed', async () => {
    const h = harness();
    h.feed.seedVerified(verifiedPayload({ reportId: 'rpt-ok' }));
    // 双段断言：故意注入运行时坏输入（词汇表外的类别），类型层不背书
    h.feed.seedVerified({ ...verifiedPayload({ reportId: 'rpt-bad' }), kind: 'welding' } as unknown as ReportEventPayloadShape);
    const refused = mustReject(await h.service.execute(t1, envelope('hours.ingest.v1', {}, { operationId: 'op-hours-same-retry' })));
    expect(refused).toContain('welding');

    // 修好生产端（坏消息类别改回合法集）后同 operationId 重发 → committed
    // （旧口径 claim 先行：此处会撞"已落账"，修复须换新 id）
    const bad = h.feed.messages.find((message) => message.payload.reportId === 'rpt-bad')!;
    (bad as { payload: ReportEventPayloadShape }).payload = { ...bad.payload, kind: 'part' };
    const retried = mustCommit(await h.service.execute(t1, envelope('hours.ingest.v1', {}, { operationId: 'op-hours-same-retry' })));
    expect(retried.ingested).toBe(2);
    expect(await h.entries.list(t1)).toHaveLength(2);

    // committed 后同 id 再发 → 仍被不变量 3 拒（"已落账"终态）
    const dup = await h.service.execute(t1, envelope('hours.ingest.v1', {}, { operationId: 'op-hours-same-retry' }));
    expect(dup.status).toBe('rejected');
    expect((dup as { reason: string }).reason).toContain('已落账');
  });

  it('minutesToHours 换算锚定（reporting laborMinutes → hours 量纲；上界沿用 reporting 44640）', () => {
    expect(minutesToHours(480)).toBe(8);
    expect(minutesToHours(90)).toBe(1.5); // 浮点结果，不四舍五入
    expect(minutesToHours(44_640)).toBe(744); // 上界（1440×31，与 reporting MAX_LABOR_MINUTES 同口径）
    expect(minutesToHours(1)).toBeCloseTo(1 / 60);
    expect(() => minutesToHours(0)).toThrow(HoursInputError);
    expect(() => minutesToHours(-30)).toThrow(HoursInputError);
    expect(() => minutesToHours(44_641)).toThrow(HoursInputError);
    expect(() => minutesToHours(Number.NaN)).toThrow(HoursInputError);
    expect(() => minutesToHours(Number.POSITIVE_INFINITY)).toThrow(HoursInputError);
  });
});
