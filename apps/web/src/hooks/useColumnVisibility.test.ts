/**
 * 列显隐纯逻辑接缝测试（fix-wave-6 6b-3，A14 / RREQ-INT-032；node 纯逻辑 +
 * window stub，体例先例 = src/shell/useMenuConfig.test.ts）：
 * toggleHiddenProps / visibleColumnsOf = useColumnVisibility 的列过滤与切换
 * 纯函数——语义锚定：勾选=隐藏追加（保序去重）、取消=恢复；过滤保持列定义
 * 原序；空数组 = 全显（与"从未保存"在服务端由行缺位区分，前端两态同形）。
 */
import { describe, expect, it, vi } from 'vitest';

// ---- window / localStorage stub（columnPreferencesApi → apiClient 模块级读 window） ----
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

// stub 之后动态 import（useColumnVisibility → columnPreferencesApi → apiClient 模块级读 window）
const { toggleHiddenProps, visibleColumnsOf, SUBMIT_DEBOUNCE_MS } = await import(
  './useColumnVisibility.js'
);

const COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'kind', label: '类别' },
  { key: 'quantity', label: '数量' },
] as const;

describe('toggleHiddenProps（勾选切换纯函数）', () => {
  it('未隐藏列勾选 → 追加（保序）；已隐藏列勾选 → 移除（恢复显示）', () => {
    expect(toggleHiddenProps([], 'kind')).toEqual(['kind']);
    expect(toggleHiddenProps(['id'], 'kind')).toEqual(['id', 'kind']);
    expect(toggleHiddenProps(['id', 'kind'], 'id')).toEqual(['kind']);
    expect(toggleHiddenProps(['kind'], 'kind')).toEqual([]);
  });

  it('toggle 对合：同键连续两次回到原状（勾选→取消）', () => {
    const once = toggleHiddenProps([], 'id');
    expect(once).toEqual(['id']);
    const twice = toggleHiddenProps(once, 'id');
    expect(twice).toEqual([]);
  });
});

describe('visibleColumnsOf（可见列过滤）', () => {
  it('隐藏列剔除、其余保持列定义原序', () => {
    expect(visibleColumnsOf(COLUMNS, ['kind'])).toEqual([
      { key: 'id', label: 'id' },
      { key: 'quantity', label: '数量' },
    ]);
    expect(visibleColumnsOf(COLUMNS, []).map((column) => column.key)).toEqual([
      'id',
      'kind',
      'quantity',
    ]);
  });

  it('空数组与从未保存（服务端缺位→前端空集）同形：均全显——两态区分由服务端行缺位承载', () => {
    expect(visibleColumnsOf(COLUMNS, [])).toHaveLength(3);
  });

  it('偏好中的陈旧键（列定义已删）静默忽略', () => {
    expect(visibleColumnsOf(COLUMNS, ['ghost', 'id'])).toEqual([
      { key: 'kind', label: '类别' },
      { key: 'quantity', label: '数量' },
    ]);
  });
});

describe('防抖窗口常量（源文档 §2.1.5 口径）', () => {
  it('SUBMIT_DEBOUNCE_MS = 300ms', () => {
    expect(SUBMIT_DEBOUNCE_MS).toBe(300);
  });
});
