/**
 * costing 模块测试（M2-W6，09-costing.md v1.0）：口径发布与版本链（乐观锁）/
 * 归集主体校验 / 三分类重算（材料金额×工时口径换算×外协价格，工时源经
 * createHoursCostSource 直连真实 HoursService——跨模块端口结构化兼容的合流
 * 预演）/ 重算幂等 / 来源重定价 delta 条目与快照版本并存 / 口径版本对比 /
 * 导出走端口（json-tables 回声）/ 下钻到来源单据 / 输入解析 / 模块装配与权限码。
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
import { COSTING_EVENT_TYPES } from '../../src/costing/costing-events.js';
import { CostingInputError, CostingNotFoundError } from '../../src/costing/costing-errors.js';
import {
  parseCostingModelPublishPayload,
  parseWorkOrderSelectorPayload,
} from '../../src/costing/costing-input.js';
import { parseHourlyRates } from '../../src/costing/costing-model.js';
import type {
  MaterialCostLine,
  MaterialCostSourcePort,
  OutsourcingCostLine,
  OutsourcingCostSourcePort,
  WorkOrderSubjectPort,
} from '../../src/costing/costing-ports.js';
import { createHoursCostSource } from '../../src/costing/costing-ports.js';
import {
  createInMemoryCostingStores,
  InMemoryCostEntryStore,
  InMemoryCostSnapshotStore,
  InMemoryCostingDomainEventStore,
  InMemoryCostingModelStore,
  InMemoryCostingOperationStore,
} from '../../src/costing/in-memory-costing-stores.js';
import { JsonTablesCostingExcelPort } from '../../src/costing/costing-excel-port.js';
import {
  CostingLedgerController,
  CostingModelsController,
} from '../../src/costing/costing.controllers.js';
import { ProjectCostController } from '../../src/costing/project-cost.controllers.js';
import { CostingModule } from '../../src/costing/costing.module.js';
import { CostingService, type CostingCommandResult } from '../../src/costing/costing.service.js';
import type { CostingCommand, CostingCommandKind } from '../../src/costing/costing-input.js';
import { HoursService } from '../../src/hours/hours.service.js';
import { createInMemoryHoursStores } from '../../src/hours/in-memory-hours-stores.js';
import { EMPTY_REPORT_EVENT_FEED, EMPTY_STANDARD_TIME } from '../../src/hours/hours-ports.js';
import type { ReportEventFeedPort, ReportEventMessage, ReportEventPayloadShape } from '../../src/hours/hours-ports.js';

const t1 = TenantId.create('t1');
const manager = UserId.create('u-manager-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';
const WO = 'wo-0001';

// ---- 可注入假端口 ----

class FakeMaterialSource implements MaterialCostSourcePort {
  readonly lines = new Map<string, MaterialCostLine[]>();

  seed(line: MaterialCostLine): void {
    const bucket = this.lines.get(line.workOrderId) ?? [];
    bucket.push(line);
    this.lines.set(line.workOrderId, bucket);
  }

  async materialLines(_tenant: TenantId, workOrderId: string): Promise<readonly MaterialCostLine[]> {
    return [...(this.lines.get(workOrderId) ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

class FakeOutsourcingSource implements OutsourcingCostSourcePort {
  readonly lines = new Map<string, OutsourcingCostLine[]>();

  seed(line: OutsourcingCostLine): void {
    const bucket = this.lines.get(line.workOrderId) ?? [];
    const existing = bucket.findIndex((row) => row.dispatchId === line.dispatchId && row.lineNo === line.lineNo);
    if (existing >= 0) bucket.splice(existing, 1); // 重定价 = 同行覆盖（端口返回当前定价）
    bucket.push(line);
    this.lines.set(line.workOrderId, bucket);
  }

  async outsourcingLines(_tenant: TenantId, workOrderId: string): Promise<readonly OutsourcingCostLine[]> {
    return [...(this.lines.get(workOrderId) ?? [])];
  }
}

class FakeSubjectPort implements WorkOrderSubjectPort {
  readonly known = new Set<string>([WO]);

  async exists(_tenant: TenantId, workOrderId: string): Promise<boolean> {
    return this.known.has(workOrderId);
  }
}

class FakeReportFeed implements ReportEventFeedPort {
  readonly messages: ReportEventMessage[] = [];
  readonly acknowledged: string[] = [];

  seedVerified(payload: ReportEventPayloadShape): void {
    this.messages.push({ eventId: `evt-${this.messages.length + 1}`, tenantId: 't1', occurredAt: FIXED_NOW, signal: 'ReportVerified', payload });
  }

  seedRevoked(payload: ReportEventPayloadShape): void {
    this.messages.push({ eventId: `evt-${this.messages.length + 1}`, tenantId: 't1', occurredAt: FIXED_NOW, signal: 'ReportRevoked', payload });
  }

  async pending(tenant: TenantId): Promise<readonly ReportEventMessage[]> {
    return this.messages.filter((message) => message.tenantId === tenant && !this.acknowledged.includes(message.eventId));
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

// ---- 服务装配（hours 真实例直连 costing 工时源） ----

interface Harness {
  readonly costing: CostingService;
  readonly entries: InMemoryCostEntryStore;
  readonly models: InMemoryCostingModelStore;
  readonly snapshots: InMemoryCostSnapshotStore;
  readonly events: InMemoryCostingDomainEventStore;
  readonly material: FakeMaterialSource;
  readonly outsourcing: FakeOutsourcingSource;
  readonly subject: FakeSubjectPort;
  readonly hours: HoursService;
  readonly hoursFeed: FakeReportFeed;
}

function harness(): Harness {
  const entries = new InMemoryCostEntryStore();
  const models = new InMemoryCostingModelStore();
  const snapshots = new InMemoryCostSnapshotStore();
  const events = new InMemoryCostingDomainEventStore();
  const operations = new InMemoryCostingOperationStore();
  const material = new FakeMaterialSource();
  const outsourcing = new FakeOutsourcingSource();
  const subject = new FakeSubjectPort();
  const hoursFeed = new FakeReportFeed();
  const hoursStores = createInMemoryHoursStores();
  const hours = new HoursService(hoursStores, { feed: hoursFeed, standardTime: EMPTY_STANDARD_TIME }, { now: () => FIXED_NOW });
  const costing = new CostingService(
    { entries, models, snapshots, events, operations },
    { material, labor: createHoursCostSource(hours), outsourcing, workOrder: subject },
    new JsonTablesCostingExcelPort(),
    { now: () => FIXED_NOW },
  );
  return { costing, entries, models, snapshots, events, material, outsourcing, subject, hours, hoursFeed };
}

let opCounter = 0;

function envelope(
  kind: CostingCommandKind,
  payload: unknown,
  options: { readonly operationId?: string; readonly expectedRevision?: 'initial' | number } = {},
): CommandEnvelope<CostingCommand> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: manager,
    operationId: OperationId.create(options.operationId ?? `op-costing-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as CostingCommand,
  });
}

function mustCommit(result: CostingCommandResult) {
  expect(result.status, `命令应 committed，得到 ${JSON.stringify(result)}`).toBe('committed');
  return result as Extract<CostingCommandResult, { status: 'committed' }>;
}

function mustReject(result: CostingCommandResult): string {
  expect(result.status, `命令应 rejected，得到 ${JSON.stringify(result)}`).toBe('rejected');
  return (result as { readonly reason: string }).reason;
}

async function publishV1(h: Harness, rates: Record<string, number> = { machining: 6000, assembly: 5000 }): Promise<void> {
  mustCommit(
    await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', name: '初版口径', hourlyRates: rates })),
  );
}

async function seedHours(h: Harness): Promise<void> {
  h.hoursFeed.seedVerified({
    reportId: 'rpt-0001',
    kind: 'part',
    dispatchId: 'dsp-0001',
    workOrderId: WO,
    drawingNo: 'DWG-A',
    processCode: 'P01',
    worker: 'u-worker-01',
    doneQty: 10,
    hours: 3,
    workDate: '2026-10-05',
    revokeReason: null,
    actor: 'u-auditor-01',
  });
  h.hoursFeed.seedVerified({
    reportId: 'rpt-0002',
    kind: 'assembly',
    dispatchId: null,
    workOrderId: WO,
    drawingNo: null,
    processCode: null,
    worker: 'u-worker-02',
    doneQty: 1,
    hours: 2,
    workDate: '2026-10-06',
    revokeReason: null,
    actor: 'u-auditor-01',
  });
  await h.hours.execute(t1, hoursIngestEnvelope());
}

function hoursIngestEnvelope(): CommandEnvelope<{ kind: 'hours.ingest.v1'; payload: unknown }> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: manager,
    operationId: OperationId.create(`op-hours-costing-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: 'initial',
    issuedAt: FIXED_NOW,
    command: { kind: 'hours.ingest.v1', payload: {} },
  });
}

function seedMaterial(h: Harness): void {
  h.material.seed({ movementId: 'mv-0001', workOrderId: WO, itemId: 'itm-0001', quantity: 5, amountMinor: 1200, occurredAt: '2026-10-07T08:00:00.000Z' });
  h.material.seed({ movementId: 'mv-0002', workOrderId: WO, itemId: 'itm-0002', quantity: 2, amountMinor: 800, occurredAt: '2026-10-08T08:00:00.000Z' });
}

function seedOutsourcing(h: Harness, unitPriceMinor = 100): void {
  h.outsourcing.seed({
    dispatchId: 'dsp-0002',
    lineNo: 1,
    workOrderId: WO,
    processCode: 'P05',
    supplierRef: 'sup-001',
    unitPriceMinor,
    quantity: 3,
    amountMinor: unitPriceMinor * 3,
  });
}

// ---- 测试 ----

describe('costing 项目成本账（09-costing.md v1.0）', () => {
  it('口径发布与版本链：首发/修订/乐观锁/重复首发', async () => {
    const h = harness();
    const v1 = mustCommit(await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 6000 } })));
    expect(v1.model!.objectVersion).toBe(1);
    expect(v1.model!.status).toBe('active');
    expect(v1.model!.supersedes).toBeNull();

    // 重复首发（initial）→ 已存在拒
    expect(mustReject(await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 1 } })))).toContain('已存在');

    // 乐观锁：错误 expectedRevision 拒
    expect(mustReject(
      await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 1 } }, { expectedRevision: 5 })),
    )).toContain('乐观锁冲突');

    // 修订 → v2 supersedes v1；版本链视图 v1=superseded
    const v2 = mustCommit(
      await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 7000 } }, { expectedRevision: 1 })),
    );
    expect(v2.model!.objectVersion).toBe(2);
    const detail = await h.costing.modelDetail(t1, 'standard');
    expect(detail.versions.map((row) => row.status)).toEqual(['superseded', 'active']);
    expect(detail.current.objectVersion).toBe(2);

    const events = await h.events.list(t1);
    expect(events.filter((event) => event.eventType === COSTING_EVENT_TYPES.costingModelPublished)).toHaveLength(2);
  });

  it('未发布口径重算拒 + 归集主体校验拒', async () => {
    const h = harness();
    expect(mustReject(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })))).toContain('未发布');
    await publishV1(h);
    h.subject.known.clear();
    expect(mustReject(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })))).toContain('不存在');
    expect(mustReject(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO }, { expectedRevision: 1 })))).toContain("expectedRevision 须为 'initial'");
  });

  it('被拒不占用 operationId（口径统一：先解析校验后记账）：主体不存在被拒后补建，同 id 重发 → committed', async () => {
    const h = harness();
    await publishV1(h);
    h.subject.known.clear();
    // 主体校验拒：不 claim operationId
    expect(mustReject(
      await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO }, { operationId: 'op-costing-same-retry' })),
    )).toContain('不存在');
    // 主体补建后同 operationId 重发 → committed（旧口径 claim 先行：此处会撞"已落账"）
    h.subject.known.add(WO);
    const retried = mustCommit(
      await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO }, { operationId: 'op-costing-same-retry' })),
    );
    expect(retried.snapshotVersion).toBe(1);
    // committed 后同 id 再发 → 仍被不变量 3 拒（"已落账"终态）
    const dup = await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO }, { operationId: 'op-costing-same-retry' }));
    expect(dup.status).toBe('rejected');
    expect((dup as { reason: string }).reason).toContain('已落账');
  });

  it('三分类重算：材料金额 + 工时口径换算（真实 HoursService 直连）+ 外协价格', async () => {
    const h = harness();
    await publishV1(h, { machining: 6000, assembly: 5000 });
    await seedHours(h); // wo-0001：machining 3h（w1）+ assembly 2h（w2）
    seedMaterial(h); // 1200 + 800 分
    seedOutsourcing(h); // 100 × 3 = 300 分

    const result = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    expect(result.entriesCommitted).toBe(5); // 材料 2 + 工时 2 + 外协 1
    expect(result.modelVersion).toBe(1);
    expect(result.snapshotVersion).toBe(1);
    expect(result.snapshotChanged).toBe(true);
    expect(result.totals!.materialMinor).toBe(2000);
    expect(result.totals!.outsourcingMinor).toBe(300);
    expect(result.totals!.laborMinor).toBe(3 * 6000 + 2 * 5000); // 28000
    expect(result.totals!.grandMinor).toBe(30300);
    expect(result.totals!.laborHoursByTrade).toEqual({ machining: 3, assembly: 2 });

    const events = await h.events.list(t1);
    expect(events.filter((event) => event.eventType === COSTING_EVENT_TYPES.costEntryCommitted)).toHaveLength(5);
    expect(events.filter((event) => event.eventType === COSTING_EVENT_TYPES.costSnapshotRebuilt)).toHaveLength(1);
  });

  it('重算幂等：再算不追加条目/不追加快照版本行', async () => {
    const h = harness();
    await publishV1(h);
    await seedHours(h);
    seedMaterial(h);
    seedOutsourcing(h);
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));

    const again = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    expect(again.entriesCommitted).toBe(0);
    expect(again.entriesSkipped).toBe(5);
    expect(again.snapshotChanged).toBe(false);
    expect(again.snapshotVersion).toBe(1);
    expect(await h.entries.list(t1)).toHaveLength(5);
    expect(await h.snapshots.listByWorkOrder(t1, WO)).toHaveLength(1); // 无漂移

    // 快照 = 实时汇总（对账口径）
    const summary = await h.costing.workOrderSummary(t1, WO);
    const current = (await h.costing.snapshots(t1, WO))[0]!;
    expect(summary.totals.grandMinor).toBe(current.totals.grandMinor);
    expect(summary.totals.laborMinor).toBe(current.totals.laborMinor);
  });

  it('来源重定价：delta 条目保净额，快照 v2 supersedes v1（新旧快照均留存）', async () => {
    const h = harness();
    await publishV1(h);
    await seedHours(h);
    seedMaterial(h);
    seedOutsourcing(h); // 300 分
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));

    seedOutsourcing(h, 200); // 重定价 → 600 分
    const repriced = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    expect(repriced.entriesCommitted).toBe(1); // 仅 delta
    expect(repriced.snapshotChanged).toBe(true);
    expect(repriced.snapshotVersion).toBe(2);
    expect(repriced.totals!.outsourcingMinor).toBe(600);

    const chain = await h.costing.snapshotChain(t1, WO, 'standard', 1);
    expect(chain).toHaveLength(2);
    expect(chain[1]!.supersedes).toBe(chain[0]!.id);
    expect(chain[0]!.totals.outsourcingMinor).toBe(300); // 历史快照可回看
    expect(chain[1]!.totals.outsourcingMinor).toBe(600);

    const delta = (await h.entries.list(t1)).find((entry) => entry.deltaOf !== null)!;
    expect(delta.amountMinor).toBe(300); // 600 − 300
    expect(delta.sourceKey).toBe('out:dsp-0002#1#d1');

    // 再算一次：净额已一致 → 幂等
    const settle = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    expect(settle.entriesCommitted).toBe(0);
    expect(settle.snapshotChanged).toBe(false);
  });

  it('hours 撤销传导：工时净额变化 → 重算快照 v2', async () => {
    const h = harness();
    await publishV1(h, { machining: 6000, assembly: 5000 });
    await seedHours(h);
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    const before = (await h.costing.snapshots(t1, WO))[0]!;

    // 撤销 assembly 报工 → hours 冲销 → costing 重算捕获负向工时行
    h.hoursFeed.seedRevoked({
      reportId: 'rpt-0002',
      kind: 'assembly',
      dispatchId: null,
      workOrderId: WO,
      drawingNo: null,
      processCode: null,
      worker: 'u-worker-02',
      doneQty: 1,
      hours: 2,
      workDate: '2026-10-06',
      revokeReason: '误报',
      actor: 'u-auditor-01',
    });
    await h.hours.execute(t1, hoursIngestEnvelope());
    const after = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));
    expect(after.entriesCommitted).toBe(1); // 新增 reverse 劳动条目的工时行
    expect(after.totals!.laborHoursByTrade.assembly).toBe(0);
    expect(after.totals!.laborMinor).toBe(3 * 6000);
    expect(after.totals!.grandMinor).toBeLessThan(before.totals.grandMinor);
  });

  it('下钻到来源单据：三类条目各引用出库单/工时条目/外协明细行', async () => {
    const h = harness();
    await publishV1(h);
    await seedHours(h);
    seedMaterial(h);
    seedOutsourcing(h);
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));

    const material = await h.costing.costDetail(t1, WO, 'material');
    expect(material.map((entry) => entry.sourceRefId).sort()).toEqual(['mv-0001', 'mv-0002']);
    const labor = await h.costing.costDetail(t1, WO, 'labor');
    expect(labor.every((entry) => entry.sourceRefId.startsWith('le-'))).toBe(true);
    expect(labor.every((entry) => entry.amountMinor === null)).toBe(true); // R6：存工时量
    const outsourcing = await h.costing.costDetail(t1, WO, 'outsourcing');
    expect(outsourcing[0]!.sourceRefId).toBe('dsp-0002#1');
    expect((await h.costing.costDetail(t1, WO)).length).toBe(5);
  });

  it('口径版本对比：同码两版本实时聚合 + 差额；口径变更不改历史快照', async () => {
    const h = harness();
    await publishV1(h, { machining: 6000, assembly: 5000 });
    await seedHours(h);
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));

    mustCommit(
      await h.costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 7000, assembly: 5000 } }, { expectedRevision: 1 })),
    );

    const comparison = await h.costing.compareModels(t1, WO, 'standard', 1, 2);
    expect(comparison.totalsA.laborMinor).toBe(28000);
    expect(comparison.totalsB.laborMinor).toBe(31000); // 3×7000 + 2×5000
    expect(comparison.deltaMinor.labor).toBe(3000);

    // 显式按 v1 重算 → 幂等（口径变更不改历史快照：v1 链不动）
    const keepV1 = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO, modelVersion: 1 })));
    expect(keepV1.snapshotChanged).toBe(false);
    expect(await h.costing.snapshotChain(t1, WO, 'standard', 1)).toHaveLength(1);

    // 按 v2 重算 → 独立快照链（口径并存）
    const underV2 = mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO, modelVersion: 2 })));
    expect(underV2.snapshotChanged).toBe(true);
    expect(underV2.totals!.laborMinor).toBe(31000);
    const all = await h.costing.snapshots(t1, WO);
    expect(all.filter((row) => row.status === 'current')).toHaveLength(2); // v1/v2 各一条当前快照
  });

  it('导出走端口：json-tables 回声（汇总 + 明细两表）', async () => {
    const h = harness();
    await publishV1(h);
    await seedHours(h);
    seedMaterial(h);
    seedOutsourcing(h);
    mustCommit(await h.costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: WO })));

    const exported = mustCommit(await h.costing.execute(t1, envelope('costing.export.v1', { workOrderId: WO })));
    expect(exported.export).toBeDefined();
    const output = exported.export!;
    expect(output.kind).toBe('json-tables');
    const sheets = output.kind === 'json-tables' ? output.sheets : [];
    expect(sheets[0]!.name).toBe('成本汇总');
    expect(sheets[0]!.header).toContain('合计(分)');
    expect(sheets[0]!.rows[0]![6]).toBe('30300');
    expect(sheets[1]!.name).toBe('成本明细');
    expect(sheets[1]!.rows).toHaveLength(5);

    // 版本不存在 → rejected
    expect(mustReject(await h.costing.execute(t1, envelope('costing.export.v1', { workOrderId: WO, modelVersion: 9 })))).toContain('不存在版本');
  });

  it('零接线口径：空三源 + 缺省端口（材料/工时/外协为 0，主体恒真）', async () => {
    const stores = createInMemoryCostingStores();
    const costing = new CostingService(stores, undefined, undefined, { now: () => FIXED_NOW });
    mustCommit(await costing.execute(t1, envelope('costing.model.publish.v1', { code: 'standard', hourlyRates: { machining: 6000 } })));
    const empty = mustCommit(await costing.execute(t1, envelope('costing.rebuild.v1', { workOrderId: 'wo-any' })));
    expect(empty.totals!.grandMinor).toBe(0);
    expect(empty.entriesCommitted).toBe(0);
  });

  it('输入解析：时薪表/选择器/发布载荷的违规 400 面', () => {
    expect(() => parseHourlyRates({ welding: 100 })).toThrow(CostingInputError);
    expect(() => parseHourlyRates({ machining: 1.5 })).toThrow(CostingInputError);
    expect(() => parseCostingModelPublishPayload({ code: '' })).toThrow(CostingInputError);
    expect(() => parseCostingModelPublishPayload({ code: 'a' })).toThrow(CostingInputError); // 缺 hourlyRates
    expect(() => parseCostingModelPublishPayload({ code: 'a', hourlyRates: {}, status: 'x' })).toThrow(CostingInputError);
    expect(() => parseWorkOrderSelectorPayload({ workOrderId: '' }, 'x')).toThrow(CostingInputError);
    expect(() => parseWorkOrderSelectorPayload({ workOrderId: 'w', modelVersion: 0 }, 'x')).toThrow(CostingInputError);
    expect(parseWorkOrderSelectorPayload({ workOrderId: 'w' }, 'x')).toEqual({ workOrderId: 'w' });
  });

  it('查询异常面：未知口径 404（读路径）', async () => {
    const h = harness();
    await expect(h.costing.modelDetail(t1, 'nope')).rejects.toBeInstanceOf(CostingNotFoundError);
  });

  it('模块装配缺省（内存回落 + 空源端口）+ 路由权限码（09-costing.md §5 最小集 + U7 项目成本面）', () => {
    const dynamic = CostingModule.register();
    expect(dynamic.module).toBe(CostingModule);
    expect(dynamic.controllers).toHaveLength(3);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CostingModule)).toBeUndefined();

    const expected: readonly [object, string, string][] = [
      [CostingModelsController.prototype, 'publish', 'costing:model-manage'],
      [CostingModelsController.prototype, 'compare', 'costing:read'],
      [CostingModelsController.prototype, 'detail', 'costing:read'],
      [CostingModelsController.prototype, 'list', 'costing:read'],
      [CostingLedgerController.prototype, 'rebuild', 'costing:rebuild'],
      [CostingLedgerController.prototype, 'export', 'costing:read'],
      [CostingLedgerController.prototype, 'summary', 'costing:read'],
      [CostingLedgerController.prototype, 'details', 'costing:read'],
      [CostingLedgerController.prototype, 'snapshots', 'costing:read'],
      [CostingLedgerController.prototype, 'events', 'costing:read'],
      // U7 项目成本（六块重算/录入价格/KPI 查询面）
      [ProjectCostController.prototype, 'rebuild', 'costing:rebuild'],
      [ProjectCostController.prototype, 'summary', 'costing:read'],
      [ProjectCostController.prototype, 'detail', 'costing:read'],
      [ProjectCostController.prototype, 'snapshots', 'costing:read'],
      [ProjectCostController.prototype, 'entries', 'costing:read'],
      [ProjectCostController.prototype, 'priceEntry', 'costing:rebuild'],
      [ProjectCostController.prototype, 'priceEntries', 'costing:read'],
    ];
    for (const [target, method, code] of expected) {
      expect(
        Reflect.getMetadata(PERMISSION_METADATA_KEY, (target as unknown as Record<string, object>)[method] as object),
        `${String(method)} 权限码`,
      ).toBe(code);
    }
  });
});
