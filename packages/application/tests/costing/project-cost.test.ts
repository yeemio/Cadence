/**
 * U7 项目成本六块测试（A5，项目成本报表-开发文档.md 口径权威源）：
 * 六块聚合（材料四类两段拆分/外协供应商行/人工三工种/售后工时+报销/设备采购+
 * 利库）/ 录入价格（默认总金额 + 同零件联动 + amountManual 豁免 + 写回端口单向）/
 * 重算幂等（值未变不加快照行）/ 来源漂移 delta 冲销（净额对齐）/ 快照版本链 /
 * KPI 详情查询面 / misc 工种不入六块 / 命令幂等与输入解析守门。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { CostingInputError, CostingNotFoundError } from '../../src/costing/costing-errors.js';
import { DEFAULT_COSTING_MODEL_DEFINITION } from '../../src/costing/costing-model.js';
import type { OutsourcingCostLine, OutsourcingCostSourcePort } from '../../src/costing/costing-ports.js';
import { EMPTY_LABOR_COST_SOURCE, EMPTY_OUTSOURCING_COST_SOURCE } from '../../src/costing/costing-ports.js';
import type { LaborCostLine, LaborCostSourcePort } from '../../src/costing/costing-ports.js';
import {
  createInMemoryCostingStores,
} from '../../src/costing/in-memory-costing-stores.js';
import { createInMemoryProjectCostStores } from '../../src/costing/in-memory-project-cost-stores.js';
import {
  parsePriceEntryPayload,
  parseProjectCommandBodyForKind,
} from '../../src/costing/project-cost-input.js';
import type {
  ProjectAftercareClaimLine,
  ProjectAftercareClaimSourcePort,
  ProjectEquipmentPurchaseLine,
  ProjectEquipmentPurchaseSourcePort,
  ProjectIssueSegmentLine,
  ProjectIssueCostSourcePort,
  IssuePriceWritebackEntry,
  IssuePriceWritebackPort,
} from '../../src/costing/project-cost-ports.js';
import { ProjectCostService, type ProjectCostCommandResult } from '../../src/costing/project-cost.service.js';
import { aggregateProjectCost, sameProjectTotals, EMPTY_PROJECT_COST_TOTALS } from '../../src/costing/project-cost-model.js';
import type { ProjectCostCommand, ProjectCostCommandKind } from '../../src/costing/project-cost-input.js';

const t1 = TenantId.create('t1');
const manager = UserId.create('u-manager-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';
const WO = 'wo-u7-0001';

// ---- 命令信封 ----

let opCounter = 0;
function envelope(
  kind: ProjectCostCommandKind,
  payload: unknown,
  options: { readonly operationId?: string; readonly expectedRevision?: 'initial' | number } = {},
): CommandEnvelope<ProjectCostCommand> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: manager,
    operationId: OperationId.create(options.operationId ?? `op-pc-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as ProjectCostCommand,
  });
}

function mustCommit(result: ProjectCostCommandResult) {
  expect(result.status, `命令应 committed，得到 ${JSON.stringify(result)}`).toBe('committed');
  return result as Extract<ProjectCostCommandResult, { status: 'committed' }>;
}

// ---- 可注入假端口 ----

class FakeIssueSource implements ProjectIssueCostSourcePort {
  readonly rows = new Map<string, ProjectIssueSegmentLine[]>();

  seed(line: ProjectIssueSegmentLine): void {
    const bucket = this.rows.get(line.workOrderId) ?? [];
    const index = bucket.findIndex(
      (row) => row.recordId === line.recordId && row.taskLineId === line.taskLineId && row.segment === line.segment,
    );
    if (index >= 0) bucket.splice(index, 1); // 来源漂移 = 同段覆盖（端口返回当前事实）
    bucket.push(line);
    this.rows.set(line.workOrderId, bucket);
  }

  async issueSegments(_tenant: TenantId, workOrderId: string): Promise<readonly ProjectIssueSegmentLine[]> {
    return [...(this.rows.get(workOrderId) ?? [])].sort(
      (a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.recordId.localeCompare(b.recordId) || a.segment.localeCompare(b.segment),
    );
  }
}

class FakeEquipmentSource implements ProjectEquipmentPurchaseSourcePort {
  readonly rows = new Map<string, ProjectEquipmentPurchaseLine[]>();

  seed(line: ProjectEquipmentPurchaseLine): void {
    const bucket = this.rows.get(line.workOrderId) ?? [];
    const index = bucket.findIndex((row) => row.purchaseOrderId === line.purchaseOrderId && row.lineNo === line.lineNo);
    if (index >= 0) bucket.splice(index, 1);
    bucket.push(line);
    this.rows.set(line.workOrderId, bucket);
  }

  async equipmentPurchases(_tenant: TenantId, workOrderId: string): Promise<readonly ProjectEquipmentPurchaseLine[]> {
    return [...(this.rows.get(workOrderId) ?? [])];
  }
}

class FakeAftercareSource implements ProjectAftercareClaimSourcePort {
  readonly rows = new Map<string, ProjectAftercareClaimLine[]>();

  seed(line: ProjectAftercareClaimLine): void {
    const bucket = this.rows.get(line.workOrderId) ?? [];
    const index = bucket.findIndex((row) => row.claimId === line.claimId);
    if (index >= 0) bucket.splice(index, 1);
    bucket.push(line);
    this.rows.set(line.workOrderId, bucket);
  }

  async aftercareClaims(_tenant: TenantId, workOrderId: string): Promise<readonly ProjectAftercareClaimLine[]> {
    return [...(this.rows.get(workOrderId) ?? [])];
  }
}

class FakeOutsourcingSource implements OutsourcingCostSourcePort {
  readonly rows = new Map<string, OutsourcingCostLine[]>();

  seed(line: OutsourcingCostLine): void {
    const bucket = this.rows.get(line.workOrderId) ?? [];
    const index = bucket.findIndex((row) => row.dispatchId === line.dispatchId && row.lineNo === line.lineNo);
    if (index >= 0) bucket.splice(index, 1);
    bucket.push(line);
    this.rows.set(line.workOrderId, bucket);
  }

  async outsourcingLines(_tenant: TenantId, workOrderId: string): Promise<readonly OutsourcingCostLine[]> {
    return [...(this.rows.get(workOrderId) ?? [])];
  }
}

class FakeLaborSource implements LaborCostSourcePort {
  readonly rows = new Map<string, LaborCostLine[]>();

  seed(line: LaborCostLine): void {
    const bucket = this.rows.get(line.workOrderId) ?? [];
    bucket.push(line);
    this.rows.set(line.workOrderId, bucket);
  }

  async laborLines(_tenant: TenantId, workOrderId: string): Promise<readonly LaborCostLine[]> {
    return [...(this.rows.get(workOrderId) ?? [])];
  }
}

class CaptureWriteback implements IssuePriceWritebackPort {
  readonly calls: IssuePriceWritebackEntry[][] = [];

  async writeback(_tenant: TenantId, entries: readonly IssuePriceWritebackEntry[]): Promise<void> {
    this.calls.push([...entries]);
  }
}

// ---- 装配 ----

interface Harness {
  readonly service: ProjectCostService;
  readonly issue: FakeIssueSource;
  readonly equipment: FakeEquipmentSource;
  readonly aftercare: FakeAftercareSource;
  readonly outsourcing: FakeOutsourcingSource;
  readonly labor: FakeLaborSource;
  readonly writeback: CaptureWriteback;
}

async function makeHarness(options: { readonly publishModel?: boolean } = {}): Promise<Harness> {
  const shared = createInMemoryCostingStores();
  if (options.publishModel !== false) {
    await shared.models.insert({
      tenant: t1,
      code: 'standard',
      name: null,
      definition: DEFAULT_COSTING_MODEL_DEFINITION,
      status: 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: 'published',
      businessTime: FIXED_NOW,
    });
  }
  const projectStores = createInMemoryProjectCostStores();
  const issue = new FakeIssueSource();
  const equipment = new FakeEquipmentSource();
  const aftercare = new FakeAftercareSource();
  const outsourcing = new FakeOutsourcingSource();
  const labor = new FakeLaborSource();
  const writeback = new CaptureWriteback();
  const service = new ProjectCostService(
    projectStores,
    { models: shared.models, events: shared.events, operations: shared.operations },
    {
      issueSegments: issue,
      equipmentPurchases: equipment,
      aftercareClaims: aftercare,
      labor,
      outsourcing,
      workOrder: { exists: async () => true },
      priceWriteback: writeback,
    },
    { now: () => FIXED_NOW },
  );
  return { service, issue, equipment, aftercare, outsourcing, labor, writeback };
}

function rebuild(service: ProjectCostService, options: { readonly operationId?: string } = {}) {
  return service.execute(t1, envelope('costing.project.rebuild.v1', { workOrderId: WO }, options));
}

// ---- 种子事实（六块固定样例） ----

function seedSixBlocks(harness: Harness): void {
  const { issue, equipment, aftercare, outsourcing, labor } = harness;
  // ② part 行 A：利库预占 5（未录价）+ 采购净发料 10×1200 + 原材料段 7777
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-1', workOrderId: WO, kind: 'part', segment: 'reserved', sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 5, amountMinor: null, equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z' });
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-1', workOrderId: WO, kind: 'part', segment: 'purchase', sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 10, amountMinor: 12000, equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z' });
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-1', workOrderId: WO, kind: 'part', segment: 'raw', sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 10, amountMinor: 7777, equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z' });
  // ② part 行 B（同 sourceLineId ll-part-1：同零件联动测试锚）：利库预占 4
  issue.seed({ recordId: 'irc-2', taskLineId: 'itl-2', workOrderId: WO, kind: 'part', segment: 'reserved', sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 4, amountMinor: null, equipmentRef: 'eq-1', issuedAt: '2026-10-21T08:00:00.000Z' });
  // ② 标准件：利库 30×800 + 采购 70×800
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-3', workOrderId: WO, kind: 'standard', segment: 'reserved', sourceLineId: 'll-std-1', itemId: 'item-std', drawingNo: null, quantity: 30, amountMinor: 24000, equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z' });
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-3', workOrderId: WO, kind: 'standard', segment: 'purchase', sourceLineId: 'll-std-1', itemId: 'item-std', drawingNo: null, quantity: 70, amountMinor: 56000, equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z' });
  // ② 电气件：利库 5×300 + 采购 5×300
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-4', workOrderId: WO, kind: 'electrical', segment: 'reserved', sourceLineId: 'll-elec-1', itemId: 'item-elec', drawingNo: null, quantity: 5, amountMinor: 1500, equipmentRef: null, issuedAt: '2026-10-20T08:00:00.000Z' });
  issue.seed({ recordId: 'irc-1', taskLineId: 'itl-4', workOrderId: WO, kind: 'electrical', segment: 'purchase', sourceLineId: 'll-elec-1', itemId: 'item-elec', drawingNo: null, quantity: 5, amountMinor: 1500, equipmentRef: null, issuedAt: '2026-10-20T08:00:00.000Z' });
  // ⑥ 设备利库段：预占 3（未录价按 0）+ 采购行 500000
  issue.seed({ recordId: 'irc-3', taskLineId: 'itl-5', workOrderId: WO, kind: 'equipment', segment: 'reserved', sourceLineId: 'll-eq-1', itemId: 'item-eq', drawingNo: 'DW-EQ', quantity: 3, amountMinor: null, equipmentRef: 'eq-2', issuedAt: '2026-10-22T08:00:00.000Z' });
  equipment.seed({ purchaseOrderId: 'po-1', lineNo: 1, workOrderId: WO, itemId: 'item-eq', drawingNo: 'DW-EQ', quantity: 10, receivedQty: 10, unitPriceMinor: 50000, amountMinor: 500000, equipmentListingLineId: 'll-eq-1', equipmentRef: null });
  // ③ 外协：S1 33000 + S2 12000
  outsourcing.seed({ dispatchId: 'dsp-1', lineNo: 1, workOrderId: WO, processCode: 'OP-1', supplierRef: 'sup-1', unitPriceMinor: 3300, quantity: 10, amountMinor: 33000 });
  outsourcing.seed({ dispatchId: 'dsp-2', lineNo: 1, workOrderId: WO, processCode: 'OP-2', supplierRef: 'sup-2', unitPriceMinor: 1200, quantity: 10, amountMinor: 12000 });
  // ④ 人工三工种 + ⑤ 售后工时 + misc（不入六块）
  labor.seed({ laborEntryId: 'le-1', workOrderId: WO, workerId: 'u-1', trade: 'machining', hours: 2, workDate: '2026-10-20' });
  labor.seed({ laborEntryId: 'le-2', workOrderId: WO, workerId: 'u-2', trade: 'assembly', hours: 1, workDate: '2026-10-21' });
  labor.seed({ laborEntryId: 'le-3', workOrderId: WO, workerId: 'u-3', trade: 'electrical', hours: 0.5, workDate: '2026-10-21' });
  labor.seed({ laborEntryId: 'le-4', workOrderId: WO, workerId: 'u-4', trade: 'aftercare', hours: 3, workDate: '2026-10-22' });
  labor.seed({ laborEntryId: 'le-5', workOrderId: WO, workerId: 'u-5', trade: 'misc', hours: 4, workDate: '2026-10-22' });
  // ⑤ 售后报销（四费合计）
  aftercare.seed({ claimId: 'acl-1', dispatchId: 'dsp-3', workOrderId: WO, reimburseMinor: 45000, filedAt: '2026-10-23T09:00:00.000Z' });
}

describe('U7 六块聚合与两段拆分（costing.project.rebuild）', () => {
  it('六块合计 + 材料四类两段拆分 + 外协供应商行 + 人工三工种 + 售后工时/报销 + 设备两段（数值全对照）', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    const result = mustCommit(await rebuild(harness.service));
    expect(result.entriesCommitted).toBe(17); // 9 issue 段 + 1 设备采购 + 1 报销 + 2 外协 + 4 工时（misc 不入六块不落账）
    const totals = result.totals!;
    // ② 非标：利库 0（未录价）+ 采购 12000
    expect(totals.materialPart).toEqual({ reservedMinor: 0, purchaseMinor: 12000, totalMinor: 12000 });
    // ② 标准：24000 + 56000
    expect(totals.materialStandard).toEqual({ reservedMinor: 24000, purchaseMinor: 56000, totalMinor: 80000 });
    // ② 电气：1500 + 1500
    expect(totals.materialElectrical).toEqual({ reservedMinor: 1500, purchaseMinor: 1500, totalMinor: 3000 });
    // ② 原材料：7777
    expect(totals.materialRaw).toEqual({ totalMinor: 7777, lineCount: 1 });
    expect(totals.materialMinor).toBe(102777);
    // ③ 外协：供应商行 + 合计
    expect(totals.outsourcingBySupplier).toEqual([
      { supplierRef: 'sup-1', amountMinor: 33000, lineCount: 1 },
      { supplierRef: 'sup-2', amountMinor: 12000, lineCount: 1 },
    ]);
    expect(totals.outsourcingMinor).toBe(45000);
    // ④ 人工：机加 2h×6000 + 装配 1h×5000 + 调试位（电气）0.5h×6500
    expect(totals.laborRows).toEqual([
      { trade: 'machining', hours: 2, amountMinor: 12000 },
      { trade: 'assembly', hours: 1, amountMinor: 5000 },
      { trade: 'electrical', hours: 0.5, amountMinor: 3250 },
    ]);
    expect(totals.laborMinor).toBe(20250);
    // ⑤ 售后：工时 3h×5500 + 报销 45000
    expect(totals.aftercare).toEqual({ laborHours: 3, laborMinor: 16500, reimburseMinor: 45000, totalMinor: 61500 });
    // ⑥ 设备：采购 500000 + 利库 0（未录价）
    expect(totals.equipment).toEqual({ purchaseMinor: 500000, inventoryUseMinor: 0, totalMinor: 500000 });
    // 总计（misc 零工不入六块账本——工时留痕归 hours 模块自身，laborHoursByTrade 只含入账工种）
    expect(totals.grandMinor).toBe(729527);
    expect(totals.laborHoursByTrade).toEqual({ machining: 2, assembly: 1, electrical: 0.5, aftercare: 3 });
    expect(result.snapshotVersion).toBe(1);
    expect(result.snapshotChanged).toBe(true);
  });

  it('重算幂等：同事实重跑不加条目不加快照版本行', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    mustCommit(await rebuild(harness.service));
    const again = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-idem' }));
    expect(again.entriesCommitted).toBe(0);
    expect(again.entriesSkipped).toBeGreaterThan(0);
    expect(again.snapshotChanged).toBe(false);
    expect(again.snapshotVersion).toBe(1);
    const snapshots = await harness.service.projectSnapshots(t1, WO);
    expect(snapshots).toHaveLength(1);
  });

  it('来源漂移：外协重定价 → delta 冲销条目保净额 + 快照 v2（supersedes 链）', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    mustCommit(await rebuild(harness.service));
    harness.outsourcing.seed({ dispatchId: 'dsp-1', lineNo: 1, workOrderId: WO, processCode: 'OP-1', supplierRef: 'sup-1', unitPriceMinor: 4000, quantity: 10, amountMinor: 40000 });
    const second = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-drift' }));
    expect(second.entriesCommitted).toBe(1); // 一条 delta
    expect(second.totals!.outsourcingMinor).toBe(52000); // 40000 + 12000
    expect(second.snapshotChanged).toBe(true);
    expect(second.snapshotVersion).toBe(2);
    const snapshots = await harness.service.projectSnapshots(t1, WO);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.supersedes).toBe(snapshots[0]!.id);
    const driftEntries = await harness.service.projectEntries(t1, WO, { block: 'outsourcing' });
    const delta = driftEntries.find((row) => row.deltaOf !== null);
    expect(delta?.amountMinor).toBe(7000); // 40000 − 33000
  });

  it('撤销回冲：revoked 记录清零行 → delta 冲销对齐净额 0（文档：净数量=已发−撤销回冲）', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    mustCommit(await rebuild(harness.service));
    // irc-2（part 行 B）整单撤销：适配器按清零行投影（数量 0 / 金额 0——锚点净贡献 0）
    harness.issue.seed({
      recordId: 'irc-2', taskLineId: 'itl-2', workOrderId: WO, kind: 'part', segment: 'reserved',
      sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 0, amountMinor: 0,
      equipmentRef: 'eq-1', issuedAt: '2026-10-21T08:00:00.000Z',
    });
    const after = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-revoke' }));
    expect(after.totals!.materialPart.reservedMinor).toBe(0); // B 行未录价，净额归零
    const partEntries = await harness.service.projectEntries(t1, WO, { block: 'material-part' });
    const revocationDelta = partEntries.find((row) => row.deltaOf !== null && row.sourceRefId.includes('itl-2:reserved'));
    expect(revocationDelta?.quantity).toBe(-4); // +4 → 0 的对齐差额
    // 已录价锚点撤销：利库段金额同随清零行归零（价格表不翻活）
    mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', costUnitPriceMinor: 2000 }],
        }),
      ),
    );
    harness.issue.seed({
      recordId: 'irc-1', taskLineId: 'itl-1', workOrderId: WO, kind: 'part', segment: 'reserved',
      sourceLineId: 'll-part-1', itemId: null, drawingNo: 'DW-A', quantity: 0, amountMinor: 0,
      equipmentRef: 'eq-1', issuedAt: '2026-10-20T08:00:00.000Z',
    });
    const zeroed = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-revoke-priced' }));
    expect(zeroed.totals!.materialPart.reservedMinor).toBe(0);
    // 撤销行的价格录入被拒（清零行不进录入范围）
    const rejected = await harness.service.execute(
      t1,
      envelope('costing.price.entry.v1', {
        workOrderId: WO,
        rows: [{ recordId: 'irc-2', taskLineId: 'itl-2', costUnitPriceMinor: 100 }],
      }),
    );
    expect(rejected).toMatchObject({ status: 'rejected' });
  });

  it('命令幂等：同 operationId 重发被拒（不重试同信封）', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-once' }));
    const replay = await rebuild(harness.service, { operationId: 'op-rebuild-once' });
    expect(replay).toMatchObject({ status: 'rejected' });
  });

  it('主体与口径守门：工作令不存在 / 口径未发布 → rejected；expectedRevision 非 initial → rejected', async () => {
    const shared = createInMemoryCostingStores();
    await shared.models.insert({
      tenant: t1,
      code: 'standard',
      name: null,
      definition: DEFAULT_COSTING_MODEL_DEFINITION,
      status: 'active',
      objectVersion: 1,
      supersedes: null,
      auditStatus: 'published',
      businessTime: FIXED_NOW,
    });
    const projectStores = createInMemoryProjectCostStores();
    const service = new ProjectCostService(
      projectStores,
      { models: shared.models, events: shared.events, operations: shared.operations },
      {
        issueSegments: { issueSegments: async () => [] },
        equipmentPurchases: { equipmentPurchases: async () => [] },
        aftercareClaims: { aftercareClaims: async () => [] },
        labor: EMPTY_LABOR_COST_SOURCE,
        outsourcing: EMPTY_OUTSOURCING_COST_SOURCE,
        workOrder: { exists: async () => false },
        priceWriteback: { writeback: async () => {} },
      },
      { now: () => FIXED_NOW },
    );
    const missingSubject = await service.execute(t1, envelope('costing.project.rebuild.v1', { workOrderId: WO }));
    expect(missingSubject).toMatchObject({ status: 'rejected' });
    expect((missingSubject as { reason: string }).reason).toContain('不存在');

    const harness = await makeHarness({ publishModel: false });
    const noModel = await harness.service.execute(t1, envelope('costing.project.rebuild.v1', { workOrderId: WO }));
    expect(noModel).toMatchObject({ status: 'rejected' });
    expect((noModel as { reason: string }).reason).toContain('未发布');

    const badRevision = await harness.service.execute(
      t1,
      envelope('costing.project.rebuild.v1', { workOrderId: WO }, { expectedRevision: 3 }),
    );
    expect(badRevision).toMatchObject({ status: 'rejected' });
  });
});

describe('U7 录入价格（costing.price.entry）', () => {
  it('默认总金额 = 预占数量×单价；同 sourceLineId 联动写同单价并按各行数量重算；写回端口单向收到镜像', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    const result = mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', costUnitPriceMinor: 2000 }],
        }),
      ),
    );
    // 提交行 A（预占 5×2000=10000）+ 联动行 B（同 ll-part-1，预占 4×2000=8000）
    expect(result.priceRows).toHaveLength(2);
    const byAnchor = new Map(result.priceRows!.map((row) => [`${row.recordId}|${row.taskLineId}`, row]));
    expect(byAnchor.get('irc-1|itl-1')).toMatchObject({ kind: 'part', unitPriceMinor: 2000, totalMinor: 10000, amountManual: false });
    expect(byAnchor.get('irc-2|itl-2')).toMatchObject({ kind: 'part', unitPriceMinor: 2000, totalMinor: 8000, amountManual: false });
    expect(result.linkedSourceLineIds).toEqual(['ll-part-1']);
    // 写回端口单向收到两行镜像
    expect(harness.writeback.calls).toHaveLength(1);
    expect(harness.writeback.calls[0]).toHaveLength(2);

    // 重算：非标利库段按价格表入账（行 A 10000 + 行 B 8000）
    const rebuilt = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-priced' }));
    expect(rebuilt.totals!.materialPart.reservedMinor).toBe(18000);
    expect(rebuilt.totals!.materialPart.totalMinor).toBe(30000);
  });

  it('amountManual 行：仅手改总金额，不改单价不联动', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    // 先录单价（联动 A/B 两行）
    mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', costUnitPriceMinor: 2000 }],
        }),
      ),
    );
    // 行 B 仅手改总金额
    const manual = mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-2', taskLineId: 'itl-2', totalMinor: 9999, amountManual: true }],
        }),
      ),
    );
    expect(manual.linkedSourceLineIds).toEqual([]);
    const byAnchor = new Map(manual.priceRows!.map((row) => [`${row.recordId}|${row.taskLineId}`, row]));
    expect(byAnchor.get('irc-2|itl-2')).toMatchObject({ unitPriceMinor: 2000, totalMinor: 9999, amountManual: true });
    // 再改行 A 单价：联动跳过 amountManual 行 B（本批不重写 B——豁免行不在回执，经读面验证保留值）
    const relink = mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', costUnitPriceMinor: 3000 }],
        }),
      ),
    );
    const anchors = new Map(relink.priceRows!.map((row) => [`${row.recordId}|${row.taskLineId}`, row]));
    expect(anchors.get('irc-1|itl-1')).toMatchObject({ unitPriceMinor: 3000, totalMinor: 15000 });
    expect(anchors.has('irc-2|itl-2')).toBe(false); // 豁免行不联动
    const stored = new Map((await harness.service.priceEntries(t1, WO)).map((row) => [`${row.recordId}|${row.taskLineId}`, row]));
    expect(stored.get('irc-2|itl-2')).toMatchObject({ unitPriceMinor: 2000, totalMinor: 9999, amountManual: true });
  });

  it('设备利库录入：⑥ inventoryUse 段按价格表入账', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    mustCommit(
      await harness.service.execute(
        t1,
        envelope('costing.price.entry.v1', {
          workOrderId: WO,
          rows: [{ recordId: 'irc-3', taskLineId: 'itl-5', costUnitPriceMinor: 15000 }],
        }),
      ),
    );
    const rebuilt = mustCommit(await rebuild(harness.service, { operationId: 'op-rebuild-eq-priced' }));
    expect(rebuilt.totals!.equipment.inventoryUseMinor).toBe(45000); // 3 × 15000
    expect(rebuilt.totals!.equipment.totalMinor).toBe(545000);
  });

  it('守门：行锚不在册 / 手改无总金额 / 未提交单价却手改总金额 / 负数单价 → rejected 或 InputError', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    const notInScope = await harness.service.execute(
      t1,
      envelope('costing.price.entry.v1', {
        workOrderId: WO,
        rows: [{ recordId: 'irc-x', taskLineId: 'itl-x', costUnitPriceMinor: 100 }],
      }),
    );
    expect(notInScope).toMatchObject({ status: 'rejected' });
    expect((notInScope as { reason: string }).reason).toContain('不在录入范围');

    const manualNoTotal = await harness.service.execute(
      t1,
      envelope('costing.price.entry.v1', {
        workOrderId: WO,
        rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', amountManual: true }],
      }),
    );
    expect(manualNoTotal).toMatchObject({ status: 'rejected' });

    const totalWithoutFlag = await harness.service.execute(
      t1,
      envelope('costing.price.entry.v1', {
        workOrderId: WO,
        rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', totalMinor: 500 }],
      }),
    );
    expect(totalWithoutFlag).toMatchObject({ status: 'rejected' });

    expect(() =>
      parsePriceEntryPayload({ workOrderId: WO, rows: [{ recordId: 'irc-1', taskLineId: 'itl-1', costUnitPriceMinor: -1 }] }),
    ).toThrow(CostingInputError);
    expect(() => parsePriceEntryPayload({ workOrderId: WO, rows: [] })).toThrow(CostingInputError);
    expect(() =>
      parseProjectCommandBodyForKind({ operationId: 'op-1', expectedRevision: 'initial', command: { kind: 'costing.rebuild.v1', payload: {} } }, 'costing.price.entry.v1'),
    ).toThrow(CostingInputError);
  });
});

describe('U7 查询面（KPI / 详情 / 下钻 / 链回看）', () => {
  it('详情：快照冻结值 + KPI 六行；无快照 → NotFound', async () => {
    const harness = await makeHarness();
    seedSixBlocks(harness);
    await expect(harness.service.projectDetail(t1, WO)).rejects.toThrow(CostingNotFoundError);
    mustCommit(await rebuild(harness.service));
    const detail = await harness.service.projectDetail(t1, WO);
    expect(detail.snapshot.objectVersion).toBe(1);
    expect(detail.snapshot.rebuiltAt).toBe(FIXED_NOW);
    expect(detail.kpi.map((row) => [row.key, row.amountMinor])).toEqual([
      ['material', 102777],
      ['outsourcing', 45000],
      ['labor', 20250],
      ['aftercare', 61500],
      ['equipment', 500000],
      ['grand', 729527],
    ]);
    // 下钻：block 过滤（原材料段）
    const rawEntries = await harness.service.projectEntries(t1, WO, { block: 'material-raw' });
    expect(rawEntries).toHaveLength(1);
    expect(rawEntries[0]).toMatchObject({ amountMinor: 7777, segment: 'raw', lineKind: 'part', sourceType: 'issue-segment' });
    // 实时汇总与快照对照一致
    const summary = await harness.service.projectSummary(t1, WO);
    expect(summary.totals.grandMinor).toBe(detail.totals.grandMinor);
  });
});

describe('U7 聚合纯函数', () => {
  it('空事实 → 空合计；sameProjectTotals 深比（块级/供应商行/工时行/条目计数）', () => {
    const definition = DEFAULT_COSTING_MODEL_DEFINITION;
    const empty = aggregateProjectCost([], definition);
    expect(empty.grandMinor).toBe(0);
    expect(sameProjectTotals(empty, EMPTY_PROJECT_COST_TOTALS)).toBe(true);
    const seeded = aggregateProjectCost(
      [
        { block: 'material-part', segment: 'reserved', lineKind: 'part', amountMinor: 100, quantity: 1, trade: null, supplierRef: null },
        { block: 'labor', segment: 'labor', lineKind: null, amountMinor: null, quantity: 2, trade: 'machining', supplierRef: null },
      ],
      definition,
    );
    expect(sameProjectTotals(seeded, empty)).toBe(false);
    expect(seeded.laborRows[0]).toEqual({ trade: 'machining', hours: 2, amountMinor: 12000 });
  });
});
