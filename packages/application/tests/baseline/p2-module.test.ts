/**
 * baseline P2/P3 件装配与边界测试：新控制器路由权限码元数据（合同 §5 最小集：
 * routing/standardtime/fault）、模块注册（七控制器挂载）、P1 装配面零破坏
 * （P1-only 选项 register 仍可装配且 P1 四控制器在位）、命令动词与端点绑定
 * （makeBaselineCommandEnvelopeForKind 的 kind 断言 = 400 语义）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { PERMISSION_METADATA_KEY } from '../../src/index.js';
import {
  BaselineFaultReportsController,
  BaselineRoutingsController,
  BaselineStandardTimesController,
} from '../../src/baseline/baseline.controllers.js';
import { BaselineModule } from '../../src/baseline/baseline.module.js';
import { makeBaselineCommandEnvelopeForKind } from '../../src/baseline/baseline-input.js';
import { BaselineInputError } from '../../src/baseline/baseline-errors.js';

function routePermissions(controller: new (...args: never[]) => unknown, handler: string): unknown {
  const proto = controller.prototype as Record<string, unknown>;
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
}

describe('P2/P3 路由权限码（合同 §5 最小集）', () => {
  it('工艺路线：command=routing:write、list/get=routing:read', () => {
    expect(routePermissions(BaselineRoutingsController, 'command')).toBe('routing:write');
    expect(routePermissions(BaselineRoutingsController, 'list')).toBe('routing:read');
    expect(routePermissions(BaselineRoutingsController, 'get')).toBe('routing:read');
  });

  it('额定工时：command=standardtime:write、list/get=standardtime:read', () => {
    expect(routePermissions(BaselineStandardTimesController, 'command')).toBe('standardtime:write');
    expect(routePermissions(BaselineStandardTimesController, 'list')).toBe('standardtime:read');
    expect(routePermissions(BaselineStandardTimesController, 'get')).toBe('standardtime:read');
  });

  it('故障单：report=fault:report、resolve=fault:resolve、list/get=fault:read（读写分权）', () => {
    expect(routePermissions(BaselineFaultReportsController, 'report')).toBe('fault:report');
    expect(routePermissions(BaselineFaultReportsController, 'resolve')).toBe('fault:resolve');
    expect(routePermissions(BaselineFaultReportsController, 'list')).toBe('fault:read');
    expect(routePermissions(BaselineFaultReportsController, 'get')).toBe('fault:read');
  });
});

describe('模块装配（P2/P3 追加 + P1 零破坏）', () => {
  // 注：register() 返回的字面量 DynamicModule 不带 reflect-metadata（P1 同形状）——
  // 控制器清单断言直读 controllers 属性（真实属性，非 metadata 空真）。
  it('register()：七控制器挂载（P1 四 + P2/P3 三），module 标识正确', () => {
    const dynamic = BaselineModule.register();
    expect(dynamic.module).toBe(BaselineModule);
    expect(dynamic.controllers).toHaveLength(7);
    expect(dynamic.controllers).toContain(BaselineRoutingsController);
    expect(dynamic.controllers).toContain(BaselineStandardTimesController);
    expect(dynamic.controllers).toContain(BaselineFaultReportsController);
  });

  it('P1-only 选项 register 仍可装配（向后兼容硬约束：既有选项面零破坏）', () => {
    const dynamic = BaselineModule.register({ thresholds: { specMatchThreshold: 0.9, suspectThreshold: 0.75 } });
    expect(dynamic.controllers).toHaveLength(7);
    expect(() => BaselineModule.register({ itemLibrary: undefined, processStore: undefined })).not.toThrow();
  });
});

describe('命令动词与端点绑定（makeBaselineCommandEnvelopeForKind）', () => {
  const identity = { tenant: TenantId.create('t1'), issuedBy: UserId.create('u-tech-01') };

  it('kind 在端点合法集内 → 深冻结信封', () => {
    const envelope = makeBaselineCommandEnvelopeForKind(
      {
        operationId: 'op-p2-1',
        expectedRevision: 'initial',
        command: { kind: 'baseline.routing.define.v1', payload: { drawingNo: 'DW-1', steps: [{ processCode: 'OP-1' }] } },
      },
      identity,
      ['baseline.routing.define.v1', 'baseline.routing.revise.v1'],
    );
    expect(envelope.command.kind).toBe('baseline.routing.define.v1');
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('kind 不在端点合法集 → BaselineInputError（400 语义：防跨资源命令经他端点提交）', () => {
    expect(() =>
      makeBaselineCommandEnvelopeForKind(
        {
          operationId: 'op-p2-2',
          expectedRevision: 'initial',
          command: { kind: 'baseline.fault.report.v1', payload: { equipmentCode: 'EQ-1', description: 'x', assignee: 'u-1' } },
        },
        identity,
        ['baseline.routing.define.v1'],
      ),
    ).toThrow(BaselineInputError);
  });
});
