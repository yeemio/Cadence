/**
 * 机构/岗位主数据测试（S1 backfill：0920 #3/#7）：
 * 端口内存实现租户收口/冲突、树守卫（父存在/不成环/不自指）、输入解析边界、
 * 控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  InMemoryDepartmentStore,
  InMemoryPositionStore,
  OrgConflictError,
  OrgInputError,
  OrgModule,
  OrgNotFoundError,
  OrgService,
  PERMISSION_METADATA_KEY,
  type PermissionService,
  type RoleStore,
  type UserStore,
} from '../src/index.js';
import {
  OrgDepartmentsController,
  OrgPositionsController,
} from '../src/org/org.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

/** 只测机构/岗位：users/roles/permissions 传哑件（本组用例不触达）。 */
function newOrg(): OrgService {
  return new OrgService(
    {} as UserStore,
    {} as RoleStore,
    {} as PermissionService,
    null,
    new InMemoryDepartmentStore(),
    new InMemoryPositionStore(),
  );
}

describe('机构端口（内存实现先行，0920 #3）', () => {
  it('create/list/find/update 租户内收口；code 冲突抛 OrgConflictError', async () => {
    const departments = new InMemoryDepartmentStore();
    const root = await departments.create({ tenant: t1, code: 'ORG-01', name: '总公司' });
    expect(root.parentId).toBeNull();
    expect(root.active).toBe(true);
    const child = await departments.create({
      tenant: t1,
      code: 'ORG-01-1',
      name: '机加车间',
      parentId: root.id,
    });
    expect(child.parentId).toBe(root.id);
    expect((await departments.list(t1)).map((node) => node.code)).toEqual(['ORG-01', 'ORG-01-1']);
    expect(await departments.find(t1, child.id)).not.toBeNull();
    expect(await departments.find(t2, child.id)).toBeNull(); // 跨租户不可见
    await expect(
      departments.create({ tenant: t1, code: 'ORG-01', name: '重名' }),
    ).rejects.toThrow(OrgConflictError);
    await departments.create({ tenant: t2, code: 'ORG-01', name: '他租户同码' }); // 他租户不冲突
    const updated = await departments.update(t1, child.id, { active: false, name: '机加一车间' });
    expect(updated?.active).toBe(false);
    expect(updated?.name).toBe('机加一车间');
    expect(await departments.update(t1, 'ghost', { active: false })).toBeNull(); // 不存在 → null
  });

  it('树守卫：父不存在 404；自指/成环 400；换挂合法路径通过', async () => {
    const service = newOrg();
    const root = await service.createDepartment(t1, { code: 'ROOT', name: '根' });
    const mid = await service.createDepartment(t1, { code: 'MID', name: '中', parentId: root.id });
    const leaf = await service.createDepartment(t1, { code: 'LEAF', name: '叶', parentId: mid.id });

    await expect(
      service.createDepartment(t1, { code: 'X', name: '孤', parentId: 'ghost' }),
    ).rejects.toThrow(OrgNotFoundError);
    await expect(
      service.updateDepartment(t1, mid.id, { parentId: mid.id }),
    ).rejects.toThrow(OrgInputError); // 自指
    await expect(
      service.updateDepartment(t1, root.id, { parentId: leaf.id }),
    ).rejects.toThrow(OrgInputError); // 成环（父链命中自身）
    const moved = await service.updateDepartment(t1, leaf.id, { parentId: root.id });
    expect(moved?.parentId).toBe(root.id); // 合法换挂
    const toTop = await service.updateDepartment(t1, leaf.id, { parentId: null });
    expect(toTop?.parentId).toBeNull(); // 挂顶层
  });
});

describe('岗位（0920 #7）', () => {
  it('CRUD + 归属机构存在性校验（404）+ 跨租户隔离', async () => {
    const service = newOrg();
    const dept = await service.createDepartment(t1, { code: 'D1', name: '技术部' });
    const created = await service.createPosition(t1, {
      code: 'POS-01',
      name: '工艺员',
      departmentRef: dept.id,
    });
    expect(created.departmentRef).toBe(dept.id);
    expect(created.active).toBe(true);
    await expect(
      service.createPosition(t1, { code: 'POS-02', name: '孤儿岗', departmentRef: 'ghost' }),
    ).rejects.toThrow(OrgNotFoundError);
    const free = await service.createPosition(t1, { code: 'POS-03', name: '顾问' });
    expect(free.departmentRef).toBeNull(); // 不挂机构合法
    await expect(
      service.createPosition(t1, { code: 'POS-01', name: '重码' }),
    ).rejects.toThrow(OrgConflictError);
    expect((await service.listPositions(t2))).toEqual([]);
    const updated = await service.updatePosition(t1, created.id, { active: false });
    expect(updated?.active).toBe(false);
    await expect(service.updatePosition(t1, 'ghost', { name: 'x' })).rejects.toThrow(OrgNotFoundError);
  });
});

describe('输入解析与权限码（org backfill）', () => {
  it('非法 code/parentId/departmentRef 拒绝；code 不可更新', async () => {
    const service = newOrg();
    await expect(service.createDepartment(t1, { code: '非法 码', name: 'x' })).rejects.toThrow(OrgInputError);
    await expect(service.createPosition(t1, { code: '-bad', name: 'x' })).rejects.toThrow(OrgInputError);
    const created = await service.createDepartment(t1, { code: 'OK-1', name: 'x' });
    await expect(service.updateDepartment(t1, created.id, { code: 'OK-2' } as never)).rejects.toThrow(
      OrgInputError,
    );
  });

  it('路由权限码：department/position 各 read/write；模块装配两控制器', () => {
    type Handler = Record<string, unknown>;
    const routePermissions = (controller: Function, handler: string): unknown =>
      Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (controller.prototype as Record<string, Handler>)[handler] as object,
      );
    expect(routePermissions(OrgDepartmentsController, 'list')).toBe('department:read');
    expect(routePermissions(OrgDepartmentsController, 'create')).toBe('department:write');
    expect(routePermissions(OrgDepartmentsController, 'update')).toBe('department:write');
    expect(routePermissions(OrgPositionsController, 'list')).toBe('position:read');
    expect(routePermissions(OrgPositionsController, 'create')).toBe('position:write');
    expect(routePermissions(OrgPositionsController, 'update')).toBe('position:write');

    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      OrgModule.register(),
    ) as unknown[];
    expect(controllers).toContain(OrgDepartmentsController);
    expect(controllers).toContain(OrgPositionsController);
  });
});
