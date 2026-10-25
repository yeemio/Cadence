/**
 * 工作台/待办测试（M1 增量 4-I）：
 * 端口内存实现（数据级过滤合同）、输入解析边界、summary 分组计数、
 * 完成的本人收口与幂等、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  InMemoryTodoStore,
  PERMISSION_METADATA_KEY,
  WorkbenchInputError,
  WorkbenchModule,
  WorkbenchNotFoundError,
  WorkbenchService,
} from '../src/index.js';
import { WorkbenchController } from '../src/workbench/workbench.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('alice');
const bob = UserId.create('bob');

function newWorkbench(): { service: WorkbenchService; store: InMemoryTodoStore } {
  const store = new InMemoryTodoStore();
  return { service: new WorkbenchService(store), store };
}

describe('待办端口（内存实现，数据级过滤合同）', () => {
  it('create 后 status=open、createdAt 服务端时间；listOwn 只见本人', async () => {
    const store = new InMemoryTodoStore();
    const before = Date.now();
    const a = await store.create({ tenant: t1, assignee: alice, title: '甲的待办', source: 'masterdata' });
    const b = await store.create({ tenant: t1, assignee: bob, title: '乙的待办', source: 'masterdata' });
    expect(a.status).toBe('open');
    expect(new Date(a.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect((await store.listOwn(t1, alice)).map((todo) => todo.id)).toEqual([a.id]);
    expect((await store.listOwn(t1, bob)).map((todo) => todo.id)).toEqual([b.id]);
    expect(await store.findOwn(t1, bob, a.id)).toBeNull(); // 非本人 → 不存在
    expect(await store.findOwn(t2, alice, a.id)).toBeNull(); // 跨租户 → 不存在
  });

  it('complete：open→done；重复 complete 幂等；非本人/不存在 → null', async () => {
    const store = new InMemoryTodoStore();
    const a = await store.create({ tenant: t1, assignee: alice, title: 'x', source: 'org' });
    const done = await store.complete(t1, alice, a.id);
    expect(done?.status).toBe('done');
    const again = await store.complete(t1, alice, a.id);
    expect(again?.status).toBe('done'); // 幂等：仍 done
    expect(await store.complete(t1, bob, a.id)).toBeNull(); // 非本人 → null
    expect(await store.complete(t1, alice, 'ghost')).toBeNull();
  });

  it('dueAt/refType/refId：可空往返', async () => {
    const store = new InMemoryTodoStore();
    const withDue = await store.create({
      tenant: t1,
      assignee: alice,
      title: 'x',
      source: 'masterdata',
      dueAt: '2026-11-01T09:00:00Z',
      refType: 'item',
      refId: 'item-1',
    });
    expect(withDue.dueAt).toBe('2026-11-01T09:00:00Z');
    expect(withDue.refType).toBe('item');
    const bare = await store.create({ tenant: t1, assignee: alice, title: 'y', source: 'org' });
    expect(bare.dueAt).toBeNull();
    expect(bare.refType).toBeNull();
  });
});

describe('输入解析（WorkbenchInputError 边界）', () => {
  it('创建待办：缺 assignee/title、非法 source 形状、非法 dueAt 拒绝', async () => {
    const { service } = newWorkbench();
    await expect(service.createTodo(t1, { title: 'x', source: 'masterdata' })).rejects.toThrow(
      WorkbenchInputError,
    );
    await expect(service.createTodo(t1, { assignee: 'alice', source: 'masterdata' })).rejects.toThrow(
      WorkbenchInputError,
    );
    await expect(
      service.createTodo(t1, { assignee: 'alice', title: 'x', source: 'MasterData' }),
    ).rejects.toThrow(WorkbenchInputError);
    await expect(
      service.createTodo(t1, { assignee: 'alice', title: 'x', source: 'org', dueAt: '2026-11-01' }),
    ).rejects.toThrow(WorkbenchInputError); // 缺时间部分/时区
    await expect(
      service.createTodo(t1, { assignee: 'alice', title: 'x', source: 'org', dueAt: 'not-a-date' }),
    ).rejects.toThrow(WorkbenchInputError);
  });

  it('合法 dueAt（Z 与 ±hh:mm 两种时区形状）通过', async () => {
    const { service } = newWorkbench();
    const z = await service.createTodo(t1, {
      assignee: 'alice',
      title: 'x',
      source: 'org',
      dueAt: '2026-11-01T09:00:00Z',
    });
    expect(z.dueAt).toBe('2026-11-01T09:00:00Z');
    const offset = await service.createTodo(t1, {
      assignee: 'alice',
      title: 'y',
      source: 'org',
      dueAt: '2026-11-01T17:00:00+08:00',
    });
    expect(offset.dueAt).toBe('2026-11-01T17:00:00+08:00');
  });
});

describe('WorkbenchService 聚合（summary 分组 / 完成本人收口）', () => {
  it('summary：本人 open 按 source 分组；done 不计数；跨人不泄漏', async () => {
    const { service } = newWorkbench();
    await service.createTodo(t1, { assignee: 'alice', title: 'a1', source: 'masterdata' });
    await service.createTodo(t1, { assignee: 'alice', title: 'a2', source: 'masterdata' });
    await service.createTodo(t1, { assignee: 'alice', title: 'a3', source: 'org' });
    await service.createTodo(t1, { assignee: 'bob', title: 'b1', source: 'masterdata' });

    const summary = await service.summary(t1, alice);
    expect(summary.openTotal).toBe(3);
    expect(summary.bySource).toEqual([
      { source: 'masterdata', open: 2 },
      { source: 'org', open: 1 },
    ]);

    const a1 = (await service.listOwnTodos(t1, alice)).find((todo) => todo.title === 'a1');
    await service.completeOwn(t1, alice, a1!.id);
    const after = await service.summary(t1, alice);
    expect(after.openTotal).toBe(2);
    expect(after.bySource).toEqual([
      { source: 'masterdata', open: 1 },
      { source: 'org', open: 1 },
    ]);
  });

  it('completeOwn：幂等；非本人/不存在 → WorkbenchNotFoundError（404）', async () => {
    const { service } = newWorkbench();
    const created = await service.createTodo(t1, { assignee: 'alice', title: 'x', source: 'org' });
    const done = await service.completeOwn(t1, alice, created.id);
    expect(done.status).toBe('done');
    await expect(service.completeOwn(t1, alice, created.id)).resolves.toMatchObject({ status: 'done' });
    await expect(service.completeOwn(t1, bob, created.id)).rejects.toThrow(WorkbenchNotFoundError);
    await expect(service.completeOwn(t1, alice, 'ghost')).rejects.toThrow(WorkbenchNotFoundError);
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('workbench 路由：summary/todos=workbench:read、create/done=todo:write', () => {
    expect(routePermissions(WorkbenchController, 'summary')).toBe('workbench:read');
    expect(routePermissions(WorkbenchController, 'list')).toBe('workbench:read');
    expect(routePermissions(WorkbenchController, 'create')).toBe('todo:write');
    expect(routePermissions(WorkbenchController, 'done')).toBe('todo:write');
  });

  it('WorkbenchModule.register 装配控制器，缺省回落内存存储', () => {
    const dynamic = WorkbenchModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WorkbenchModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(WorkbenchModule);
    expect(controllers).toContain(WorkbenchController);
  });
});
