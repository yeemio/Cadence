/**
 * 运营总览页权限投影接缝测试（fix-wave-2 D-12；node 纯逻辑 + window stub，
 * 体例先例=tests/overview-api.test.ts）：overviewDeniedSources = 页面
 * fetchOverviewView 查询 enabled 与"无权限"终态文案的唯一决策点。
 *
 * 页面是四码一体的全量聚合（部分渲染易误导，取舍见 data/overviewApi.ts）：
 * 任一源缺权限即整页不发起请求——受限 session（approver 仅 workbench:read /
 * viewer 空权限）实测得到非空缺失清单 ⇒ 零请求（D-12：菜单可见性=接口
 * 可达性对齐到首页数据请求），缺失源与权限码同时是终态文案的数据源。
 */
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSION } from '@smes/product-ui';

// ---- window / localStorage stub（apiClient 模块加载即读 window.localStorage） ----
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key) => storageBacking.get(key) ?? null,
  setItem: (key, value) => void storageBacking.set(key, value),
  removeItem: (key) => void storageBacking.delete(key),
  clear: () => void storageBacking.clear(),
  key: () => null,
  get length() {
    return storageBacking.size;
  },
};
vi.stubGlobal('window', {
  localStorage: localStorageStub,
  location: { pathname: '/', assign: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
});

// stub 之后动态 import（页面 → overviewApi → apiClient 模块级读 window）
const { overviewDeniedSources } = await import('./IndexPage.js');

const FOUR_KEYS = ['todo', 'delivery', 'inspection', 'machining'] as const;

describe('overviewDeniedSources（D-12：整页数据请求 enabled 的唯一决策点）', () => {
  it('会话权限未就绪（undefined）→ null：不发起请求、不误报无权限', () => {
    expect(overviewDeniedSources(undefined)).toBeNull();
  });

  it('空权限（viewer/种子访客实态）→ 四源全缺失：整页零请求，终态列出全部源', () => {
    const denied = overviewDeniedSources([]);
    expect(denied?.map((source) => source.key)).toEqual([...FOUR_KEYS]);
  });

  it('仅 workbench:read（approver 实态）→ 缺交付态势/质检汇总/机加工时：整页零请求', () => {
    const denied = overviewDeniedSources(['workbench:read']);
    expect(denied?.map((source) => source.key)).toEqual([
      'delivery',
      'inspection',
      'machining',
    ]);
  });

  it('缺失项带标签与权限码（终态文案"交付态势（workorder:read）"的数据源）', () => {
    const denied = overviewDeniedSources(['workbench:read']) ?? [];
    expect(denied[0]).toMatchObject({
      key: 'delivery',
      label: '交付态势',
      permission: 'workorder:read',
    });
  });

  it('四码齐备 → 空数组：放行 fetchOverviewView（四 GET 照常发起）', () => {
    expect(
      overviewDeniedSources([
        'workbench:read',
        'workorder:read',
        'inspection:read',
        'hours:read',
      ]),
    ).toEqual([]);
  });

  it("admin 通配 '*' → 空数组（bypass，与侧栏菜单投影同语义）", () => {
    expect(overviewDeniedSources([ADMIN_PERMISSION])).toEqual([]);
  });
});
