/**
 * 菜单配置读取门禁接缝测试（fix-wave-2 D-12 总控裁定追加；node 纯逻辑 +
 * window stub，体例先例=src/pages/workbench/WorkbenchPage.test.ts）：
 * canFetchMenuConfigs = useMergedMenu 内 configsQuery enabled 的唯一决策点。
 * 受限 session（种子访客空权限 / 无 menu:read 的 approver、viewer）返回
 * false ⇒ 不发起 GET /menu-config/configs（此前 403 后才回落），fail-open
 * 静态树语义不变（enabled=false ⇒ data undefined ⇒ configNodes null）。
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

// stub 之后动态 import（useMenuConfig → menuConfigApi → apiClient 模块级读 window）
const { canFetchMenuConfigs } = await import('./useMenuConfig.js');

describe('canFetchMenuConfigs（D-12：configsQuery enabled 的唯一决策点）', () => {
  it('会话权限未就绪（undefined）→ false：不发起请求（静态树原样，不误报）', () => {
    expect(canFetchMenuConfigs(undefined)).toBe(false);
  });

  it('空权限（viewer/种子访客实态）→ false：不发 configs 请求、零 403', () => {
    expect(canFetchMenuConfigs([])).toBe(false);
  });

  it('仅 menu:write（管理写码≠读码）→ false：精确匹配不放行', () => {
    expect(canFetchMenuConfigs(['menu:write'])).toBe(false);
  });

  it("持有 menu:read → true：与后端 GET /menu-config/configs 门禁同码放行", () => {
    expect(canFetchMenuConfigs(['menu:read', 'role:read'])).toBe(true);
  });

  it("admin 通配 '*' → true（bypass，与侧栏菜单投影同语义）", () => {
    expect(canFetchMenuConfigs([ADMIN_PERMISSION])).toBe(true);
  });
});
