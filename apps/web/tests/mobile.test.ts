/**
 * 移动端注册表冒烟测试（M5 首波 + S3 增量，纯数据）：路由清单/权限码/
 * 底部导航 RBAC 投影。注册表见 src/mobile.ts（复用 MenuNode +
 * filterMenuByPermissions——投影语义由 product-ui menu 语义保证，此处钉
 * 装配数据本身）。S3 增量：MOBILE_SUBPAGES 11 子页（覆盖矩阵 §3.2 19 项 +
 * §3.4 #116）进 mobileRoutes 全量清单但不进底部标签（≤5 合同）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION,
  DEMO_IDENTITIES,
  filterMenuByPermissions,
  permissionCode,
} from '@smes/product-ui';
import { MOBILE_MENU, MOBILE_SUBPAGES, mobileRoutes } from '../src/mobile.js';
import { menuRoutes } from '../src/menu.js';

const operatorIdentity = DEMO_IDENTITIES.find((identity) => identity.email === 'operator@demo.local');
if (operatorIdentity === undefined) throw new Error('fixture: operator identity missing');

const leadIdentity = DEMO_IDENTITIES.find((identity) => identity.email === 'lead@demo.local');
if (leadIdentity === undefined) throw new Error('fixture: lead identity missing');

describe('移动注册表（底部标签装配数据——M5 四项冻结）', () => {
  it('底部标签：m.workbench / m.report / m.hours / m.stock 四项不变（≤5 合同）', () => {
    expect(MOBILE_MENU.map((tab) => tab.code)).toEqual([
      'm.workbench',
      'm.report',
      'm.hours',
      'm.stock',
    ]);
  });

  it('权限码与各模块后端端点一一对应（镜像逻辑归各模块 API 的呈现口径）', () => {
    const byCode = new Map(MOBILE_MENU.map((tab) => [tab.code, tab.permission]));
    expect(byCode.get('m.workbench')).toBe(permissionCode('workbench:read')); // GET /workbench/*
    expect(byCode.get('m.report')).toBe(permissionCode('report:submit')); // POST /reports
    expect(byCode.get('m.hours')).toBe(permissionCode('hours:read')); // GET /hours/my
    expect(byCode.get('m.stock')).toBe(permissionCode('stock:read')); // GET /inventory/stock
  });

  it('底部导航投影：operator（车间工人 demo 身份）四页全见', () => {
    const tabs = filterMenuByPermissions(MOBILE_MENU, operatorIdentity.permissions);
    expect(tabs.map((tab) => tab.code)).toEqual(['m.workbench', 'm.report', 'm.hours', 'm.stock']);
  });

  it('底部导航投影：无任何移动权限的角色全隐；admin bypass 全见', () => {
    expect(filterMenuByPermissions(MOBILE_MENU, [permissionCode('user:read')])).toEqual([]);
    expect(
      filterMenuByPermissions(MOBILE_MENU, [ADMIN_PERMISSION]).map((tab) => tab.code),
    ).toEqual(['m.workbench', 'm.report', 'm.hours', 'm.stock']);
  });

  it('底部导航投影：单码窄授权只见对应页（精确码匹配证据）', () => {
    const tabs = filterMenuByPermissions(MOBILE_MENU, [permissionCode('hours:read')]);
    expect(tabs.map((tab) => tab.code)).toEqual(['m.hours']);
  });
});

describe('移动子页注册表（S3 增量 11 页——覆盖 §3.2 19 项 + #116）', () => {
  it('子页清单：11 页码齐全、路径 /m/* 唯一、不与底部标签重叠', () => {
    expect(MOBILE_SUBPAGES.map((page) => page.code)).toEqual([
      'm.verify',
      'm.parts',
      'm.parts-approval',
      'm.inspection',
      'm.fault',
      'm.receipt',
      'm.transfer',
      'm.stocktake',
      'm.progress',
      'm.op-progress',
      'm.mine',
    ]);
    const paths = MOBILE_SUBPAGES.map((page) => page.routePath);
    for (const path of paths) {
      expect(path?.startsWith('/m/')).toBe(true);
    }
    expect(new Set(paths).size).toBe(paths.length);
    const tabPaths = new Set(MOBILE_MENU.map((tab) => tab.routePath));
    for (const path of paths) expect(tabPaths.has(path)).toBe(false);
  });

  it('子页权限码与后端控制器 @RequirePermission 实态同码（覆盖项 → 页 → 码）', () => {
    const byCode = new Map(MOBILE_SUBPAGES.map((page) => [page.code, page.permission]));
    // 111-114 四类报工核查（POST /reports/:id/verify）
    expect(byCode.get('m.verify')).toBe(permissionCode('report:verify'));
    // 117 配件申请（POST /workorder/parts-requests）
    expect(byCode.get('m.parts')).toBe(permissionCode('parts:request'));
    // 118 配件审批（POST /workorder/parts-requests/:id/approval）
    expect(byCode.get('m.parts-approval')).toBe(permissionCode('parts:approve'));
    // 119-122 四类质检（POST /inspection/orders/:id/judgment|recheck）
    expect(byCode.get('m.inspection')).toBe(permissionCode('inspection:judge'));
    // 127 故障上报（POST /baseline/fault-reports/commands）
    expect(byCode.get('m.fault')).toBe(permissionCode('fault:report'));
    // 128-130 三类入库（POST /inventory/stock/receipts）
    expect(byCode.get('m.receipt')).toBe(permissionCode('stock:receive'));
    // 132 调拨和移库（POST /inventory/stock/transfers）
    expect(byCode.get('m.transfer')).toBe(permissionCode('stock:transfer'));
    // 133 库存盘点（POST /inventory/stocktakes 系）
    expect(byCode.get('m.stocktake')).toBe(permissionCode('stocktake:record'));
    // 134 工作令进度查询（GET /workorder/work-orders/:id/progress）
    expect(byCode.get('m.progress')).toBe(permissionCode('workorder:read'));
    // 135 图号/工序进度查询（GET /reporting/drawings/:drawingNo/operation-progress）
    expect(byCode.get('m.op-progress')).toBe(permissionCode('report:read'));
    // 136 我的报工 + #116 记录列表（GET /reports/mine）
    expect(byCode.get('m.mine')).toBe(permissionCode('report:read'));
  });

  it('子页投影：admin bypass 全见；单码窄授权只见对应页', () => {
    expect(
      filterMenuByPermissions(MOBILE_SUBPAGES, [ADMIN_PERMISSION]).map((page) => page.code),
    ).toHaveLength(11);
    expect(
      filterMenuByPermissions(MOBILE_SUBPAGES, [permissionCode('fault:report')]).map((page) => page.code),
    ).toEqual(['m.fault']);
    expect(filterMenuByPermissions(MOBILE_SUBPAGES, [])).toEqual([]);
  });

  it('S3-d 身份投影：演示班长（lead@demo.local）11 子页全见 + 底部标签部分可见', () => {
    // 动作码承载身份：核查/审批/判定/入库/调拨/盘点全径 + 工人查询页（S3-d
    // 19 项呈现可见面证据——权限取自 DEMO_IDENTITIES 真实表，防测试与身份表漂移）。
    // 底部标签按码投影部分可见：班长不提交报工（无 report:submit → 无 m.report
    // 标签）、无个人工时口径（无 hours:read → 无 m.hours 标签）——精确码匹配证据。
    expect(
      filterMenuByPermissions(MOBILE_SUBPAGES, leadIdentity.permissions).map((page) => page.code),
    ).toEqual(MOBILE_SUBPAGES.map((page) => page.code));
    expect(
      filterMenuByPermissions(MOBILE_MENU, leadIdentity.permissions).map((tab) => tab.code),
    ).toEqual(['m.workbench', 'm.stock']);
  });

  it('S3-d 身份投影：演示操作员见查询三页 + 配件申请/故障上报（工人动作面）', () => {
    expect(
      filterMenuByPermissions(MOBILE_SUBPAGES, operatorIdentity.permissions).map((page) => page.code),
    ).toEqual(['m.parts', 'm.fault', 'm.progress', 'm.op-progress', 'm.mine']);
  });
});

describe('移动全量路由清单（标签 + 子页；main.tsx 装配数据）', () => {
  it('15 项：四标签在前、11 子页在后，路径唯一且在 /m 组', () => {
    expect(mobileRoutes).toHaveLength(15);
    expect(mobileRoutes.slice(0, 4).map((route) => route.code)).toEqual([
      'm.workbench',
      'm.report',
      'm.hours',
      'm.stock',
    ]);
    expect(mobileRoutes.slice(4).map((route) => route.code)).toEqual(
      MOBILE_SUBPAGES.map((page) => page.code),
    );
    const paths = mobileRoutes.map((route) => route.routePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith('/m')).toBe(true);
  });

  it('与桌面注册表不重叠（两导航面各自演进，路径/码不串）', () => {
    const desktopPaths = new Set(menuRoutes.map((route) => route.routePath));
    for (const route of mobileRoutes) {
      expect(desktopPaths.has(route.routePath)).toBe(false);
    }
  });
});
