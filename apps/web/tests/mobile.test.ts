/**
 * 移动端注册表冒烟测试（M5 首波，纯数据）：路由清单/权限码/底部导航
 * RBAC 投影。注册表见 src/mobile.ts（复用 MenuNode + filterMenuByPermissions
 * ——投影语义由 product-ui menu 语义保证，此处钉装配数据本身）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION,
  DEMO_IDENTITIES,
  filterMenuByPermissions,
  permissionCode,
} from '@smes/product-ui';
import { MOBILE_MENU, mobileRoutes } from '../src/mobile.js';
import { menuRoutes } from '../src/menu.js';

const operatorIdentity = DEMO_IDENTITIES.find((identity) => identity.email === 'operator@demo.local');
if (operatorIdentity === undefined) throw new Error('fixture: operator identity missing');

describe('移动注册表（四页装配数据）', () => {
  it('路由清单：m.workbench / m.report / m.hours / m.stock 四项，路径唯一且在 /m 组', () => {
    expect(mobileRoutes.map((route) => route.code)).toEqual([
      'm.workbench',
      'm.report',
      'm.hours',
      'm.stock',
    ]);
    expect(mobileRoutes.map((route) => route.routePath)).toEqual([
      '/m',
      '/m/report',
      '/m/hours',
      '/m/stock',
    ]);
    const paths = mobileRoutes.map((route) => route.routePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith('/m')).toBe(true);
  });

  it('权限码与各模块后端端点一一对应（镜像逻辑归各模块 API 的呈现口径）', () => {
    const byCode = new Map(mobileRoutes.map((route) => [route.code, route.permission]));
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

  it('与桌面注册表不重叠（两导航面各自演进，路径/码不串）', () => {
    const desktopPaths = new Set(menuRoutes.map((route) => route.routePath));
    for (const route of mobileRoutes) {
      expect(desktopPaths.has(route.routePath)).toBe(false);
    }
  });
});
