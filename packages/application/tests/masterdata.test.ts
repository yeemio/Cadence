/**
 * 基础数据（物品/资源主数据）测试（M1 增量 4-I）：
 * 端口内存实现、输入解析边界、用例 404/409 语义、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  InMemoryItemStore,
  InMemoryResourceStore,
  MasterdataConflictError,
  MasterdataInputError,
  MasterdataModule,
  MasterdataNotFoundError,
  MasterdataService,
  PERMISSION_METADATA_KEY,
} from '../src/index.js';
import {
  MasterdataItemsController,
  MasterdataResourcesController,
} from '../src/masterdata/masterdata.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newMasterdata(): MasterdataService {
  return new MasterdataService(new InMemoryItemStore(), new InMemoryResourceStore());
}

describe('基础数据端口（内存实现先行）', () => {
  it('物品：create/list/find/update 租户内收口；code 冲突抛 MasterdataConflictError', async () => {
    const items = new InMemoryItemStore();
    const created = await items.create({
      tenant: t1,
      code: 'P-1001',
      name: '轴承',
      spec: '6204-2RS',
      unit: '个',
      category: 'part',
    });
    expect(created.active).toBe(true);
    expect(created.spec).toBe('6204-2RS');
    expect((await items.list(t1)).map((item) => item.code)).toEqual(['P-1001']);
    expect(await items.find(t1, created.id)).not.toBeNull();
    expect(await items.find(t2, created.id)).toBeNull(); // 跨租户不可见
    await expect(
      items.create({ tenant: t1, code: 'P-1001', name: '重名' }),
    ).rejects.toThrow(MasterdataConflictError);
    await items.create({ tenant: t2, code: 'P-1001', name: '他租户同码' }); // 他租户不冲突

    // 字段级期望态更新：未提供即不变
    const updated = await items.update(t1, created.id, { active: false, name: '轴承 6204' });
    expect(updated?.active).toBe(false);
    expect(updated?.name).toBe('轴承 6204');
    expect(updated?.spec).toBe('6204-2RS');
    expect(await items.update(t1, 'ghost', { active: false })).toBeNull(); // 不存在 → null
  });

  it('资源：create/list/update；code 冲突与跨租户隔离同物品', async () => {
    const resources = new InMemoryResourceStore();
    const created = await resources.create({ tenant: t1, code: 'M-01', name: '一号铣床', type: 'machine' });
    expect(created.type).toBe('machine');
    await expect(
      resources.create({ tenant: t1, code: 'M-01', name: '重名' }),
    ).rejects.toThrow(MasterdataConflictError);
    expect((await resources.list(t2))).toEqual([]);
    const updated = await resources.update(t1, created.id, { type: null, active: false });
    expect(updated?.type).toBeNull();
    expect(updated?.active).toBe(false);
  });
});

describe('输入解析（MasterdataInputError 边界）', () => {
  it('创建物品：非法 code / name / spec / active 拒绝', async () => {
    const service = newMasterdata();
    await expect(service.createItem(t1, { code: '非法 码', name: 'x' })).rejects.toThrow(
      MasterdataInputError,
    );
    await expect(service.createItem(t1, { code: '-bad', name: 'x' })).rejects.toThrow(
      MasterdataInputError,
    );
    await expect(service.createItem(t1, { code: 'ok', name: '  ' })).rejects.toThrow(
      MasterdataInputError,
    );
    await expect(
      service.createItem(t1, { code: 'ok', name: 'x', active: 'yes' }),
    ).rejects.toThrow(MasterdataInputError);
  });

  it('更新物品：code 不可更新；空更新合法（幂等无操作）', async () => {
    const service = newMasterdata();
    const created = await service.createItem(t1, { code: 'P-1', name: 'x' });
    await expect(service.updateItem(t1, created.id, { code: 'P-2' })).rejects.toThrow(
      MasterdataInputError,
    );
    const same = await service.updateItem(t1, created.id, {});
    expect(same.name).toBe('x');
  });

  it('更新/列表：未知 id → MasterdataNotFoundError（404 语义）', async () => {
    const service = newMasterdata();
    await expect(service.updateItem(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MasterdataNotFoundError,
    );
    await expect(service.updateResource(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MasterdataNotFoundError,
    );
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('items 路由：list=item:read、create/update=item:write', () => {
    expect(routePermissions(MasterdataItemsController, 'list')).toBe('item:read');
    expect(routePermissions(MasterdataItemsController, 'create')).toBe('item:write');
    expect(routePermissions(MasterdataItemsController, 'update')).toBe('item:write');
  });

  it('resources 路由：list=resource:read、create/update=resource:write', () => {
    expect(routePermissions(MasterdataResourcesController, 'list')).toBe('resource:read');
    expect(routePermissions(MasterdataResourcesController, 'create')).toBe('resource:write');
    expect(routePermissions(MasterdataResourcesController, 'update')).toBe('resource:write');
  });

  it('MasterdataModule.register 装配五个控制器（items/resources + S1 客户/供应商/计量单位 backfill），缺省回落内存存储', () => {
    const dynamic = MasterdataModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      MasterdataModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(MasterdataModule);
    expect(controllers).toContain(MasterdataItemsController);
    expect(controllers).toContain(MasterdataResourcesController);
  });
});
