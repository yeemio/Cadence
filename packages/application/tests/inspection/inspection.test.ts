/**
 * inspection 模块测试（M2-W4）：存储端口内存合同、四态/三态状态机全路径、
 * 四类来源自动建单（幂等）、判定（合格放行/不合格闭环明细）、复检、处置
 * （三枚举）、闭环（返工复检前置 + 全明细闭环推单）、闭环超时点名（事件+
 * 待办+IM，一次幂等）、汇总事实（合格率/待检/未闭环——工作台 KPI 口径）、
 * 队列与明细查询、命令信封（幂等/乐观锁/信封形状误用）、账本↔投影对账、
 * 模块装配与权限码。全部零框架直连（内存实现 + engine-flow 内存账本 +
 * 可注入假端口——跨模块夹具另见 testkit inspection-fixtures）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  EventId,
  InspectionId,
  makeCommandEnvelope,
  OperationId,
  TenantId,
  UserId,
  type CommandEnvelope,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_INSPECTION_FLOW_CONFIG,
  DEFAULT_NONCONFORM_FLOW_CONFIG,
  INSPECTION_KINDS,
  INSPECTION_STATE_IDS,
  NONCONFORM_DISPOSALS,
  kindForSourceFact,
} from '../../src/inspection/inspection-config.js';
import { INSPECTION_EVENT_TYPES } from '../../src/inspection/inspection-events.js';
import {
  InspectionConflictError,
  InspectionInputError,
  InspectionNotFoundError,
  InspectionStateError,
} from '../../src/inspection/inspection-errors.js';
import {
  parseCommandBodyForKind,
  parseCommandEnvelopeBody,
  parseDisposeNonconformPayload,
  parseKindFilter,
  parseStateFilter,
} from '../../src/inspection/inspection-input.js';
import type {
  InspectionSourceFact,
  NotifyChannel,
  NotifyMessage,
  StockReleaseFact,
  StockReleasePort,
} from '../../src/inspection/inspection-ports.js';
import {
  InMemoryInspectionDomainEventStore,
  InMemoryInspectionOperationStore,
  InMemoryInspectionOrderStore,
  InMemoryNonconformStore,
} from '../../src/inspection/in-memory-inspection-stores.js';
import {
  InspectionsController,
  InspectionQueriesController,
  NonconformitiesController,
} from '../../src/inspection/inspection.controllers.js';
import { InspectionModule } from '../../src/inspection/inspection.module.js';
import { InspectionService, type InspectionCrossModulePorts } from '../../src/inspection/inspection.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const inspector = UserId.create('qc-01');
const worker = UserId.create('worker-01');
const supervisor = UserId.create('qc-lead');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版供跨模块使用） ----

class FakeStockReleasePort implements StockReleasePort {
  readonly facts: StockReleaseFact[] = [];
  async recordRelease(_tenant: unknown, fact: StockReleaseFact): Promise<void> {
    this.facts.push(fact);
  }
}

class FakeNotifyChannel implements NotifyChannel {
  readonly messages: NotifyMessage[] = [];
  async notify(_tenant: unknown, message: NotifyMessage): Promise<void> {
    this.messages.push(message);
  }
}

function newHarness(
  options: {
    readonly closeTimeoutMs?: number;
    readonly overdueAssignee?: typeof supervisor | null;
    readonly now?: () => string;
  } = {},
) {
  const orders = new InMemoryInspectionOrderStore();
  const nonconforms = new InMemoryNonconformStore();
  const operations = new InMemoryInspectionOperationStore();
  const domainEvents = new InMemoryInspectionDomainEventStore();
  const machineEvents = createInMemoryApprovalEventStore();
  const todos = new InMemoryTodoStore();
  const stockRelease = new FakeStockReleasePort();
  const notify = new FakeNotifyChannel();
  const ports: InspectionCrossModulePorts = { stockRelease, notify };
  const service = new InspectionService(
    orders,
    nonconforms,
    operations,
    domainEvents,
    machineEvents,
    todos,
    ports,
    {
      ...(options.now === undefined ? { now: () => FIXED_NOW } : { now: options.now }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      ...(options.overdueAssignee === undefined ? {} : { overdueAssignee: options.overdueAssignee }),
    },
  );
  return { orders, nonconforms, operations, domainEvents, machineEvents, todos, stockRelease, notify, service };
}

let opCounter = 0;
function envelope(
  kind: string,
  payload: unknown,
  options: {
    readonly tenant?: typeof t1;
    readonly actor?: typeof inspector;
    readonly operationId?: string;
    readonly expectedRevision?: number | 'initial';
  } = {},
): CommandEnvelope<{ kind: never; payload: unknown }> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: options.actor ?? inspector,
    operationId: OperationId.create(options.operationId ?? `op-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as never,
  }) as CommandEnvelope<{ kind: never; payload: unknown }>;
}

function mustCommit(result: Awaited<ReturnType<InspectionService['execute']>>) {
  if (result.status !== 'committed') {
    throw new Error(`期望 committed，得到 rejected：${result.reason}`);
  }
  return result;
}

/** 来源事实构造（reporting 末道报工 / dispatch 外协回厂 / listing 收货）。 */
function sourceFact(overrides: Partial<InspectionSourceFact> = {}): InspectionSourceFact {
  return {
    sourceType: 'report',
    sourceRefId: 'rpt-0001',
    itemId: 'item-1',
    drawingNo: 'DWG-001',
    quantity: 10,
    workOrderId: 'wo-1',
    occurredAt: FIXED_NOW,
    triggeredBy: 'system-reporting',
    ...overrides,
  };
}

async function judgeFail(h: ReturnType<typeof newHarness>, inspectionId: string, failedQty = 3, passedQty = 7) {
  return h.service.execute(
    envelope('inspection.judge.v1', { passedQty, failedQty, remark: '首检不合格' }, { expectedRevision: 1 }),
    inspectionId,
  );
}

describe('存储端口（内存实现，租户收口 + 乐观推进 + append-only）', () => {
  it('InspectionOrderStore：create/list/findBySourceRef 按租户收口；advance/updateJudgment 乐观检查', async () => {
    const store = new InMemoryInspectionOrderStore();
    const order = await store.create({
      tenant: t1, id: InspectionId.create('insp-a'),
      flowConfigId: 'inspection-order', state: 'pending', objectVersion: 1,
      kind: 'self_outsourced', sourceType: 'report', sourceRefId: 'rpt-a',
      itemId: 'item-1', drawingNo: null, quantity: 5,
    });
    expect((await store.find(t2, order.id)) === null).toBe(true); // 跨租户不可见
    expect((await store.find(t1, order.id))?.state).toBe('pending');
    expect((await store.findBySourceRef(t1, 'report', 'rpt-a'))?.id).toBe(order.id);
    expect((await store.findBySourceRef(t2, 'report', 'rpt-a')) === null).toBe(true);
    expect((await store.list(t1, { kind: 'self_outsourced' })).length).toBe(1);
    expect((await store.list(t1, { state: 'passed' })).length).toBe(0);
    const advanced = await store.advance(t1, order.id, 1, 'failed', 2, {
      passedQty: 2, failedQty: 3, judgeRemark: null,
      judgedBy: inspector, judgedAt: FIXED_NOW, closeDueAt: FIXED_NOW,
    });
    expect([advanced.state, advanced.objectVersion, advanced.failedQty]).toEqual(['failed', 2, 3]);
    await expect(store.advance(t1, order.id, 1, 'closed', 3)).rejects.toBeInstanceOf(InspectionConflictError);
    const updated = await store.updateJudgment(t1, order.id, 2, {
      passedQty: 5, failedQty: 0, judgeRemark: '复检', judgedBy: inspector, judgedAt: FIXED_NOW, closeDueAt: null,
    });
    expect([updated?.failedQty, updated?.objectVersion]).toEqual([0, 2]); // 无迁移不推进版本
    expect(await store.updateJudgment(t1, InspectionId.create('insp-x'), 1, {
      passedQty: 1, failedQty: 0, judgeRemark: null, judgedBy: inspector, judgedAt: FIXED_NOW, closeDueAt: null,
    })).toBeNull();
    expect((await store.markOverdueNotified(t1, order.id, FIXED_NOW))?.overdueNotifiedAt).toBe(FIXED_NOW);
  });

  it('NonconformStore：advance 携处置/闭环字段；状态过滤', async () => {
    const orders = new InMemoryInspectionOrderStore();
    const store = new InMemoryNonconformStore();
    const inspectionId = InspectionId.create('insp-a');
    void orders;
    const nc = await store.create({
      tenant: t1, id: 'nc-1', inspectionId, flowConfigId: 'nonconform',
      state: 'open', objectVersion: 1, itemId: 'item-1', quantity: 3,
    });
    const disposed = await store.advance(t1, 'nc-1', 1, 'disposed', 2, {
      disposal: 'rework', reason: '尺寸超差', disposedBy: inspector, disposedAt: FIXED_NOW,
    });
    expect([disposed.state, disposed.disposal, disposed.reason]).toEqual(['disposed', 'rework', '尺寸超差']);
    const closed = await store.advance(t1, 'nc-1', 2, 'closed', 3, {
      closeRemark: '返工复检合格', closedBy: inspector, closedAt: FIXED_NOW,
    });
    expect(closed.state).toBe('closed');
    expect((await store.list(t1, { inspectionId })).length).toBe(1);
    expect((await store.list(t1, { state: 'open' })).length).toBe(0);
    await expect(store.advance(t1, 'nc-1', 2, 'closed', 4)).rejects.toBeInstanceOf(InspectionConflictError);
  });

  it('OperationStore 幂等 + DomainEventStore eventId 去重/Outbox', async () => {
    const operations = new InMemoryInspectionOperationStore();
    const first = await operations.record({
      tenant: t1, operationId: 'op-1', command: 'inspection.create.v1',
      aggregateType: 'inspection-order', aggregateId: 'insp-1', occurredAt: FIXED_NOW,
    });
    expect(first).not.toBeNull();
    expect(
      await operations.record({
        tenant: t1, operationId: 'op-1', command: 'inspection.create.v1',
        aggregateType: 'inspection-order', aggregateId: 'insp-1', occurredAt: FIXED_NOW,
      }),
    ).toBeNull();
    expect(
      await operations.record({
        tenant: t2, operationId: 'op-1', command: 'inspection.create.v1',
        aggregateType: 'inspection-order', aggregateId: 'insp-1', occurredAt: FIXED_NOW,
      }),
    ).not.toBeNull();

    const domainEvents = new InMemoryInspectionDomainEventStore();
    const event = {
      eventId: 'evt-1', eventType: INSPECTION_EVENT_TYPES.created, tenantId: t1,
      aggregate: { id: 'insp-1', type: 'inspection-order', revision: 1 },
      occurredAt: FIXED_NOW, payload: {},
    };
    const outbox = await domainEvents.append(event as never);
    expect([outbox.eventId, outbox.deliveredAt]).toEqual(['evt-1', null]);
    await expect(domainEvents.append(event as never)).rejects.toBeInstanceOf(InspectionConflictError);
    expect((await domainEvents.pendingOutbox()).length).toBe(1);
    await domainEvents.markDelivered(EventId.create('evt-1'), FIXED_NOW);
    expect((await domainEvents.pendingOutbox()).length).toBe(0);
  });
});

describe('状态机配置与来源映射', () => {
  it('四态齐备、passed/closed 终态、4 条迁移；处置三态 2 条迁移', () => {
    expect(DEFAULT_INSPECTION_FLOW_CONFIG.states.map((state) => state.id)).toEqual([...INSPECTION_STATE_IDS]);
    expect(DEFAULT_INSPECTION_FLOW_CONFIG.states.filter((s) => s.final).map((s) => s.id)).toEqual(['passed', 'closed']);
    expect(DEFAULT_INSPECTION_FLOW_CONFIG.transitions.length).toBe(4);
    expect(DEFAULT_NONCONFORM_FLOW_CONFIG.states.map((state) => state.id)).toEqual(['open', 'disposed', 'closed']);
    expect(DEFAULT_NONCONFORM_FLOW_CONFIG.transitions.length).toBe(2);
  });

  it('kindForSourceFact：report/dispatch 恒自制外协；receipt 须三类采购之一', () => {
    expect(kindForSourceFact('report')).toBe('self_outsourced');
    expect(kindForSourceFact('dispatch', 'self_outsourced')).toBe('self_outsourced');
    expect(kindForSourceFact('receipt', 'nonstandard_purchase')).toBe('nonstandard_purchase');
    expect(kindForSourceFact('receipt')).toBeNull();
    expect(kindForSourceFact('receipt', 'self_outsourced')).toBeNull();
    expect(kindForSourceFact('report', 'equipment_purchase')).toBeNull();
    expect(INSPECTION_KINDS.length).toBe(4);
    expect(NONCONFORM_DISPOSALS).toEqual(['rework', 'concession', 'scrap']);
    expect(DEFAULT_CLOSE_TIMEOUT_MS).toBe(72 * 60 * 60 * 1000);
  });
});

describe('四类来源自动建单（Done-when ①）', () => {
  it('reporting 末道报工 → 自制外协待检单 pending@v1 + InspectionCreated', async () => {
    const h = newHarness();
    const receipt = await h.service.receiveSourceFact(t1, sourceFact());
    expect(receipt.created).toBe(true);
    const order = await h.orders.find(t1, InspectionId.create(receipt.inspectionId as string));
    expect([order?.state, order?.objectVersion, order?.kind, order?.sourceRefId]).toEqual([
      'pending', 1, 'self_outsourced', 'rpt-0001',
    ]);
    const published = await h.domainEvents.byAggregate({ id: receipt.inspectionId as string, type: 'inspection-order' });
    expect(published.map((event) => event.eventType)).toEqual([INSPECTION_EVENT_TYPES.created]);
  });

  it('dispatch 外协回厂 → 自制外协；listing 收货三类采购 kind 显式', async () => {
    const h = newHarness();
    const dispatch = await h.service.receiveSourceFact(t1, sourceFact({
      sourceType: 'dispatch', sourceRefId: 'dsp-0001', triggeredBy: 'system-dispatch',
    }));
    expect(dispatch.created).toBe(true);
    for (const kind of ['nonstandard_purchase', 'standard_purchase', 'equipment_purchase'] as const) {
      const rcpt = await h.service.receiveSourceFact(t1, sourceFact({
        sourceType: 'receipt', sourceRefId: `rcv-${kind}`, kind, triggeredBy: 'system-listing',
      }));
      expect(rcpt.created, kind).toBe(true);
    }
    const bad = await h.service.receiveSourceFact(t1, sourceFact({
      sourceType: 'receipt', sourceRefId: 'rcv-bad', triggeredBy: 'system-listing',
    }));
    expect(bad.created).toBe(false); // receipt 缺采购类 kind → 拒收
    expect((await h.orders.list(t1)).length).toBe(4);
  });

  it('同来源对象幂等：重复事实不重建（回执 created=false + 命中既有单 id）', async () => {
    const h = newHarness();
    const first = await h.service.receiveSourceFact(t1, sourceFact());
    const again = await h.service.receiveSourceFact(t1, sourceFact({ occurredAt: '2026-10-25T12:00:00.000Z' }));
    expect(again.created).toBe(false);
    expect(again.inspectionId).toBe(first.inspectionId);
    expect((await h.orders.list(t1)).length).toBe(1);
  });
});

describe('inspection.create（手工建单）', () => {
  it('手工建单（无来源引用）落 pending@v1；重复 operationId rejected', async () => {
    const h = newHarness();
    const created = mustCommit(
      await h.service.execute(envelope('inspection.create.v1', {
        kind: 'equipment_purchase', itemId: 'item-eq', quantity: 1,
      })),
    );
    expect([created.inspection?.state, created.inspection?.kind, created.inspection?.sourceType]).toEqual([
      'pending', 'equipment_purchase', null,
    ]);
    const dup = await h.service.execute(
      envelope('inspection.create.v1', { kind: 'standard_purchase', quantity: 1 }, { operationId: 'op-dup' }),
    );
    expect(dup.status).toBe('committed');
    const again = await h.service.execute(
      envelope('inspection.create.v1', { kind: 'standard_purchase', quantity: 1 }, { operationId: 'op-dup' }),
    );
    expect(again.status).toBe('rejected');
    expect((again as { reason: string }).reason).toContain('幂等');
  });

  it('带来源引用建单：来源幂等（既有待检单 rejected）；信封口径误用 rejected', async () => {
    const h = newHarness();
    await h.service.receiveSourceFact(t1, sourceFact({ sourceRefId: 'rpt-x' }));
    const clash = await h.service.execute(envelope('inspection.create.v1', {
      kind: 'self_outsourced', sourceType: 'report', sourceRefId: 'rpt-x', quantity: 5,
    }));
    expect(clash.status).toBe('rejected');
    expect((clash as { reason: string }).reason).toContain('来源幂等');
    const numeric = await h.service.execute(
      envelope('inspection.create.v1', { kind: 'standard_purchase', quantity: 1 }, { expectedRevision: 3 }),
    );
    expect(numeric.status).toBe('rejected');
  });
});

describe('inspection.judge（检验记录：合格/不合格数量）', () => {
  async function pendingOrder(h: ReturnType<typeof newHarness>, quantity = 10) {
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity }));
    return receipt.inspectionId as string;
  }

  it('合格：pending → passed@v2，judged + released 双事件，放行端口收到事实（放行-入库咬合）', async () => {
    const h = newHarness();
    const id = await pendingOrder(h);
    const committed = mustCommit(await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 10, failedQty: 0, remark: '全检合格' }, { expectedRevision: 1 }),
      id,
    ));
    expect(committed.inspection?.state).toBe('passed');
    expect(committed.newRevision).toBe(2);
    expect(committed.events.map((event) => event.eventType)).toEqual([
      INSPECTION_EVENT_TYPES.judged,
      INSPECTION_EVENT_TYPES.released,
    ]);
    const released = committed.events[1]?.payload as { quantity: number; itemId: string | null; phase: string };
    expect([released.quantity, released.itemId, released.phase]).toEqual([10, 'item-1', 'judge']);
    expect(h.stockRelease.facts.length).toBe(1);
    expect(h.stockRelease.facts[0]?.inspectionId).toBe(id);
    expect((await h.service.summary(t1)).passRate).toBe(1);
  });

  it('不合格：pending → failed@v2 + 自动建不合格明细 open@v1 + 闭环时限入投影', async () => {
    const h = newHarness();
    const id = await pendingOrder(h);
    const committed = mustCommit(await judgeFail(h, id));
    expect(committed.inspection?.state).toBe('failed');
    expect(committed.inspection?.closeDueAt).toBe(
      new Date(Date.parse(FIXED_NOW) + DEFAULT_CLOSE_TIMEOUT_MS).toISOString(),
    );
    expect(committed.nonconform?.state).toBe('open');
    expect(committed.nonconform?.quantity).toBe(3);
    const judged = committed.events[0]?.payload as { outcome: string; nonconformId: string | null };
    expect(judged.outcome).toBe('failed');
    expect(judged.nonconformId).toBe(committed.nonconform?.id);
    expect(h.stockRelease.facts.length).toBe(0); // 不合格不放行
    // 判定迁移留痕：机器账本含决策记录（检验记录事实）
    const page = await h.machineEvents.readByAggregate({ id, type: 'inspection-order' });
    expect(page.events.length).toBe(1);
    expect(page.events[0]?.payload.record?.decision).toBe('reject');
  });

  it('数量规则：总数 0 / 超送检量 / 非待检态 / 乐观锁过期 / 不存在 → rejected', async () => {
    const h = newHarness();
    const id = await pendingOrder(h, 5);
    for (const payload of [{ passedQty: 0, failedQty: 0 }, { passedQty: 4, failedQty: 3 }]) {
      const result = await h.service.execute(
        envelope('inspection.judge.v1', payload, { expectedRevision: 1 }), id,
      );
      expect(result.status).toBe('rejected');
    }
    expect((await h.orders.find(t1, InspectionId.create(id)))?.state).toBe('pending');
    const missing = await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 1, failedQty: 0 }, { expectedRevision: 1 }), 'insp-missing',
    );
    expect(missing.status).toBe('rejected');
    const stale = await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 1, failedQty: 0 }, { expectedRevision: 9 }), id,
    );
    expect(stale.status).toBe('rejected');
    mustCommit(await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 5, failedQty: 0 }, { expectedRevision: 1 }), id,
    ));
    const judgedAgain = await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 5, failedQty: 0 }, { expectedRevision: 2 }), id,
    );
    expect(judgedAgain.status).toBe('rejected'); // passed 终态不可再判
  });
});

describe('inspection.recheck（复检）', () => {
  async function failedOrder(h: ReturnType<typeof newHarness>) {
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity: 6 }));
    const id = receipt.inspectionId as string;
    mustCommit(await judgeFail(h, id, 2, 4));
    return id;
  }

  it('复检仍不合格：版本不推进、数量刷新、闭环窗口重计、judged(phase=recheck)', async () => {
    const h = newHarness();
    const id = await failedOrder(h);
    const still = mustCommit(await h.service.execute(
      envelope('inspection.recheck.v1', { passedQty: 5, failedQty: 1, remark: '复检剩 1 件超差' }, { expectedRevision: 2 }),
      id,
    ));
    expect(still.inspection?.state).toBe('failed');
    expect(still.inspection?.objectVersion).toBe(2); // 无迁移不推进
    expect(still.inspection?.failedQty).toBe(1);
    expect((still.events[0]?.payload as { phase: string; outcome: string }).outcome).toBe('still_failed');
  });

  it('复检合格：failed → passed@v3 + released 放行（返工件重新放行入库）', async () => {
    const h = newHarness();
    const id = await failedOrder(h);
    const passed = mustCommit(await h.service.execute(
      envelope('inspection.recheck.v1', { passedQty: 6, failedQty: 0, remark: '返工后全检合格' }, { expectedRevision: 2 }),
      id,
    ));
    expect(passed.inspection?.state).toBe('passed');
    expect(passed.newRevision).toBe(3);
    expect(passed.events.map((event) => event.eventType)).toEqual([
      INSPECTION_EVENT_TYPES.judged,
      INSPECTION_EVENT_TYPES.released,
    ]);
    expect(h.stockRelease.facts.length).toBe(1);
    const released = passed.events[1]?.payload as { quantity: number; phase: string };
    expect([released.quantity, released.phase]).toEqual([6, 'recheck']);
  });

  it('仅 failed 可复检：pending/passed → rejected', async () => {
    const h = newHarness();
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity: 3 }));
    const id = receipt.inspectionId as string;
    const pending = await h.service.execute(
      envelope('inspection.recheck.v1', { passedQty: 3, failedQty: 0 }, { expectedRevision: 1 }), id,
    );
    expect(pending.status).toBe('rejected');
  });
});

describe('nonconform.dispose / close（不合格闭环，Done-when ③）', () => {
  let ncSeq = 0;
  async function failedWithNc(h: ReturnType<typeof newHarness>, quantity = 4, failedQty = 4) {
    ncSeq += 1;
    const receipt = await h.service.receiveSourceFact(
      t1,
      sourceFact({ quantity, sourceRefId: `rpt-nc-${String(ncSeq).padStart(3, '0')}` }),
    );
    const id = receipt.inspectionId as string;
    const committed = mustCommit(await judgeFail(h, id, failedQty, quantity - failedQty));
    return { id, nc: committed.nonconform as NonNullable<typeof committed.nonconform> };
  }

  it('处置三枚举各可登记：open → disposed@v2 + NonconformDisposed（返工标记复检必要）', async () => {
    const h = newHarness();
    for (const [disposal, recheckRequired] of [['rework', true], ['concession', false], ['scrap', false]] as const) {
      const { nc } = await failedWithNc(h, 2, 2);
      const disposed = mustCommit(await h.service.execute(
        envelope('nonconform.dispose.v1', { disposal, reason: '尺寸超差', remark: '按流程处置' }, { expectedRevision: 1, actor: worker }),
        nc.id,
      ));
      expect(disposed.nonconform?.state).toBe('disposed');
      expect(disposed.nonconform?.disposal).toBe(disposal);
      const payload = disposed.events[0]?.payload as { recheckRequired: boolean; reason: string };
      expect([payload.recheckRequired, payload.reason]).toEqual([recheckRequired, '尺寸超差']);
    }
    expect((await h.service.summary(t1)).nonconformOpenCount).toBe(3); // 未闭环明细
  });

  it('返工处置：未复检合格不可闭环；复检合格后 close 成功（单保持 passed 不再推 closed）', async () => {
    const h = newHarness();
    const { id, nc } = await failedWithNc(h, 4, 4);
    mustCommit(await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'rework', reason: '返工处理' }, { expectedRevision: 1 }),
      nc.id,
    ));
    const early = await h.service.execute(
      envelope('nonconform.close.v1', { remark: '提前闭环' }, { expectedRevision: 2 }),
      nc.id,
    );
    expect(early.status).toBe('rejected');
    expect((early as { reason: string }).reason).toContain('复检合格');
    mustCommit(await h.service.execute(
      envelope('inspection.recheck.v1', { passedQty: 4, failedQty: 0, remark: '返工复检合格' }, { expectedRevision: 2 }),
      id,
    ));
    const closed = mustCommit(await h.service.execute(
      envelope('nonconform.close.v1', { remark: '返工闭环' }, { expectedRevision: 2 }),
      nc.id,
    ));
    expect(closed.nonconform?.state).toBe('closed');
    expect((closed.events[0]?.payload as { orderClosed: boolean }).orderClosed).toBe(false); // 单已 passed
    expect((await h.orders.find(t1, InspectionId.create(id)))?.state).toBe('passed');
  });

  it('报废处置：dispose → close 推单 failed → closed@v3（全部明细闭环联动）+ 机器账本两迁移', async () => {
    const h = newHarness();
    const { id, nc } = await failedWithNc(h, 3, 3);
    mustCommit(await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'scrap', reason: '报废处理' }, { expectedRevision: 1 }),
      nc.id,
    ));
    const closed = mustCommit(await h.service.execute(
      envelope('nonconform.close.v1', { remark: '报废闭环' }, { expectedRevision: 2 }),
      nc.id,
    ));
    expect(closed.nonconform?.state).toBe('closed');
    expect((closed.events[0]?.payload as { orderClosed: boolean }).orderClosed).toBe(true);
    expect(closed.inspection?.state).toBe('closed');
    expect(closed.inspection?.objectVersion).toBe(3);
    const milestones = (await h.service.detail(t1, id)).milestones;
    expect(milestones.map((milestone) => [milestone.from, milestone.to])).toEqual([
      ['pending', 'failed'],
      ['failed', 'closed'],
    ]);
  });

  it('open 不可 close、disposed 不可重复 dispose、非法枚举 InputError、乐观锁 rejected', async () => {
    const h = newHarness();
    const { nc } = await failedWithNc(h, 2, 2);
    const directClose = await h.service.execute(
      envelope('nonconform.close.v1', { remark: 'x' }, { expectedRevision: 1 }),
      nc.id,
    );
    expect(directClose.status).toBe('rejected');
    expect(() =>
      parseDisposeNonconformPayload({ disposal: 'donate', reason: 'x' }),
    ).toThrow(InspectionInputError);
    mustCommit(await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'concession', reason: '让步接收' }, { expectedRevision: 1 }),
      nc.id,
    ));
    const reDispose = await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'scrap', reason: 'x' }, { expectedRevision: 2 }),
      nc.id,
    );
    expect(reDispose.status).toBe('rejected');
    const stale = await h.service.execute(
      envelope('nonconform.close.v1', { remark: 'x' }, { expectedRevision: 9 }),
      nc.id,
    );
    expect(stale.status).toBe('rejected');
  });
});

describe('闭环超时点名（Done-when ④：超时可见并可催办；信封命令 inspection.overdue.scan.v1）', () => {
  it('超时 → InspectionOverdue 事件 + 判定人待办 + IM 点名；一次点名幂等', async () => {
    const h = newHarness({ closeTimeoutMs: 60 * 60 * 1000 }); // 1h
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity: 2, sourceRefId: 'rpt-late' }));
    const id = receipt.inspectionId as string;
    mustCommit(await judgeFail(h, id, 2, 0));
    // 固定时钟 = 判定时刻 → 未超时，点名空
    const emptyScan = mustCommit(await h.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor }),
    ));
    expect(emptyScan.notifications ?? []).toHaveLength(0);

    // 可变时钟：判定后 2 小时（超 1h 阈值）→ 超时点名
    let clock = FIXED_NOW;
    const later = newHarness({ closeTimeoutMs: 60 * 60 * 1000, now: () => clock });
    const receipt2 = await later.service.receiveSourceFact(t1, sourceFact({ quantity: 2, sourceRefId: 'rpt-late2' }));
    const id2 = receipt2.inspectionId as string;
    const committed = mustCommit(await judgeFail(later, id2, 2, 0));
    clock = '2026-10-25T12:00:00.000Z'; // +2h
    const scan = mustCommit(await later.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor }),
    ));
    const notifications = scan.notifications ?? [];
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.inspectionId).toBe(id2);
    const published = await later.domainEvents.byAggregate({ id: id2, type: 'inspection-order' });
    expect(published.map((event) => event.eventType)).toContain(INSPECTION_EVENT_TYPES.overdue);
    const own = await later.todos.listOwn(t1, inspector); // 缺省点名给判定人
    expect(own.filter((todo) => todo.refId === id2 && todo.status === 'open').length).toBe(1);
    expect(later.notify.messages.length).toBe(1);
    expect(later.notify.messages[0]?.title).toContain('超时点名');

    // 二次扫描：单级一次点名幂等（不再重复事件/待办/IM）
    const again = mustCommit(await later.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor }),
    ));
    expect(again.notifications ?? []).toHaveLength(0);
    expect(later.notify.messages.length).toBe(1);
    void committed;
  });

  it('信封幂等账：同 operationId 重复点名命令 rejected；非 initial 乐观锁拒绝', async () => {
    let clock = FIXED_NOW;
    const h = newHarness({ closeTimeoutMs: 1, now: () => clock });
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity: 1, sourceRefId: 'rpt-dup' }));
    const id = receipt.inspectionId as string;
    mustCommit(await judgeFail(h, id, 1, 0));
    clock = '2026-10-25T12:00:00.000Z'; // 超时（阈值 1ms）
    const first = mustCommit(await h.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor, operationId: 'op-scan-once' }),
    ));
    expect((first.notifications ?? []).length).toBe(1);
    const duplicate = await h.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor, operationId: 'op-scan-once' }),
    );
    expect(duplicate.status).toBe('rejected');
    if (duplicate.status === 'rejected') expect(duplicate.reason).toContain('幂等');
    const notInitial = await h.service.execute(
      envelope('inspection.overdue.scan.v1', {}, { actor: supervisor, expectedRevision: 3 }),
    );
    expect(notInitial.status).toBe('rejected');
    expect(h.notify.messages.length).toBe(1); // 重复命令不重复点名
  });

  it('闭环完成 → 点名待办自动完成；汇总 overdueCount 归零口径（点名后不再计）', async () => {
    let clock = FIXED_NOW;
    const h = newHarness({ closeTimeoutMs: 1, overdueAssignee: supervisor, now: () => clock });
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ quantity: 1, sourceRefId: 'rpt-nc' }));
    const id = receipt.inspectionId as string;
    const judged = mustCommit(await judgeFail(h, id, 1, 0));
    clock = '2026-10-25T12:00:00.000Z'; // 超时（阈值 1ms）
    await h.service.execute(envelope('inspection.overdue.scan.v1', {}, { actor: supervisor }));
    expect((await h.todos.listOwn(t1, supervisor)).filter((todo) => todo.status === 'open').length).toBe(1);
    mustCommit(await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'scrap', reason: '报废' }, { expectedRevision: 1 }),
      (judged.nonconform as NonNullable<typeof judged.nonconform>).id,
    ));
    const closed = mustCommit(await h.service.execute(
      envelope('nonconform.close.v1', { remark: '超时后闭环' }, { expectedRevision: 2 }),
      (judged.nonconform as NonNullable<typeof judged.nonconform>).id,
    ));
    expect(closed.todosCompleted.length).toBe(1); // 点名待办随闭环完成
    expect((await h.todos.listOwn(t1, supervisor)).every((todo) => todo.status === 'done')).toBe(true);
  });
});

describe('查询视图（队列 / 汇总事实 / 不合格明细与闭环追踪）', () => {
  it('四类质检队列：kind/state 筛选', async () => {
    const h = newHarness();
    await h.service.receiveSourceFact(t1, sourceFact({ sourceRefId: 'r1' }));
    await h.service.receiveSourceFact(t1, sourceFact({ sourceType: 'receipt', sourceRefId: 'r2', kind: 'standard_purchase' }));
    const all = await h.service.queue(t1);
    expect(all.length).toBe(2);
    expect((await h.service.queue(t1, { kind: 'standard_purchase' })).length).toBe(1);
    expect((await h.service.queue(t1, { state: 'pending' })).length).toBe(2);
    expect((await h.service.queue(t1, { kind: 'self_outsourced', state: 'passed' })).length).toBe(0);
  });

  it('汇总事实：待检/合格率/未闭环三项计数（工作台 KPI 口径）+ 四类分桶', async () => {
    const h = newHarness();
    // 3 张单：1 合格（self_outsourced）、1 不合格未闭环（standard_purchase）、1 待检（equipment_purchase）
    const a = (await h.service.receiveSourceFact(t1, sourceFact({ sourceRefId: 'qa' }))).inspectionId as string;
    mustCommit(await h.service.execute(
      envelope('inspection.judge.v1', { passedQty: 10, failedQty: 0 }, { expectedRevision: 1 }), a,
    ));
    const b = (await h.service.receiveSourceFact(t1, sourceFact({
      sourceType: 'receipt', sourceRefId: 'qb', kind: 'standard_purchase', itemId: 'item-std', quantity: 5,
    }))).inspectionId as string;
    mustCommit(await judgeFail(h, b, 2, 3));
    await h.service.receiveSourceFact(t1, sourceFact({
      sourceType: 'receipt', sourceRefId: 'qc', kind: 'equipment_purchase', quantity: 1,
    }));

    const summary = await h.service.summary(t1);
    expect([summary.pendingCount, summary.passedCount, summary.failedCount, summary.judgedCount]).toEqual([1, 1, 1, 2]);
    expect(summary.passRate).toBe(0.5);
    expect(summary.nonconformOpenCount).toBe(1);
    expect(summary.overdueCount).toBe(0); // FIXED_NOW 未超时
    const byKind = new Map(summary.byKind.map((row) => [row.kind, row]));
    expect(byKind.get('self_outsourced')?.passRate).toBe(1);
    expect(byKind.get('standard_purchase')?.nonconformOpen).toBe(1);
    expect(byKind.get('equipment_purchase')?.pending).toBe(1);
    expect(summary.generatedAt).toBe(FIXED_NOW);
  });

  it('明细与闭环追踪：nonconformList 状态过滤 + detail 迁移史 + 404', async () => {
    const h = newHarness();
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ sourceRefId: 'qd', quantity: 2 }));
    const id = receipt.inspectionId as string;
    const judged = mustCommit(await judgeFail(h, id, 2, 0));
    const ncId = (judged.nonconform as NonNullable<typeof judged.nonconform>).id;
    expect((await h.service.nonconformList(t1, { state: 'open' })).map((nc) => nc.id)).toEqual([ncId]);
    expect((await h.service.nonconformList(t1, { inspectionId: id })).length).toBe(1);
    const detail = await h.service.nonconformDetail(t1, ncId);
    expect(detail.inspectionState).toBe('failed');
    mustCommit(await h.service.execute(
      envelope('nonconform.dispose.v1', { disposal: 'concession', reason: '让步' }, { expectedRevision: 1 }),
      ncId,
    ));
    const disposed = await h.service.nonconformDetail(t1, ncId);
    expect(disposed.nonconform.state).toBe('disposed');
    expect(disposed.milestones.map((milestone) => milestone.to)).toEqual(['disposed']);
    const orderDetail = await h.service.detail(t1, id);
    expect(orderDetail.nonconforms.length).toBe(1);
    expect(orderDetail.milestones.map((milestone) => milestone.to)).toEqual(['failed']);
    await expect(h.service.detail(t1, 'insp-missing')).rejects.toBeInstanceOf(InspectionNotFoundError);
    await expect(h.service.nonconformDetail(t1, 'nc-missing')).rejects.toBeInstanceOf(InspectionNotFoundError);
  });

  it('账本↔投影不一致（写入中断模拟）→ 后续迁移抛 InspectionStateError', async () => {
    const h = newHarness();
    const receipt = await h.service.receiveSourceFact(t1, sourceFact({ sourceRefId: 'qe', quantity: 4 }));
    const id = receipt.inspectionId as string;
    mustCommit(await judgeFail(h, id, 1, 3));
    // 直接推进投影模拟中断窗口（账本未落；保持 failed 态以通过前置状态检查）
    await h.orders.advance(t1, InspectionId.create(id), 2, 'failed', 3);
    await expect(
      h.service.execute(
        envelope('inspection.recheck.v1', { passedQty: 4, failedQty: 0 }, { expectedRevision: 3 }),
        id,
      ),
    ).rejects.toBeInstanceOf(InspectionStateError);
  });
});

describe('输入解析与信封体', () => {
  it('parseCommandEnvelopeBody：形状校验与命令动词白名单', () => {
    const parsed = parseCommandEnvelopeBody({
      operationId: 'op-x', expectedRevision: 'initial',
      command: { kind: 'inspection.create.v1', payload: { kind: 'standard_purchase', quantity: 1 } },
    });
    expect(parsed.command.kind).toBe('inspection.create.v1');
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 'initial', command: { kind: 'x.y.v1', payload: {} } }),
    ).toThrow(InspectionInputError);
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 0, command: { kind: 'inspection.create.v1', payload: {} } }),
    ).toThrow(InspectionInputError);
    expect(() =>
      parseCommandBodyForKind(
        { operationId: 'op-x', expectedRevision: 1, command: { kind: 'inspection.judge.v1', payload: {} } },
        'nonconform.dispose.v1',
      ),
    ).toThrow(InspectionInputError);
  });

  it('队列过滤参数：kind 白名单 / state 蛇形 / inspectionId', () => {
    expect(parseKindFilter('self_outsourced')).toBe('self_outsourced');
    expect(parseKindFilter(undefined)).toBeUndefined();
    expect(() => parseKindFilter('unknown_kind')).toThrow(InspectionInputError);
    expect(parseStateFilter('pending')).toBe('pending');
    expect(parseStateFilter('')).toBeUndefined();
    expect(() => parseStateFilter('Pending')).toThrow(InspectionInputError);
  });
});

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + service 可解析）', () => {
    const module = InspectionModule.register();
    expect(module.controllers).toEqual([InspectionsController, InspectionQueriesController, NonconformitiesController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, InspectionModule)).toBeUndefined();
  });

  it('权限码：11 路由逐点声明（06-inspection.md §5 最小集）', () => {
    const expected: readonly [object, string, string][] = [
      [InspectionsController.prototype, 'create', 'inspection:judge'],
      [InspectionsController.prototype, 'list', 'inspection:read'],
      [InspectionsController.prototype, 'get', 'inspection:read'],
      [InspectionsController.prototype, 'judge', 'inspection:judge'],
      [InspectionsController.prototype, 'recheck', 'inspection:judge'],
      [InspectionQueriesController.prototype, 'summary', 'inspection:read'],
      [InspectionQueriesController.prototype, 'scanOverdue', 'inspection:judge'],
      [NonconformitiesController.prototype, 'list', 'nonconform:read'],
      [NonconformitiesController.prototype, 'get', 'nonconform:read'],
      [NonconformitiesController.prototype, 'dispose', 'nonconform:dispose'],
      [NonconformitiesController.prototype, 'close', 'nonconform:close'],
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
