/**
 * 演示应用注册表 → 菜单树与路由清单（装配数据层，纯数据无浏览器依赖）。
 *
 * manifest 形状见 @smes/product-ui（ADR-0009 参照字段集）；
 * 词汇纪律 ADR-0010：模块代码用离散制造通用词（workbench/workorder/dispatch/system）。
 */
import { buildMenuTree, flattenRoutes, permissionCode, SCAN_READ } from '@smes/product-ui';
import type { AppModuleManifest } from '@smes/product-ui';

const pc = permissionCode;

export const DEMO_MANIFESTS: readonly AppModuleManifest[] = [
  {
    code: 'workbench',
    routePath: '/',
    marketCategory: 'base',
    entryPoint: 'workbench/index.tsx',
    // M1 增量 4-I：工作台页升级为真实页面（本人待办 + source 计数）；
    // 菜单可见性挂 workbench:read（与后端 GET /workbench/* 门禁同码）。
    menuConfig: { title: '工作台', icon: 'workbench', permission: pc('workbench:read') },
  },
  {
    code: 'masterdata',
    marketCategory: 'base',
    menuConfig: { title: '基础数据' },
    children: [
      {
        code: 'masterdata-item',
        routePath: '/masterdata/items',
        marketCategory: 'base',
        entryPoint: 'masterdata/items.tsx',
        menuConfig: { title: '物品', permission: pc('item:read') },
      },
      {
        code: 'masterdata-resource',
        routePath: '/masterdata/resources',
        marketCategory: 'base',
        entryPoint: 'masterdata/resources.tsx',
        menuConfig: { title: '资源', permission: pc('resource:read') },
      },
    ],
  },
  {
    code: 'manufacturing',
    marketCategory: 'base',
    menuConfig: { title: '制造运营' },
    children: [
      {
        code: 'workorder',
        routePath: '/workorders',
        marketCategory: 'process',
        entryPoint: 'workorder/index.tsx',
        menuConfig: { title: '工作令', permission: pc('workorder:access') },
      },
      {
        code: 'dispatch',
        routePath: '/dispatches',
        marketCategory: 'process',
        entryPoint: 'dispatch/index.tsx',
        menuConfig: { title: '派工', permission: pc('dispatch:access') },
      },
      {
        code: 'scan',
        routePath: '/scan',
        marketCategory: 'base',
        entryPoint: 'scan/index.tsx',
        // M1 收尾波-②：真实扫码页（三档降级链）。扫码是跨环节的通用数据
        // 采集动作，故 marketCategory 记 base、挂制造运营分组展示。
        menuConfig: { title: '扫码', icon: 'scan', permission: SCAN_READ },
      },
      // M5 首波：预研期的扫码报工页（scan-report）升级为移动组 m.report
      // （/m/report，底部标签导航——见 mobile.ts）；桌面菜单不再保留预研条目。
    ],
  },
  {
    code: 'system',
    marketCategory: 'base',
    menuConfig: { title: '系统管理' },
    children: [
      {
        code: 'system-user',
        routePath: '/system/users',
        marketCategory: 'base',
        entryPoint: 'org/users.tsx',
        menuConfig: { title: '用户与角色', permission: pc('user:read') },
      },
      {
        code: 'system-role',
        routePath: '/system/roles',
        marketCategory: 'base',
        entryPoint: 'org/roles.tsx',
        menuConfig: { title: '角色与授权', permission: pc('role:read') },
      },
      {
        code: 'system-session',
        routePath: '/system/sessions',
        marketCategory: 'base',
        menuConfig: {
          title: '会话审计',
          permission: pc('system:access'),
          hideInMenu: true,
        },
      },
    ],
  },
];

export const menuTree = buildMenuTree(DEMO_MANIFESTS);

/** 全量路由清单（含 hideInMenu 项；权限守卫在路由层按 permission 码执行）。 */
export const menuRoutes = flattenRoutes(menuTree);
