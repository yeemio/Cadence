/**
 * 工程壳装配层数据的冒烟测试（纯数据，node 环境）：
 * 证明演示注册表经 product-ui 投影后，四条 RBAC 语义在真实装配数据上成立。
 * M1 增量 4-I：workbench 挂 workbench:read、新增基础数据分组（item/resource 两页）。
 * M1 收尾波-②：制造运营组新增扫码页（scan 挂 scan:read；operator 身份
 * 已加 scan:read——权限清单直接取自 DEMO_IDENTITIES，防测试与身份表漂移）。
 * M5 首波：扫码报工页升级为移动组 m.report（/m/report，见 mobile.test.ts）。
 * S2 批次：九循环模块桌面管理页建组挂页（workorder/listing/dispatch/reporting/
 * inspection/inventory/hours/costing/baseline），菜单码全部用后端控制器实态
 * :read 码；operator 身份按"车间岗位桌面可见面"授码。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION,
  DEMO_IDENTITIES,
  permissionCode,
  toSidebarMenu,
} from '@smes/product-ui';
import { menuRoutes, menuTree } from '../src/menu.js';

const operatorIdentity = DEMO_IDENTITIES.find((identity) => identity.email === 'operator@demo.local');
if (operatorIdentity === undefined) throw new Error('fixture: operator identity missing');
const operatorPermissions = operatorIdentity.permissions;

describe('演示注册表装配数据', () => {
  it('路由清单：全量、唯一、含 hideInMenu 项（会话审计/通知中心）与九循环模块页', () => {
    const paths = menuRoutes.map((route) => route.routePath);
    expect(paths).toEqual([
      '/manufacturing',
      // T1 能力子集 #1：运营总览四源聚合页（菜单首项）
      '/overview',
      '/',
      '/masterdata/items',
      '/masterdata/resources',
      // 基础数据（S3-a：客户/供应商/计量单位 backfill 三页）
      '/masterdata/customers',
      '/masterdata/suppliers',
      '/masterdata/units',
      // 制造运营（S2：workorder/dispatch 占位页升级，新增配件/清单/缺口/外协）
      '/workorders',
      '/workorders/parts',
      '/listings/sheets',
      '/listings/gap-checks',
      '/dispatches',
      '/outsourcing/lines',
      '/scan',
      // 报工管理（S2；UX-PRD-01 增移动报工桌面引导叶子）
      '/reports',
      '/reports/verification',
      '/reports/mobile',
      // 采购管理（S2；UX-PUR-01/02 增采购收货直达别名路径，同订单页组件）
      '/purchase/requests',
      '/purchase/orders',
      '/purchase/receiving',
      '/purchase/returns',
      '/purchase/details',
      // 质量管理（S2）
      '/inspections',
      '/inspections/nonconformities',
      // 仓储管理（S2）
      '/inventory/warehouses',
      '/inventory/stock',
      '/inventory/stock-operations',
      '/inventory/stocktakes',
      '/inventory/shipping-orders',
      // 成本与工时（S2）
      '/hours/stats',
      '/costing',
      // 标准报表（S3-a：口径四选一单页）
      '/standard-reports',
      // AI 问数首版（CONTRACT v1 · WP-C：规则引擎问数页，挂 ai-query:read）
      '/ai-query',
      // 图纸文档（D-WO-05：图纸库 + 查看留痕审计）
      '/drawings',
      '/drawings/view-audit',
      // 工艺与设备（S2）
      '/baseline/processes',
      '/baseline/routings',
      '/baseline/standard-times',
      '/baseline/equipment',
      '/baseline/fault-reports',
      '/baseline/outsourcing-rules',
      '/baseline/material-validations',
      '/system/users',
      '/system/roles',
      // 系统管理（S3-a：机构/岗位/操作日志 backfill 三页）
      '/system/departments',
      '/system/positions',
      '/system/audit',
      // 系统管理（T1：菜单管理 #98/99 + 审批流配置 #102）
      '/system/menus',
      '/system/approval-config',
      '/system/sessions',
      // T1 #101：通知中心（hideInMenu——入口 = 顶栏铃铛，路由保留）
      '/notifications',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('S2 菜单码：九模块叶子全部挂后端控制器实态 :read 码（不虚构权限）', () => {
    const expected = new Map([
      ['workorder', 'workorder:read'],
      ['workorder-parts', 'parts:read'],
      ['listing-sheets', 'listing:read'],
      ['listing-gap-checks', 'gap:read'],
      ['dispatch', 'dispatch:read'],
      ['outsourcing-lines', 'outsourcing:read'],
      ['reports', 'report:read'],
      ['report-verification', 'report:read'],
      ['purchase-requests', 'purchase:read'],
      ['purchase-orders', 'purchase:read'],
      ['purchase-receiving', 'purchase:receive'],
      ['purchase-returns', 'purchase:read'],
      ['purchase-details', 'purchase:read'],
      ['inspections', 'inspection:read'],
      ['nonconformities', 'nonconform:read'],
      ['warehouses', 'warehouse:read'],
      ['stock-levels', 'stock:read'],
      ['stock-operations', 'stock:read'],
      ['stocktakes', 'stocktake:read'],
      ['shipping-orders', 'shipping:read'],
      ['hours-stats', 'hours:read'],
      ['costing', 'costing:read'],
      ['baseline-processes', 'process:read'],
      ['baseline-routings', 'routing:read'],
      ['baseline-standard-times', 'standardtime:read'],
      ['baseline-equipment', 'equipment:read'],
      ['baseline-fault-reports', 'fault:read'],
      ['baseline-outsourcing-rules', 'outsourcing-rule:read'],
      ['baseline-material-validations', 'material-validation:read'],
    ]);
    for (const [code, permission] of expected) {
      const route = menuRoutes.find((candidate) => candidate.code === code);
      expect(route, `菜单码 ${code} 应在路由清单`).toBeDefined();
      expect(route?.permission).toBe(permissionCode(permission));
    }
  });

  it('S3-a 菜单码：backfill 六资源 :read + audit:read + 标准报表复用 report:read（后端控制器同码）', () => {
    const expected = new Map([
      ['masterdata-customer', 'customer:read'],
      ['masterdata-supplier', 'supplier:read'],
      ['masterdata-unit', 'unit:read'],
      ['system-department', 'department:read'],
      ['system-position', 'position:read'],
      ['system-audit', 'audit:read'],
      ['standard-reports', 'report:read'],
    ]);
    for (const [code, permission] of expected) {
      const route = menuRoutes.find((candidate) => candidate.code === code);
      expect(route, `菜单码 ${code} 应在路由清单`).toBeDefined();
      expect(route?.permission).toBe(permissionCode(permission));
    }
  });

  it('AI 问数菜单码：挂 ai-query:read（与 ai-query 控制器端点同码）；operator 未授不可见', () => {
    const route = menuRoutes.find((candidate) => candidate.code === 'ai-query');
    expect(route, '菜单码 ai-query 应在路由清单').toBeDefined();
    expect(route?.routePath).toBe('/ai-query');
    expect(route?.permission).toBe(permissionCode('ai-query:read'));
    // 域码由服务端逐次复核（denied 走回答通道）——operator 侧栏断言不动的证据面
    expect(operatorPermissions).not.toContain(permissionCode('ai-query:read'));
  });

  it('扫码页权限：菜单挂 scan:read；operator 身份持有 scan:read（M1 收尾波-②授予）', () => {
    const scanRoute = menuRoutes.find((route) => route.code === 'scan');
    expect(scanRoute?.permission).toBe(permissionCode('scan:read'));
    expect(operatorPermissions).toContain(permissionCode('scan:read'));
  });

  it('移动报工引导叶子：码 mobile-report 挂 report:submit（与 mobile.ts m.report 同码——动作页挂动作码先例）', () => {
    const mobileReportRoute = menuRoutes.find((route) => route.code === 'mobile-report');
    expect(mobileReportRoute, '移动报工引导路由应在清单').toBeDefined();
    expect(mobileReportRoute?.routePath).toBe('/reports/mobile');
    expect(mobileReportRoute?.permission).toBe(permissionCode('report:submit'));
    // 桌面注册表不得复制移动路径（mobile.test「两注册表不重叠」同款口径，此处就近复核）
    const desktopPaths = new Set(menuRoutes.map((route) => route.routePath));
    expect(desktopPaths.has('/m/report')).toBe(false);
  });

  it('侧栏：operator（真实身份权限）见工作台/物品/制造运营/报工/库存两页/工时统计/标准报表', () => {
    const sidebar = toSidebarMenu(menuTree, operatorPermissions);
    expect(sidebar.map((node) => node.code)).toEqual([
      // T1 #1：运营总览挂 workbench:read（operator 持码可见）
      'overview',
      'workbench',
      'masterdata',
      'manufacturing',
      'reporting',
      'warehouse',
      'costing',
      // S3-a：标准报表页复用 report:read——operator 持码可见（控制器同码）
      'standard-reports',
    ]);
    const masterdata = sidebar.find((node) => node.code === 'masterdata');
    expect(masterdata?.children?.map((child) => child.code)).toEqual(['masterdata-item']); // 无 resource:read
    const manufacturing = sidebar.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual([
      'workorder',
      'workorder-parts',
      'listing-sheets',
      'listing-gap-checks',
      'dispatch',
      'outsourcing-lines',
      'scan',
    ]);
    // 仓储组部分可见（stock:read 有、warehouse/stocktake/shipping 无）——权限投影证据
    const warehouse = sidebar.find((node) => node.code === 'warehouse');
    expect(warehouse?.children?.map((child) => child.code)).toEqual(['stock-levels', 'stock-operations']);
    // 成本与工时组部分可见（hours:read 有、costing:read 无）
    const costing = sidebar.find((node) => node.code === 'costing');
    expect(costing?.children?.map((child) => child.code)).toEqual(['hours-stats']);
  });

  it('侧栏：无制造运营/报工任何码的角色不见两组——采购/质检/工艺基线同理空壳隐藏', () => {
    const sidebar = toSidebarMenu(menuTree, [
      permissionCode('user:read'),
      permissionCode('role:read'),
      permissionCode('workbench:read'),
      permissionCode('item:read'),
    ]);
    // workorder/dispatch 系码全缺 → 制造运营与报工/采购/质检/仓储/成本/工艺基线全隐藏
    expect(sidebar.map((node) => node.code)).toEqual(['overview', 'workbench', 'masterdata', 'system']);
  });

  it('侧栏：组织管理员（user/role 码）只见系统管理（无 workbench:read）', () => {
    const sidebar = toSidebarMenu(menuTree, [
      permissionCode('user:read'),
      permissionCode('role:read'),
    ]);
    // 工作台挂 workbench:read（4-I 起）→ 无码不可见；基础数据两页无码 → 空壳隐藏
    expect(sidebar.map((node) => node.code)).toEqual(['system']);
    const system = sidebar.find((node) => node.code === 'system');
    expect(system?.children?.map((child) => child.code)).toEqual(['system-user', 'system-role']);
  });

  it('侧栏：admin 全量可见（九模块组全展开），但 hideInMenu 的会话审计不进侧栏', () => {
    const sidebar = toSidebarMenu(menuTree, [ADMIN_PERMISSION]);
    expect(new Set(sidebar.map((node) => node.code)).size).toBe(sidebar.length);
    expect(menuRoutes.find((route) => route.code === 'manufacturing-control')?.routePath).toBe('/manufacturing');
    expect(sidebar.map((node) => node.code)).toEqual([
      'manufacturing-control',
      'overview',
      'workbench',
      'masterdata',
      'manufacturing',
      'reporting',
      'purchasing',
      'quality',
      'warehouse',
      'costing',
      'standard-reports',
      'ai-query',
      'drawing',
      'baseline',
      'system',
    ]);
    const manufacturing = sidebar.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual([
      'workorder',
      'workorder-parts',
      'listing-sheets',
      'listing-gap-checks',
      'dispatch',
      'outsourcing-lines',
      'scan',
    ]);
    // D-WO-05：admin 全量可见图纸文档组两页
    const drawing = sidebar.find((node) => node.code === 'drawing');
    expect(drawing?.children?.map((child) => child.code)).toEqual(['drawing-library', 'drawing-audit']);
    const baseline = sidebar.find((node) => node.code === 'baseline');
    expect(baseline?.children?.map((child) => child.code)).toEqual([
      'baseline-processes',
      'baseline-routings',
      'baseline-standard-times',
      'baseline-equipment',
      'baseline-fault-reports',
      'baseline-outsourcing-rules',
      'baseline-material-validations',
    ]);
    // T1：系统管理组新增菜单管理/审批流配置（admin 全量可见）
    const system = sidebar.find((node) => node.code === 'system');
    expect(system?.children?.map((child) => child.code)).toEqual([
      'system-user',
      'system-role',
      'system-department',
      'system-position',
      'system-audit',
      'system-menus',
      'system-approval-config',
    ]);
    const sidebarTitles = JSON.stringify(sidebar);
    expect(sidebarTitles).not.toContain('会话审计');
    expect(sidebarTitles).not.toContain('通知中心'); // hideInMenu：铃铛入口，不进侧栏
  });
});
