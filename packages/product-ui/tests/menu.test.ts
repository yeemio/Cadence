import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSION, permissionCode } from '../src/permissions.js';
import type { AppModuleManifest } from '../src/manifest.js';
import {
  buildMenuTree,
  filterMenuByPermissions,
  flattenRoutes,
  toSidebarMenu,
} from '../src/menu.js';
import type { MenuNode } from '../src/menu.js';

const pc = permissionCode;

const tree: MenuNode[] = [
  { code: 'workbench', title: '工作台', routePath: '/' },
  {
    code: 'manufacturing',
    title: '制造运营',
    children: [
      {
        code: 'workorder',
        title: '工作令',
        routePath: '/workorders',
        permission: pc('workorder:access'),
      },
      {
        code: 'dispatch',
        title: '派工',
        routePath: '/dispatches',
        permission: pc('dispatch:access'),
      },
    ],
  },
  {
    code: 'system',
    title: '系统管理',
    children: [
      {
        code: 'system-user',
        title: '用户与权限',
        routePath: '/system/users',
        permission: pc('system:access'),
      },
      {
        code: 'system-session',
        title: '会话审计',
        routePath: '/system/sessions',
        permission: pc('system:access'),
        hideInMenu: true,
      },
    ],
  },
  {
    code: 'tools',
    title: '工具',
    children: [
      { code: 'tools-diag', title: '诊断', routePath: '/tools/diag', hideInMenu: true },
    ],
  },
  {
    code: 'legacy',
    title: '旧入口',
    hideInMenu: true,
    children: [{ code: 'legacy-a', title: '旧A', routePath: '/legacy/a' }],
  },
];

const operatorPermissions = [pc('workorder:access'), pc('dispatch:access')];
const adminPermissions = [ADMIN_PERMISSION];

describe('菜单 RBAC 过滤：精确权限码匹配', () => {
  it('持有精确码的节点可见，未持有的不可见', () => {
    const filtered = filterMenuByPermissions(tree, operatorPermissions);
    const manufacturing = filtered.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual([
      'workorder',
      'dispatch',
    ]);
    expect(filtered.some((node) => node.code === 'system')).toBe(false);
  });

  it('匹配是精确的：前缀码 / 超集码都不放行', () => {
    const byPrefix = filterMenuByPermissions(tree, [pc('workorder')]);
    expect(
      byPrefix.some((node) => node.children?.some((child) => child.code === 'workorder')),
    ).toBe(false);

    const byLongerCode = filterMenuByPermissions(tree, [pc('workorder:access:extra')]);
    expect(
      byLongerCode.some((node) => node.children?.some((child) => child.code === 'workorder')),
    ).toBe(false);

    const byOtherModule = filterMenuByPermissions(tree, [pc('dispatch:access')])
      .find((node) => node.code === 'manufacturing')
      ?.children?.map((child) => child.code);
    expect(byOtherModule).toEqual(['dispatch']);
  });

  it('未声明权限码的节点对空权限集也可见；hideInMenu 不影响权限过滤', () => {
    const filtered = filterMenuByPermissions(tree, []);
    expect(filtered.map((node) => node.code)).toEqual(['workbench', 'tools', 'legacy']);
    expect(filtered.find((node) => node.code === 'legacy')?.hideInMenu).toBe(true);
  });
});

describe('菜单 RBAC 过滤：空壳隐藏', () => {
  it('声明过子菜单但过滤后全不可见的父级整体隐藏', () => {
    // operator 不持有 system:access → system 两个子项全不可见 → 分组隐藏
    const filtered = filterMenuByPermissions(tree, operatorPermissions);
    expect(filtered.some((node) => node.code === 'system')).toBe(false);
  });

  it('子项部分可见时父级保留（只剔除不可见子项）', () => {
    const filtered = filterMenuByPermissions(tree, [pc('workorder:access')]);
    const manufacturing = filtered.find((node) => node.code === 'manufacturing');
    expect(manufacturing?.children?.map((child) => child.code)).toEqual(['workorder']);
  });
});

describe('菜单 RBAC 过滤：admin bypass', () => {
  it("持有 ADMIN_PERMISSION('*') 时全部可见、结构不变；无需持有任何具体码", () => {
    const filtered = filterMenuByPermissions(tree, adminPermissions);
    expect(filtered).toEqual(tree);
  });
});

describe('菜单投影：hideInMenu 只留路由不进侧栏', () => {
  it('hideInMenu 子项不出现在侧栏，但路由清单保留（守卫仍生效）', () => {
    const sidebar = toSidebarMenu(tree, adminPermissions);
    const system = sidebar.find((node) => node.code === 'system');
    expect(system?.children?.map((child) => child.code)).toEqual(['system-user']);

    const routes = flattenRoutes(tree);
    expect(routes.map((route) => route.routePath)).toContain('/system/sessions');
    expect(routes.find((route) => route.code === 'system-session')?.permission).toBe(
      pc('system:access'),
    );
  });

  it('子项全部 hideInMenu 的无路由分组在侧栏整体剔除，路由仍在', () => {
    const sidebar = toSidebarMenu(tree, adminPermissions);
    expect(sidebar.some((node) => node.code === 'tools')).toBe(false);
    expect(flattenRoutes(tree).some((route) => route.routePath === '/tools/diag')).toBe(true);
  });

  it('hideInMenu 父级的可见子级保序提升到父级位置', () => {
    const sidebar = toSidebarMenu(tree, adminPermissions);
    expect(sidebar.some((node) => node.code === 'legacy')).toBe(false);
    expect(sidebar.some((node) => node.code === 'legacy-a')).toBe(true);
  });

  it('侧栏投影建立在权限过滤之上（admin 与 operator 看到不同分组）', () => {
    const operatorSidebar = toSidebarMenu(tree, operatorPermissions);
    expect(operatorSidebar.map((node) => node.code)).toEqual([
      'workbench',
      'manufacturing',
      'legacy-a',
    ]);
    const adminSidebar = toSidebarMenu(tree, adminPermissions);
    expect(adminSidebar.map((node) => node.code)).toEqual([
      'workbench',
      'manufacturing',
      'system',
      'legacy-a',
    ]);
  });
});

describe('flattenRoutes：全量路由清单', () => {
  it('包含所有带路由节点（含 hideInMenu），权限码随行，不做权限过滤', () => {
    const routes = flattenRoutes(tree);
    expect(routes.map((route) => route.routePath)).toEqual([
      '/',
      '/workorders',
      '/dispatches',
      '/system/users',
      '/system/sessions',
      '/tools/diag',
      '/legacy/a',
    ]);
    expect(routes.every((route) => route.routePath.startsWith('/'))).toBe(true);
  });
});

describe('buildMenuTree：manifest 注册表投影', () => {
  const manifests: readonly AppModuleManifest[] = [
    {
      code: 'workbench',
      routePath: '/',
      marketCategory: 'base',
      entryPoint: 'workbench/index.tsx',
      menuConfig: { title: '工作台', icon: 'workbench' },
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
          isPro: true,
          menuConfig: { title: '工作令', permission: pc('workorder:access') },
        },
      ],
    },
  ];

  it('字段 1:1 保序投影；entryPoint/isPro/marketCategory 不入菜单节点', () => {
    const menuTree = buildMenuTree(manifests);
    expect(menuTree).toEqual([
      { code: 'workbench', title: '工作台', routePath: '/', icon: 'workbench' },
      {
        code: 'manufacturing',
        title: '制造运营',
        children: [
          {
            code: 'workorder',
            title: '工作令',
            routePath: '/workorders',
            permission: pc('workorder:access'),
          },
        ],
      },
    ]);
  });
});
