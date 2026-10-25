/**
 * 菜单配置合并（T1 #98/99"前端启动合并"）测试：交集/顺序/覆盖语义、
 * 未知码跳过、缺失隐藏、空集/停用回落、嵌套子层、叶子声明 children 的
 * 忽略、selectMenuConfigNodes 的激活/空集判定。
 */
import { describe, expect, it } from 'vitest';
import { permissionCode } from '../src/permissions.js';
import { mergeMenuConfig, selectMenuConfigNodes } from '../src/menu-merge.js';
import type { MenuConfigSetView, MenuConfigNodeView } from '../src/menu-merge.js';
import type { MenuNode } from '../src/menu.js';

const pc = permissionCode;

const STATIC_TREE: MenuNode[] = [
  { code: 'workbench', title: '工作台', routePath: '/', permission: pc('workbench:read') },
  {
    code: 'manufacturing',
    title: '制造运营',
    children: [
      { code: 'workorder', title: '工作令', routePath: '/workorders', permission: pc('workorder:read') },
      { code: 'dispatch', title: '派工', routePath: '/dispatches', permission: pc('dispatch:read') },
      { code: 'scan', title: '扫码', routePath: '/scan', permission: pc('scan:read') },
    ],
  },
  { code: 'system', title: '系统管理', children: [{ code: 'system-user', title: '用户', routePath: '/system/users' }] },
];

describe('mergeMenuConfig（配置树叠加静态树）', () => {
  it('交集 + config 序即渲染序 + title 覆盖；缺失的 static 节点隐藏', () => {
    const merged = mergeMenuConfig(STATIC_TREE, [
      { code: 'manufacturing', title: '生产', children: [{ code: 'dispatch', title: '派工单' }] },
      { code: 'workbench', title: '我的工作台' },
    ]);
    expect(merged.map((node) => node.code)).toEqual(['manufacturing', 'workbench']); // config 序
    expect(merged[0]?.title).toBe('生产'); // title 覆盖
    expect(merged[0]?.children?.map((child) => child.code)).toEqual(['dispatch']); // scan/workorder 隐藏
    expect(merged[0]?.children?.[0]?.title).toBe('派工单');
    expect(merged[1]?.title).toBe('我的工作台');
    // 静态字段保形：permission/routePath 以装配态为准（不接受配置覆盖）
    expect(merged[1]?.permission).toBe('workbench:read');
    expect(merged[1]?.routePath).toBe('/');
    expect(merged[0]?.children?.[0]?.permission).toBe('dispatch:read');
  });

  it('未知配置码跳过（无装配绑定即无页面）；permission/routePath 配置值被忽略', () => {
    const merged = mergeMenuConfig(STATIC_TREE, [
      { code: 'ghost-page', title: '幽灵', routePath: '/ghost', permission: 'hack:all' },
      {
        code: 'workbench',
        title: '工作台',
        routePath: '/hijack',
        permission: 'hack:read',
      },
    ]);
    expect(merged.map((node) => node.code)).toEqual(['workbench']);
    expect(merged[0]?.routePath).toBe('/'); // 装配绑定优先
    expect(merged[0]?.permission).toBe('workbench:read');
  });

  it('hideInMenu/icon 覆盖生效；config 对叶子声明 children 按叶子处理', () => {
    const merged = mergeMenuConfig(STATIC_TREE, [
      { code: 'workbench', title: '工作台', icon: 'star', hideInMenu: true, children: [{ code: 'x', title: 'X' }] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.hideInMenu).toBe(true);
    expect(merged[0]?.icon).toBe('star');
    expect(merged[0]?.children).toBeUndefined(); // 静态是叶子——配置子层不无中生有
  });

  it('嵌套分组：子层交集递归；分组不在配置 = 整组隐藏', () => {
    const merged = mergeMenuConfig(STATIC_TREE, [
      { code: 'system', title: '系统', children: [{ code: 'system-user', title: '用户管理' }] },
    ]);
    expect(merged.map((node) => node.code)).toEqual(['system']);
    expect(merged[0]?.children?.[0]?.title).toBe('用户管理');
  });

  it('空配置数组 = 空输出（可见性清空由调用方在配置面提示，合并层不回落）', () => {
    expect(mergeMenuConfig(STATIC_TREE, [])).toEqual([]);
  });

  it('静态树为空 = 空（配置不能无中生有）', () => {
    expect(mergeMenuConfig([], [{ code: 'workbench', title: '工作台' }])).toEqual([]);
  });
});

describe('selectMenuConfigNodes（配置集选中判定）', () => {
  function set(code: string, nodes: MenuConfigNodeView[], active = true): MenuConfigSetView {
    return { id: `id-${code}`, code, name: code, nodes, active, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' };
  }

  it('active 且 code 匹配且非空 → 返回节点树；停用/缺失/空集 → null（fail-open 回落静态）', () => {
    const configs = [
      set('default', [{ code: 'workbench', title: '工作台' }]),
      set('mobile', [{ code: 'm.workbench', title: '工作台' }], false),
      set('empty', []),
    ];
    expect(selectMenuConfigNodes(configs, 'default')).toEqual([{ code: 'workbench', title: '工作台' }]);
    expect(selectMenuConfigNodes(configs, 'mobile')).toBeNull(); // 停用
    expect(selectMenuConfigNodes(configs, 'empty')).toBeNull(); // 空集 = 占位
    expect(selectMenuConfigNodes(configs, 'ghost')).toBeNull(); // 缺失
  });
});
