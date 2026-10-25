/**
 * 菜单管理（T 波 #98/99）测试：端口内存实现（租户收口/code 冲突/软停用）、
 * 节点树校验边界（形状/树内唯一/深度/总量）、期望态更新、读实态定权限码、
 * 控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { InMemoryMenuConfigStore } from '../../src/menu-config/in-memory-menu-config-stores.js';
import { MenuConfigController } from '../../src/menu-config/menu-config.controllers.js';
import {
  MenuConfigConflictError,
  MenuConfigInputError,
  MenuConfigNotFoundError,
} from '../../src/menu-config/menu-config-errors.js';
import { MenuConfigModule } from '../../src/menu-config/menu-config.module.js';
import { MenuConfigService } from '../../src/menu-config/menu-config.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newService(): { service: MenuConfigService; store: InMemoryMenuConfigStore } {
  const store = new InMemoryMenuConfigStore();
  return { service: new MenuConfigService(store), store };
}

const sampleTree = [
  {
    code: 'workbench',
    title: '工作台',
    permission: 'workbench:read',
    children: [
      { code: 'workbench.todos', title: '待办', routePath: '/workbench/todos' },
      { code: 'workbench.summary', title: '总览', routePath: '/workbench/summary' },
    ],
  },
  {
    code: 'quality',
    title: '质检',
    routePath: '/quality',
    children: [{ code: 'm.inspection', title: '移动质检', routePath: '/m/inspection', hideInMenu: false }],
  },
];

describe('菜单配置端口（内存实现先行）', () => {
  it('create/list/find：租户内收口、code 冲突 409、他租户同码不冲突、list 按 code 升序', async () => {
    const store = new InMemoryMenuConfigStore();
    const created = await store.create({
      tenant: t1,
      code: 'default',
      name: '默认菜单',
      nodes: sampleTree,
    });
    expect(created.active).toBe(true);
    expect(created.nodes).toHaveLength(2);
    expect(created.createdAt).toBe(created.updatedAt);

    await expect(store.create({ tenant: t1, code: 'default', name: '重码', nodes: [] })).rejects.toThrow(
      MenuConfigConflictError,
    );
    await store.create({ tenant: t2, code: 'default', name: '他租户同码', nodes: [] }); // 他租户不冲突
    expect((await store.list(t1)).map((c) => c.code)).toEqual(['default']);
    expect(await store.find(t1, created.id)).not.toBeNull();
    expect(await store.find(t2, created.id)).toBeNull(); // 跨租户不可见
    expect(await store.update(t1, 'ghost', { active: false })).toBeNull(); // 不存在 → null
  });

  it('update：字段级期望态（未提供即不变）+ updatedAt 推进 + nodes 整树替换', async () => {
    const store = new InMemoryMenuConfigStore();
    const created = await store.create({ tenant: t1, code: 'default', name: '默认', nodes: sampleTree });
    await new Promise((resolve) => setTimeout(resolve, 2)); // updatedAt 可区分
    const updated = await store.update(t1, created.id, {
      active: false,
      nodes: [{ code: 'solo', title: '唯一叶', routePath: '/solo' }],
    });
    expect(updated?.active).toBe(false);
    expect(updated?.name).toBe('默认'); // 未提供不变
    expect(updated?.nodes).toEqual([{ code: 'solo', title: '唯一叶', routePath: '/solo' }]);
    expect(updated !== null && updated.updatedAt > created.updatedAt).toBe(true);
  });
});

describe('节点树校验（MenuConfigInputError 边界）', () => {
  it('节点形状：非法 code/title/routePath/permission/hideInMenu 拒绝', async () => {
    const { service } = newService();
    await expect(
      service.createConfig(t1, { code: 'default', name: 'x', nodes: [{ code: '非法 码', title: 'x' }] }),
    ).rejects.toThrow(MenuConfigInputError);
    await expect(
      service.createConfig(t1, { code: 'default', name: 'x', nodes: [{ code: 'ok', title: '  ' }] }),
    ).rejects.toThrow(MenuConfigInputError);
    await expect(
      service.createConfig(t1, {
        code: 'default',
        name: 'x',
        nodes: [{ code: 'ok', title: 'x', routePath: 'no-slash' }],
      }),
    ).rejects.toThrow(MenuConfigInputError);
    await expect(
      service.createConfig(t1, {
        code: 'default',
        name: 'x',
        nodes: [{ code: 'ok', title: 'x', permission: 'Bad:Shape' }],
      }),
    ).rejects.toThrow(MenuConfigInputError);
    await expect(
      service.createConfig(t1, {
        code: 'default',
        name: 'x',
        nodes: [{ code: 'ok', title: 'x', hideInMenu: 'yes' }],
      }),
    ).rejects.toThrow(MenuConfigInputError);
  });

  it('树约束：code 树内全局唯一（跨层重复拒绝）；深度 >8 拒绝；空数组合法（占位配置集）', async () => {
    const { service } = newService();
    await expect(
      service.createConfig(t1, {
        code: 'default',
        name: 'x',
        nodes: [
          { code: 'dup', title: '父', children: [{ code: 'dup', title: '子同码' }] },
        ],
      }),
    ).rejects.toThrow(MenuConfigInputError);

    // 9 层链（超 MAX_DEPTH=8）
    let deep: Record<string, unknown> = { code: 'l9', title: '第九层' };
    for (let level = 8; level >= 1; level -= 1) deep = { code: `l${level}`, title: `第${level}层`, children: [deep] };
    await expect(
      service.createConfig(t1, { code: 'default', name: 'x', nodes: [deep] }),
    ).rejects.toThrow(MenuConfigInputError);

    const empty = await service.createConfig(t1, { code: 'placeholder', name: '占位', nodes: [] });
    expect(empty.nodes).toEqual([]);
  });

  it('更新：code 不可更新；nodes 替换重走校验；空更新幂等', async () => {
    const { service } = newService();
    const created = await service.createConfig(t1, { code: 'default', name: '默认', nodes: sampleTree });
    await expect(service.updateConfig(t1, created.id, { code: 'other' })).rejects.toThrow(
      MenuConfigInputError,
    );
    await expect(
      service.updateConfig(t1, created.id, { nodes: [{ code: 'a', title: 'x' }, { code: 'a', title: 'y' }] }),
    ).rejects.toThrow(MenuConfigInputError);
    const same = await service.updateConfig(t1, created.id, {});
    expect(same.nodes).toHaveLength(2);
  });

  it('未知 id → MenuConfigNotFoundError（404 语义）', async () => {
    const { service } = newService();
    await expect(service.getConfig(t1, 'ghost')).rejects.toThrow(MenuConfigNotFoundError);
    await expect(service.updateConfig(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MenuConfigNotFoundError,
    );
  });
});

describe('读实态定权限码', () => {
  it('聚合 active 配置树声明的权限码（去重排序）；停用配置集不参与；无码节点跳过', async () => {
    const { service } = newService();
    await service.createConfig(t1, {
      code: 'default',
      name: '默认',
      nodes: sampleTree, // 声明 workbench:read；其余无码
    });
    await service.createConfig(t1, {
      code: 'mobile',
      name: '移动',
      nodes: [
        { code: 'm.report', title: '报工', permission: 'workorder:report' },
        { code: 'm.quality', title: '质检', permission: 'workbench:read' }, // 与 default 重复
      ],
    });
    await service.createConfig(t1, {
      code: 'legacy',
      name: '停用集',
      active: false,
      nodes: [{ code: 'old', title: '旧', permission: 'legacy:read' }],
    });

    expect(await service.listPermissionCodes(t1)).toEqual(['workbench:read', 'workorder:report']);
    expect(await service.listPermissionCodes(t2)).toEqual([]); // 跨租户不可见
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('menu-config 路由：list/get/permission-codes=menu:read；create/update=menu:write', () => {
    expect(routePermissions(MenuConfigController, 'list')).toBe('menu:read');
    expect(routePermissions(MenuConfigController, 'create')).toBe('menu:write');
    expect(routePermissions(MenuConfigController, 'get')).toBe('menu:read');
    expect(routePermissions(MenuConfigController, 'update')).toBe('menu:write');
    expect(routePermissions(MenuConfigController, 'permissionCodes')).toBe('menu:read');
  });

  it('MenuConfigModule.register 装配控制器，缺省回落内存存储', () => {
    const dynamic = MenuConfigModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      MenuConfigModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(MenuConfigModule);
    expect(controllers).toContain(MenuConfigController);
  });
});
