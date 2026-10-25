/**
 * 工程壳装配层数据的冒烟测试（纯数据，node 环境）：
 * 证明演示注册表经 product-ui 投影后，四条 RBAC 语义在真实装配数据上成立。
 * M1 增量 4-I：workbench 挂 workbench:read、新增基础数据分组（item/resource 两页）。
 * M1 收尾波-②：制造运营组新增扫码页（scan 挂 scan:read；operator 身份
 * 已加 scan:read——权限清单直接取自 DEMO_IDENTITIES，防测试与身份表漂移）。
 * M5 预研：制造运营组曾新增扫码报工页（report:write → report:submit）。
 * M5 首波：预研扫码报工页升级为移动组 m.report（/m/report，见 mobile.test.ts），
 * 桌面注册表不再保留该条目。
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
  it('路由清单：全量、唯一、含 hideInMenu 项（会话审计）与扫码页', () => {
    const paths = menuRoutes.map((route) => route.routePath);
    expect(paths).toEqual([
      '/',
      '/masterdata/items',
      '/masterdata/resources',
      '/workorders',
      '/dispatches',
      '/scan',
      '/system/users',
      '/system/roles',
      '/system/sessions',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('扫码页权限：菜单挂 scan:read；operator 身份持有 scan:read（M1 收尾波-②授予）', () => {
    const scanRoute = menuRoutes.find((route) => route.code === 'scan');
    expect(scanRoute?.permission).toBe(permissionCode('scan:read'));
    expect(operatorPermissions).toContain(permissionCode('scan:read'));
  });

  it('侧栏：operator（真实身份权限）见工作台 + 基础数据-物品 + 制造运营（含扫码）', () => {
    const sidebar = toSidebarMenu(menuTree, operatorPermissions);
    expect(sidebar.map((node) => node.code)).toEqual(['workbench', 'masterdata', 'manufacturing']);
    const masterdata = sidebar.find((node) => node.code === 'masterdata');
    expect(masterdata?.children?.map((child) => child.code)).toEqual(['masterdata-item']); // 无 resource:read
    const manufacturing = sidebar.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual([
      'workorder',
      'dispatch',
      'scan', // operator 持 scan:read（收尾波-②起）
      // M5 首波：scan-report 升级为移动组 m.report（/m/report），桌面菜单移除
    ]);
  });

  it('侧栏：无 scan:read（也无工单/派工码）的角色不见制造运营组——扫码页随组隐藏', () => {
    const sidebar = toSidebarMenu(menuTree, [
      permissionCode('user:read'),
      permissionCode('role:read'),
      permissionCode('workbench:read'),
      permissionCode('item:read'),
    ]);
    // workorder:access / dispatch:access / scan:read 三码全缺 → 制造运营组空壳隐藏
    expect(sidebar.map((node) => node.code)).toEqual(['workbench', 'masterdata', 'system']);
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

  it('侧栏：admin 全量可见，但 hideInMenu 的会话审计不进侧栏', () => {
    const sidebar = toSidebarMenu(menuTree, [ADMIN_PERMISSION]);
    expect(sidebar.map((node) => node.code)).toEqual(['workbench', 'masterdata', 'manufacturing', 'system']);
    const masterdata = sidebar.find((node) => node.code === 'masterdata');
    expect(masterdata?.children?.map((child) => child.code)).toEqual([
      'masterdata-item',
      'masterdata-resource',
    ]);
    const manufacturing = sidebar.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual([
      'workorder',
      'dispatch',
      'scan',
    ]);
    const sidebarTitles = JSON.stringify(sidebar);
    expect(sidebarTitles).not.toContain('会话审计');
  });
});
