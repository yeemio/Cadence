/**
 * ai-query 模块测试（CONTRACT v1 · 2026-10-28）：意图路由规则全分支（各短语
 * 类/编号多匹配 clarify/无时间词 clarify/未命中 unsupported）、三能力
 * （happy/零行/denied；material-gap 另有 unavailable 合同冻结分支）、口径注记
 * verbatim、时间语义 freeze（今日/本周/最近N天，Asia/Shanghai 本地周一起点）、
 * 澄清回放（选项 id 稳定可重放/非法选项/无 pending 冲突）、会话租户与用户
 * 隔离（跨用户读 404）、输入解析边界（question 1..500、selectedOptionId 非法）、
 * 模块装配与权限码。全部零框架直连（兄弟域内存实现 + 可注入假端口）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  InspectionId,
  TenantId,
  UserId,
  WorkOrderId,
} from '@smes/business-core';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  InMemoryInspectionOrderStore,
  InMemoryNonconformStore,
} from '../../src/inspection/in-memory-inspection-stores.js';
import type { InspectionOrderStore, NonconformStore } from '../../src/inspection/inspection-stores.js';
import {
  InMemoryGapCheckStore,
  InMemoryPurchaseOrderStore,
  InMemoryPurchaseRequestStore,
} from '../../src/listing/in-memory-listing-stores.js';
import type {
  GapCheckStore,
  PurchaseOrderStore,
  PurchaseRequestStore,
} from '../../src/listing/listing-stores.js';
import { newGapCheckId } from '../../src/listing/listing-ids.js';
import {
  InMemoryWorkOrderStore,
} from '../../src/workorder/in-memory-workorder-stores.js';
import type { ProgressFact, ProgressFactPort } from '../../src/workorder/workorder-ports.js';
import type { WorkOrder, WorkOrderStore } from '../../src/workorder/workorder-stores.js';
import { newWorkOrderId } from '../../src/workorder/workorder-ids.js';
import {
  AI_QUERY_CAPABILITIES,
  AI_QUERY_TIME_CLARIFY_OPTIONS,
  DONE_QTY_CALIBER_NOTE,
} from '../../src/ai-query/ai-query.capabilities.js';
import {
  AiQueryConflictError,
  AiQueryInputError,
  AiQueryNotFoundError,
} from '../../src/ai-query/ai-query-errors.js';
import {
  AI_QUERY_SESSION_LIMIT_DEFAULT,
  parseAskBody,
  parseSessionLimit,
} from '../../src/ai-query/ai-query-input.js';
import { resolveTimeWindow } from '../../src/ai-query/ai-query-time.js';
import { InMemoryAiQuerySessionStore } from '../../src/ai-query/in-memory-ai-query-stores.js';
import type { AiQueryAnswer, AiQueryPermissionResolver, AskResponse } from '../../src/ai-query/ai-query-ports.js';
import { RuleIntentRouter } from '../../src/ai-query/rule-intent-router.js';
import { AiQueryService } from '../../src/ai-query/ai-query.service.js';
import { AiQueryModule } from '../../src/ai-query/ai-query.module.js';
import {
  AiQueryController,
  AiQuerySessionsController,
} from '../../src/ai-query/ai-query.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const userA = UserId.create('u-a-01');
const userB = UserId.create('u-b-01');
// 上海当地 2026-10-28（周三）18:00 —— 今日零点 = 2026-10-27T16:00Z，本周一 = 10-26。
const FIXED_NOW = '2026-10-28T10:00:00.000Z';

// ---- 可注入假端口 ----

class FakeProgressFactPort implements ProgressFactPort {
  readonly facts = new Map<string, readonly ProgressFact[]>();

  seed(workOrderId: string, facts: readonly ProgressFact[]): void {
    this.facts.set(workOrderId, facts);
  }

  async progressFacts(_tenant: TenantId, workOrderId: string): Promise<readonly ProgressFact[]> {
    return this.facts.get(workOrderId) ?? [];
  }
}

class FakePermissionResolver implements AiQueryPermissionResolver {
  constructor(private readonly allowed: ReadonlySet<string>) {}

  async hasPermission(_tenant: TenantId, _user: UserId, code: string): Promise<boolean> {
    return this.allowed.has(code);
  }
}

// ---- 夹具 ----

interface Fixture {
  readonly workOrders: InMemoryWorkOrderStore;
  readonly progressFacts: FakeProgressFactPort;
  readonly gapChecks: InMemoryGapCheckStore;
  readonly purchaseRequests: InMemoryPurchaseRequestStore;
  readonly purchaseOrders: InMemoryPurchaseOrderStore;
  readonly inspectionOrders: InMemoryInspectionOrderStore;
  readonly nonconforms: InMemoryNonconformStore;
}

function makeFixture(): Fixture {
  return {
    workOrders: new InMemoryWorkOrderStore(),
    progressFacts: new FakeProgressFactPort(),
    gapChecks: new InMemoryGapCheckStore(),
    purchaseRequests: new InMemoryPurchaseRequestStore(),
    purchaseOrders: new InMemoryPurchaseOrderStore(),
    inspectionOrders: new InMemoryInspectionOrderStore(),
    nonconforms: new InMemoryNonconformStore(),
  };
}

function makeService(
  fixture: Fixture,
  allowed: readonly string[] = ['workorder:read', 'listing:read', 'inspection:read'],
  options: { readonly now?: () => string; readonly rowLimit?: number } = {},
): AiQueryService {
  return new AiQueryService(
    {
      workOrders: fixture.workOrders as WorkOrderStore,
      progressFacts: fixture.progressFacts,
      gapChecks: fixture.gapChecks as GapCheckStore,
      purchaseRequests: fixture.purchaseRequests as PurchaseRequestStore,
      purchaseOrders: fixture.purchaseOrders as PurchaseOrderStore,
      inspectionOrders: fixture.inspectionOrders as InspectionOrderStore,
      nonconforms: fixture.nonconforms as NonconformStore,
    },
    new InMemoryAiQuerySessionStore(),
    new FakePermissionResolver(new Set(allowed)),
    new RuleIntentRouter(),
    {
      clarifyOptionLimit: 5,
      rowLimit: options.rowLimit ?? 50,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

async function seedWorkOrder(
  fixture: Fixture,
  id: string,
  projectName: string,
  plannedDeliveryAt: string | null = null,
): Promise<WorkOrder> {
  return fixture.workOrders.create({
    tenant: t1,
    id: WorkOrderId.create(id),
    flowConfigId: 'work-order',
    state: 'in_production',
    objectVersion: 1,
    customerRef: null,
    projectName,
    salesRep: null,
    manager: null,
    plannedDeliveryAt,
    packagingArrivalAt: null,
  });
}

const PROGRESS_FACTS: readonly ProgressFact[] = [
  { stage: 'machining', drawingNo: 'DWG-A01', operationId: 'OP-10', doneQty: 10, totalQty: 10, status: 'done' },
  { stage: 'machining', drawingNo: 'DWG-A01', operationId: 'OP-20', doneQty: 3, totalQty: 10, status: 'in_progress' },
  { stage: 'assembly', drawingNo: null, operationId: '装配', doneQty: 0, totalQty: 5, status: 'pending' },
];

async function seedGapCheck(fixture: Fixture, workOrderId: string, withGaps: boolean): Promise<void> {
  await fixture.gapChecks.append({
    tenant: t1,
    id: newGapCheckId(),
    workOrderId,
    kinds: [
      { kind: 'part', lineCount: 10, checkedLineCount: 10, gapLineCount: withGaps ? 2 : 0, complete: !withGaps },
      { kind: 'standard', lineCount: 5, checkedLineCount: 5, gapLineCount: 0, complete: true },
    ],
    gapLines: withGaps
      ? [
          {
            kind: 'part',
            listingLineId: 'll-1',
            itemId: 'item-001',
            drawingNo: 'DWG-A01',
            requiredQty: 10,
            availableQty: 4,
            gapQty: 6,
            neededBy: '2026-11-01',
          },
          {
            kind: 'part',
            listingLineId: 'll-2',
            itemId: 'item-002',
            drawingNo: 'DWG-B02',
            requiredQty: 8,
            availableQty: 8,
            gapQty: 0,
            neededBy: null,
          },
        ]
      : [],
    complete: !withGaps,
    checkedBy: userA,
  });
}

async function seedPurchaseLinks(fixture: Fixture, workOrderId: string): Promise<void> {
  await fixture.purchaseRequests.create({
    tenant: t1,
    id: 'preq-1',
    workOrderId,
    kind: 'nonstandard',
    flowConfigId: 'purchase-request',
    state: 'approved',
    objectVersion: 2,
    itemId: 'item-001',
    quantity: 6,
    requester: userA,
    remark: null,
    source: { type: 'gap', gapCheckId: 'gc-fixture', listingLineId: 'll-1' },
  });
  await fixture.purchaseOrders.create({
    tenant: t1,
    id: 'po-1',
    workOrderId,
    flowConfigId: 'purchase-order',
    state: 'issued',
    objectVersion: 4,
    supplierRef: 'sup-1',
    supplierName: '华东铸锻',
    promisedAt: '2026-11-10T00:00:00.000Z',
    lines: [
      { lineNo: 1, itemId: 'item-001', drawingNo: 'DWG-A01', quantity: 6, unitPriceMinor: 12500, receivedQty: 0 },
    ],
    requestIds: ['preq-1'],
    buyer: null,
    remark: null,
  });
}

async function seedInspection(
  fixture: Fixture,
  id: string,
  judgedAt: string | null,
  failedQty: number,
  state = 'failed',
): Promise<void> {
  await fixture.inspectionOrders.create({
    tenant: t1,
    id: InspectionId.create(id),
    flowConfigId: 'inspection-order',
    state,
    objectVersion: 1,
    kind: 'self_outsourced',
    sourceType: 'dispatch',
    sourceRefId: 'disp-fixture',
    itemId: 'item-001',
    drawingNo: 'DWG-A01',
    quantity: 20,
  });
  if (judgedAt === null) return;
  await fixture.inspectionOrders.updateJudgment(t1, InspectionId.create(id), 1, {
    passedQty: 20 - failedQty,
    failedQty,
    judgeRemark: null,
    judgedBy: userA,
    judgedAt,
    closeDueAt: null,
  });
}

function answerOf(response: AskResponse): AiQueryAnswer {
  if (response.kind !== 'answer') {
    throw new Error(`期望 answer，得到 ${response.kind}`);
  }
  return response;
}

// ---- 意图路由规则全分支 ----

describe('RuleIntentRouter（v1 确定性规则）', () => {
  const router = new RuleIntentRouter();

  it('进度词各短语 → workorder-progress（进度/做到/完成/剩）', () => {
    for (const question of ['WO-2026-001 进度如何', 'WO-2026-001 做到哪了', '完成多少了', '还剩多少没做']) {
      expect(router.route(question), question).toMatchObject({ kind: 'routed', capabilityId: 'workorder-progress' });
    }
    const intent = router.route('WO-2026-001 做到哪了');
    if (intent.kind === 'routed' && intent.capabilityId === 'workorder-progress') {
      expect(intent.subjectTokens).toEqual(['wo-2026-001']);
    }
  });

  it('缺口词各短语 → material-gap（缺料/齐套/物料/材料）', () => {
    for (const question of ['WO-2026-001 缺料吗', '齐套了吗', '物料还差多少', '材料什么时候到']) {
      const intent = router.route(question);
      expect(intent, question).toMatchObject({ kind: 'routed', capabilityId: 'material-gap' });
    }
  });

  it('质检词＋时间词 → quality-inspection（今日/本周/最近N天）', () => {
    expect(router.route('今天有哪些不合格')).toMatchObject({
      kind: 'routed',
      capabilityId: 'quality-inspection',
      timeRange: { kind: 'today' },
    });
    expect(router.route('本周返工多少')).toMatchObject({
      kind: 'routed',
      capabilityId: 'quality-inspection',
      timeRange: { kind: 'this-week' },
    });
    expect(router.route('最近7天检验情况')).toMatchObject({
      kind: 'routed',
      capabilityId: 'quality-inspection',
      timeRange: { kind: 'last-n-days', days: 7 },
    });
    expect(router.route('过去30天特采有几单')).toMatchObject({
      kind: 'routed',
      capabilityId: 'quality-inspection',
      timeRange: { kind: 'last-n-days', days: 30 },
    });
  });

  it('质检词无时间词 → timeRange null（服务层发澄清）', () => {
    expect(router.route('有哪些不合格')).toMatchObject({
      kind: 'routed',
      capabilityId: 'quality-inspection',
      timeRange: null,
    });
  });

  it('未命中 → unsupported', () => {
    for (const question of ['薪酬怎么算', '帮我下个采购单', '今天天气如何']) {
      expect(router.route(question), question).toEqual({ kind: 'unsupported' });
    }
  });

  it('时间词剥离：最近N天中的数字不混入主体线索 token', () => {
    const intent = router.route('WO-2026 最近7天进度');
    expect(intent).toMatchObject({ kind: 'routed', capabilityId: 'workorder-progress' });
    if (intent.kind === 'routed' && intent.capabilityId === 'workorder-progress') {
      expect(intent.subjectTokens).toEqual(['wo-2026']);
    }
  });
});

// ---- 时间语义（freeze） ----

describe('resolveTimeWindow（Asia/Shanghai 本地口径）', () => {
  it('今日 = 当地 00:00 至今（周三 18:00 当地 → 前日 16:00Z 起）', () => {
    const window = resolveTimeWindow({ kind: 'today' }, FIXED_NOW);
    expect(window.from).toBe('2026-10-27T16:00:00.000Z');
    expect(window.to).toBe(FIXED_NOW);
    expect(window.label).toBe('今日');
  });

  it('本周 = 当地本周一 00:00 至今（周一 10-26 → 10-25T16:00Z 起）', () => {
    const window = resolveTimeWindow({ kind: 'this-week' }, FIXED_NOW);
    expect(window.from).toBe('2026-10-25T16:00:00.000Z');
    expect(window.label).toBe('本周');
  });

  it('最近N天 = 滚动 N×24h', () => {
    const window = resolveTimeWindow({ kind: 'last-n-days', days: 7 }, FIXED_NOW);
    expect(window.from).toBe('2026-10-21T10:00:00.000Z');
    expect(window.label).toBe('最近7天');
  });
});

// ---- workorder-progress 能力 ----

describe('能力 workorder-progress', () => {
  it('happy：三卡事实 + 未完成任务 + 口径注记 verbatim', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造', '2026-11-15T00:00:00.000Z');
    fixture.progressFacts.seed('wo-2026-001', PROGRESS_FACTS);
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 做到哪了' }));
    expect(response.capabilityId).toBe('workorder-progress');
    expect(response.factCards.map((card) => card.title)).toEqual(['项目进度', '机加工进度', '装配调试进度', '未完成任务']);
    // 未完成任务 = 机加工 OP-20（剩 7）+ 装配（剩 5）。
    const unfinished = response.factCards[3]!;
    expect(unfinished.completeness).toMatchObject({ status: 'complete', rowCount: 2, totalKnown: true });
    expect(unfinished.rows?.values[0]).toEqual(['机加工', 'DWG-A01', 'OP-20', 7]);
    // 口径注记原样携带（不得静默吞掉）。
    expect(response.caliberNotes.join('\n')).toContain('口径暂按派工侧终态呈现，对账阶段校正');
    expect(response.caliberNotes).toContain(DONE_QTY_CALIBER_NOTE);
    // 交付倒计时初版口径注记随计划交付出现。
    expect(response.caliberNotes.join('\n')).toContain('初版口径');
    const countdown = response.factCards[0]!.metrics.find((metric) => metric.key === 'daysToDelivery');
    // 截断取整：11-15 00:00Z − 10-28 10:00Z = 17.58 天 → 17。
    expect(countdown?.value).toBe(17);
  });

  it('零行：无进度事实 → 合法 answer 明示无记录', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 进度' }));
    expect(response.summary).toContain('查询有效、无记录');
    expect(response.factCards.length).toBe(4); // 结构仍完整（零值来自有效查询）
  });

  it('denied：缺 workorder:read → 200 回答通道明示缺码', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, []);

    const response = await service.ask(t1, userA, { question: 'WO-2026-001 进度' });
    expect(response).toMatchObject({
      kind: 'denied',
      reason: 'no_permission',
      missingPermissions: ['workorder:read'],
    });
    expect(response.kind === 'denied' ? response.hint : '').toContain('workorder:read');
  });

  it('截断如实：rowLimit 越限 → completeness truncated + note', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    fixture.progressFacts.seed(
      'wo-2026-001',
      Array.from({ length: 3 }, (_, index) => ({
        stage: 'machining' as const,
        drawingNo: `DWG-A0${index + 1}`,
        operationId: 'OP-10',
        doneQty: 1,
        totalQty: 10,
        status: 'in_progress' as const,
      })),
    );
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW, rowLimit: 2 });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 进度' }));
    const machining = response.factCards[1]!;
    expect(machining.completeness).toMatchObject({ status: 'truncated', rowCount: 2, totalKnown: true });
    expect(machining.completeness!.note).toContain('共 3 行');
  });
});

// ---- material-gap 能力 ----

describe('能力 material-gap', () => {
  it('happy：齐套总览 + 缺口明细 + 采购关联', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    await seedGapCheck(fixture, 'wo-2026-001', true);
    await seedPurchaseLinks(fixture, 'wo-2026-001');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 缺料吗' }));
    expect(response.capabilityId).toBe('material-gap');
    expect(response.factCards.map((card) => card.title)).toEqual(['物料缺口（最新齐套核对）', '缺口明细', '采购关联']);
    expect(response.factCards[0]!.metrics.find((metric) => metric.key === 'complete')?.value).toBe('存在缺口');
    expect(response.factCards[1]!.completeness.rowCount).toBe(2);
    expect(response.factCards[1]!.rows?.values[0]).toEqual([
      '零件清单',
      'DWG-A01',
      'item-001',
      10,
      4,
      6,
      '2026-11-01',
    ]);
    expect(response.factCards[2]!.metrics.find((metric) => metric.key === 'orderCount')?.value).toBe(1);
    // 可用量口径注记（利库预占口径）。
    expect(response.caliberNotes.join('\n')).toContain('可用量口径');
  });

  it('零行：已核查且无缺口行 → 合法 answer 明示无记录（非 unavailable）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    await seedGapCheck(fixture, 'wo-2026-001', false);
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 齐套了吗' }));
    expect(response.kind).toBe('answer');
    expect(response.summary).toContain('查询有效、无记录');
    expect(response.summary).toContain('无缺口行');
  });

  it('unavailable：无齐套核对记录 → 数据源未就绪，不当零缺口回答', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = await service.ask(t1, userA, { question: 'WO-2026-001 缺料吗' });
    expect(response).toMatchObject({ kind: 'unavailable', reason: 'data_source_not_ready' });
    if (response.kind === 'unavailable') {
      expect(response.detail).toContain('无齐套核对记录');
    }
  });

  it('denied：缺 listing:read → 明示缺码', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    await seedGapCheck(fixture, 'wo-2026-001', true);
    const service = makeService(fixture, ['workorder:read']);

    const response = await service.ask(t1, userA, { question: 'WO-2026-001 缺料吗' });
    expect(response).toMatchObject({ kind: 'denied', missingPermissions: ['listing:read'] });
  });
});

// ---- quality-inspection 能力 ----

describe('能力 quality-inspection', () => {
  it('happy：窗口内 failed 落窗 + 处置状态（左闭右开）', async () => {
    const fixture = makeFixture();
    await seedInspection(fixture, 'insp-1', '2026-10-28T09:00:00.000Z', 5); // 今日窗内
    await seedInspection(fixture, 'insp-2', '2026-10-27T16:00:00.000Z', 3); // 恰在 from（含）
    await seedInspection(fixture, 'insp-3', '2026-10-28T10:00:00.000Z', 4); // 恰在 to（不含）
    await seedInspection(fixture, 'insp-4', '2026-10-20T00:00:00.000Z', 8); // 窗外
    await seedInspection(fixture, 'insp-5', null, 0, 'passed'); // 非 failed 态
    await fixture.nonconforms.create({
      tenant: t1,
      id: 'nc-1',
      inspectionId: InspectionId.create('insp-1'),
      flowConfigId: 'nonconform',
      state: 'open',
      objectVersion: 1,
      itemId: 'item-001',
      quantity: 5,
    });
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: '今天有哪些不合格' }));
    expect(response.capabilityId).toBe('quality-inspection');
    const card = response.factCards[0]!;
    expect(card.metrics.find((metric) => metric.key === 'failedCount')?.value).toBe(2);
    expect(card.metrics.find((metric) => metric.key === 'failedQty')?.value).toBe(8);
    expect(card.metrics.find((metric) => metric.key === 'openNonconformCount')?.value).toBe(1);
    expect(card.timeBasis).toMatchObject({ kind: 'range', from: '2026-10-27T16:00:00.000Z', to: FIXED_NOW });
    expect(card.rows?.values.length).toBe(2);
    expect(response.summary).toContain('不合格检验单 2 张');
  });

  it('零行：窗口内无 failed → 合法 answer 明示无记录', async () => {
    const fixture = makeFixture();
    await seedInspection(fixture, 'insp-1', '2026-10-01T00:00:00.000Z', 5); // 窗外
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: '今日不合格有哪些' }));
    expect(response.kind).toBe('answer');
    expect(response.summary).toContain('查询有效、无记录');
  });

  it('denied：缺 inspection:read → 明示缺码', async () => {
    const fixture = makeFixture();
    const service = makeService(fixture, ['workorder:read', 'listing:read']);

    const response = await service.ask(t1, userA, { question: '今天有哪些不合格' });
    expect(response).toMatchObject({ kind: 'denied', missingPermissions: ['inspection:read'] });
  });
});

// ---- 澄清（clarify）与回放 ----

describe('澄清与回放', () => {
  it('编号多匹配 → 列候选选项；selectedOptionId 回放续走（选项 id 稳定）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    await seedWorkOrder(fixture, 'wo-2026-002', '二号机组改造');
    fixture.progressFacts.seed('wo-2026-002', PROGRESS_FACTS);
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const clarify = await service.ask(t1, userA, { question: 'WO-2026 进度' });
    expect(clarify.kind).toBe('clarify');
    if (clarify.kind !== 'clarify') return;
    expect(clarify.options.map((option) => option.id)).toEqual(['wo-2026-001', 'wo-2026-002']);

    const answer = answerOf(
      await service.ask(t1, userA, {
        sessionId: clarify.sessionId,
        question: 'WO-2026 进度',
        selectedOptionId: 'wo-2026-002',
      }),
    );
    expect(answer.capabilityId).toBe('workorder-progress');
    expect(answer.factCards[0]!.subject.id).toBe('wo-2026-002');
    // 回放后 pending 清空：再回传同一选项 → 409 冲突。
    await expect(
      service.ask(t1, userA, {
        sessionId: clarify.sessionId,
        question: 'WO-2026 进度',
        selectedOptionId: 'wo-2026-002',
      }),
    ).rejects.toBeInstanceOf(AiQueryConflictError);
  });

  it('质检无时间词 → 时间选项澄清；回放 last-7-days 续走滚动窗口', async () => {
    const fixture = makeFixture();
    await seedInspection(fixture, 'insp-1', '2026-10-22T00:00:00.000Z', 5); // 最近7天窗内
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const clarify = await service.ask(t1, userA, { question: '有哪些不合格' });
    expect(clarify.kind).toBe('clarify');
    if (clarify.kind !== 'clarify') return;
    expect(clarify.options).toEqual(AI_QUERY_TIME_CLARIFY_OPTIONS.map((option) => expect.objectContaining({ id: option.id })));

    const answer = answerOf(
      await service.ask(t1, userA, {
        sessionId: clarify.sessionId,
        question: '有哪些不合格',
        selectedOptionId: 'last-7-days',
      }),
    );
    expect(answer.capabilityId).toBe('quality-inspection');
    expect(answer.factCards[0]!.timeBasis).toMatchObject({ from: '2026-10-21T10:00:00.000Z', to: FIXED_NOW });
  });

  it('非法选项 → 400 输入错误', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    await seedWorkOrder(fixture, 'wo-2026-002', '二号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const clarify = await service.ask(t1, userA, { question: 'WO-2026 进度' });
    if (clarify.kind !== 'clarify') throw new Error('期望 clarify');
    await expect(
      service.ask(t1, userA, {
        sessionId: clarify.sessionId,
        question: 'WO-2026 进度',
        selectedOptionId: 'wo-999',
      }),
    ).rejects.toBeInstanceOf(AiQueryInputError);
  });

  it('denied 先于澄清：质检无时间词且缺码 → 直接 denied（不带澄清选项）', async () => {
    const fixture = makeFixture();
    const service = makeService(fixture, []);

    const response = await service.ask(t1, userA, { question: '有哪些不合格' });
    expect(response).toMatchObject({ kind: 'denied', missingPermissions: ['inspection:read'] });
  });
});

// ---- 未命中 / 主体解析 ----

describe('未命中与主体解析', () => {
  it('未命中 → unsupported 带能力提示', async () => {
    const fixture = makeFixture();
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = await service.ask(t1, userA, { question: '薪酬怎么算' });
    expect(response).toMatchObject({ kind: 'unsupported' });
    if (response.kind === 'unsupported') {
      expect(response.capabilityHints.length).toBe(3);
      expect(response.hint).toContain('规则引擎模式');
    }
  });

  it('主体无匹配 → 零主体 answer（查询有效、无记录）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const response = answerOf(await service.ask(t1, userA, { question: 'WO-999 进度' }));
    expect(response.summary).toContain('未找到匹配的工作令');
    expect(response.factCards).toEqual([]);
  });

  it('项目名模糊匹配（无编号 token 时回落全量候选）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, newWorkOrderId(), '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    // 问题只含领域词（无 token）→ 单一工作令租户内直接执行。
    const response = await service.ask(t1, userA, { question: '进度怎么样' });
    expect(response.kind).toBe('answer');
  });
});

// ---- 会话（租户/用户隔离 + 线程历史） ----

describe('会话存储与隔离', () => {
  it('ask 落 turn；list 只见本人；detail 回放线程', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const answer = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 进度' }));
    const items = await service.listSessions(t1, userA, AI_QUERY_SESSION_LIMIT_DEFAULT);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ sessionId: answer.sessionId, turnCount: 1 });

    const detail = await service.sessionDetail(t1, userA, answer.sessionId);
    expect(detail.turns.length).toBe(1);
    expect(detail.turns[0]!.kind).toBe('answer');
    expect(detail.turns[0]!.answerId).toBe(answer.answerId);
    expect(detail.turns[0]!.question).toBe('WO-2026-001 进度');
  });

  it('跨用户读 → 404（不泄漏存在性）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const answer = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 进度' }));
    await expect(service.sessionDetail(t1, userB, answer.sessionId)).rejects.toBeInstanceOf(AiQueryNotFoundError);
    await expect(
      service.ask(t1, userB, { sessionId: answer.sessionId, question: 'WO-2026-001 进度' }),
    ).rejects.toBeInstanceOf(AiQueryNotFoundError);
    expect(await service.listSessions(t1, userB, 50)).toEqual([]);
  });

  it('跨租户读 → 404（session 归属 tenant+userId）', async () => {
    const fixture = makeFixture();
    await seedWorkOrder(fixture, 'wo-2026-001', '一号机组改造');
    const service = makeService(fixture, undefined, { now: () => FIXED_NOW });

    const answer = answerOf(await service.ask(t1, userA, { question: 'WO-2026-001 进度' }));
    await expect(service.sessionDetail(t2, userA, answer.sessionId)).rejects.toBeInstanceOf(AiQueryNotFoundError);
  });
});

// ---- 输入解析边界 ----

describe('输入解析', () => {
  it('question 1..500：空/超长拒绝，500 字符收', () => {
    expect(() => parseAskBody({ question: '  ' })).toThrow(AiQueryInputError);
    expect(() => parseAskBody({ question: 'x'.repeat(501) })).toThrow(AiQueryInputError);
    expect(parseAskBody({ question: `进度${'好'.repeat(498)}` }).question.length).toBe(500);
    expect(() => parseAskBody({ question: '进度', selectedOptionId: 'today' })).toThrow(AiQueryInputError);
    expect(parseAskBody({ question: '进度', sessionId: 'aiq-s-1', selectedOptionId: 'today' })).toMatchObject({
      sessionId: 'aiq-s-1',
      selectedOptionId: 'today',
    });
  });

  it('limit：1..200 整数，缺省 undefined', () => {
    expect(parseSessionLimit(undefined)).toBeUndefined();
    expect(parseSessionLimit('')).toBeUndefined();
    expect(parseSessionLimit('50')).toBe(50);
    expect(() => parseSessionLimit('0')).toThrow(AiQueryInputError);
    expect(() => parseSessionLimit('201')).toThrow(AiQueryInputError);
    expect(() => parseSessionLimit('abc')).toThrow(AiQueryInputError);
  });
});

// ---- 能力目录 / 模块装配 / 权限码 ----

describe('能力目录与模块装配', () => {
  it('capabilities：三域能力、权限码与主体类别', () => {
    expect(AI_QUERY_CAPABILITIES.map((entry) => entry.capabilityId)).toEqual([
      'workorder-progress',
      'material-gap',
      'quality-inspection',
    ]);
    expect(AI_QUERY_CAPABILITIES.map((entry) => entry.subjectKind)).toEqual(['workorder', 'material', 'inspection']);
    expect(AI_QUERY_CAPABILITIES.map((entry) => entry.requiredPermissions)).toEqual([
      ['workorder:read'],
      ['listing:read'],
      ['inspection:read'],
    ]);
    expect(AI_QUERY_CAPABILITIES.every((entry) => entry.status === 'ready')).toBe(true);
  });

  it('register()：store 端口注入装配完整（controllers + providers）', () => {
    const fixture = makeFixture();
    const module = AiQueryModule.register({
      workOrderStore: fixture.workOrders,
      progressFacts: fixture.progressFacts,
      gapCheckStore: fixture.gapChecks,
      purchaseRequestStore: fixture.purchaseRequests,
      purchaseOrderStore: fixture.purchaseOrders,
      inspectionOrderStore: fixture.inspectionOrders,
      nonconformStore: fixture.nonconforms,
      permissionResolver: new FakePermissionResolver(new Set(['ai-query:read'])),
    });
    expect(module.controllers).toEqual([AiQueryController, AiQuerySessionsController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiQueryModule)).toBeUndefined();
  });

  it('权限码：4 路由逐点声明 ai-query:read（字面量）', () => {
    const expected: readonly [object, string, string][] = [
      [AiQueryController.prototype, 'capabilities', 'ai-query:read'],
      [AiQueryController.prototype, 'ask', 'ai-query:read'],
      [AiQuerySessionsController.prototype, 'list', 'ai-query:read'],
      [AiQuerySessionsController.prototype, 'detail', 'ai-query:read'],
    ];
    for (const [target, method, code] of expected) {
      const actual = Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (target as unknown as Record<string, object>)[method] as object,
      );
      expect(actual, `${String(method)} 权限码`).toBe(code);
    }
  });
});
