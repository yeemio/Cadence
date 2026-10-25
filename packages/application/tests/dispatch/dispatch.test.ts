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

  it('幂等：同 operationId 重放被拒', async () => {
    const h = newHarness();
    const envelope = envelopeOf('dispatch.create.v1', PART_CREATE);
    await committed(await h.service.execute(envelope));
    mustBeRejected(await h.service.execute(envelope), '已落账');
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

// ---- 模块装配与权限码 ----

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = DispatchModule.register();
    expect(module.controllers).toEqual([DispatchOrdersController, DispatchTasksController, OutsourcingController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DispatchModule)).toBeUndefined();
  });

  it('权限码：13 路由逐点声明（04-dispatch.md §5 最小集）', () => {
    const expected: readonly [object, string, string][] = [
      [DispatchOrdersController.prototype, 'create', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'list', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'get', 'dispatch:read'],
      [DispatchOrdersController.prototype, 'assign', 'dispatch:assign'],
      [DispatchOrdersController.prototype, 'start', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'complete', 'dispatch:write'],
      [DispatchOrdersController.prototype, 'cancel', 'dispatch:cancel'],
      [DispatchTasksController.prototype, 'tasksByAssignee', 'dispatch:read'],
      [DispatchTasksController.prototype, 'tasksByWorkOrder', 'dispatch:read'],
      [DispatchTasksController.prototype, 'progressFacts', 'dispatch:read'],
      [OutsourcingController.prototype, 'bySupplier', 'outsourcing:read'],
      [OutsourcingController.prototype, 'backfillPrice', 'outsourcing:price'],
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
