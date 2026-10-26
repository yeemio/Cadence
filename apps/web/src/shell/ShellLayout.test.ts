/**
 * 顶栏未读计数门禁接缝测试（fix-wave-2 D-12 总控裁定追加；node 纯逻辑 +
 * window stub，体例先例=src/pages/workbench/WorkbenchPage.test.ts）：
 * canPollUnreadCount = ShellBody 内 unreadQuery enabled 的唯一决策点。
 * 受限 session（种子访客空权限 / 无 notification:read）返回 false ⇒ 不发起
 * GET /notifications/unread-count（此前 403 后才不渲染铃铛），fail-open
 * 语义不变（enabled=false ⇒ data undefined ⇒ showBell=false 不渲染）。
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

// stub 之后动态 import（ShellLayout → notificationsApi/menuConfigApi → apiClient）
const { canPollUnreadCount } = await import('./ShellLayout.js');

describe('canPollUnreadCount（D-12：unreadQuery enabled 的唯一决策点）', () => {
  it('会话权限未就绪（undefined）→ false：不发起请求（就绪后再判定）', () => {
    expect(canPollUnreadCount(undefined)).toBe(false);
  });

  it('空权限（viewer/种子访客实态）→ false：不发 unread-count 请求，铃铛不渲染', () => {
    expect(canPollUnreadCount([])).toBe(false);
  });

  it('仅无关码（approver 实态无 notification:read）→ false：精确匹配不放行', () => {
    expect(canPollUnreadCount(['approval:read', 'workbench:read'])).toBe(false);
  });

  it('持有 notification:read → true：与后端 GET /notifications/unread-count 门禁同码放行', () => {
    expect(canPollUnreadCount(['notification:read'])).toBe(true);
  });

  it("admin 通配 '*' → true（bypass，与侧栏菜单投影同语义）", () => {
    expect(canPollUnreadCount([ADMIN_PERMISSION])).toBe(true);
  });
});
