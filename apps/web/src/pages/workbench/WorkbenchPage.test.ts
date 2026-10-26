/**
 * 工作台页权限投影接缝测试（fix-wave-2 D-12/D-6；node 纯逻辑 + fetch/window
 * stub，体例先例=tests/overview-api.test.ts 与 colocated 先例
 * src/pages/costing/timeFormat.test.ts）：
 *
 * - canAccessWorkbench = 页面 summary/todos 两查询 enabled 的唯一决策点：
 *   受限 session（种子访客空权限 / 无 workbench:read 的 approver）返回
 *   false ⇒ 不发起任何 /workbench/* 请求（D-12：菜单可见性=接口可达性对齐
 *   到首页数据请求）；
 * - D-6 兜底数据链：请求已发出而 403（如服务端策略与会话投影短暂不一致）
 *   ⇒ ApiError(403) 抛出且不清会话——页面 isError 分支据此渲染显式无权限
 *   报错，卡片不停在"正在加载…"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PERMISSION,
  TOKEN_SESSION_STORAGE_KEY,
  createBrowserTokenSessionStore,
} from '@smes/product-ui';

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

// stub 之后动态 import（页面 → workbenchApi → apiClient 模块级读 window）
const { canAccessWorkbench } = await import('./WorkbenchPage.js');
const { fetchWorkbenchSummary } = await import('../../data/workbenchApi.js');
const { ApiError } = await import('../../data/apiClient.js');

describe('canAccessWorkbench（D-12：页面数据请求 enabled 的唯一决策点）', () => {
  it('会话权限未就绪（undefined）→ false：不发起请求、不误报无权限', () => {
    expect(canAccessWorkbench(undefined)).toBe(false);
  });

  it('空权限（viewer/种子访客实态）→ false：summary/todos 两查询均不放行、零请求', () => {
    expect(canAccessWorkbench([])).toBe(false);
  });

  it('仅持无关码（approver 缺 workbench:read 的实态）→ false：精确匹配不放行', () => {
    expect(canAccessWorkbench(['approval:read', 'workorder:read'])).toBe(false);
  });

  it('持有 workbench:read → true：与后端 GET /workbench/* 门禁同码放行', () => {
    expect(canAccessWorkbench(['workbench:read', 'approval:read'])).toBe(true);
  });

  it("admin 通配 '*' → true（bypass，与侧栏菜单投影同语义）", () => {
    expect(canAccessWorkbench([ADMIN_PERMISSION])).toBe(true);
  });
});

describe('D-6 兜底：请求已发出而 403 → 显式终态的数据链语义', () => {
  beforeEach(() => {
    storageBacking.clear();
    createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
      userId: 'user-viewer' as never,
      tenantId: 'tenant-a' as never,
      displayName: 'viewer',
      permissions: [],
      token: 'token-viewer-abc',
      expiresAt: '2026-10-26T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchWorkbenchSummary 遇 403 → 抛 ApiError(403) 且不清会话（isError 分支据此显式报错）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: '租户 tenant-a 内用户无权限码 workbench:read' }),
      };
    });

    const error: unknown = await fetchWorkbenchSummary().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(calls).toEqual(['/workbench/summary']);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(storageBacking.size).toBeGreaterThan(0); // 403 ≠ 401：不清会话、不跳登录
  });
});
