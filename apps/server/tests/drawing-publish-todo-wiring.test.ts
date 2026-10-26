/**
 * 图文档管理 P1-a 焦点测试：drawing 发布→挂接方待办桥（接线 #40，
 * drawing-module CONTRACT P1-1 / RESEARCH G3——DrawingRevisionPublished 全仓
 * 零消费缺口的收口证据）。三段：
 *  1. 适配器行为合同（真实内存 store，不起 HTTP）：发布→挂接该 drawingId
 *     钉版附件的在途工作令 manager 收待办（title/source/refType/refId 钉形）；
 *     普通文件指针附件/终态令（completed/closed）/无 manager/他图号挂接零投递；
 *     逐版本各一条；待办创建失败不阻塞发布（通知式合同）。
 *  2. wiring 装配面：drawing+workorder+todoStore 齐备产出
 *     storeOverrides.drawingStores；任一缺位不装饰（模块回落原生存储）。
 *  3. 全链回归（buildAppModule 组合形态，共享注入 workOrders/attachments/
 *     todo/notification 句柄）：发布→manager 收待办+收件箱通知（#27 桥一点
 *     双通道）；双租户隔离；无挂接零增量；workorder 未启用零待办零通知；
 *     notifications 未启用只建待办（结构零通知面）。
 *
 * 销账语义不在本文件重复验证：待办键（source=workorder + refType=work-order +
 * refId=工作令 id）与 workorder.service.completeTodosFor 同键——关闭清待办沿
 * RREQ-WO-009 先例由既有测试面背书，本文件只钉键形咬合。
 */
import 'reflect-metadata';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
  InMemoryNotificationStore,
  InMemoryTodoStore,
  InMemoryWorkOrderAttachmentStore,
  InMemoryWorkOrderStore,
  WORKORDER_TODO_SOURCE,
  WORK_ORDER_AGGREGATE_TYPE,
  type TodoStore,
} from '@smes/application';
import {
  OperationId,
  TenantId,
  UserId,
  WorkOrderId,
  makeCommandEnvelope,
} from '@smes/business-core';
import { DrawingService, inMemoryDrawingStores, type DrawingCommandEnvelope } from '@smes/drawing';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import {
  CROSS_MODULE_WIRING,
  bindCrossModuleWiring,
  createCrossModuleWiring,
  createDrawingRevisionTodoBridgeStores,
} from '../src/cross-module-wiring.js';

const TENANT_A = TenantId.create('t-p1a-a');
const TENANT_B = TenantId.create('t-p1a-b');
const FIXED_NOW = '2026-10-26T10:00:00.000Z';
const TITLE_DWG_A_V1 = '图纸 DWG-A 已发布新版本 v1，请确认生产使用版本';
const TITLE_DWG_A_V2 = '图纸 DWG-A 已发布新版本 v2，请确认生产使用版本';
const contexts: INestApplicationContext[] = [];

afterAll(async () => {
  for (const context of contexts) await context.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let opCounter = 0;

function publishEnvelope(
  drawingId: string,
  expectedRevision: number | 'initial',
  tenant: TenantId = TENANT_A,
): DrawingCommandEnvelope {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: tenant,
    issuedBy: UserId.create('u-tech-p1a'),
    operationId: OperationId.create(`p1a-op-${String(opCounter).padStart(4, '0')}`),
    expectedRevision,
    issuedAt: FIXED_NOW,
    command: {
      kind: 'drawing.publish.v1',
      payload: {
        drawingId,
        fileRef: `files/${drawingId}.pdf`,
        changeNote: 'P1-a 接线测试发布',
        classification: 'public',
      },
    },
  });
}

/** 造一条工作令（可选挂一张 drawing 附件，ref 由调用方给钉版编码或普通指针）。 */
async function seedOrder(
  workOrders: InMemoryWorkOrderStore,
  attachments: InMemoryWorkOrderAttachmentStore,
  spec: {
    readonly id: string;
    readonly state?: string;
    readonly manager?: string | null;
    readonly drawingRef?: string;
    readonly tenant?: TenantId;
  },
): Promise<void> {
  const tenant = spec.tenant ?? TENANT_A;
  await workOrders.create({
    tenant,
    id: WorkOrderId.create(spec.id),
    flowConfigId: 'work-order',
    state: spec.state ?? 'in_progress',
    objectVersion: 1,
    customerRef: null,
    projectName: `P1-a ${spec.id}`,
    salesRep: null,
    manager: spec.manager === undefined || spec.manager === null ? null : UserId.create(spec.manager),
    plannedDeliveryAt: null,
    packagingArrivalAt: null,
  });
  if (spec.drawingRef !== undefined) {
    await attachments.append({
      tenant,
      id: `att-${spec.id}`,
      workOrderId: WorkOrderId.create(spec.id),
      name: `${spec.id} 图纸`,
      kind: 'drawing',
      ref: spec.drawingRef,
      attachedBy: UserId.create('u-tech-p1a'),
    });
  }
}

/** 适配器段共用造数束：六令覆盖钉版在途/普通附件/终态×2/无经理/他图号。 */
async function seedAdapterMatrix(
  workOrders: InMemoryWorkOrderStore,
  attachments: InMemoryWorkOrderAttachmentStore,
): Promise<void> {
  await seedOrder(workOrders, attachments, { id: 'wo-pin', manager: 'u-mgr-pin', drawingRef: 'DWG-A@v1' });
  await seedOrder(workOrders, attachments, {
    id: 'wo-plain',
    manager: 'u-mgr-plain',
    drawingRef: 'share/dwg-a.pdf', // 未升级钉版的普通文件指针（#23 同口径不入清单）
  });
  await seedOrder(workOrders, attachments, { id: 'wo-closed', state: 'closed', manager: 'u-mgr-closed', drawingRef: 'DWG-A@v1' });
  await seedOrder(workOrders, attachments, { id: 'wo-done', state: 'completed', manager: 'u-mgr-done', drawingRef: 'DWG-A@v1' });
  await seedOrder(workOrders, attachments, { id: 'wo-nomgr', manager: null, drawingRef: 'DWG-A@v1' });
  await seedOrder(workOrders, attachments, { id: 'wo-other', manager: 'u-mgr-other', drawingRef: 'DWG-B@v1' });
}

describe('P1-a #40 适配器行为合同（发布→在途挂接令 manager 待办）', () => {
  it('发布 v1 → 钉版挂接的在途令 manager 收待办（键形钉死）；普通附件/终态/无经理/他图号零投递', async () => {
    const drawing = inMemoryDrawingStores();
    const workOrders = new InMemoryWorkOrderStore();
    const attachments = new InMemoryWorkOrderAttachmentStore();
    const todos = new InMemoryTodoStore();
    await seedAdapterMatrix(workOrders, attachments);
    const service = new DrawingService(
      createDrawingRevisionTodoBridgeStores({ drawing, workOrders, workOrderAttachments: attachments, todos }),
    );

    const outcome = await service.execute(TENANT_A, publishEnvelope('DWG-A', 'initial'));
    expect(outcome.status).toBe('committed');

    const own = await todos.listOwn(TENANT_A, UserId.create('u-mgr-pin'));
    expect(own).toHaveLength(1);
    expect(own[0]!.title).toBe(TITLE_DWG_A_V1);
    expect(own[0]!.source).toBe(WORKORDER_TODO_SOURCE);
    expect(own[0]!.refType).toBe(WORK_ORDER_AGGREGATE_TYPE);
    expect(own[0]!.refId).toBe('wo-pin');
    expect(own[0]!.status).toBe('open');

    expect(await todos.listOwn(TENANT_A, UserId.create('u-mgr-plain'))).toHaveLength(0);
    expect(await todos.listOwn(TENANT_A, UserId.create('u-mgr-closed'))).toHaveLength(0);
    expect(await todos.listOwn(TENANT_A, UserId.create('u-mgr-done'))).toHaveLength(0);
    expect(await todos.listOwn(TENANT_A, UserId.create('u-mgr-other'))).toHaveLength(0);
  });

  it('同一图纸再发 v2 → 每版本各一条（挂接判定按 drawingId，钉版 v1 也提示确认生产版本）', async () => {
    const drawing = inMemoryDrawingStores();
    const workOrders = new InMemoryWorkOrderStore();
    const attachments = new InMemoryWorkOrderAttachmentStore();
    const todos = new InMemoryTodoStore();
    await seedOrder(workOrders, attachments, { id: 'wo-pin2', manager: 'u-mgr-pin2', drawingRef: 'DWG-A@v1' });
    const service = new DrawingService(
      createDrawingRevisionTodoBridgeStores({ drawing, workOrders, workOrderAttachments: attachments, todos }),
    );

    expect((await service.execute(TENANT_A, publishEnvelope('DWG-A', 'initial'))).status).toBe('committed');
    expect((await service.execute(TENANT_A, publishEnvelope('DWG-A', 1))).status).toBe('committed');

    const own = await todos.listOwn(TENANT_A, UserId.create('u-mgr-pin2'));
    expect(own.map((todo) => todo.title).sort()).toEqual([TITLE_DWG_A_V1, TITLE_DWG_A_V2].sort());
  });

  it('待办创建失败不阻塞发布（通知式合同：committed + warn 留痕，事件已落账）', async () => {
    const drawing = inMemoryDrawingStores();
    const workOrders = new InMemoryWorkOrderStore();
    const attachments = new InMemoryWorkOrderAttachmentStore();
    await seedOrder(workOrders, attachments, { id: 'wo-fail', manager: 'u-mgr-fail', drawingRef: 'DWG-A@v1' });
    const failingTodos = {
      create: async () => {
        throw new Error('inbox down');
      },
      listOwn: async () => [],
      findOwn: async () => null,
      complete: async () => null,
    } as unknown as TodoStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new DrawingService(
      createDrawingRevisionTodoBridgeStores({
        drawing,
        workOrders,
        workOrderAttachments: attachments,
        todos: failingTodos,
      }),
    );

    const outcome = await service.execute(TENANT_A, publishEnvelope('DWG-A', 'initial'));
    expect(outcome.status).toBe('committed'); // 不翻 indeterminate——联动故障不污染发布结果
    expect((await drawing.events.list(TENANT_A)).length).toBe(1); // 事件照常落账
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('通知式合同');
  });
});

describe('P1-a #40 wiring 装配面', () => {
  it('drawing+workorder+todoStore 齐备 → storeOverrides.drawingStores 装饰态实例', () => {
    const wiring = createCrossModuleWiring({
      enabled: ['drawing', 'workorder'],
      stores: {
        drawingStores: inMemoryDrawingStores(),
        workOrders: new InMemoryWorkOrderStore(),
        workOrderAttachments: new InMemoryWorkOrderAttachmentStore(),
        todoStore: new InMemoryTodoStore(),
      },
    });
    expect(wiring.storeOverrides.drawingStores).toBeDefined();
  });

  it('workorder 未启用 / todoStore 缺位 → 不装饰（模块回落原生存储）', () => {
    const drawingOnly = createCrossModuleWiring({
      enabled: ['drawing'],
      stores: { drawingStores: inMemoryDrawingStores(), todoStore: new InMemoryTodoStore() },
    });
    expect(drawingOnly.storeOverrides.drawingStores).toBeUndefined();

    const noTodo = createCrossModuleWiring({
      enabled: ['drawing', 'workorder'],
      stores: {
        drawingStores: inMemoryDrawingStores(),
        workOrders: new InMemoryWorkOrderStore(),
        workOrderAttachments: new InMemoryWorkOrderAttachmentStore(),
      },
    });
    expect(noTodo.storeOverrides.drawingStores).toBeUndefined();
  });
});

describe('P1-a 全链回归：组合形态发布→待办+通知双通道', () => {
  it('发布 → 挂接在途令 manager 收待办+收件箱通知（#27 桥）；终态令/他租户/无挂接零投递', async () => {
    const workOrders = new InMemoryWorkOrderStore();
    const workOrderAttachments = new InMemoryWorkOrderAttachmentStore();
    const todoStore = new InMemoryTodoStore();
    const notificationStore = new InMemoryNotificationStore();
    const app = await NestFactory.create(
      buildAppModule(parseModulesEnabled('core,drawing,workorder,workbench,notifications'), {
        workOrderStore: workOrders,
        workOrderAttachmentStore: workOrderAttachments,
        todoStore,
        notificationStore,
      }),
      { logger: false },
    );
    contexts.push(app);
    bindCrossModuleWiring(app);
    const wiring = app.get(CROSS_MODULE_WIRING, { strict: false });
    expect(wiring.storeOverrides.drawingStores).toBeDefined(); // 模块拿到装饰态五存储束

    await seedOrder(workOrders, workOrderAttachments, { id: 'wo-a-pin', manager: 'u-mgr-a', drawingRef: 'DWG-A@v1' });
    await seedOrder(workOrders, workOrderAttachments, {
      id: 'wo-a-closed',
      state: 'closed',
      manager: 'u-mgr-closed',
      drawingRef: 'DWG-A@v1',
    });
    await seedOrder(workOrders, workOrderAttachments, {
      id: 'wo-b-pin',
      manager: 'u-mgr-b',
      drawingRef: 'DWG-A@v1',
      tenant: TENANT_B,
    });

    const drawing = app.get(DrawingService, { strict: false });
    const published = await drawing.execute(TENANT_A, publishEnvelope('DWG-A', 'initial'));
    expect(published.status).toBe('committed');

    // 双通道：待办本体 + 收件箱通知（#27 桥一点双通道，标题同文）。
    const todos = await todoStore.listOwn(TENANT_A, UserId.create('u-mgr-a'));
    expect(todos).toHaveLength(1);
    expect(todos[0]!.title).toBe(TITLE_DWG_A_V1);
    expect(todos[0]!.refId).toBe('wo-a-pin');
    const inbox = await notificationStore.listOwn(TENANT_A, UserId.create('u-mgr-a'));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.title).toBe(TITLE_DWG_A_V1);

    // 终态令 manager / 他租户挂接令 manager：双通道均零投递（租户收口=事件 tenantId）。
    expect(await todoStore.listOwn(TENANT_A, UserId.create('u-mgr-closed'))).toHaveLength(0);
    expect(await todoStore.listOwn(TENANT_B, UserId.create('u-mgr-b'))).toHaveLength(0);
    expect(await notificationStore.listOwn(TENANT_B, UserId.create('u-mgr-b'))).toHaveLength(0);

    // 无挂接图纸：发布 DWG-NOATT → 全员零增量。
    expect((await drawing.execute(TENANT_A, publishEnvelope('DWG-NOATT', 'initial'))).status).toBe('committed');
    expect(await todoStore.listOwn(TENANT_A, UserId.create('u-mgr-a'))).toHaveLength(1);
    expect(await notificationStore.listOwn(TENANT_A, UserId.create('u-mgr-a'))).toHaveLength(1);
  });

  it('workorder 未启用 → 发布零待办零通知（桥不装配，模块回落原生存储）', async () => {
    const todoStore = new InMemoryTodoStore();
    const notificationStore = new InMemoryNotificationStore();
    const app = await NestFactory.create(
      buildAppModule(parseModulesEnabled('core,drawing,workbench,notifications'), {
        todoStore,
        notificationStore,
      }),
      { logger: false },
    );
    contexts.push(app);
    bindCrossModuleWiring(app);
    const wiring = app.get(CROSS_MODULE_WIRING, { strict: false });
    expect(wiring.storeOverrides.drawingStores).toBeUndefined();

    const drawing = app.get(DrawingService, { strict: false });
    expect((await drawing.execute(TENANT_A, publishEnvelope('DWG-NOWO', 'initial'))).status).toBe('committed');
    expect(await todoStore.listOwn(TENANT_A, UserId.create('u-mgr-a'))).toHaveLength(0);
    expect(await notificationStore.listOwn(TENANT_A, UserId.create('u-mgr-a'))).toHaveLength(0);
  });

  it('notifications 未启用 → 只建待办零收件箱行（effectiveTodoStore 无装饰层，结构零通知面）', async () => {
    const workOrders = new InMemoryWorkOrderStore();
    const workOrderAttachments = new InMemoryWorkOrderAttachmentStore();
    const todoStore = new InMemoryTodoStore();
    // 注意：不注入 notificationStore——notifications 未装配时注入反而会点亮 #27 桥
    // （sharedNotificationStore 取 options 值），与本用例语义相悖。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await NestFactory.create(
      buildAppModule(parseModulesEnabled('core,drawing,workorder,workbench'), {
        workOrderStore: workOrders,
        workOrderAttachmentStore: workOrderAttachments,
        todoStore,
      }),
      { logger: false },
    );
    contexts.push(app);
    bindCrossModuleWiring(app);
    await seedOrder(workOrders, workOrderAttachments, { id: 'wo-nonotif', manager: 'u-mgr-nn', drawingRef: 'DWG-A@v1' });

    const drawing = app.get(DrawingService, { strict: false });
    expect((await drawing.execute(TENANT_A, publishEnvelope('DWG-A', 'initial'))).status).toBe('committed');
    const todos = await todoStore.listOwn(TENANT_A, UserId.create('u-mgr-nn'));
    expect(todos).toHaveLength(1); // 待办通道不受 notifications 启停影响
    expect(todos[0]!.title).toBe(TITLE_DWG_A_V1);
    expect(warn).not.toHaveBeenCalled(); // 无失败投递——收件箱面结构性不存在
  });
});
