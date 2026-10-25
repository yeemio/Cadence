/**
 * baseline 模块装配与边界测试：BaselineModule.register（DI providers/控制器清单）、
 * 路由权限码元数据（合同 §5 最小集）、命令提交体解析（信封层 400 语义）、
 * 内存端口唯一性护栏（并发竞态合同）、信封深冻结。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { PERMISSION_METADATA_KEY } from '../../src/index.js';
import {
  BaselineEquipmentController,
  BaselineMaterialValidationsController,
  BaselineOutsourcingRulesController,
  BaselineProcessesController,
} from '../../src/baseline/baseline.controllers.js';
import { BaselineModule } from '../../src/baseline/baseline.module.js';
import { makeBaselineCommandEnvelope } from '../../src/baseline/baseline-input.js';
import { BaselineConflictError, BaselineInputError } from '../../src/baseline/baseline-errors.js';
import { InMemoryEquipmentStore } from '../../src/baseline/in-memory-baseline-stores.js';

function routePermissions(controller: new (...args: never[]) => unknown, handler: string): unknown {
  const proto = controller.prototype as Record<string, unknown>;
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
}

describe('路由权限码（合同 §5 最小集）', () => {
  it('工序：command=process:write、list/get=process:read', () => {
    expect(routePermissions(BaselineProcessesController, 'command')).toBe('process:write');
    expect(routePermissions(BaselineProcessesController, 'list')).toBe('process:read');
    expect(routePermissions(BaselineProcessesController, 'get')).toBe('process:read');
  });

  it('外协计价规则：command=outsourcing-rule:write、list/get=outsourcing-rule:read', () => {
    expect(routePermissions(BaselineOutsourcingRulesController, 'command')).toBe('outsourcing-rule:write');
    expect(routePermissions(BaselineOutsourcingRulesController, 'list')).toBe('outsourcing-rule:read');
    expect(routePermissions(BaselineOutsourcingRulesController, 'get')).toBe('outsourcing-rule:read');
  });

  it('设备：command=equipment:write、list/get=equipment:read', () => {
    expect(routePermissions(BaselineEquipmentController, 'command')).toBe('equipment:write');
    expect(routePermissions(BaselineEquipmentController, 'list')).toBe('equipment:read');
    expect(routePermissions(BaselineEquipmentController, 'get')).toBe('equipment:read');
  });

  it('物料校验：只读两径 material-validation:read（执行走端口，无 HTTP 写端点）', () => {
    expect(routePermissions(BaselineMaterialValidationsController, 'list')).toBe('material-validation:read');
    expect(routePermissions(BaselineMaterialValidationsController, 'get')).toBe('material-validation:read');
    expect(Object.getOwnPropertyNames(BaselineMaterialValidationsController.prototype).sort()).toEqual([
      'constructor',
      'get',
      'list',
    ]);
  });
});

describe('模块装配', () => {
  it('register：四控制器挂载，module 标识正确', () => {
    const dynamic = BaselineModule.register();
    expect(dynamic.module).toBe(BaselineModule);
    // 注：register() 返回的字面量 DynamicModule 不带 reflect-metadata——断言
    // 直读 controllers 属性（真实属性，非 metadata 空真；体例同 p2-module.test.ts，
    // 七控制器总数断言亦在该文件）。
    expect(dynamic.controllers).toContain(BaselineProcessesController);
    expect(dynamic.controllers).toContain(BaselineOutsourcingRulesController);
    expect(dynamic.controllers).toContain(BaselineEquipmentController);
    expect(dynamic.controllers).toContain(BaselineMaterialValidationsController);
  });
});

describe('命令提交体解析（信封层，BaselineInputError=400 语义）', () => {
  const identity = { tenant: TenantId.create('t1'), issuedBy: UserId.create('u-tech-01') };

  it('合法提交体 → 深冻结信封；issuedAt 缺省取服务器时刻', () => {
    const envelope = makeBaselineCommandEnvelope(
      {
        operationId: 'op-http-1',
        expectedRevision: 'initial',
        command: { kind: 'baseline.process.define.v1', payload: { code: 'OP-90', name: '镗孔' } },
      },
      identity,
    );
    expect(envelope.contract).toBe('smes.command.v1');
    expect(envelope.command.kind).toBe('baseline.process.define.v1');
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.command)).toBe(true); // 深冻结（含 command）
    expect(Number.isNaN(Date.parse(envelope.issuedAt))).toBe(false);
  });

  it('非法 operationId / expectedRevision / kind / command 形状 → BaselineInputError', () => {
    expect(() => makeBaselineCommandEnvelope({ expectedRevision: 'initial', command: { kind: 'baseline.process.define.v1' } }, identity)).toThrow(BaselineInputError);
    expect(() =>
      makeBaselineCommandEnvelope({ operationId: 'op-x', expectedRevision: 0, command: { kind: 'baseline.process.define.v1' } }, identity),
    ).toThrow(BaselineInputError);
    expect(() =>
      makeBaselineCommandEnvelope({ operationId: 'op-x', expectedRevision: 'initial', command: { kind: 'baseline.unknown.v1' } }, identity),
    ).toThrow(BaselineInputError);
    expect(() =>
      makeBaselineCommandEnvelope({ operationId: 'op-x', expectedRevision: 'initial', command: { kind: 'baseline.process.define.v1', payload: 'not-object' } }, identity),
    ).toThrow(BaselineInputError);
    expect(() => makeBaselineCommandEnvelope(null, identity)).toThrow(BaselineInputError);
  });
});

describe('内存端口唯一性护栏（并发竞态合同）', () => {
  it('同 (code, objectVersion) 重复插入 → BaselineConflictError；supersedes 分叉同样拒绝', async () => {
    const store = new InMemoryEquipmentStore();
    const base = {
      tenant: TenantId.create('t1'),
      code: 'EQ-1',
      name: '车床',
      type: null,
      location: null,
      status: 'active' as const,
      auditStatus: 'unaudited',
      businessTime: '2026-10-25T10:00:00.000Z',
    };
    const v1 = await store.insert({ ...base, objectVersion: 1, supersedes: null });
    await expect(store.insert({ ...base, objectVersion: 1, supersedes: null })).rejects.toThrow(BaselineConflictError);
    const v2 = await store.insert({ ...base, objectVersion: 2, supersedes: v1.id });
    await expect(store.insert({ ...base, objectVersion: 3, supersedes: v1.id })).rejects.toThrow(BaselineConflictError); // 链分叉
    expect((await store.versions(TenantId.create('t1'), 'EQ-1')).map((row) => row.objectVersion)).toEqual([1, 2]);
  });
});
