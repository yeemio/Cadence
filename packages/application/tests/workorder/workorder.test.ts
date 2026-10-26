/**
 * workorder 模块测试（M2-W1）：存储端口内存合同、九态/配件状态机全路径
 * （跳态/回退/非法目标/终态）、命令信封（幂等/乐观锁/信封形状误用）、
 * update/attach/kit.refresh、配件审批-发货-出库联动、查询视图（详情/三类进度/
 * 齐套看板/交付态势）、账本↔投影对账、模块装配与权限码。全部零框架直连
 * （内存实现 + engine-flow 内存账本 + 可注入假端口——联动验证用夹具，真实
 * 端口由兄弟模块合流时提供）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  EventId,
  makeCommandEnvelope,
  OperationId,
  TenantId,
  UserId,
  WorkOrderId,
  type CommandEnvelope,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  DEFAULT_PARTS_REQUEST_FLOW_CONFIG,
  DEFAULT_WORK_ORDER_FLOW_CONFIG,
  LISTING_KINDS,
  WORK_ORDER_STATE_IDS,
  buildPartsRequestFlowConfig,
  definePartsApprovalChain,
  partsApprovalLevelOfState,
  partsRequestStateLabel,
  workOrderStateLabel,
  type ListingKind,
  type PartsApprovalChain,
} from '../../src/workorder/workorder-config.js';
import { PARTS_REQUEST_AGGREGATE_TYPE, WORKORDER_EVENT_TYPES, WORK_ORDER_AGGREGATE_TYPE } from '../../src/workorder/workorder-events.js';
import {
  WorkOrderConflictError,
  WorkOrderInputError,
  WorkOrderNotFoundError,
  WorkOrderStateError,
} from '../../src/workorder/workorder-errors.js';
import {
  parseCommandBodyForKind,
  parseCommandEnvelopeBody,
  parseStateFilter,
  parseTransitionWorkOrderPayload,
} from '../../src/workorder/workorder-input.js';
import type {
  InventoryAvailabilityPort,
  ListingRequirementLine,
  ListingRequirementPort,
  PartsApproverDirectoryPort,
  PartsIssueCommand,
  PartsIssuePort,
  ProgressFact,
  ProgressFactPort,
} from '../../src/workorder/workorder-ports.js';
import {
  InMemoryKitCheckStore,
  InMemoryPartsRequestStore,
  InMemoryWorkOrderAttachmentStore,
  InMemoryWorkOrderDomainEventStore,
  InMemoryWorkOrderOperationStore,
  InMemoryWorkOrderStore,
} from '../../src/workorder/in-memory-workorder-stores.js';
import {
  PartsRequestsController,
  WorkOrdersController,
  WorkOrderQueriesController,
} from '../../src/workorder/workorder.controllers.js';
import { WorkOrderModule } from '../../src/workorder/workorder.module.js';
import { WorkOrderService, type WorkOrderCrossModulePorts } from '../../src/workorder/workorder.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const pm = UserId.create('pm-01');
const sales = UserId.create('sales-01');
const worker = UserId.create('worker-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版供跨模块使用） ----

class FakeListingPort implements ListingRequirementPort {
  readonly lines: ListingRequirementLine[] = [];
  async requirementLines(_tenant: unknown, _workOrderId: string): Promise<readonly ListingRequirementLine[]> {
    return [...this.lines];
  }
}

class FakeInventoryPort implements InventoryAvailabilityPort {
  readonly stock = new Map<string, number>();
  async availableQty(_tenant: unknown, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(itemIds.map((id) => [id, this.stock.get(id) ?? 0]));
  }
}

class FakeIssuePort implements PartsIssuePort {
  readonly calls: PartsIssueCommand[] = [];
  refuseReason: string | null = null;
  async issueParts(_tenant: unknown, command: PartsIssueCommand) {
    this.calls.push(command);
    return this.refuseReason === null ? { issued: true } : { issued: false, refusedReason: this.refuseReason };
  }
}

class FakeProgressPort implements ProgressFactPort {
  readonly facts: ProgressFact[] = [];
  async progressFacts(_tenant: unknown, _workOrderId: string): Promise<readonly ProgressFact[]> {
    return [...this.facts];
  }
}

/** 配件审批链角色目录假件（S6 / RREQ-IS-037：或签名单实时解析）。 */
class FakeApproverDirectory implements PartsApproverDirectoryPort {
  /** 角色 → 成员（空数组 = 角色无人；未登记角色 = 角色未配置）。 */
  readonly roles = new Map<string, readonly UserId[]>();
  readonly calls: Array<readonly [string, string]> = [];
  async roleApprovers(_tenant: unknown, role: string): Promise<readonly UserId[]> {
    this.calls.push([_tenant as string, role]);
    return this.roles.get(role) ?? [];
  }
}

const LEVEL2_ROLE = 'parts-manager';
const LEVEL3_ROLE = 'parts-leader';
const manager2 = UserId.create('mgr2-01'); // 二级审批角色成员甲
const manager2b = UserId.create('mgr2-02'); // 二级审批角色成员乙（或签）
const leader3 = UserId.create('leader3-01'); // 三级审批角色成员

function newChainHarness(options: {
  readonly levels?: 1 | 2 | 3;
  readonly level2Role?: string;
  readonly level3Role?: string;
} = {}) {
  const stores = {
    orders: new InMemoryWorkOrderStore(),
    attachments: new InMemoryWorkOrderAttachmentStore(),
    parts: new InMemoryPartsRequestStore(),
    kitChecks: new InMemoryKitCheckStore(),
    operations: new InMemoryWorkOrderOperationStore(),
    domainEvents: new InMemoryWorkOrderDomainEventStore(),
    machineEvents: createInMemoryApprovalEventStore(),
    todos: new InMemoryTodoStore(),
  };
  const issue = new FakeIssuePort();
  const approvers = new FakeApproverDirectory();
  approvers.roles.set(LEVEL2_ROLE, [manager2, manager2b]);
  approvers.roles.set(LEVEL3_ROLE, [leader3]);
  const service = new WorkOrderService(
    stores.orders,
    stores.attachments,
    stores.parts,
    stores.kitChecks,
    stores.operations,
    stores.domainEvents,
    stores.machineEvents,
    stores.todos,
    {
      listing: new FakeListingPort(),
      inventory: new FakeInventoryPort(),
      issue,
      progress: new FakeProgressPort(),
      customer: { findCustomer: async () => null },
      approvers,
    },
    {
      now: () => FIXED_NOW,
      partsApprovalChain: definePartsApprovalChain({
        levels: options.levels ?? 3,
        level2Role: options.level2Role ?? LEVEL2_ROLE,
        level3Role: options.level3Role ?? LEVEL3_ROLE,
      }),
    },
  );
  return { ...stores, issue, approvers, service };
}

function newHarness() {
  const orders = new InMemoryWorkOrderStore();
  const attachments = new InMemoryWorkOrderAttachmentStore();
  const parts = new InMemoryPartsRequestStore();
  const kitChecks = new InMemoryKitCheckStore();
  const operations = new InMemoryWorkOrderOperationStore();
  const domainEvents = new InMemoryWorkOrderDomainEventStore();
  const machineEvents = createInMemoryApprovalEventStore();
  const todos = new InMemoryTodoStore();
  const listing = new FakeListingPort();
  const inventory = new FakeInventoryPort();
  const issue = new FakeIssuePort();
  const progress = new FakeProgressPort();
  const ports: WorkOrderCrossModulePorts = {
    listing,
    inventory,
    issue,
    progress,
    customer: { findCustomer: async () => null },
    approvers: new FakeApproverDirectory(),
  };
  const service = new WorkOrderService(
    orders,
    attachments,
    parts,
    kitChecks,
    operations,
    domainEvents,
    machineEvents,
    todos,
    ports,
    { now: () => FIXED_NOW },
  );
  return { orders, attachments, parts, kitChecks, operations, domainEvents, machineEvents, todos, listing, inventory, issue, progress, service };
}

let opCounter = 0;
function envelope(
  kind: string,
  payload: unknown,
  options: {
    readonly tenant?: typeof t1;
    readonly actor?: typeof pm;
    readonly operationId?: string;
    readonly expectedRevision?: number | 'initial';
  } = {},
): CommandEnvelope<{ kind: never; payload: unknown }> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: options.actor ?? pm,
    operationId: OperationId.create(options.operationId ?? `op-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    // 信封 command 形状由 service 按窄类型分发；测试以宽类型构造后收窄
    command: { kind, payload } as never,
  }) as CommandEnvelope<{ kind: never; payload: unknown }>;
}

function mustCommit(result: Awaited<ReturnType<WorkOrderService['execute']>>) {
  if (result.status !== 'committed') {
    throw new Error(`期望 committed，得到 rejected：${result.reason}`);
  }
  return result;
}

async function createOrder(
  service: WorkOrderService,
  fields: { readonly projectName?: string; readonly manager?: string | null; readonly plannedDeliveryAt?: string | null } = {},
) {
  const result = mustCommit(
    await service.execute(
      envelope('workorder.create.v1', {
        projectName: fields.projectName ?? '项目甲',
        manager: fields.manager === undefined ? pm : fields.manager,
        plannedDeliveryAt: fields.plannedDeliveryAt === undefined ? '2026-11-01T00:00:00.000Z' : fields.plannedDeliveryAt,
      }),
    ),
  );
  return result.workOrder as NonNullable<typeof result.workOrder>;
}

async function transition(service: WorkOrderService, id: string, targetState: string, revision: number, actor = pm) {
  return service.execute(
    envelope('workorder.transition.v1', { targetState }, { expectedRevision: revision, actor }),
    id,
  );
}

async function close(service: WorkOrderService, id: string, revision: number, remark = '合同闭环', actor = pm) {
  return service.execute(
    envelope('workorder.close.v1', { remark }, { expectedRevision: revision, actor }),
    id,
  );
}

describe('存储端口（内存实现，租户收口 + 乐观推进 + append-only）', () => {
  it('WorkOrderStore：create/list/find/update 按租户收口；advance 乐观检查', async () => {
    const store = new InMemoryWorkOrderStore();
    const id = WorkOrderId.create('wo-a');
    await store.create({
      tenant: t1, id, flowConfigId: 'work-order', state: 'not_started', objectVersion: 1,
      customerRef: null, projectName: '项目一', salesRep: null, manager: null,
      plannedDeliveryAt: null, packagingArrivalAt: null,
    });
    expect(await store.find(t2, id)).toBeNull(); // 跨租户不可见
    expect((await store.find(t1, id))?.projectName).toBe('项目一');
    const updated = await store.update(t1, id, { projectName: '项目一改' });
    expect(updated?.projectName).toBe('项目一改');
    expect(updated?.objectVersion).toBe(1); // update 不推进状态机版本
    expect(await store.update(t1, WorkOrderId.create('wo-ghost'), { projectName: 'x' })).toBeNull();
    const advanced = await store.advance(t1, id, 1, 'in_progress', 2);
    expect([advanced.state, advanced.objectVersion]).toEqual(['in_progress', 2]);
    await expect(store.advance(t1, id, 1, 'ready_to_ship', 3)).rejects.toBeInstanceOf(WorkOrderConflictError);
    await expect(store.advance(t1, WorkOrderId.create('wo-ghost'), 1, 'x', 2)).rejects.toBeInstanceOf(WorkOrderConflictError);
  });

  it('OperationStore：同租户同 operationId 二次记账返回 null；跨租户互不干扰', async () => {
    const store = new InMemoryWorkOrderOperationStore();
    const first = await store.record({
      tenant: t1, operationId: 'op-1', command: 'workorder.create.v1',
      aggregateType: 'work-order', aggregateId: 'wo-1', occurredAt: FIXED_NOW,
    });
    expect(first).not.toBeNull();
    expect(await store.record({
      tenant: t1, operationId: 'op-1', command: 'workorder.create.v1',
      aggregateType: 'work-order', aggregateId: 'wo-1', occurredAt: FIXED_NOW,
    })).toBeNull();
    expect(await store.record({
      tenant: t2, operationId: 'op-1', command: 'workorder.create.v1',
      aggregateType: 'work-order', aggregateId: 'wo-1', occurredAt: FIXED_NOW,
    })).not.toBeNull();
  });

  it('DomainEventStore：eventId 幂等去重、Outbox 记账、标记投递', async () => {
    const store = new InMemoryWorkOrderDomainEventStore();
    const event = {
      eventId: 'evt-1', eventType: WORKORDER_EVENT_TYPES.created, tenantId: t1,
      aggregate: { id: 'wo-1', type: 'work-order', revision: 1 },
      occurredAt: FIXED_NOW, payload: {},
    };
    const outbox = await store.append(event as never);
    expect([outbox.eventId, outbox.deliveredAt]).toEqual(['evt-1', null]);
    await expect(store.append(event as never)).rejects.toBeInstanceOf(WorkOrderConflictError);
    expect((await store.pendingOutbox()).length).toBe(1);
    await store.markDelivered(EventId.create('evt-1'), FIXED_NOW);
    expect((await store.pendingOutbox()).length).toBe(0);
  });

  it('KitCheckStore：latestByWorkOrder/latestPerTenant 取最新快照', async () => {
    const store = new InMemoryKitCheckStore();
    const wo = WorkOrderId.create('wo-a');
    await new Promise((resolve) => setTimeout(resolve, 3)); // refreshedAt 毫秒可分
    await store.append({ tenant: t1, id: 'kc-1', workOrderId: wo, kinds: [], gapLines: [], complete: false, refreshedBy: pm });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await store.append({ tenant: t1, id: 'kc-2', workOrderId: wo, kinds: [], gapLines: [], complete: true, refreshedBy: pm });
    expect((await store.latestByWorkOrder(t1, wo))?.id).toBe('kc-2');
    expect((await store.latestByWorkOrder(t2, wo))?.id ?? null).toBeNull();
    expect((await store.latestPerTenant(t1)).map((row) => row.id)).toEqual(['kc-2']);
  });
});

describe('九态配置（初版合法集）', () => {
  it('九态齐备、closed 为终态；迁移规则 = 主干 8 + 跳态 5 + 回退 6 = 19 条', () => {
    expect(DEFAULT_WORK_ORDER_FLOW_CONFIG.states.map((state) => state.id)).toEqual([...WORK_ORDER_STATE_IDS]);
    const closed = DEFAULT_WORK_ORDER_FLOW_CONFIG.states.find((state) => state.id === 'closed');
    expect(closed?.final).toBe(true);
    expect(DEFAULT_WORK_ORDER_FLOW_CONFIG.transitions.length).toBe(19);
    expect(workOrderStateLabel('in_progress')).toBe('进行中');
    expect(workOrderStateLabel('unknown_state')).toBe('unknown_state');
  });

  it('配件配置：draft→submitted→approved/rejected→shipped→received；rejected/received 终态', () => {
    expect(DEFAULT_PARTS_REQUEST_FLOW_CONFIG.initial).toBe('draft');
    const finalIds = DEFAULT_PARTS_REQUEST_FLOW_CONFIG.states.filter((s) => s.final).map((s) => s.id);
    expect(finalIds).toEqual(['rejected', 'received']);
  });
});

describe('workorder.create', () => {
  it('建令落 not_started@v1，发 WorkOrderCreated（四类清单骨架提示）；重复 operationId 拒绝', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    expect([order.state, order.objectVersion, order.projectName, order.manager]).toEqual([
      'not_started', 1, '项目甲', pm,
    ]);
    const published = await h.domainEvents.byAggregate({ id: order.id, type: 'work-order' });
    expect(published.map((event) => event.eventType)).toEqual([WORKORDER_EVENT_TYPES.created]);
    const payload = published[0]?.payload as { listingKinds: readonly ListingKind[]; workOrderId: string };
    expect(payload.listingKinds).toEqual([...LISTING_KINDS]);
    expect(payload.workOrderId).toBe(order.id);
    expect((await h.domainEvents.pendingOutbox()).length).toBe(1); // Outbox 已记账

    const duplicate = await h.service.execute(
      envelope('workorder.create.v1', { projectName: '重复建' }, { operationId: 'op-dup' }),
    );
    expect(duplicate.status).toBe('committed');
    const again = await h.service.execute(
      envelope('workorder.create.v1', { projectName: '再建' }, { operationId: 'op-dup' }),
    );
    expect(again.status).toBe('rejected');
    if (again.status === 'rejected') expect(again.reason).toContain('幂等');
  });

  it('创建命令带数字 expectedRevision → rejected（信封口径）', async () => {
    const h = newHarness();
    const result = await h.service.execute(
      envelope('workorder.create.v1', { projectName: 'x' }, { expectedRevision: 3 }),
    );
    expect(result.status).toBe('rejected');
  });
});

describe('九态流转（transition/close）', () => {
  it('主干全链：未开始→…→已关闭，版本 1→9；每步项目经理待办，关闭清待办', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    const chain = [
      'in_progress', 'ready_to_ship', 'shipped', 'in_acceptance',
      'in_maintenance', 'in_aftermarket', 'completed',
    ] as const;
    let revision = 1;
    for (const target of chain) {
      const committed = mustCommit(await transition(h.service, order.id, target, revision));
      expect(committed.workOrder?.state).toBe(target);
      expect(committed.newRevision).toBe(revision + 1);
      expect(committed.todosCreated.length).toBe(1);
      expect(committed.todosCreated[0]?.assignee).toBe(pm);
      revision += 1;
    }
    // 终态走 close 命令（closed 保留给 workorder:close，Wave-1 验收低危①）
    const closedResult = mustCommit(await close(h.service, order.id, revision));
    expect(closedResult.workOrder?.state).toBe('closed');
    expect(closedResult.newRevision).toBe(revision + 1);
    expect(closedResult.todosCompleted.length).toBe(7); // 前 7 步累积的流转待办
    const own = await h.todos.listOwn(t1, pm);
    expect(own.every((todo) => todo.status === 'done')).toBe(true);
    const detail = await h.service.detail(t1, order.id);
    expect(detail.milestones.map((milestone) => milestone.to)).toEqual([...chain, 'closed']);
    expect(detail.order.state).toBe('closed');
  });

  it('跳态：未开始→待发货、进行中→已发货、验收中→已完成', async () => {
    const h = newHarness();
    const a = await createOrder(h.service, { projectName: '跳 1' });
    mustCommit(await transition(h.service, a.id, 'ready_to_ship', 1));
    expect((await h.orders.find(t1, a.id))?.state).toBe('ready_to_ship');

    const b = await createOrder(h.service, { projectName: '跳 2' });
    mustCommit(await transition(h.service, b.id, 'in_progress', 1));
    mustCommit(await transition(h.service, b.id, 'shipped', 2));
    expect((await h.orders.find(t1, b.id))?.state).toBe('shipped');

    const c = await createOrder(h.service, { projectName: '跳 3' });
    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3], ['in_acceptance', 4]] as const) {
      mustCommit(await transition(h.service, c.id, target, revision));
    }
    mustCommit(await transition(h.service, c.id, 'completed', 5));
    expect((await h.orders.find(t1, c.id))?.state).toBe('completed');
  });

  it('回退：已发货→进行中（返工）；已完成→售后中（重开）', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3]] as const) {
      mustCommit(await transition(h.service, order.id, target, revision));
    }
    mustCommit(await transition(h.service, order.id, 'in_progress', 4)); // 回退
    expect((await h.orders.find(t1, order.id))?.state).toBe('in_progress');
    mustCommit(await transition(h.service, order.id, 'ready_to_ship', 5));
    mustCommit(await transition(h.service, order.id, 'shipped', 6));
    mustCommit(await transition(h.service, order.id, 'in_acceptance', 7));
    mustCommit(await transition(h.service, order.id, 'in_maintenance', 8));
    mustCommit(await transition(h.service, order.id, 'in_aftermarket', 9));
    mustCommit(await transition(h.service, order.id, 'completed', 10));
    mustCommit(await transition(h.service, order.id, 'in_aftermarket', 11)); // 完成重开
    expect((await h.orders.find(t1, order.id))?.state).toBe('in_aftermarket');
  });

  it('非法目标态 rejected：未开始→已关闭、未开始→维保中、终态迁出、未知目标', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    for (const target of ['closed', 'in_maintenance', 'unknown_state']) {
      const result = await transition(h.service, order.id, target, 1);
      expect(result.status).toBe('rejected');
    }
    expect((await h.orders.find(t1, order.id))?.state).toBe('not_started'); // 全部未落账

    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3], ['in_acceptance', 4], ['in_maintenance', 5], ['in_aftermarket', 6], ['completed', 7]] as const) {
      mustCommit(await transition(h.service, order.id, target, revision));
    }
    mustCommit(await close(h.service, order.id, 8));
    const afterClose = await transition(h.service, order.id, 'in_progress', 9);
    expect(afterClose.status).toBe('rejected'); // 终态不可迁出
  });

  it('close 命令：仅 completed 可关闭；带备注落 transitioned 域事件', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    const earlyClose = await h.service.execute(
      envelope('workorder.close.v1', { remark: '提前关' }, { expectedRevision: 1 }),
      order.id,
    );
    expect(earlyClose.status).toBe('rejected');
    mustCommit(await transition(h.service, order.id, 'in_progress', 1));
    mustCommit(await transition(h.service, order.id, 'ready_to_ship', 2));
    mustCommit(await transition(h.service, order.id, 'shipped', 3));
    mustCommit(await transition(h.service, order.id, 'in_acceptance', 4));
    mustCommit(await transition(h.service, order.id, 'in_maintenance', 5));
    mustCommit(await transition(h.service, order.id, 'in_aftermarket', 6));
    mustCommit(await transition(h.service, order.id, 'completed', 7));
    const closed = mustCommit(
      await h.service.execute(
        envelope('workorder.close.v1', { remark: '合同闭环' }, { expectedRevision: 8 }),
        order.id,
      ),
    );
    expect(closed.newRevision).toBe(9);
    const published = await h.domainEvents.byAggregate({ id: order.id, type: 'work-order' });
    const transitioned = published.filter((event) => event.eventType === WORKORDER_EVENT_TYPES.transitioned);
    expect(transitioned.length).toBe(8);
    const last = transitioned[transitioned.length - 1]?.payload as { to: string; remark: string };
    expect([last.to, last.remark]).toEqual(['closed', '合同闭环']);
  });

  it('transition.v1 拒绝直达 closed：终态保留给 close 命令（Wave-1 验收低危①）', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3], ['in_acceptance', 4], ['in_maintenance', 5], ['in_aftermarket', 6], ['completed', 7]] as const) {
      mustCommit(await transition(h.service, order.id, target, revision));
    }
    const direct = await transition(h.service, order.id, 'closed', 8);
    expect(direct.status).toBe('rejected');
    if (direct.status === 'rejected') expect(direct.reason).toContain('close');
    mustCommit(
      await h.service.execute(
        envelope('workorder.close.v1', { remark: '正道关闭' }, { expectedRevision: 8 }),
        order.id,
      ),
    );
    expect((await h.orders.find(t1, order.id))?.state).toBe('closed');
  });

  it('乐观锁：过期 expectedRevision rejected；对象不存在 rejected；initial 对既有命令 rejected', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    const stale = await transition(h.service, order.id, 'in_progress', 5);
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') expect(stale.reason).toContain('乐观锁');
    const missing = await transition(h.service, 'wo-missing', 'in_progress', 1);
    expect(missing.status).toBe('rejected');
    const initialRevision = await h.service.execute(
      envelope('workorder.transition.v1', { targetState: 'in_progress' }),
      order.id,
    );
    expect(initialRevision.status).toBe('rejected');
  });

  it('账本↔投影不一致（写入中断模拟）→ 后续迁移抛 WorkOrderStateError', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    mustCommit(await transition(h.service, order.id, 'in_progress', 1));
    // 直接推进投影模拟中断窗口（账本未落）
    await h.orders.advance(t1, order.id, 2, 'ready_to_ship', 3);
    await expect(transition(h.service, order.id, 'shipped', 3)).rejects.toBeInstanceOf(WorkOrderStateError);
  });
});

describe('workorder.update / attach', () => {
  it('update：字段生效、版本不推进、发 updated 事件；空载荷 InputError', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    const result = mustCommit(
      await h.service.execute(
        envelope('workorder.update.v1', { projectName: '项目乙', salesRep: sales }, { expectedRevision: 1 }),
        order.id,
      ),
    );
    expect(result.newRevision).toBe(1); // update 不推进状态机版本
    expect(result.workOrder?.projectName).toBe('项目乙');
    expect(result.workOrder?.salesRep).toBe(sales);
    const published = await h.domainEvents.byAggregate({ id: order.id, type: 'work-order' });
    expect(published.map((event) => event.eventType)).toEqual([
      WORKORDER_EVENT_TYPES.created,
      WORKORDER_EVENT_TYPES.updated,
    ]);
    await expect(
      h.service.execute(envelope('workorder.update.v1', {}, { expectedRevision: 1 }), order.id),
    ).rejects.toBeInstanceOf(WorkOrderInputError);
  });

  it('attach：附件事实 + 附件事件（独立聚合一版一事件）；终态拒收', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    const result = mustCommit(
      await h.service.execute(
        envelope('workorder.attach.v1', { name: '总装图', kind: 'drawing', ref: 'oss://dwg/001.pdf' }, { expectedRevision: 1, actor: worker }),
        order.id,
      ),
    );
    expect(result.attachment?.name).toBe('总装图');
    expect(result.newRevision).toBe(1);
    expect((await h.attachments.listByWorkOrder(t1, order.id)).length).toBe(1);
    const attachmentEvents = await h.domainEvents.byAggregate({
      id: result.attachment?.id as string,
      type: 'work-order-attachment',
    });
    expect(attachmentEvents.map((event) => event.eventType)).toEqual([WORKORDER_EVENT_TYPES.attachmentAdded]);

    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3], ['in_acceptance', 4], ['in_maintenance', 5], ['in_aftermarket', 6], ['completed', 7]] as const) {
      mustCommit(await transition(h.service, order.id, target, revision));
    }
    mustCommit(await close(h.service, order.id, 8));
    const refused = await h.service.execute(
      envelope('workorder.attach.v1', { name: '后补图', kind: 'drawing', ref: 'oss://dwg/002.pdf' }, { expectedRevision: 9 }),
      order.id,
    );
    expect(refused.status).toBe('rejected');
  });
});

describe('workorder.kit.refresh（齐套编排）', () => {
  it('缺口判定 = 三类清单需求行 × 库存可用量；缺口 → 项目经理催办待办', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    h.listing.lines.push(
      { kind: 'part', itemId: 'item-1', drawingNo: 'DWG-001', requiredQty: 10, neededBy: null },
      { kind: 'part', itemId: 'item-2', drawingNo: 'DWG-002', requiredQty: 4, neededBy: null },
      { kind: 'standard', itemId: 'item-3', drawingNo: null, requiredQty: 6, neededBy: null },
      { kind: 'electrical', itemId: 'item-4', drawingNo: null, requiredQty: 2, neededBy: null },
      { kind: 'equipment', itemId: 'item-5', drawingNo: null, requiredQty: 1, neededBy: null }, // 不入齐套范围
    );
    h.inventory.stock.set('item-1', 7); // 缺 3
    h.inventory.stock.set('item-2', 5); // 齐
    h.inventory.stock.set('item-3', 0); // 缺 6
    h.inventory.stock.set('item-4', 2); // 齐

    const result = mustCommit(
      await h.service.execute(
        envelope('workorder.kit.refresh.v1', {}, { expectedRevision: 1, actor: worker }),
        order.id,
      ),
    );
    const snapshot = result.kitCheck;
    expect(snapshot?.complete).toBe(false);
    expect(snapshot?.gapLines).toEqual([
      { kind: 'part', itemId: 'item-1', drawingNo: 'DWG-001', requiredQty: 10, availableQty: 7, gapQty: 3 },
      { kind: 'standard', itemId: 'item-3', drawingNo: null, requiredQty: 6, availableQty: 0, gapQty: 6 },
    ]);
    expect(snapshot?.kinds.map((kind) => [kind.kind, kind.gapLineCount, kind.complete])).toEqual([
      ['part', 1, false],
      ['standard', 1, false],
      ['electrical', 0, true],
    ]);
    expect(result.todosCreated.length).toBe(1); // 缺口 → 催办待办
    expect(result.todosCreated[0]?.assignee).toBe(pm);
    expect(result.todosCreated[0]?.title).toContain('齐套缺口催办');
    const events = await h.domainEvents.byAggregate({ id: snapshot?.id as string, type: 'kit-check' });
    expect(events.map((event) => event.eventType)).toEqual([WORKORDER_EVENT_TYPES.kitCheckRefreshed]);
  });

  it('库存补齐后再次刷新：新快照 complete=true；看板取最新', async () => {
    const h = newHarness();
    const order = await createOrder(h.service, { projectName: '补齐' });
    h.listing.lines.push({ kind: 'part', itemId: 'item-1', drawingNo: 'D-1', requiredQty: 2, neededBy: null });
    mustCommit(
      await h.service.execute(envelope('workorder.kit.refresh.v1', {}, { expectedRevision: 1 }), order.id),
    );
    h.inventory.stock.set('item-1', 2);
    const second = mustCommit(
      await h.service.execute(envelope('workorder.kit.refresh.v1', {}, { expectedRevision: 1 }), order.id),
    );
    expect(second.kitCheck?.complete).toBe(true);
    expect(second.todosCreated.length).toBe(0); // 齐套不催办
    const board = await h.service.kitBoard(t1);
    expect(board.length).toBe(1);
    expect(board[0]?.complete).toBe(true); // 看板取最新快照
    expect(board[0]?.gapLines).toEqual([]);
    expect((await h.kitChecks.latestPerTenant(t1)).length).toBe(1); // 旧快照仍保留（不可变）
  });

  it('register 注入面（S3-e 接线 #25/#26 锚点）：listingPort/inventoryPort 经模块装配到达服务，真实缺口数据驱动快照翻转', async () => {
    // 组合根（app-registry + cross-module-wiring）喂的就是 register 的这两个
    // 选项——零框架直连解析 providers 工厂，证明选项真正传入服务并被齐套
    // 判定消费（接线前该缝只在单测注入，真实栈从未喂过——S3-b 钉住的缺口）。
    const listing = new FakeListingPort();
    const inventory = new FakeInventoryPort();
    const dynamic = WorkOrderModule.register({ listingPort: listing, inventoryPort: inventory });
    const providers = (dynamic.providers ?? []) as readonly {
      readonly provide?: unknown;
      readonly useValue?: unknown;
      readonly useFactory?: (...args: never[]) => WorkOrderService;
      readonly inject?: readonly unknown[];
    }[];
    const byToken = new Map(providers.map((provider) => [provider.provide, provider]));
    const serviceFactory = providers.find((provider) => provider.provide === WorkOrderService);
    expect(serviceFactory?.useFactory, 'register 应以 useFactory 构造 WorkOrderService').toBeTypeOf('function');
    const args = (serviceFactory!.inject ?? []).map(
      (token) => (byToken.get(token) as { useValue: unknown }).useValue,
    );
    const service = serviceFactory!.useFactory!(...(args as never[]));

    // 真实缺口形状（e2e 同款）：1 行 part 需 10 / 库存 0 → complete=false（缺口行
    // = dispatch 齐套拦截的证据）；补货到 10 → 再刷新 complete=true（放行）。
    const order = await createOrder(service, { projectName: '接线注入面' });
    listing.lines.push({ kind: 'part', itemId: 'item-kit-wire', drawingNo: null, requiredQty: 10, neededBy: null });

    const short = mustCommit(
      await service.execute(envelope('workorder.kit.refresh.v1', {}, { expectedRevision: 1 }), order.id),
    );
    expect(short.kitCheck?.complete).toBe(false);
    expect(short.kitCheck?.gapLines).toEqual([
      { kind: 'part', itemId: 'item-kit-wire', drawingNo: null, requiredQty: 10, availableQty: 0, gapQty: 10 },
    ]);

    inventory.stock.set('item-kit-wire', 10);
    const filled = mustCommit(
      await service.execute(envelope('workorder.kit.refresh.v1', {}, { expectedRevision: 1 }), order.id),
    );
    expect(filled.kitCheck?.complete).toBe(true);
    expect(filled.kitCheck?.gapLines).toEqual([]);
  });
});

describe('配件申请（parts.request/approve/ship）', () => {
  async function submittedRequest(h: ReturnType<typeof newHarness>) {
    const order = await createOrder(h.service, { projectName: '配件项目' });
    const result = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-9', quantity: 3, remark: '售后急件' }, { actor: worker }),
      ),
    );
    return { order, result, partsRequest: result.partsRequest as NonNullable<typeof result.partsRequest> };
  }

  it('申请：建单即 submitted@v2，发 PartsRequested；项目经理审批待办', async () => {
    const h = newHarness();
    const { partsRequest, order } = await submittedRequest(h);
    expect([partsRequest.state, partsRequest.objectVersion, partsRequest.itemId, partsRequest.quantity]).toEqual([
      'submitted', 2, 'item-9', 3,
    ]);
    expect(partsRequest.requester).toBe(worker);
    const events = await h.domainEvents.byAggregate({ id: partsRequest.id, type: 'parts-request' });
    expect(events.map((event) => event.eventType)).toEqual([WORKORDER_EVENT_TYPES.partsRequested]);
    const own = await h.todos.listOwn(t1, pm);
    expect(own.filter((todo) => todo.refId === partsRequest.id && todo.status === 'open').length).toBe(1);
    void order;
  });

  it('审批 approve → approved@v3；审批人待办自动完成；reject → rejected 终态', async () => {
    const h = newHarness();
    const { partsRequest } = await submittedRequest(h);
    const approved = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.approve.v1', { decision: 'approve', remark: '同意' }, { expectedRevision: 2, actor: pm }),
        partsRequest.id,
      ),
    );
    expect(approved.partsRequest?.state).toBe('approved');
    expect(approved.newRevision).toBe(3);
    expect(approved.todosCompleted.length).toBe(1);
    expect((await h.domainEvents.byAggregate({ id: partsRequest.id, type: 'parts-request' })).map((e) => e.eventType)).toEqual([
      WORKORDER_EVENT_TYPES.partsRequested,
      WORKORDER_EVENT_TYPES.partsApproved,
    ]);

    const { partsRequest: another } = await submittedRequest(h);
    const rejected = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.approve.v1', { decision: 'reject', remark: '库存足够' }, { expectedRevision: 2, actor: pm }),
        another.id,
      ),
    );
    expect(rejected.partsRequest?.state).toBe('rejected');
    expect(
      (await h.domainEvents.byAggregate({ id: another.id, type: 'parts-request' })).map((e) => e.eventType),
    ).toEqual([WORKORDER_EVENT_TYPES.partsRequested, WORKORDER_EVENT_TYPES.partsRejected]);
    const shipRejected = await h.service.execute(
      envelope('workorder.parts.ship.v1', {}, { expectedRevision: 3 }),
      another.id,
    );
    expect(shipRejected.status).toBe('rejected'); // rejected 终态不可发货
  });

  it('发货：联动 inventory 出库（requestId 幂等键）；出库拒绝 → 命令 rejected 且状态不变', async () => {
    const h = newHarness();
    const { partsRequest, order } = await submittedRequest(h);
    mustCommit(
      await h.service.execute(
        envelope('workorder.parts.approve.v1', { remark: '同意' }, { expectedRevision: 2, actor: pm }),
        partsRequest.id,
      ),
    );
    h.issue.refuseReason = '可用量不足';
    const refused = await h.service.execute(
      envelope('workorder.parts.ship.v1', { shipmentRef: 'SHIP-001' }, { expectedRevision: 3 }),
      partsRequest.id,
    );
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason).toContain('可用量不足');
    expect((await h.parts.find(t1, partsRequest.id))?.state).toBe('approved'); // 未落账
    expect(h.issue.calls.length).toBe(1);

    h.issue.refuseReason = null;
    const shipped = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.ship.v1', { shipmentRef: 'SHIP-001' }, { expectedRevision: 3 }),
        partsRequest.id,
      ),
    );
    expect(shipped.partsRequest?.state).toBe('shipped');
    expect(shipped.partsRequest?.shipmentRef).toBe('SHIP-001');
    expect(shipped.newRevision).toBe(4);
    // 两次出库指令同载荷（第一次被拒、第二次放行）——端口按 requestId 幂等去重
    // 是实现方合同；命令侧语义 = 拒绝不落账、放行才迁移。
    expect(h.issue.calls).toEqual([
      { requestId: partsRequest.id, workOrderId: order.id, itemId: 'item-9', quantity: 3 },
      { requestId: partsRequest.id, workOrderId: order.id, itemId: 'item-9', quantity: 3 },
    ]);
    const events = await h.domainEvents.byAggregate({ id: partsRequest.id, type: 'parts-request' });
    expect(events.map((event) => event.eventType)).toEqual([
      WORKORDER_EVENT_TYPES.partsRequested,
      WORKORDER_EVENT_TYPES.partsApproved,
      WORKORDER_EVENT_TYPES.partsShipped,
    ]);
  });

  it('未审批直接发货 rejected；乐观锁过期 rejected', async () => {
    const h = newHarness();
    const { partsRequest } = await submittedRequest(h);
    const direct = await h.service.execute(
      envelope('workorder.parts.ship.v1', {}, { expectedRevision: 2 }),
      partsRequest.id,
    );
    expect(direct.status).toBe('rejected');
    const stale = await h.service.execute(
      envelope('workorder.parts.approve.v1', { remark: 'r' }, { expectedRevision: 9, actor: pm }),
      partsRequest.id,
    );
    expect(stale.status).toBe('rejected');
  });
});

describe('配件审批链三级（S6 / RREQ-IS-037：或签 + 实时解析 + 统一文案）', () => {
  async function chainSubmitted(h: ReturnType<typeof newChainHarness>, actor = worker) {
    const order = await createOrder(h.service, { projectName: '三级配件项目' });
    const result = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-9', quantity: 2 }, { actor }),
      ),
    );
    return { order, partsRequest: result.partsRequest as NonNullable<typeof result.partsRequest> };
  }

  function decide(
    h: ReturnType<typeof newChainHarness>,
    requestId: string,
    revision: number,
    decision: 'approve' | 'reject',
    actor: typeof pm,
    remark = '同意',
  ) {
    return h.service.execute(
      envelope('workorder.parts.approve.v1', { decision, remark }, { expectedRevision: revision, actor }),
      requestId,
    );
  }

  it('三级全链：submitted → level2_review → level3_review → approved → shipped；逐级或签 + 待办联动 + 事件带 level', async () => {
    const h = newChainHarness();
    const { order, partsRequest } = await chainSubmitted(h);
    expect(partsRequest.state).toBe('submitted');
    expect(partsRequest.objectVersion).toBe(2);
    // 一级待办 = 工作令负责人（项目经理）；或签名单外用户不可决策
    const outsider = await decide(h, partsRequest.id, 2, 'approve', manager2);
    expect(outsider.status).toBe('rejected');
    if (outsider.status === 'rejected') expect(outsider.reason).toContain('或签校验未通过');

    const level1 = mustCommit(await decide(h, partsRequest.id, 2, 'approve', pm));
    expect(level1.partsRequest?.state).toBe('level2_review');
    expect(level1.partsRequest?.objectVersion).toBe(3);
    // 一级审批人待办完成 + 二级或签两名成员各得一条待办
    expect(level1.todosCompleted.length).toBe(1);
    expect(level1.todosCreated.length).toBe(2);
    const mgr2Todos = await h.todos.listOwn(t1, manager2);
    expect(mgr2Todos.filter((todo) => todo.refId === partsRequest.id && todo.status === 'open').length).toBe(1);
    // 详情读面：待审批人实时解析（二级角色两名成员），不落库
    const detail2 = await h.service.partsDetail(t1, partsRequest.id);
    expect(detail2.pendingApproval?.level).toBe(2);
    expect(detail2.pendingApproval?.approvers).toEqual([manager2, manager2b]);
    expect(detail2.pendingApproval?.note).toBeNull();
    // 事件载荷携带审批层级
    const events2 = await h.domainEvents.byAggregate({ id: partsRequest.id, type: 'parts-request' });
    expect((events2[1]?.payload as { level?: number }).level).toBe(1);

    // 二级或签：任一成员可过（乙过）；两名成员待办全部完成 + 三级待办派发
    const level2 = mustCommit(await decide(h, partsRequest.id, 3, 'approve', manager2b));
    expect(level2.partsRequest?.state).toBe('level3_review');
    expect(level2.todosCompleted.length).toBe(2);
    expect(level2.todosCreated.length).toBe(1);
    expect(
      (await h.todos.listOwn(t1, manager2)).every((todo) => todo.refId !== partsRequest.id || todo.status !== 'open'),
    ).toBe(true);

    const level3 = mustCommit(await decide(h, partsRequest.id, 4, 'approve', leader3));
    expect(level3.partsRequest?.state).toBe('approved');
    expect(level3.todosCreated.length).toBe(0);
    // approved 后详情不再有待审批人（终态读面 null）
    expect((await h.service.partsDetail(t1, partsRequest.id)).pendingApproval).toBeNull();

    const shipped = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.ship.v1', { shipmentRef: 'S6-SHIP' }, { expectedRevision: 5 }),
        partsRequest.id,
      ),
    );
    expect(shipped.partsRequest?.state).toBe('shipped');
    expect(h.issue.calls).toEqual([
      { requestId: partsRequest.id, workOrderId: order.id, itemId: 'item-9', quantity: 2 },
    ]);
  });

  it('中间级驳回 → rejected 终态；未审级不再派待办', async () => {
    const h = newChainHarness();
    const { partsRequest } = await chainSubmitted(h);
    mustCommit(await decide(h, partsRequest.id, 2, 'approve', pm));
    const rejected = mustCommit(await decide(h, partsRequest.id, 3, 'reject', manager2, '数量不符'));
    expect(rejected.partsRequest?.state).toBe('rejected');
    expect(rejected.todosCreated.length).toBe(0);
    // rejected 终态：三级角色成员不可再决策
    const after = await decide(h, partsRequest.id, 4, 'approve', leader3);
    expect(after.status).toBe('rejected');
  });

  it('角色无人/未配置 → 该级审批明确拒绝（不静默换人）', async () => {
    const h = newChainHarness(); // LEVEL3_ROLE 成员在场
    const { partsRequest } = await chainSubmitted(h);
    mustCommit(await decide(h, partsRequest.id, 2, 'approve', pm));
    mustCommit(await decide(h, partsRequest.id, 3, 'approve', manager2));
    // 三级角色清空 → 决策拒绝，读面名单空带说明（展示「—」语义）
    h.approvers.roles.set(LEVEL3_ROLE, []);
    const refused = await decide(h, partsRequest.id, 4, 'approve', leader3);
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') {
      expect(refused.reason).toContain('未配置审批人');
      expect(refused.reason).toContain(LEVEL3_ROLE);
    }
    const detail = await h.service.partsDetail(t1, partsRequest.id);
    expect(detail.pendingApproval?.approvers).toEqual([]);
    expect(detail.pendingApproval?.note).toContain(LEVEL3_ROLE);
  });

  it('二级链（levels=2）：两级通过即 approved（无 level3_review）；缺省一级链零回归（无服务端或签校验）', async () => {
    const two = newChainHarness({ levels: 2 });
    const { partsRequest: first } = await chainSubmitted(two);
    const level1 = mustCommit(await decide(two, first.id, 2, 'approve', pm));
    expect(level1.partsRequest?.state).toBe('level2_review');
    const approved = mustCommit(await decide(two, first.id, 3, 'approve', manager2));
    expect(approved.partsRequest?.state).toBe('approved');

    // 零回归：未配链的基线服务（newHarness）任何 parts:approve 持有者可决策
    const base = newHarness();
    const order = await createOrder(base.service, { projectName: '基线零回归' });
    const created = mustCommit(
      await base.service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-8', quantity: 1 }, { actor: worker }),
      ),
    );
    const baseRequest = created.partsRequest as NonNullable<typeof created.partsRequest>;
    expect(baseRequest.state).toBe('submitted');
    const baseApproved = mustCommit(
      await base.service.execute(
        envelope('workorder.parts.approve.v1', { decision: 'approve', remark: '同意' }, { expectedRevision: 2, actor: worker }),
        baseRequest.id,
      ),
    );
    expect(baseApproved.partsRequest?.state).toBe('approved'); // 非负责人亦可（基线口径原样）
    expect((baseApproved.events[0]?.payload as { level?: number }).level).toBeUndefined();
  });

  it('租户级链解析器（沿 approval flowConfigResolver 先例）：null 回落静态链', async () => {
    const stores = {
      orders: new InMemoryWorkOrderStore(),
      attachments: new InMemoryWorkOrderAttachmentStore(),
      parts: new InMemoryPartsRequestStore(),
      kitChecks: new InMemoryKitCheckStore(),
      operations: new InMemoryWorkOrderOperationStore(),
      domainEvents: new InMemoryWorkOrderDomainEventStore(),
      machineEvents: createInMemoryApprovalEventStore(),
      todos: new InMemoryTodoStore(),
    };
    const chains = new Map<string, PartsApprovalChain>([
      [t1 as string, definePartsApprovalChain({ levels: 2, level2Role: LEVEL2_ROLE })],
    ]);
    const service = new WorkOrderService(
      stores.orders, stores.attachments, stores.parts, stores.kitChecks, stores.operations,
      stores.domainEvents, stores.machineEvents, stores.todos,
      {
        listing: new FakeListingPort(), inventory: new FakeInventoryPort(), issue: new FakeIssuePort(),
        progress: new FakeProgressPort(), customer: { findCustomer: async () => null },
        approvers: new FakeApproverDirectory(),
      },
      {
        now: () => FIXED_NOW,
        partsApprovalChain: definePartsApprovalChain({ levels: 1 }),
        partsChainResolver: async (tenant) => chains.get(tenant as string) ?? null,
      },
    );
    const order = await createOrder(service, { projectName: '租户链' });
    const created = mustCommit(
      await service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-7', quantity: 1 }, { actor: worker }),
      ),
    );
    const request = created.partsRequest as NonNullable<typeof created.partsRequest>;
    // t1 解析出二级链：一级过后落 level2_review（静态链 levels=1 被解析器覆盖）
    mustCommit(await service.execute(
      envelope('workorder.parts.approve.v1', { decision: 'approve', remark: '同意' }, { expectedRevision: 2, actor: pm }),
      request.id,
    ));
    expect((await stores.parts.find(t1, request.id))?.state).toBe('level2_review');
  });

  it('统一文案与状态过滤：待审三态同标签、族内过滤互为同义词；层级推导正确', async () => {
    expect(['submitted', 'level2_review', 'level3_review'].map(partsRequestStateLabel)).toEqual([
      '审批中', '审批中', '审批中',
    ]);
    expect(partsRequestStateLabel('approved')).toBe('已批准');
    expect(partsRequestStateLabel('unknown_state')).toBe('unknown_state');
    expect(
      ['submitted', 'level2_review', 'level3_review', 'approved'].map(partsApprovalLevelOfState),
    ).toEqual([1, 2, 3, null]);

    const h = newChainHarness();
    const order = await createOrder(h.service, { projectName: '过滤项目' });
    const ids: string[] = [];
    for (const itemId of ['item-a', 'item-b', 'item-c']) {
      const created = mustCommit(
        await h.service.execute(
          envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId, quantity: 1 }, { actor: worker }),
        ),
      );
      ids.push((created.partsRequest as NonNullable<typeof created.partsRequest>).id);
    }
    // 三张单分别推进到 submitted / level2_review / level3_review
    mustCommit(await decide(h, ids[0] as string, 2, 'approve', pm));
    mustCommit(await decide(h, ids[1] as string, 2, 'approve', pm));
    mustCommit(await decide(h, ids[1] as string, 3, 'approve', manager2));
    expect((await h.service.listParts(t1)).map((row) => row.state).sort()).toEqual([
      'level2_review', 'level3_review', 'submitted',
    ]);
    // 任一「审批中」族 id 过滤命中全族（统一文案语义）；族外状态仍精确
    for (const filter of ['submitted', 'level2_review', 'level3_review'] as const) {
      expect((await h.service.listParts(t1, filter)).length).toBe(3);
    }
    expect((await h.service.listParts(t1, 'approved')).length).toBe(0);
  });

  it('链配置校验（fail-fast）与流配置派生', () => {
    expect(() => definePartsApprovalChain({ levels: 4 })).toThrow(/levels/);
    expect(() => definePartsApprovalChain({ levels: 2 })).toThrow(/level2Role/);
    expect(() => definePartsApprovalChain({ levels: 3, level2Role: 'parts-manager' })).toThrow(/level3Role/);
    expect(() => definePartsApprovalChain({ levels: 2, level2Role: 'Bad Role' })).toThrow(/level2Role/);
    expect(definePartsApprovalChain({ levels: 1 })).toEqual({ levels: 1 });
    // levels=1 派生 = 基线配置（零回归锚点）；多级链同 flowId（请求行引用稳定）
    expect(buildPartsRequestFlowConfig({ levels: 1 })).toBe(DEFAULT_PARTS_REQUEST_FLOW_CONFIG);
    const three = buildPartsRequestFlowConfig(definePartsApprovalChain({ levels: 3, level2Role: 'r2', level3Role: 'r3' }));
    expect(three.flowId).toBe(DEFAULT_PARTS_REQUEST_FLOW_CONFIG.flowId);
    expect(three.transitions.map((rule) => [rule.from, rule.event, rule.to])).toContainEqual([
      'submitted', 'APPROVE', 'level2_review',
    ]);
    expect(three.transitions.map((rule) => [rule.from, rule.event, rule.to])).toContainEqual([
      'level2_review', 'APPROVE', 'level3_review',
    ]);
    expect(three.transitions.filter((rule) => rule.event === 'REJECT').map((rule) => rule.from).sort()).toEqual([
      'level2_review', 'level3_review', 'submitted',
    ]);
    const two = buildPartsRequestFlowConfig(definePartsApprovalChain({ levels: 2, level2Role: 'r2' }));
    expect(two.states.map((state) => state.id)).not.toContain('level3_review');
    expect(two.transitions.map((rule) => [rule.from, rule.event, rule.to])).toContainEqual([
      'level2_review', 'APPROVE', 'approved',
    ]);
  });
});

describe('查询视图', () => {
  function seedProgress(h: ReturnType<typeof newHarness>) {
    h.progress.facts.push(
      { stage: 'machining', drawingNo: 'DWG-A', operationId: 'op-mill', doneQty: 10, totalQty: 10, status: 'done' },
      { stage: 'machining', drawingNo: 'DWG-A', operationId: 'op-drill', doneQty: 3, totalQty: 10, status: 'in_progress' },
      { stage: 'machining', drawingNo: 'DWG-B', operationId: 'op-mill', doneQty: 0, totalQty: 5, status: 'pending' },
      { stage: 'machining', drawingNo: null, operationId: 'op-lost', doneQty: 1, totalQty: 1, status: 'done' }, // 缺图号不可上卷
      { stage: 'assembly', drawingNo: null, operationId: 'asm-fit', doneQty: 2, totalQty: 4, status: 'in_progress' },
      { stage: 'assembly', drawingNo: null, operationId: 'asm-test', doneQty: 0, totalQty: 4, status: 'pending' },
    );
  }

  it('列表状态过滤；详情含附件/齐套/迁移史', async () => {
    const h = newHarness();
    const a = await createOrder(h.service, { projectName: 'A' });
    await createOrder(h.service, { projectName: 'B' });
    mustCommit(await transition(h.service, a.id, 'in_progress', 1));
    expect((await h.service.list(t1)).length).toBe(2);
    expect((await h.service.list(t1, 'in_progress')).map((order) => order.projectName)).toEqual(['A']);
    expect(await h.service.list(t1, 'closed')).toEqual([]);
    const detail = await h.service.detail(t1, a.id);
    expect(detail.order.projectName).toBe('A');
    expect(detail.milestones.map((milestone) => milestone.to)).toEqual(['in_progress']);
    await expect(h.service.detail(t1, 'wo-missing')).rejects.toBeInstanceOf(WorkOrderNotFoundError);
  });

  it('项目进度（计划 vs 实际）：里程碑 + 倒计时', async () => {
    const h = newHarness();
    const order = await createOrder(h.service, { plannedDeliveryAt: '2026-11-15T00:00:00.000Z' });
    mustCommit(await transition(h.service, order.id, 'in_progress', 1));
    const progress = await h.service.projectProgress(t1, order.id);
    expect(progress.state).toBe('in_progress');
    expect(progress.plannedDeliveryAt).toBe('2026-11-15T00:00:00.000Z');
    expect(progress.daysToDelivery).toBe(20); // FIXED_NOW 2026-10-25T10:00Z → 11-15T00:00Z 截断取整
    expect(progress.milestones.length).toBe(1);
  });

  it('机加工进度：图号×工序上卷（缺图号行跳过）；装配调试进度：工序上卷', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    seedProgress(h);
    const machining = await h.service.machiningProgress(t1, order.id);
    expect(machining.rows).toEqual([
      { drawingNo: 'DWG-A', operationId: 'op-drill', doneQty: 3, totalQty: 10, status: 'in_progress' },
      { drawingNo: 'DWG-A', operationId: 'op-mill', doneQty: 10, totalQty: 10, status: 'done' },
      { drawingNo: 'DWG-B', operationId: 'op-mill', doneQty: 0, totalQty: 5, status: 'pending' },
    ]);
    const assembly = await h.service.assemblyProgress(t1, order.id);
    expect(assembly.rows).toEqual([
      { operationId: 'asm-fit', doneQty: 2, totalQty: 4, status: 'in_progress' },
      { operationId: 'asm-test', doneQty: 0, totalQty: 4, status: 'pending' },
    ]);
  });

  it('交付态势：风险分级（逾期/临期/正常）+ 九态分布（工作台 KPI）', async () => {
    const h = newHarness();
    const overdue = await createOrder(h.service, { projectName: '逾期件', plannedDeliveryAt: '2026-10-20T00:00:00.000Z' });
    await createOrder(h.service, { projectName: '临期件', plannedDeliveryAt: '2026-10-28T00:00:00.000Z' });
    await createOrder(h.service, { projectName: '正常件', plannedDeliveryAt: '2026-12-30T00:00:00.000Z' });
    const closed = await createOrder(h.service, { projectName: '已关闭件', plannedDeliveryAt: '2026-10-26T00:00:00.000Z' });
    for (const [target, revision] of [['in_progress', 1], ['ready_to_ship', 2], ['shipped', 3], ['in_acceptance', 4], ['in_maintenance', 5], ['in_aftermarket', 6], ['completed', 7]] as const) {
      mustCommit(await transition(h.service, closed.id, target, revision));
    }
    mustCommit(await close(h.service, closed.id, 8));
    const situation = await h.service.deliverySituation(t1);
    const byName = new Map(situation.orders.map((row) => [row.projectName, row]));
    expect(byName.get('逾期件')?.riskLevel).toBe('overdue');
    expect(byName.get('临期件')?.riskLevel).toBe('at_risk');
    expect(byName.get('正常件')?.riskLevel).toBe('on_track');
    expect(byName.has('已关闭件')).toBe(false); // 终态不进态势行
    expect(byName.get('逾期件')?.daysToDelivery).toBe(-5);
    expect(situation.distribution).toEqual({
      not_started: 3, in_progress: 0, ready_to_ship: 0, shipped: 0, in_acceptance: 0,
      in_maintenance: 0, in_aftermarket: 0, completed: 0, closed: 1,
    });
    void overdue;
  });

  it('配件列表（状态/工作令过滤）与详情', async () => {
    const h = newHarness();
    const order = await createOrder(h.service);
    mustCommit(
      await h.service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-9', quantity: 1 }),
      ),
    );
    expect((await h.service.listParts(t1)).length).toBe(1);
    expect((await h.service.listParts(t1, 'submitted')).length).toBe(1);
    expect(await h.service.listParts(t1, 'approved')).toEqual([]);
    const detail = await h.service.partsDetail(t1, (await h.service.listParts(t1))[0]?.id as string);
    expect(detail.milestones.map((milestone) => milestone.to)).toEqual(['submitted']);
    expect((await h.service.listParts(t1, undefined, order.id)).length).toBe(1);
  });
});

describe('落账顺序锚点（PG 投影租户解析语义：机器事件账本按投影行解析租户）', () => {
  /**
   * 模拟 pg-workorder-stores.tenantOfWorkorderAggregate：append /
   * readByAggregate 前按投影行解析租户，聚合不存在于投影行 = 孤儿账目
   * fail-fast 拒写。投影行在投影存储 create 落账时登记——若 service 先 append
   * 机器事件后落投影行（M2 Wave-2 验收缺陷同型），此处即抛孤儿错误。
   */
  function createProjectionAnchoredMachineEvents(
    projections: ReadonlyMap<string, TenantId>,
  ): ApprovalEventStore {
    const inner = createInMemoryApprovalEventStore();
    const requireProjected = (aggregate: { readonly id: string; readonly type: string }): void => {
      if (!projections.has(`${aggregate.type}\u0000${aggregate.id}`)) {
        throw new Error(
          `workorder aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（Fake 模拟 PG tenantOfWorkorderAggregate）`,
        );
      }
    };
    return {
      append: async (event) => {
        requireProjected(event.aggregate);
        await inner.append(event);
      },
      readByAggregate: async (aggregate, options) => {
        requireProjected(aggregate);
        return inner.readByAggregate(aggregate, options);
      },
    };
  }

  /** 包装投影存储：create 落账即登记投影行（聚合键 → 租户）；advance 不改登记。 */
  function anchorProjectionsOnCreate<
    S extends { create(input: { readonly id: string; readonly tenant: TenantId }): Promise<{ readonly id: string; readonly tenant: TenantId }> },
  >(store: S, aggregateType: string, projections: Map<string, TenantId>): S {
    const originalCreate = store.create.bind(store);
    store.create = async (input) => {
      const created = await originalCreate(input);
      projections.set(`${aggregateType}\u0000${created.id}`, created.tenant);
      return created;
    };
    return store;
  }

  function newAnchoredHarness() {
    const projections = new Map<string, TenantId>();
    const orders = anchorProjectionsOnCreate(
      new InMemoryWorkOrderStore(), WORK_ORDER_AGGREGATE_TYPE, projections,
    );
    const parts = anchorProjectionsOnCreate(
      new InMemoryPartsRequestStore(), PARTS_REQUEST_AGGREGATE_TYPE, projections,
    );
    const service = new WorkOrderService(
      orders,
      new InMemoryWorkOrderAttachmentStore(),
      parts,
      new InMemoryKitCheckStore(),
      new InMemoryWorkOrderOperationStore(),
      new InMemoryWorkOrderDomainEventStore(),
      createProjectionAnchoredMachineEvents(projections),
      new InMemoryTodoStore(),
      {
        listing: new FakeListingPort(),
        inventory: new FakeInventoryPort(),
        issue: new FakeIssuePort(),
        progress: new FakeProgressPort(),
        customer: { findCustomer: async () => null },
      },
      { now: () => FIXED_NOW },
    );
    return { service, orders, parts };
  }

  it('配件申请提交全程不触发孤儿账目：先落 draft@v1 投影行再 append；重放对账一致', async () => {
    const h = newAnchoredHarness();
    const order = await createOrder(h.service, { projectName: '锚点项目' });
    const submitted = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.request.v1', { workOrderId: order.id, itemId: 'item-9', quantity: 3 }, { actor: worker }),
      ),
    );
    const partsRequest = submitted.partsRequest as NonNullable<typeof submitted.partsRequest>;
    expect([partsRequest.state, partsRequest.objectVersion]).toEqual(['submitted', 2]);
    // 后续审批（重放对账）在同一 Fake 账本下通过
    const approved = mustCommit(
      await h.service.execute(
        envelope('workorder.parts.approve.v1', { decision: 'approve', remark: '锚点核准' }, { expectedRevision: 2, actor: pm }),
        partsRequest.id,
      ),
    );
    expect(approved.partsRequest?.state).toBe('approved');
    expect((await h.parts.find(t1, partsRequest.id))?.objectVersion).toBe(3);
  });
});

describe('输入解析与信封体', () => {
  it('parseCommandEnvelopeBody：形状校验与命令动词白名单', () => {
    const parsed = parseCommandEnvelopeBody({
      operationId: 'op-x', expectedRevision: 'initial',
      command: { kind: 'workorder.create.v1', payload: { projectName: 'p' } },
    });
    expect(parsed.command.kind).toBe('workorder.create.v1');
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 'initial', command: { kind: 'x.y.v1', payload: {} } }),
    ).toThrow(WorkOrderInputError);
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 0, command: { kind: 'workorder.create.v1', payload: {} } }),
    ).toThrow(WorkOrderInputError);
    expect(() => parseCommandBodyForKind(
      { operationId: 'op-x', expectedRevision: 1, command: { kind: 'workorder.update.v1', payload: {} } },
      'workorder.transition.v1',
    )).toThrow(WorkOrderInputError);
  });

  it('transition 载荷：targetState 形状校验；evidence 条目校验', () => {
    expect(parseTransitionWorkOrderPayload({ targetState: 'in_progress' })).toEqual({
      targetState: 'in_progress', remark: null, evidence: [],
    });
    expect(() => parseTransitionWorkOrderPayload({ targetState: 'InProgress' })).toThrow(WorkOrderInputError);
    expect(parseTransitionWorkOrderPayload({
      targetState: 'in_progress',
      evidence: [{ kind: 'photo', ref: 'oss://p/1' }],
    }).evidence).toEqual([{ kind: 'photo', ref: 'oss://p/1' }]);
    expect(() => parseTransitionWorkOrderPayload({ targetState: 'in_progress', evidence: [{ kind: '', ref: 'x' }] })).toThrow(
      WorkOrderInputError,
    );
  });

  it('状态过滤参数：小写蛇形白名单', () => {
    expect(parseStateFilter('in_progress')).toBe('in_progress');
    expect(parseStateFilter(undefined)).toBeUndefined();
    expect(parseStateFilter('')).toBeUndefined();
    expect(() => parseStateFilter('IN-PROGRESS')).toThrow(WorkOrderInputError);
  });
});

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + service 可解析）', () => {
    const module = WorkOrderModule.register();
    expect(module.controllers).toEqual([WorkOrdersController, WorkOrderQueriesController, PartsRequestsController]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, WorkOrderModule)).toBeUndefined();
  });

  it('权限码：19 路由逐点声明（02-workorder.md §5 最小集）', () => {
    const expected: readonly [object, string, string][] = [
      [WorkOrdersController.prototype, 'create', 'workorder:write'],
      [WorkOrdersController.prototype, 'list', 'workorder:read'],
      [WorkOrdersController.prototype, 'get', 'workorder:read'],
      [WorkOrdersController.prototype, 'update', 'workorder:write'],
      [WorkOrdersController.prototype, 'transition', 'workorder:transition'],
      [WorkOrdersController.prototype, 'close', 'workorder:close'],
      [WorkOrdersController.prototype, 'attach', 'workorder:write'],
      [WorkOrdersController.prototype, 'refreshKit', 'kit:refresh'],
      [WorkOrdersController.prototype, 'progress', 'workorder:read'],
      [WorkOrdersController.prototype, 'machiningProgress', 'workorder:read'],
      [WorkOrdersController.prototype, 'assemblyProgress', 'workorder:read'],
      [WorkOrderQueriesController.prototype, 'kitBoard', 'kit:read'],
      [WorkOrderQueriesController.prototype, 'deliverySituation', 'workorder:read'],
      [PartsRequestsController.prototype, 'request', 'parts:request'],
      [PartsRequestsController.prototype, 'list', 'parts:read'],
      [PartsRequestsController.prototype, 'get', 'parts:read'],
      [PartsRequestsController.prototype, 'approve', 'parts:approve'],
      [PartsRequestsController.prototype, 'ship', 'parts:request'],
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
