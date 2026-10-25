/**
 * connect* 工厂 RLS session 门控接线一致性（ESCALATION-2 收尾，M4 部署期收尾波）。
 *
 * 覆盖：全部 18 个连接工厂（先例四家 org / masterdata / workbench / approval +
 * 其余十四家各领域 pg-*-stores + metric-pack 六源 bundle）在 SMES_RLS_SESSION=on
 * 时必须经 withRlsTenantSession 装扩展、缺省不装。
 *
 * 纯装配面（不连库）：vi.mock @prisma/client 以桩类拦截 $extends——
 * PrismaClient 构造本就惰性连接、$extends 是纯客户端操作，桩不破坏惰性合同；
 * 容器级贯通实证在 deploy/scripts/rls-session-proof.mjs。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantId } from '@smes/business-core';

const mock = vi.hoisted(() => ({ extendsNames: [] as string[] }));

vi.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class MockPrismaClient {
    $extends(extension: { name?: string }): unknown {
      mock.extendsNames.push(extension?.name ?? '(anon)');
      return this;
    }
    async $disconnect(): Promise<void> {}
  },
}));

import { connectApprovalStore } from '../src/approval/pg-approval-stores.js';
import { connectBaselineStore } from '../src/baseline/pg-baseline-stores.js';
import { connectCostingStore } from '../src/costing/pg-costing-stores.js';
import { connectDispatchStore } from '../src/dispatch/pg-dispatch-stores.js';
import { connectDrawingStore } from '../src/drawing/pg-drawing-stores.js';
import { connectHoursStore } from '../src/hours/pg-hours-stores.js';
import { connectInspectionStore } from '../src/inspection/pg-inspection-stores.js';
import { connectInventoryStore } from '../src/inventory/pg-inventory-stores.js';
import { connectListingStore } from '../src/listing/pg-listing-stores.js';
import { connectMaintenanceStore } from '../src/maintenance/pg-maintenance-stores.js';
import { connectMasterdataStore } from '../src/masterdata/pg-masterdata-stores.js';
import {
  connectMetricPackStore,
  connectMetricSourceBundle,
} from '../src/metric-pack/pg-metric-pack-stores.js';
import { connectBusinessStore } from '../src/org/pg-org-stores.js';
import { connectPayrollStore } from '../src/payroll/pg-payroll-stores.js';
import { connectReportingStore } from '../src/reporting/pg-reporting-stores.js';
import { connectWorkbenchStore } from '../src/workbench/pg-workbench-stores.js';
import { connectWorkOrderStore } from '../src/workorder/pg-workorder-stores.js';
import { SMES_RLS_SESSION_ENV } from '../src/rls-session.js';

/** 18 家工厂清单（与 main.ts 装配序同源；新增 connect* 工厂漏接线 → 此表补行 → 红）。 */
const factories: ReadonlyArray<readonly [string, () => unknown]> = [
  ['org', () => connectBusinessStore()],
  ['masterdata', () => connectMasterdataStore()],
  ['workbench', () => connectWorkbenchStore()],
  ['approval', () => connectApprovalStore()],
  ['baseline', () => connectBaselineStore()],
  ['workorder', () => connectWorkOrderStore()],
  ['listing', () => connectListingStore()],
  ['inspection', () => connectInspectionStore()],
  ['inventory', () => connectInventoryStore()],
  ['dispatch', () => connectDispatchStore()],
  ['reporting', () => connectReportingStore()],
  ['hours', () => connectHoursStore()],
  ['costing', () => connectCostingStore()],
  ['payroll', () => connectPayrollStore()],
  ['maintenance', () => connectMaintenanceStore()],
  ['drawing', () => connectDrawingStore()],
  ['metric-pack', () => connectMetricPackStore()],
  ['metric-source-bundle', () => connectMetricSourceBundle(TenantId.create('t-a'))],
];

describe('connect* 工厂 RLS session 门控（ESCALATION-2 收尾：18/18 全接线）', () => {
  const savedEnv = process.env[SMES_RLS_SESSION_ENV];

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[SMES_RLS_SESSION_ENV];
    } else {
      process.env[SMES_RLS_SESSION_ENV] = savedEnv;
    }
  });

  it('SMES_RLS_SESSION=on：每家工厂恰装一次 withRlsTenantSession 扩展', () => {
    process.env[SMES_RLS_SESSION_ENV] = 'on';
    for (const [name, connect] of factories) {
      mock.extendsNames.length = 0;
      expect(() => connect(), `${name} 工厂构造`).not.toThrow();
      expect(mock.extendsNames, `${name} 工厂 $extends 调用`).toEqual(['rlsTenantSession']);
    }
  });

  it('缺省不包装：零行为变化（superuser / 既有测试与 e2e 形态）', () => {
    delete process.env[SMES_RLS_SESSION_ENV];
    for (const [name, connect] of factories) {
      mock.extendsNames.length = 0;
      expect(() => connect(), `${name} 工厂构造`).not.toThrow();
      expect(mock.extendsNames, `${name} 工厂不应装扩展`).toEqual([]);
    }
  });

  it('SMES_RLS_SESSION=off（显式非 on 取值）：同缺省不包装（门控精确匹配 on）', () => {
    process.env[SMES_RLS_SESSION_ENV] = 'off';
    for (const [name, connect] of factories) {
      mock.extendsNames.length = 0;
      connect();
      expect(mock.extendsNames, `${name} 工厂 off 不装`).toEqual([]);
    }
  });
});
