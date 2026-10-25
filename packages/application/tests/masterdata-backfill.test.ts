/**
 * 客户/供应商/计量单位主数据测试（S1 backfill：0920 #8/#9/#100）：
 * 端口内存实现租户收口/冲突、输入解析边界、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  InMemoryCustomerStore,
  InMemoryItemStore,
  InMemoryResourceStore,
  InMemorySupplierStore,
  InMemoryUnitStore,
  MasterdataConflictError,
  MasterdataInputError,
  MasterdataModule,
  MasterdataNotFoundError,
  MasterdataService,
  PERMISSION_METADATA_KEY,
} from '../src/index.js';
import {
  MasterdataCustomersController,
  MasterdataSuppliersController,
  MasterdataUnitsController,
} from '../src/masterdata/masterdata.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newMasterdata(): MasterdataService {
  return new MasterdataService(
    new InMemoryItemStore(),
    new InMemoryResourceStore(),
    new InMemoryCustomerStore(),
    new InMemorySupplierStore(),
    new InMemoryUnitStore(),
  );
}

describe('客户主数据（0920 #8）', () => {
  it('create/list/update 租户内收口；code 冲突 409；contact 可空可清空', async () => {
    const service = newMasterdata();
    const created = await service.createCustomer(t1, {
      code: 'CUST-001',
      name: '北方重工',
      contact: '010-88886666',
    });
    expect(created.contact).toBe('010-88886666');
    expect(created.active).toBe(true);
    await expect(
      service.createCustomer(t1, { code: 'CUST-001', name: '重码' }),
    ).rejects.toThrow(MasterdataConflictError);
    await service.createCustomer(t2, { code: 'CUST-001', name: '他租户同码' }); // 他租户不冲突
    expect((await service.listCustomers(t2)).map((row) => row.name)).toEqual(['他租户同码']);
    const updated = await service.updateCustomer(t1, created.id, { contact: null, active: false });
    expect(updated?.contact).toBeNull();
    expect(updated?.active).toBe(false);
    await expect(service.updateCustomer(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MasterdataNotFoundError,
    );
  });

  it('非法输入拒绝；code 不可更新', async () => {
    const service = newMasterdata();
    await expect(service.createCustomer(t1, { code: '非法', name: 'x' })).rejects.toThrow(
      MasterdataInputError,
    );
    await expect(service.createCustomer(t1, { code: 'ok', name: '  ' })).rejects.toThrow(
      MasterdataInputError,
    );
    const created = await service.createCustomer(t1, { code: 'C-1', name: 'x' });
    await expect(
      service.updateCustomer(t1, created.id, { code: 'C-2' } as never),
    ).rejects.toThrow(MasterdataInputError);
  });
});

describe('供应商主数据（0920 #9）', () => {
  it('CRUD + 冲突 + 软停用', async () => {
    const service = newMasterdata();
    const created = await service.createSupplier(t1, { code: 'SUP-001', name: '外协一厂' });
    expect(created.active).toBe(true);
    await expect(
      service.createSupplier(t1, { code: 'SUP-001', name: '重码' }),
    ).rejects.toThrow(MasterdataConflictError);
    const updated = await service.updateSupplier(t1, created.id, { active: false, name: '外协一厂（停）' });
    expect(updated?.active).toBe(false);
    expect((await service.listSuppliers(t1)).length).toBe(1); // 软停用不出清单（全量返回，active=false 标记）
    await expect(service.updateSupplier(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MasterdataNotFoundError,
    );
  });
});

describe('计量单位（0920 #100）', () => {
  it('字典 CRUD：symbol 可空；无 active（字典取舍）；冲突隔离', async () => {
    const service = newMasterdata();
    const created = await service.createUnit(t1, { code: 'PCS', name: '件', symbol: 'PCS' });
    expect(created.symbol).toBe('PCS');
    const noSymbol = await service.createUnit(t1, { code: 'LOT', name: '批' });
    expect(noSymbol.symbol).toBeNull();
    await expect(
      service.createUnit(t1, { code: 'PCS', name: '重码' }),
    ).rejects.toThrow(MasterdataConflictError);
    expect((await service.listUnits(t2))).toEqual([]);
    const updated = await service.updateUnit(t1, created.id, { name: '件（EA）' });
    expect(updated?.name).toBe('件（EA）');
    await expect(service.updateUnit(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      MasterdataNotFoundError,
    );
  });
});

describe('控制器权限码与模块装配（masterdata backfill）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('customers/suppliers/units 各 read/write', () => {
    expect(routePermissions(MasterdataCustomersController, 'list')).toBe('customer:read');
    expect(routePermissions(MasterdataCustomersController, 'create')).toBe('customer:write');
    expect(routePermissions(MasterdataCustomersController, 'update')).toBe('customer:write');
    expect(routePermissions(MasterdataSuppliersController, 'list')).toBe('supplier:read');
    expect(routePermissions(MasterdataSuppliersController, 'create')).toBe('supplier:write');
    expect(routePermissions(MasterdataSuppliersController, 'update')).toBe('supplier:write');
    expect(routePermissions(MasterdataUnitsController, 'list')).toBe('unit:read');
    expect(routePermissions(MasterdataUnitsController, 'create')).toBe('unit:write');
    expect(routePermissions(MasterdataUnitsController, 'update')).toBe('unit:write');
  });

  it('MasterdataModule.register 装配三个新控制器，缺省回落内存存储', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      MasterdataModule.register(),
    ) as unknown[];
    expect(controllers).toContain(MasterdataCustomersController);
    expect(controllers).toContain(MasterdataSuppliersController);
    expect(controllers).toContain(MasterdataUnitsController);
  });
});
