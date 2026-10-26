/**
 * dispatch 模块测试（M2-W6）：四态状态机配置合法集、六类创建（零件工艺属性
 * 随单 / 外协批量派发×实时取价 / 装配电气齐套硬拦截 / 售后零工）、派工-开工-
 * 完工-撤销全链（待办联动 + 幂等 + 乐观锁）、外协单价补录（OutsourcingPriced
 * →costing 重算信号）、外协完工回厂触发（InspectionIntakePort）、打印数据、
 * 进度事实上卷（workorder ProgressFact 同形）、查询视图（列表筛选/按人/按序/
 * 供应商维度）、账本↔投影对账、模块装配与权限码。全部零框架直连（内存实现
 * + engine-flow 内存账本 + 可注入假端口——联动验证用夹具，真实端口由兄弟模块
 * 合流提供）。
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
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  DEFAULT_DISPATCH_FLOW_CONFIG,
  DEFAULT_KIT_GATED_KINDS,
  DISPATCH_KINDS,
  DISPATCH_STATE_IDS,
  dispatchKindLabel,
  dispatchStateLabel,
  progressStageOfDispatchKind,
} from '../../src/dispatch/dispatch-config.js';
import {
  DISPATCH_EVENT_TYPES,
  DISPATCH_ORDER_AGGREGATE_TYPE,
} from '../../src/dispatch/dispatch-events.js';
import { DispatchInputError } from '../../src/dispatch/dispatch-errors.js';
import {
  parseDispatchCreatePayload,
  parseDispatchTransferPayload,
  parseOutsourcingPriceBackfillPayload,
  type DispatchCommand,
} from '../../src/dispatch/dispatch-input.js';
import type {
  DispatchPrintPort,
  KitCheckFact,
  KitCheckReadPort,
  OutsourcingPriceSource,
} from '../../src/dispatch/dispatch-ports.js';
import type { InspectionIntakeReceipt, InspectionSourceFact } from '../../src/inspection/inspection-ports.js';
import {
  InMemoryDispatchDomainEventStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchOrderStore,
  InMemoryOutsourcingLineStore,
} from '../../src/dispatch/in-memory-dispatch-stores.js';
import { DispatchModule } from '../../src/dispatch/dispatch.module.js';
import {
  DispatchOrdersController,
  DispatchTasksController,
  OutsourcingController,
} from '../../src/dispatch/dispatch.controllers.js';
import { DispatchService } from '../../src/dispatch/dispatch.service.js';
import type { DispatchCommitted, DispatchCommandResult } from '../../src/dispatch/dispatch.service.js';
import type { OutsourcingPriceQuote } from '../../src/baseline/outsourcing-price.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const planner = UserId.create('u-planner-01');
const worker = UserId.create('u-worker-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版供跨模块使用） ----

class FakeKitCheckPort implements KitCheckReadPort {
  facts = new Map<string, KitCheckFact | null>(); // workOrderId -> 快照（null = 记录过"无"）
  calls: string[] = [];

  seed(workOrderId: string, complete: boolean, gapLineCount = 0): void {
    this.facts.set(workOrderId, {
      id: `kc-${workOrderId}`,
      workOrderId,
      complete,
      gapLineCount,
      refreshedAt: FIXED_NOW,
    });
  }

  async latestKitCheck(_tenant: TenantId, workOrderId: string): Promise<KitCheckFact | null> {
    this.calls.push(workOrderId);
    return this.facts.get(workOrderId) ?? null;
  }
}

class FakePriceSource implements OutsourcingPriceSource {
  quotes = new Map<string, OutsourcingPriceQuote>(); // processCode -> quote
  calls: string[] = [];

  seed(processCode: string, unitPriceMinor: number, marginPermyriad: number): void {
    this.quotes.set(processCode, {
      ruleCode: `rule-${processCode}`,
      processCode,
      unitPriceMinor,
      marginPermyriad,
      priceMinor: Math.floor((unitPriceMinor * (10_000 + marginPermyriad) + 5_000) / 10_000),
      unitPrice: '0',
      price: '0',
    });
  }

  async resolve(_tenant: TenantId, processCode: string): Promise<OutsourcingPriceQuote | null> {
    this.calls.push(processCode);
    return this.quotes.get(processCode) ?? null;
  }
}

class FakeInspectionIntake {
  facts: InspectionSourceFact[] = [];
  nextReceipt: InspectionIntakeReceipt = { inspectionId: 'ins-fixture-1', created: true };

  async receiveSourceFact(_tenant: TenantId, fact: InspectionSourceFact): Promise<InspectionIntakeReceipt> {
    this.facts.push(fact);
    return this.nextReceipt;
  }
}

class FakePrintPort implements DispatchPrintPort {
  documents: unknown[] = [];
  nextReceipt = { printed: true, jobId: 'job-1' as string | null };

  async print(_tenant: TenantId, document: unknown) {
    this.documents.push(document);
    return this.nextReceipt;
  }
}

function newHarness() {
  const orders = new InMemoryDispatchOrderStore();
  const outsourcingLines = new InMemoryOutsourcingLineStore();
  const operations = new InMemoryDispatchOperationStore();
  const domainEvents = new InMemoryDispatchDomainEventStore();
  const machineEvents = createInMemoryApprovalEventStore();
  const todos = new InMemoryTodoStore();
  const kitCheck = new FakeKitCheckPort();
  const priceSource = new FakePriceSource();
  const inspectionIntake = new FakeInspectionIntake();
  const print = new FakePrintPort();
  const service = new DispatchService(
    orders,
    outsourcingLines,
    operations,
    domainEvents,
    machineEvents,
    todos,
    { kitCheck, priceSource, inspectionIntake, print },
    { now: () => FIXED_NOW },
  );
  return { service, orders, outsourcingLines, operations, domainEvents, machineEvents, todos, kitCheck, priceSource, inspectionIntake, print };
}

let opSeq = 0;
function envelopeOf(
  kind: DispatchCommand['kind'],
  payload: unknown,
  expectedRevision: 'initial' | number = 'initial',
): CommandEnvelope<DispatchCommand> {
  opSeq += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: planner,
    operationId: OperationId.create(`op-dispatch-${opSeq}`),
    expectedRevision,
    issuedAt: FIXED_NOW,
    command: { kind, payload },
  });
}

async function committed(result: DispatchCommandResult): Promise<DispatchCommitted> {
  expect(result.status).toBe('committed');
  return result as DispatchCommitted;
}

function mustBeRejected(result: DispatchCommandResult, reasonMatch: string): void {
  expect(result.status).toBe('rejected');
  expect((result as { readonly reason: string }).reason).toContain(reasonMatch);
}

/** 批操作结果（DispatchBatchResult 形状）的拒绝断言。 */
function mustBatchBeRejected(
  result: { readonly status: string; readonly reason?: string },
  reasonMatch: string,
): void {
  expect(result.status).toBe('rejected');
  expect(result.reason ?? '').toContain(reasonMatch);
}

/** 零件派工创建（图号×工序×工艺属性随单）。 */
const PART_CREATE = {
  kind: 'part',
  workOrderId: 'wo-1',
  drawingNo: 'DWG-001',
  operationCode: 'proc-turn',
  material: '45# 钢',
  sizeSpec: 'Φ120×200',
  quantity: 10,
} as const;

/** 外协派工创建载荷（两行批量派发到供应商，其中一行未定价）。 */
function outsourcingCreatePayload(): Record<string, unknown> {
  return {
    kind: 'outsourcing',
    workOrderId: 'wo-1',
    quantity: 5,
    lines: [
      {
        processCode: 'proc-plate',
        drawingNo: 'DWG-002',
        supplierRef: 'sup-01',
        supplierName: '供应商甲',
        quantity: 3,
      },
      {
        processCode: 'proc-heat',
        supplierRef: 'sup-01',
        supplierName: '供应商甲',
        quantity: 2,
        unitPriceMinor: 12_500,
        promisedAt: '2026-11-10T00:00:00.000Z',
      },
    ],
  };
}

/** fix-wave-6 6a-1 测试板（与查询视图 seedBoard 同构：part(draft)+outsourcing(assigned)+assembly(draft)）。 */
async function seedBoardFor(h: ReturnType<typeof newHarness>): Promise<void> {
  h.kitCheck.seed('wo-1', true);
  await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE))); // wo-1 part
  const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
  await committed(
    await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), created.dispatchOrder!.id),
  );
  await committed(
    await h.service.execute(
      envelopeOf('dispatch.create.v1', { kind: 'assembly', workOrderId: 'wo-1', operationCode: 'proc-assemble', quantity: 1 }),
    ),
  );
}

// ---- 状态机配置与词汇 ----

describe('dispatch 状态机配置（engine-flow 配置形态，ADR-0010）', () => {
  it('五态 + 五条迁移：主干 draft→assigned→executing→done + 撤销 draft/assigned→cancelled', () => {
    expect(DISPATCH_STATE_IDS).toEqual(['draft', 'assigned', 'executing', 'done', 'cancelled']);
    expect(DEFAULT_DISPATCH_FLOW_CONFIG.initial).toBe('draft');
    expect(DEFAULT_DISPATCH_FLOW_CONFIG.transitions.map((rule) => `${rule.from}--${rule.event}-->${rule.to}`))
      .toEqual([
        'draft--ASSIGN-->assigned',
        'assigned--START-->executing',
        'executing--COMPLETE-->done',
        'draft--CANCEL-->cancelled',
        'assigned--CANCEL-->cancelled',
      ]);
    expect(DEFAULT_DISPATCH_FLOW_CONFIG.states.filter((state) => state.final).map((state) => state.id))
      .toEqual(['done', 'cancelled']);
  });

  it('六类 kind 词汇与中文标签', () => {
    expect(DISPATCH_KINDS).toEqual(['part', 'outsourcing', 'assembly', 'electrical', 'aftermarket', 'oddjob']);
    expect(dispatchKindLabel('part')).toBe('零件派工');
    expect(dispatchKindLabel('outsourcing')).toBe('外协派工');
    expect(dispatchStateLabel('assigned')).toBe('已派工');
    expect(dispatchStateLabel('unknown')).toBe('unknown');
  });

  it('齐套拦截默认配置 = 装配/电气；进度阶段映射（零件→machining、装配/电气→assembly）', () => {
    expect(DEFAULT_KIT_GATED_KINDS).toEqual(['assembly', 'electrical']);
    expect(progressStageOfDispatchKind('part')).toBe('machining');
    expect(progressStageOfDispatchKind('assembly')).toBe('assembly');
    expect(progressStageOfDispatchKind('electrical')).toBe('assembly');
    expect(progressStageOfDispatchKind('outsourcing')).toBeNull();
    expect(progressStageOfDispatchKind('oddjob')).toBeNull();
  });
});

// ---- 六类创建 ----

describe('dispatch.create：六类派工单创建', () => {
  it('零件派工：图号×工序×工艺属性快照随单（尺寸/材料），draft@v1 无机器事件', async () => {
    const h = newHarness();
    const result = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));

    expect(result.newRevision).toBe(1);
    expect(result.dispatchOrder?.state).toBe('draft');
    expect(result.dispatchOrder?.objectVersion).toBe(1);
    expect(result.dispatchOrder?.drawingNo).toBe('DWG-001');
    expect(result.dispatchOrder?.operationCode).toBe('proc-turn');
    expect(result.dispatchOrder?.material).toBe('45# 钢');
    expect(result.dispatchOrder?.sizeSpec).toBe('Φ120×200');
    expect(result.dispatchOrder?.doneQty).toBe(0);
    expect(result.dispatchOrder?.title).toBe('零件派工：DWG-001 × proc-turn');
    // 建单零机器事件（draft 初始态投影先行）
    const page = await h.machineEvents.readByAggregate({
      id: result.dispatchOrder!.id,
      type: DISPATCH_ORDER_AGGREGATE_TYPE,
    });
    expect(page.events).toHaveLength(0);
    // DispatchCreated 事件（Outbox 原子产生）
    expect(result.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.dispatchCreated);
    expect(result.events[0]?.payload).toMatchObject({ drawingNo: 'DWG-001', material: '45# 钢', quantity: 10 });
    expect(await h.domainEvents.pendingOutbox()).toHaveLength(1);
  });

  it('幂等：同 operationId 重放被拒（fix-wave-6 6a-1 起：占用互斥检先行——重放即重复占键）', async () => {
    const h = newHarness();
    const envelope = envelopeOf('dispatch.create.v1', PART_CREATE);
    await committed(await h.service.execute(envelope));
    // 重放被拒（不双写）：零件单成功后自身占用图号×工序键 → 占用互斥先于幂等账拒绝
    mustBeRejected(await h.service.execute(envelope), '已被零件派工单');
    expect((await h.orders.list(t1)).length).toBe(1);
    // 不占键类别（oddjob 无图号×工序键）：重放命中 operationId 幂等账
    const odd = envelopeOf('dispatch.create.v1', { kind: 'oddjob', title: '清理车间', quantity: 1 });
    await committed(await h.service.execute(odd));
    mustBeRejected(await h.service.execute(odd), '已落账');
    expect((await h.orders.list(t1, { kind: 'oddjob' })).length).toBe(1);
  });

  it('载荷判别：零件缺图号拒绝；外协缺行集拒绝；非外协带行集拒绝；售后/零工须有标题或工序', () => {
    expect(() => parseDispatchCreatePayload({ kind: 'part', operationCode: 'p', quantity: 1 })).toThrow(DispatchInputError);
    expect(() => parseDispatchCreatePayload({ kind: 'outsourcing', quantity: 1, lines: [] })).toThrow(DispatchInputError);
    expect(() =>
      parseDispatchCreatePayload({ kind: 'oddjob', quantity: 1, lines: [{ processCode: 'p', supplierRef: 's', quantity: 1 }] }),
    ).toThrow(DispatchInputError);
    expect(() => parseDispatchCreatePayload({ kind: 'oddjob', quantity: 1 })).toThrow(DispatchInputError);
    expect(parseDispatchCreatePayload({ kind: 'oddjob', title: '清理车间', quantity: 1 }).title).toBe('清理车间');
    expect(() => parseDispatchCreatePayload({ kind: 'assembly', quantity: 1 })).toThrow(DispatchInputError);
  });

  it('租户隔离：t2 看不到 t1 的派工单', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const detail = await h.orders.find(t2, created.dispatchOrder!.id);
    expect(detail).toBeNull();
    expect(await h.orders.list(t2)).toHaveLength(0);
  });
});

// ---- 齐套放行拦截（装配/电气） ----

describe('齐套放行拦截（装配/电气派工创建——workorder KitCheck 读端口）', () => {
  const ASSEMBLY_CREATE = { kind: 'assembly', workOrderId: 'wo-kit', operationCode: 'proc-assemble', quantity: 1 };

  it('fail-closed：端口未接线/无核查记录 → 拒绝创建', async () => {
    const h = newHarness();
    mustBeRejected(
      await h.service.execute(envelopeOf('dispatch.create.v1', ASSEMBLY_CREATE)),
      '无齐套核查记录',
    );
  });

  it('未齐套 → 拒绝创建（含缺口行数）', async () => {
    const h = newHarness();
    h.kitCheck.seed('wo-kit', false, 3);
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.create.v1', ASSEMBLY_CREATE)), '齐套未通过（缺 3 行');
  });

  it('齐套通过 → 创建成功且放行证据进事件载荷（装配与电气同拦截）', async () => {
    const h = newHarness();
    h.kitCheck.seed('wo-kit', true);
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', ASSEMBLY_CREATE)));
    expect(created.dispatchOrder?.state).toBe('draft');
    expect(created.events[0]?.payload).toMatchObject({
      kitCheck: { kitCheckId: 'kc-wo-kit', refreshedAt: FIXED_NOW },
    });

    h.kitCheck.seed('wo-kit-2', true);
    const electrical = await committed(
      await h.service.execute(
        envelopeOf('dispatch.create.v1', { kind: 'electrical', workOrderId: 'wo-kit-2', operationCode: 'proc-wire', quantity: 2 }),
      ),
    );
    expect(electrical.dispatchOrder?.kind).toBe('electrical');
  });

  it('装配无工作令 → 拒绝（齐套判断按工作令）', async () => {
    const h = newHarness();
    mustBeRejected(
      await h.service.execute(envelopeOf('dispatch.create.v1', { kind: 'assembly', operationCode: 'p', quantity: 1 })),
      '必须挂工作令',
    );
  });

  it('拦截覆盖集可整体替换（默认配置层）：oddjob 不经拦截', async () => {
    const h = newHarness();
    const created = await committed(
      await h.service.execute(envelopeOf('dispatch.create.v1', { kind: 'oddjob', title: '零工', quantity: 1 })),
    );
    expect(created.dispatchOrder?.kind).toBe('oddjob');
    expect(h.kitCheck.calls).toHaveLength(0);
  });
});

// ---- 外协链路（批量派发 / 实时取价 / 补录 / 回厂触发） ----

describe('外协链路：批量派发 + baseline 实时取价', () => {
  it('创建：未给定单价的行实时取价（lookup），给定行人工单价（manual），无规则行未定价', async () => {
    const h = newHarness();
    h.priceSource.seed('proc-plate', 10_000, 1_500); // 100 × 1.15 = 115.00 → 11500 分
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));

    const lines = created.outsourcingLines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      lineNo: 1,
      processCode: 'proc-plate',
      supplierRef: 'sup-01',
      quantity: 3,
      unitPriceMinor: 11_500,
      priceSource: 'lookup',
      marginPermyriad: 1_500,
    });
    expect(lines[1]).toMatchObject({
      lineNo: 2,
      unitPriceMinor: 12_500,
      priceSource: 'manual',
      marginPermyriad: null,
      promisedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(h.priceSource.calls).toEqual(['proc-plate']); // 只有未定价行走取价
    // 取价 = 工序单价×(1+利润率)（对账要点：10000 × 1.15 = 11500）
    expect(lines[0]?.unitPriceMinor).toBe(11_500);
  });

  it('无计价规则：行落未定价（priceSource null）——补录锚点', async () => {
    const h = newHarness();
    const payload = outsourcingCreatePayload();
    (payload.lines as { unitPriceMinor?: number | undefined }[])[1]!.unitPriceMinor = undefined;
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', payload)));
    expect(created.outsourcingLines?.[1]).toMatchObject({ unitPriceMinor: null, priceSource: null });
  });

  it('单价补录：v1→v2 + OutsourcingPriced 事件（costing 重算信号，含前值与数量）', async () => {
    const h = newHarness();
    const payload = outsourcingCreatePayload();
    (payload.lines as { unitPriceMinor?: number | undefined }[])[1]!.unitPriceMinor = undefined; // 未定价待补录
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', payload)));
    const line = created.outsourcingLines![1]!;

    const backfilled = await committed(
      await h.service.execute(
        envelopeOf('outsourcing.price.backfill.v1', { unitPriceMinor: 9_900, promisedAt: '2026-11-20T00:00:00.000Z' }, line.objectVersion),
        line.id,
      ),
    );
    expect(backfilled.newRevision).toBe(2);
    expect(backfilled.outsourcingLines?.[0]).toMatchObject({
      unitPriceMinor: 9_900,
      priceSource: 'backfill',
      promisedAt: '2026-11-20T00:00:00.000Z',
      objectVersion: 2,
    });
    expect(backfilled.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.outsourcingPriced);
    expect(backfilled.events[0]?.payload).toMatchObject({
      dispatchId: created.dispatchOrder!.id,
      lineNo: 2,
      previousUnitPriceMinor: null,
      unitPriceMinor: 9_900,
      quantity: 2,
    });

    // 乐观锁：旧版本补录被拒
    mustBeRejected(
      await h.service.execute(envelopeOf('outsourcing.price.backfill.v1', { unitPriceMinor: 1 }, 1), line.id),
      '乐观锁冲突',
    );
    // 载荷校验：非正单价拒绝
    expect(() => parseOutsourcingPriceBackfillPayload({ unitPriceMinor: 0 })).toThrow(DispatchInputError);
  });
});

// ---- 四态全链 ----

describe('四态全链：assign → start → complete（含待办联动与进度事实）', () => {
  it('全链推进 + 事件序 + 里程碑 + 待办创建/完成', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const id = created.dispatchOrder!.id;

    // assign：draft→assigned + 执行人 + 待办
    const assigned = await committed(
      await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01', remark: '今日开工' }, 1), id),
    );
    expect(assigned.dispatchOrder?.state).toBe('assigned');
    expect(assigned.dispatchOrder?.objectVersion).toBe(2);
    expect(assigned.dispatchOrder?.assignee).toEqual(worker);
    expect(assigned.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.dispatchAssigned);
    expect(assigned.events[0]?.payload).toMatchObject({ assignee: 'u-worker-01', remark: '今日开工' });
    expect(assigned.todosCreated).toHaveLength(1);
    expect(assigned.todosCreated[0]?.assignee).toEqual(worker);
    expect(assigned.todosCreated[0]?.source).toBe('dispatch');
    expect((await h.todos.listOwn(t1, worker)).filter((todo) => todo.status === 'open')).toHaveLength(1);

    // start：assigned→executing + 进度事实（machining/in_progress）+ 待办完成
    const started = await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    expect(started.dispatchOrder?.state).toBe('executing');
    expect(started.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.dispatchStarted);
    expect(started.events[0]?.payload).toMatchObject({
      progress: { stage: 'machining', drawingNo: 'DWG-001', operationId: 'proc-turn', doneQty: 0, totalQty: 10, status: 'in_progress' },
    });
    expect(started.todosCompleted).toHaveLength(1);

    // complete：executing→done + doneQty 回填 + 进度事实 done
    const completedResult = await committed(
      await h.service.execute(envelopeOf('dispatch.complete.v1', { doneQty: 8 }, 3), id),
    );
    expect(completedResult.dispatchOrder?.state).toBe('done');
    expect(completedResult.dispatchOrder?.doneQty).toBe(8);
    expect(completedResult.dispatchOrder?.objectVersion).toBe(4);
    expect(completedResult.events[0]?.payload).toMatchObject({
      doneQty: 8,
      quantity: 10,
      progress: { status: 'done', doneQty: 8, totalQty: 10 },
      inspectionIntake: null, // 零件单不触发回厂
    });

    // 完工后再迁移被拒（终态）
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 4), id), '不可开工');

    // 详情里程碑 = 三次迁移时序
    const detail = await h.service.dispatchDetail(t1, id);
    expect(detail.milestones.map((m) => `${m.from}--${m.event}-->${m.to}`)).toEqual([
      'draft--ASSIGN-->assigned',
      'assigned--START-->executing',
      'executing--COMPLETE-->done',
    ]);
  });

  it('乐观锁：expectedRevision 与当前版本不符 → rejected', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    mustBeRejected(
      await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 5), created.dispatchOrder!.id),
      '乐观锁冲突',
    );
  });

  it('完工数量超派工数量 → rejected；缺省整单完工', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const id = created.dispatchOrder!.id;
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.complete.v1', { doneQty: 11 }, 3), id), '超派工数量');
    const done = await committed(await h.service.execute(envelopeOf('dispatch.complete.v1', {}, 3), id));
    expect(done.dispatchOrder?.doneQty).toBe(10);
  });

  it('撤销：draft/assigned 可撤（事件含来源态），executing 起不可撤', async () => {
    const h = newHarness();
    const a = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const idA = a.dispatchOrder!.id;
    const cancelled = await committed(await h.service.execute(envelopeOf('dispatch.cancel.v1', { remark: '计划变更' }, 1), idA));
    expect(cancelled.dispatchOrder?.state).toBe('cancelled');
    expect(cancelled.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.dispatchCancelled);
    expect(cancelled.events[0]?.payload).toMatchObject({ fromState: 'draft', remark: '计划变更' });

    const b = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const idB = b.dispatchOrder!.id;
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), idB));
    await committed(await h.service.execute(envelopeOf('dispatch.cancel.v1', {}, 2), idB)); // assigned 可撤
    expect((await h.service.dispatchDetail(t1, idB)).order.state).toBe('cancelled');

    const c = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const idC = c.dispatchOrder!.id;
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), idC));
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), idC));
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.cancel.v1', {}, 3), idC), '不可撤销');
  });
});

// ---- 外协回厂触发 ----

describe('外协单完工回厂触发（InspectionIntakePort）', () => {
  async function outsourcingAtExecuting(h: ReturnType<typeof newHarness>): Promise<string> {
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    const id = created.dispatchOrder!.id;
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    return id;
  }

  it('完工 → 来源事实投递（sourceType=dispatch、幂等键=派工单 id、回执进事件载荷）', async () => {
    const h = newHarness();
    const id = await outsourcingAtExecuting(h);
    const done = await committed(await h.service.execute(envelopeOf('dispatch.complete.v1', {}, 3), id));
    expect(h.inspectionIntake.facts).toHaveLength(1);
    expect(h.inspectionIntake.facts[0]).toMatchObject({
      sourceType: 'dispatch',
      sourceRefId: id,
      drawingNo: 'DWG-002',
      quantity: 5,
      workOrderId: 'wo-1',
    });
    expect(done.inspectionIntake).toEqual({ inspectionId: 'ins-fixture-1', created: true, reason: null });
    expect(done.events[0]?.payload).toMatchObject({ inspectionIntake: { inspectionId: 'ins-fixture-1', created: true } });
  });

  it('未接线（缺省空实现）：回执 created:false，完工照常落账', async () => {
    const orders = new InMemoryDispatchOrderStore();
    const service = new DispatchService(
      orders,
      new InMemoryOutsourcingLineStore(),
      new InMemoryDispatchOperationStore(),
      new InMemoryDispatchDomainEventStore(),
      createInMemoryApprovalEventStore(),
      new InMemoryTodoStore(),
      {}, // 全部缺省端口（inspectionIntake = NOOP）
      { now: () => FIXED_NOW },
    );
    const created = await committed(await service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    const id = created.dispatchOrder!.id;
    await committed(await service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    await committed(await service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    const done = await committed(await service.execute(envelopeOf('dispatch.complete.v1', {}, 3), id));
    expect(done.dispatchOrder?.state).toBe('done');
    expect(done.inspectionIntake).toMatchObject({ created: false });
  });
});

// ---- 查询视图 ----

describe('查询视图：列表筛选 / 按人 / 按序 / 供应商维度 / 打印数据 / 进度事实', () => {
  async function seedBoard(h: ReturnType<typeof newHarness>): Promise<void> {
    h.kitCheck.seed('wo-1', true);
    await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE))); // wo-1 part
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    await committed(
      await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), created.dispatchOrder!.id),
    );
    await committed(
      await h.service.execute(envelopeOf('dispatch.create.v1', { kind: 'assembly', workOrderId: 'wo-1', operationCode: 'proc-assemble', quantity: 1 })),
    );
  }

  it('六类列表：kind/state/workOrderId/assignee 筛选', async () => {
    const h = newHarness();
    await seedBoard(h);
    expect((await h.service.listDispatchOrders(t1)).length).toBe(3);
    expect((await h.service.listDispatchOrders(t1, { kind: 'outsourcing' })).length).toBe(1);
    expect((await h.service.listDispatchOrders(t1, { state: 'assigned' })).length).toBe(1);
    expect((await h.service.listDispatchOrders(t1, { workOrderId: 'wo-1' })).length).toBe(3);
    expect((await h.service.listDispatchOrders(t1, { assignee: 'u-worker-01' })).length).toBe(1);
  });

  it('按人任务视图（assigned/executing）与按序任务视图', async () => {
    const h = newHarness();
    await seedBoard(h);
    const tasks = await h.service.tasksByAssignee(t1, 'u-worker-01');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe('outsourcing');
    expect(await h.service.tasksByWorkOrder(t1, 'wo-1')).toHaveLength(3);
  });

  it('外协单供应商维度（明细行 × 派工单投影 join）', async () => {
    const h = newHarness();
    await seedBoard(h);
    const rows = await h.service.outsourcingBySupplier(t1, 'sup-01');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ supplierRef: 'sup-01', dispatchState: 'assigned', lineNo: 1, processCode: 'proc-plate' });
    expect(await h.service.outsourcingBySupplier(t1, 'sup-unknown')).toHaveLength(0);
  });

  it('打印数据：外协加工单结构化文档（含未定价行展示）；非外协单 404 语义', async () => {
    const h = newHarness();
    await seedBoard(h);
    const outsourcing = (await h.service.listDispatchOrders(t1, { kind: 'outsourcing' }))[0]!;
    const document = await h.service.outsourcingPrintData(t1, outsourcing.id);
    expect(document.title).toBe('外协加工单（供应商甲）');
    expect(document.fields.map((field) => field.label)).toEqual(
      ['派工单号', '工作令', '供应商', '派工数量', '交期', '状态'],
    );
    expect(document.lines).toHaveLength(2);
    expect(document.lines[1]?.unitPriceLabel).toBe('125.00'); // manual 单价格式化
    // 打印提交（端口回执）
    const printed = await h.service.printOutsourcingSheet(t1, outsourcing.id);
    expect(printed.receipt.printed).toBe(true);
    expect(h.print.documents).toHaveLength(1);

    const part = (await h.service.listDispatchOrders(t1, { kind: 'part' }))[0]!;
    await expect(h.service.outsourcingPrintData(t1, part.id)).rejects.toThrow('不是外协单');
  });

  it('进度事实上卷：零件→machining、装配→assembly、外协/零工不进上卷', async () => {
    const h = newHarness();
    await seedBoard(h);
    const facts = await h.service.progressFacts(t1, 'wo-1');
    expect(facts).toHaveLength(2); // part + assembly；outsourcing 不进上卷
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'machining', drawingNo: 'DWG-001', operationId: 'proc-turn', status: 'pending' }),
        expect.objectContaining({ stage: 'assembly', operationId: 'proc-assemble', status: 'pending' }),
      ]),
    );
  });
});

// ---- fix-wave-6 6a-1：同工序占用互斥（RREQ-DP-021） ----

describe('同工序占用互斥（RREQ-DP-021：活跃（非终态）占用）', () => {
  it('同 (工作令,图号,工序) 活跃单存在时零件建单被拒；撤销释放可再派；跨工作令同键不互斥', async () => {
    const h = newHarness();
    const a = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const idA = a.dispatchOrder!.id;
    // 同键再建被拒（draft 即占用）
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)), '已被零件派工单');
    // 跨工作令同键不互斥（占用锚=令内工序行，源 is_dispatch 语义）
    const otherWo = await committed(
      await h.service.execute(envelopeOf('dispatch.create.v1', { ...PART_CREATE, workOrderId: 'wo-2' })),
    );
    expect(otherWo.dispatchOrder?.state).toBe('draft');
    // 同令不同工序不互斥
    const otherProc = await committed(
      await h.service.execute(envelopeOf('dispatch.create.v1', { ...PART_CREATE, operationCode: 'proc-mill' })),
    );
    expect(otherProc.dispatchOrder?.state).toBe('draft');
    // 撤销释放 → 可再派
    await committed(await h.service.execute(envelopeOf('dispatch.cancel.v1', { remark: '计划变更' }, 1), idA));
    const again = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    expect(again.dispatchOrder?.state).toBe('draft');
  });

  it('外协明细行与零件单共用占用账；行取消/父单完工释放占用', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    const line = created.outsourcingLines![0]!; // DWG-002 × proc-plate
    mustBeRejected(
      await h.service.execute(
        envelopeOf('dispatch.create.v1', {
          kind: 'part', workOrderId: 'wo-1', drawingNo: 'DWG-002', operationCode: 'proc-plate', quantity: 1,
        }),
      ),
      '已被外协派工单明细行',
    );
    // 行取消释放 → 零件建单放行
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), created.dispatchOrder!.id));
    await committed(
      await h.service.execute(envelopeOf('outsourcing.line.cancel.v1', { reason: '供应商取消' }, line.objectVersion), line.id),
    );
    const part = await committed(
      await h.service.execute(
        envelopeOf('dispatch.create.v1', {
          kind: 'part', workOrderId: 'wo-1', drawingNo: 'DWG-002', operationCode: 'proc-plate', quantity: 1,
        }),
      ),
    );
    expect(part.dispatchOrder?.state).toBe('draft');
  });

  it('外协建单：撞既有占用拒绝；同单内重复键拒绝', async () => {
    const h = newHarness();
    await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE))); // 占 wo-1|DWG-001|proc-turn
    const payload = outsourcingCreatePayload();
    const lines = payload.lines as Record<string, unknown>[];
    lines[0]!.drawingNo = 'DWG-001';
    lines[0]!.processCode = 'proc-turn';
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.create.v1', payload)), '已被零件派工单');

    const duplicateWithin = {
      kind: 'outsourcing', workOrderId: 'wo-9', quantity: 1,
      lines: [
        { processCode: 'proc-x', drawingNo: 'DWG-DUP', supplierRef: 'sup-01', quantity: 1 },
        { processCode: 'proc-x', drawingNo: 'DWG-DUP', supplierRef: 'sup-02', quantity: 1 },
      ],
    };
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.create.v1', duplicateWithin)), '同单内亦不可重复派工');
  });
});

// ---- fix-wave-6 6a-1：转单+审计（dispatch.transfer.v1——RREQ-DP-024 我方形态） ----

describe('转单+审计（dispatch.transfer.v1：executing 整单换执行人/工序）', () => {
  async function partAtExecuting(h: ReturnType<typeof newHarness>): Promise<string> {
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const id = created.dispatchOrder!.id;
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    return id;
  }

  it('executing 转单：换执行人/工序落投影 + 审计事件快照 + 版本不动（机器账本零追加）+ 转单后完工照常', async () => {
    const h = newHarness();
    const id = await partAtExecuting(h);
    const transferred = await committed(
      await h.service.execute(
        envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-02', operationCode: 'proc-mill', remark: '产能调整' }, 3),
        id,
      ),
    );
    expect(transferred.dispatchOrder?.state).toBe('executing');
    expect(transferred.dispatchOrder?.objectVersion).toBe(3); // 非状态机迁移：版本不推进
    expect(String(transferred.dispatchOrder?.assignee)).toBe('u-worker-02');
    expect(transferred.dispatchOrder?.operationCode).toBe('proc-mill');
    // 机器事件零追加（账本重放口径不变——重放↔投影一致性保持）
    const page = await h.machineEvents.readByAggregate({ id, type: DISPATCH_ORDER_AGGREGATE_TYPE });
    expect(page.events).toHaveLength(2);
    // 审计事件：前后全快照（mes_transfer_operation 语义 → 事件账本形态）
    expect(transferred.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.dispatchTransferred);
    expect(transferred.events[0]?.payload).toMatchObject({
      kind: 'part',
      workOrderId: 'wo-1',
      drawingNo: 'DWG-001',
      fromAssignee: 'u-worker-01',
      toAssignee: 'u-worker-02',
      fromOperationCode: 'proc-turn',
      toOperationCode: 'proc-mill',
      state: 'executing',
      quantity: 10,
      doneQty: 0,
      remark: '产能调整',
    });
    // 换执行人 → 新执行人待办
    expect(transferred.todosCreated).toHaveLength(1);
    expect(String(transferred.todosCreated[0]?.assignee)).toBe('u-worker-02');
    // 转单后完工照常（账本↔投影一致性锚点）
    const done = await committed(await h.service.execute(envelopeOf('dispatch.complete.v1', {}, 3), id));
    expect(done.dispatchOrder?.state).toBe('done');
  });

  it('仅 executing 可转；无变更拒绝；目标工序撞他单活跃占用拒绝；幂等与乐观锁', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', PART_CREATE)));
    const id = created.dispatchOrder!.id;
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-02' }, 1), id), '不可转单');
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    // 无变更（载荷至少携其一，但值与当前一致）
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-01' }, 3), id), '无变更');
    // 目标工序被另一活跃单占用（同令 DWG-001 × proc-mill）
    await committed(
      await h.service.execute(envelopeOf('dispatch.create.v1', { ...PART_CREATE, operationCode: 'proc-mill' })),
    );
    mustBeRejected(await h.service.execute(envelopeOf('dispatch.transfer.v1', { operationCode: 'proc-mill' }, 3), id), '转单目标工序');
    // 幂等与版本稳定：转单不推进版本 → opA 重放在 opB（换回）后仍过无变更检，
    // 命中 operationId 幂等账（claim 拒绝，不二次写投影/事件）
    const opA = envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-02' }, 3);
    await committed(await h.service.execute(opA, id));
    await committed(await h.service.execute(envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-01' }, 3), id));
    mustBeRejected(await h.service.execute(opA, id), '已落账');
    expect(String((await h.orders.find(t1, id))?.assignee)).toBe('u-worker-01');
    // 乐观锁
    mustBeRejected(
      await h.service.execute(envelopeOf('dispatch.transfer.v1', { assignee: 'u-worker-02' }, 99), id),
      '乐观锁冲突',
    );
    // 载荷判别：两维均缺拒绝
    expect(() => parseDispatchTransferPayload({ remark: 'r' })).toThrow(DispatchInputError);
  });
});

// ---- fix-wave-6 6a-1：派工单 Excel 导出（RREQ-DP-026） ----

describe('派工单 Excel 导出（RREQ-DP-026：ExcelPort 先例，仅导出不写库）', () => {
  it('两表产出：零件表含材料/尺寸列；外协表按行展开、末列状态/取消原因；过滤维度与列表一致', async () => {
    const h = newHarness();
    await seedBoardFor(h); // part(draft) + outsourcing(assigned, 2 行) + assembly(draft)
    const result = await h.service.exportDispatchOrders(t1);
    expect(result.kind).toBe('json-tables');
    if (result.kind !== 'json-tables') return;
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['零件派工单', '外协派工单']);
    const partSheet = result.sheets[0]!;
    expect(partSheet.header).toContain('材料');
    expect(partSheet.header).toContain('尺寸');
    expect(partSheet.rows).toHaveLength(1);
    expect(partSheet.rows[0]?.[partSheet.header.indexOf('材料')]).toBe('45# 钢');
    expect(partSheet.rows[0]?.[partSheet.header.indexOf('尺寸')]).toBe('Φ120×200');
    const osSheet = result.sheets[1]!;
    expect(osSheet.rows).toHaveLength(2);
    expect(osSheet.header.slice(-2)).toEqual(['状态', '取消原因']); // 源 七.4：明细末尾增列
    expect(osSheet.rows[0]?.[osSheet.header.indexOf('状态')]).toBe('已派工'); // 父单 assigned → 行已派工
    // kind 过滤：只导外协 → 零件表零行
    const onlyOutsourcing = await h.service.exportDispatchOrders(t1, { kind: 'outsourcing' });
    if (onlyOutsourcing.kind !== 'json-tables') throw new Error('shape');
    expect(onlyOutsourcing.sheets[0]?.rows).toHaveLength(0);
    expect(onlyOutsourcing.sheets[1]?.rows).toHaveLength(2);
    // 仅导出不写库：投影行数与状态不变、零机器事件追加
    expect((await h.orders.list(t1)).length).toBe(3);
    const part = (await h.service.listDispatchOrders(t1, { kind: 'part' }))[0]!;
    const partPage = await h.machineEvents.readByAggregate({ id: part.id, type: DISPATCH_ORDER_AGGREGATE_TYPE });
    expect(partPage.events).toHaveLength(0);
  });
});

// ---- fix-wave-6 6a-1：列表批操作 + 页眉状态统计（RREQ-DP-032） ----

describe('列表批操作与页眉状态统计（RREQ-DP-032）', () => {
  it('页眉五态计数随搜索口径（kind 维过滤生效；零基全键）', async () => {
    const h = newHarness();
    await seedBoardFor(h);
    expect(await h.service.dispatchOrderStats(t1)).toEqual({
      draft: 2, assigned: 1, executing: 0, done: 0, cancelled: 0,
    });
    expect(await h.service.dispatchOrderStats(t1, { kind: 'outsourcing' })).toEqual({
      draft: 0, assigned: 1, executing: 0, done: 0, cancelled: 0,
    });
  });

  it('批量派工下发：勾选均 draft → 全部 assigned + 各自待办；版本不符整批拒绝零副作用', async () => {
    const h = newHarness();
    await seedBoardFor(h);
    const part = (await h.service.listDispatchOrders(t1, { kind: 'part' }))[0]!;
    const assembly = (await h.service.listDispatchOrders(t1, { kind: 'assembly' }))[0]!;
    // 乐观锁整批拒绝：第一张 revision 不符 → 两张均不动
    const refused = await h.service.batchAssign(t1, planner, {
      operationId: OperationId.create('op-batch-refuse'),
      assignee: UserId.create('u-worker-01'),
      remark: null,
      items: [
        { id: part.id, expectedRevision: 9 },
        { id: assembly.id, expectedRevision: 1 },
      ],
    });
    mustBatchBeRejected(refused, '乐观锁冲突');
    expect((await h.orders.find(t1, assembly.id))?.state).toBe('draft');
    // 正常批：两张 draft → assigned + 两待办
    const result = await h.service.batchAssign(t1, planner, {
      operationId: OperationId.create('op-batch-ok'),
      assignee: UserId.create('u-worker-01'),
      remark: null,
      items: [
        { id: part.id, expectedRevision: 1 },
        { id: assembly.id, expectedRevision: 1 },
      ],
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.items.every((item) => item.status === 'committed')).toBe(true);
    expect(result.items.map((item) => item.newRevision)).toEqual([2, 2]);
    expect(result.todosCreated).toHaveLength(2);
    expect((await h.service.listDispatchOrders(t1, { state: 'assigned' })).length).toBe(3);
  });

  it('批量删除：装配豁免整批拒绝零副作用；零件/外协 draft 落撤销终态；非 draft 整批拒绝', async () => {
    const h = newHarness();
    await seedBoardFor(h);
    const part = (await h.service.listDispatchOrders(t1, { kind: 'part' }))[0]!;
    const assembly = (await h.service.listDispatchOrders(t1, { kind: 'assembly' }))[0]!;
    mustBatchBeRejected(
      await h.service.batchCancel(t1, planner, {
        operationId: OperationId.create('op-bc-exempt'),
        remark: null,
        items: [
          { id: part.id, expectedRevision: 1 },
          { id: assembly.id, expectedRevision: 1 },
        ],
      }),
      '豁免',
    );
    expect((await h.orders.find(t1, part.id))?.state).toBe('draft'); // 整批拒绝零副作用
    const ok = await h.service.batchCancel(t1, planner, {
      operationId: OperationId.create('op-bc-ok'),
      remark: null,
      items: [{ id: part.id, expectedRevision: 1 }],
    });
    expect(ok.status).toBe('committed');
    expect((await h.orders.find(t1, part.id))?.state).toBe('cancelled');
    // 非 draft（outsourcing 已 assigned）整批拒绝
    const outsourcing = (await h.service.listDispatchOrders(t1, { kind: 'outsourcing' }))[0]!;
    mustBatchBeRejected(
      await h.service.batchCancel(t1, planner, {
        operationId: OperationId.create('op-bc-state'),
        remark: null,
        items: [{ id: outsourcing.id, expectedRevision: 1 }],
      }),
      '仅待下发',
    );
    // 批量删除释放占用：DWG-001×proc-turn 可再建
    const reDispatched = await committed(
      await h.service.execute(
        envelopeOf('dispatch.create.v1', {
          kind: 'part', workOrderId: 'wo-1', drawingNo: 'DWG-001', operationCode: 'proc-turn', quantity: 1,
        }),
      ),
    );
    expect(reDispatched.dispatchOrder?.state).toBe('draft');
  });
});

// ---- fix-wave-6 6a-1：取消外协明细行（RREQ-DP-031） ----

describe('取消外协明细行（outsourcing.line.cancel.v1：状态流转 + 原因记录）', () => {
  async function outsourcingAt(h: ReturnType<typeof newHarness>, state: 'draft' | 'assigned' | 'executing') {
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    const id = created.dispatchOrder!.id;
    if (state === 'draft') return { id, lines: created.outsourcingLines! };
    await committed(await h.service.execute(envelopeOf('dispatch.assign.v1', { assignee: 'u-worker-01' }, 1), id));
    if (state === 'assigned') return { id, lines: created.outsourcingLines! };
    await committed(await h.service.execute(envelopeOf('dispatch.start.v1', {}, 2), id));
    return { id, lines: created.outsourcingLines! };
  }

  it('已派工行取消：dispatched→cancelled + 原因记录 + 版本 +1 + 事件快照；父单状态不动；查询/打印/详情面带出', async () => {
    const h = newHarness();
    const { id, lines } = await outsourcingAt(h, 'assigned');
    const line = lines[0]!; // DWG-002 × proc-plate（v1）
    const rowsBefore = await h.service.outsourcingBySupplier(t1, 'sup-01');
    expect(rowsBefore[0]).toMatchObject({ status: 'dispatched', statusLabel: '已派工' });

    const cancelled = await committed(
      await h.service.execute(envelopeOf('outsourcing.line.cancel.v1', { reason: '供应商产能不足' }, line.objectVersion), line.id),
    );
    expect(cancelled.outsourcingLines?.[0]).toMatchObject({
      cancelReason: '供应商产能不足',
      cancelledAt: FIXED_NOW,
      objectVersion: 2,
    });
    expect(cancelled.events[0]?.eventType).toBe(DISPATCH_EVENT_TYPES.outsourcingLineCancelled);
    expect(cancelled.events[0]?.payload).toMatchObject({
      dispatchId: id,
      dispatchState: 'assigned',
      lineNo: 1,
      processCode: 'proc-plate',
      supplierRef: 'sup-01',
      quantity: 3,
      previousStatus: 'dispatched',
      status: 'cancelled',
      cancelReason: '供应商产能不足',
    });
    // 行状态流转可判定：行 1 已取消、行 2 仍已派工；父单状态不动
    const rowsAfter = await h.service.outsourcingBySupplier(t1, 'sup-01');
    expect(rowsAfter[0]).toMatchObject({ status: 'cancelled', statusLabel: '已取消' });
    expect(rowsAfter[1]).toMatchObject({ status: 'dispatched', statusLabel: '已派工' });
    expect((await h.orders.find(t1, id))?.state).toBe('assigned');
    // 打印列带出（源 七.4：状态/取消原因列）
    const print = await h.service.outsourcingPrintData(t1, id);
    expect(print.lines[0]).toMatchObject({ statusLabel: '已取消', cancelReason: '供应商产能不足' });
    expect(print.lines[1]).toMatchObject({ statusLabel: '已派工' });
    // 详情行视图带状态
    const detail = await h.service.dispatchDetail(t1, id);
    expect(detail.outsourcingLines[0]).toMatchObject({ status: 'cancelled', statusLabel: '已取消' });
  });

  it('draft（待派工行）不可取消；重复取消/幂等/乐观锁拒绝；父单完工后（已质检行）不可取消', async () => {
    const h = newHarness();
    const { id, lines } = await outsourcingAt(h, 'executing');
    const line = lines[0]!;
    const other = lines[1]!;
    const envelope = envelopeOf('outsourcing.line.cancel.v1', { reason: '改自制' }, line.objectVersion);
    await committed(await h.service.execute(envelope, line.id));
    mustBeRejected(await h.service.execute(envelopeOf('outsourcing.line.cancel.v1', {}, 2), line.id), '已取消');
    // 幂等：同 operationId 携当前版本重放 → 已取消行校验先行拒绝（不二次写行/事件）
    mustBeRejected(
      await h.service.execute(
        makeCommandEnvelope({
          tenantId: t1,
          issuedBy: planner,
          operationId: envelope.operationId,
          expectedRevision: 2,
          issuedAt: FIXED_NOW,
          command: { kind: 'outsourcing.line.cancel.v1', payload: { reason: '改自制' } },
        }),
        line.id,
      ),
      '已取消，不可重复取消',
    );
    // 旧版本（乐观锁）拒绝
    mustBeRejected(
      await h.service.execute(envelopeOf('outsourcing.line.cancel.v1', {}, 1), line.id),
      '乐观锁冲突',
    );
    // 父单完工 → 已质检行不可取消
    await committed(await h.service.execute(envelopeOf('dispatch.complete.v1', {}, 3), id));
    mustBeRejected(await h.service.execute(envelopeOf('outsourcing.line.cancel.v1', {}, 1), other.id), '已质检');

    // draft 父单：行推导态=待派工 → 不可取消
    const h2 = newHarness();
    const draft = await committed(await h2.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    mustBeRejected(
      await h2.service.execute(envelopeOf('outsourcing.line.cancel.v1', { reason: 'x' }, 1), draft.outsourcingLines![0]!.id),
      '待派工',
    );
  });

  it('父单撤销 → 明细行状态推导为已取消（父撤即行取消，无行级写入）', async () => {
    const h = newHarness();
    const created = await committed(await h.service.execute(envelopeOf('dispatch.create.v1', outsourcingCreatePayload())));
    await committed(
      await h.service.execute(envelopeOf('dispatch.cancel.v1', { remark: '计划变更' }, 1), created.dispatchOrder!.id),
    );
    const rows = await h.service.outsourcingBySupplier(t1, 'sup-01');
    expect(rows[0]).toMatchObject({ status: 'cancelled', statusLabel: '已取消' });
  });
});

// ---- 模块装配与权限码 ----

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = DispatchModule.register();
    expect(module.controllers).toEqual([DispatchOrdersController, DispatchTasksController, OutsourcingController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DispatchModule)).toBeUndefined();
  });

  it('权限码：20 路由逐点声明（04-dispatch.md §5 最小集 + fix-wave-6 6a-1 增量）', () => {
    const expected: readonly [object, string, string][] = [
      [DispatchOrdersController.prototype, 'create', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'list', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'exportOrders', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'stats', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'get', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'assign', 'dispatch:assign'],
      [DispatchOrdersController.prototype, 'start', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'complete', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'cancel', 'dispatch:cancel'],
      [DispatchOrdersController.prototype, 'transfer', 'dispatch:assign'],
      [DispatchOrdersController.prototype, 'batchAssign', 'dispatch:assign'],
      [DispatchOrdersController.prototype, 'batchCancel', 'dispatch:cancel'],
      [DispatchTasksController.prototype, 'tasksByAssignee', 'dispatch:read'],
      [DispatchTasksController.prototype, 'tasksByWorkOrder', 'dispatch:read'],
      [DispatchTasksController.prototype, 'progressFacts', 'dispatch:read'],
      [OutsourcingController.prototype, 'bySupplier', 'outsourcing:read'],
      [OutsourcingController.prototype, 'backfillPrice', 'outsourcing:price'],
      [OutsourcingController.prototype, 'cancelLine', 'dispatch:cancel'],
      [OutsourcingController.prototype, 'printData', 'outsourcing:read'],
      [OutsourcingController.prototype, 'print', 'outsourcing:read'],
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
