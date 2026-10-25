/**
 * 通知中心（T 波 #101）测试：端口内存实现（数据级过滤/幂等标记）、
 * 输入解析边界、用例 404 语义、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { InMemoryNotificationStore } from '../../src/notifications/in-memory-notifications-stores.js';
import { NotificationsController } from '../../src/notifications/notifications.controllers.js';
import { NotificationInputError, NotificationNotFoundError } from '../../src/notifications/notifications-errors.js';
import { NotificationsModule } from '../../src/notifications/notifications.module.js';
import { NotificationService } from '../../src/notifications/notifications.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('user-alice');
const bob = UserId.create('user-bob');

function newService(): { service: NotificationService; store: InMemoryNotificationStore } {
  const store = new InMemoryNotificationStore();
  return { service: new NotificationService(store), store };
}

describe('通知端口（内存实现先行）', () => {
  it('create 后未读；listOwn 按 (tenant, recipient) 双键收口、新的在前；countUnread 只数未读', async () => {
    const store = new InMemoryNotificationStore();
    const first = await store.create({
      tenant: t1,
      recipient: alice,
      title: '第一条',
      source: 'inspection',
      refType: 'inspection',
      refId: 'ins-1',
    });
    const second = await store.create({ tenant: t1, recipient: alice, title: '第二条', source: 'dispatch' });
    await store.create({ tenant: t1, recipient: bob, title: '他本人的', source: 'im' });
    await store.create({ tenant: t2, recipient: alice, title: '他租户的', source: 'im' });

    expect(first.readAt).toBeNull();
    expect(first.createdAt).not.toBeNull();

    const own = await store.listOwn(t1, alice);
    expect(own.map((n) => n.title)).toEqual(['第二条', '第一条']); // 新的在前
    expect(await store.countUnread(t1, alice)).toBe(2);
    expect(await store.countUnread(t1, bob)).toBe(1);
    expect(await store.countUnread(t2, alice)).toBe(1); // 跨租户/跨本人互不可见
  });

  it('markRead 幂等（已读原样返回）；不存在/非本人 → null；markAllRead 只迁移未读并返回条数', async () => {
    const store = new InMemoryNotificationStore();
    const a = await store.create({ tenant: t1, recipient: alice, title: 'a', source: 'im' });
    await store.create({ tenant: t1, recipient: alice, title: 'b', source: 'im' });
    await store.create({ tenant: t1, recipient: bob, title: 'c', source: 'im' });

    const at = '2026-10-26T12:00:00.000Z';
    const marked = await store.markRead(t1, alice, a.id, at);
    expect(marked?.readAt).toBe(at);
    const again = await store.markRead(t1, alice, a.id, '2026-10-26T13:00:00.000Z');
    expect(again?.readAt).toBe(at); // 幂等：时刻不漂移
    expect(await store.markRead(t1, bob, a.id, at)).toBeNull(); // 非本人 → null
    expect(await store.markRead(t1, alice, 'ghost', at)).toBeNull(); // 不存在 → null

    expect(await store.markAllRead(t1, alice, at)).toBe(1); // 只剩 b 未读
    expect(await store.markAllRead(t1, alice, at)).toBe(0); // 幂等：本无未读
    expect(await store.countUnread(t1, bob)).toBe(1); // 本人 markAll 不波及他人
  });
});

describe('用例（NotificationSourcePort 发布 + 收件箱）', () => {
  it('publish（NotificationSource 端口）= create 直达存储，无请求体解析', async () => {
    const { service } = newService();
    const sent = await service.publish({
      tenant: t1,
      recipient: alice,
      title: '质检逾期点名',
      body: 'INS-1 超时未闭环',
      source: 'inspection',
      refType: 'inspection',
      refId: 'INS-1',
    });
    expect(sent.readAt).toBeNull();
    expect((await service.listOwn(t1, alice)).map((n) => n.title)).toEqual(['质检逾期点名']);
  });

  it('create 端点解析：recipient/title/source 必填、source 单段小写形状；404 翻译', async () => {
    const { service } = newService();
    await expect(service.create(t1, { title: 'x', source: 'im' })).rejects.toThrow(
      NotificationInputError,
    );
    await expect(
      service.create(t1, { recipient: 'user-alice', title: '  ', source: 'im' }),
    ).rejects.toThrow(NotificationInputError);
    await expect(
      service.create(t1, { recipient: 'user-alice', title: 'x', source: 'Not Lower' }),
    ).rejects.toThrow(NotificationInputError);

    const sent = await service.create(t1, {
      recipient: 'user-alice',
      title: '派修完成',
      source: 'dispatch',
      refType: 'dispatch',
      refId: 'DSP-9',
    });
    expect(sent.recipient).toBe(alice);

    await expect(service.markRead(t1, alice, 'ghost')).rejects.toThrow(
      NotificationNotFoundError,
    );
    // 幂等标记（服务端取时刻）
    const once = await service.markRead(t1, alice, sent.id);
    const twice = await service.markRead(t1, alice, sent.id);
    expect(once.readAt).toBe(twice.readAt);
  });

  it('markAllRead 用例：本人全部置读并返回条数', async () => {
    const { service } = newService();
    await service.create(t1, { recipient: 'user-alice', title: 'a', source: 'im' });
    await service.create(t1, { recipient: 'user-alice', title: 'b', source: 'im' });
    expect(await service.markAllRead(t1, alice)).toBe(2);
    expect(await service.countUnread(t1, alice)).toBe(0);
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('notifications 路由：list/unread-count=notification:read；mark-read/mark-all-read/create=notification:write', () => {
    expect(routePermissions(NotificationsController, 'list')).toBe('notification:read');
    expect(routePermissions(NotificationsController, 'unreadCount')).toBe('notification:read');
    expect(routePermissions(NotificationsController, 'markRead')).toBe('notification:write');
    expect(routePermissions(NotificationsController, 'markAllRead')).toBe('notification:write');
    expect(routePermissions(NotificationsController, 'create')).toBe('notification:write');
  });

  it('NotificationsModule.register 装配控制器，缺省回落内存存储', () => {
    const dynamic = NotificationsModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      NotificationsModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(NotificationsModule);
    expect(controllers).toContain(NotificationsController);
  });
});
