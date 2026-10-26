/**
 * 移动页数据请求门禁接缝测试（fix-wave-2 D-12/D-6 移动收尾；node 纯逻辑 +
 * fetch/window stub，体例先例=src/pages/workbench/WorkbenchPage.test.ts）：
 *
 * - canAccessMobileData = m/ 各页进页自动查询 enabled 的唯一决策点（经
 *   useMobileDataAccess 包装 usePermissions）——未就绪/无权限（种子访客空
 *   权限实态）返回 false ⇒ 不发起任何请求（D-12：菜单可见性=接口可达性对齐
 *   到移动页数据请求）；
 * - 门禁码按后端 GET 端点实码（非 mobile.ts 导航注册码）：m.verify 等四页
 *   导航挂动作码、队列 GET 实码为 read 码——动作码不折算读码；
 * - D-6 兜底数据链：/workbench/todos 请求已发出而 403（如服务端策略与会话
 *   投影短暂不一致）⇒ ApiError(403) 抛出且不清会话——页面 isError 分支据此
 *   渲染显式报错，卡片不停在"正在加载…"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PERMISSION,
  HOURS_READ,
  INSPECTION_JUDGE,
  INSPECTION_READ,
  PARTS_APPROVE,
  PARTS_READ,
  REPORT_READ,
  STOCK_READ,
  STOCKTAKE_READ,
  STOCKTAKE_RECORD,
  TOKEN_SESSION_STORAGE_KEY,
  WORKBENCH_READ,
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

// stub 之后动态 import（页面 → 数据层 → apiClient 模块级读 window）
const { canAccessMobileData } = await import('./pageAccess.js');
const { listMyTodos } = await import('../../data/workbenchApi.js');
const { ApiError } = await import('../../data/apiClient.js');

/** m/ 各页进页自动查询的门禁面（页 → 门禁码 = 后端 GET 端点 @RequirePermission 实码）。 */
const MOBILE_DATA_GATES: ReadonlyArray<{
  readonly page: string;
  readonly gate: Parameters<typeof canAccessMobileData>[1];
  readonly endpointCode: string;
}> = [
  { page: '/m 工作台待办', gate: WORKBENCH_READ, endpointCode: 'workbench:read' },
  { page: '/m/hours 我的工时', gate: HOURS_READ, endpointCode: 'hours:read' },
  { page: '/m/stock 库存查询', gate: STOCK_READ, endpointCode: 'stock:read' },
  { page: '/m/mine 我的报工', gate: REPORT_READ, endpointCode: 'report:read' },
  { page: '/m/verify 待核队列', gate: REPORT_READ, endpointCode: 'report:read' },
  { page: '/m/inspection 待检队列', gate: INSPECTION_READ, endpointCode: 'inspection:read' },
  { page: '/m/parts-approval 待审队列', gate: PARTS_READ, endpointCode: 'parts:read' },
  { page: '/m/stocktake 台账/详情', gate: STOCKTAKE_READ, endpointCode: 'stocktake:read' },
];

describe('canAccessMobileData（D-12：m/ 各页自动查询 enabled 的唯一决策点）', () => {
  it('会话权限未就绪（undefined）→ false：不发起请求、不误报', () => {
    expect(canAccessMobileData(undefined, WORKBENCH_READ)).toBe(false);
  });

  it('空权限（viewer/种子访客实态）→ false：全部移动数据门禁零放行、零请求', () => {
    for (const { gate } of MOBILE_DATA_GATES) {
      expect(canAccessMobileData([], gate)).toBe(false);
    }
  });

  it('仅持无关码 → false：精确匹配不放行', () => {
    expect(canAccessMobileData(['approval:read', 'workorder:read'], WORKBENCH_READ)).toBe(false);
  });

  it('持对应端点码 → true：门禁码与后端 GET @RequirePermission 同码放行（正常态）', () => {
    for (const { gate, endpointCode } of MOBILE_DATA_GATES) {
      expect(canAccessMobileData([endpointCode, 'approval:read'], gate)).toBe(true);
    }
  });

  it("admin 通配 '*' → true（bypass，与底部导航/快捷入口投影同语义）", () => {
    expect(canAccessMobileData([ADMIN_PERMISSION], WORKBENCH_READ)).toBe(true);
  });

  it('动作码不折算读码：导航注册码 ≠ 队列 GET 端点实码时不放行', () => {
    // m.verify 导航挂 report:verify、m.inspection 挂 inspection:judge、
    // m.parts-approval 挂 parts:approve、m.stocktake 挂 stocktake:record——
    // 四页队列/台账 GET 的 @RequirePermission 实码均为各自 read 码。
    expect(canAccessMobileData(['report:verify'], REPORT_READ)).toBe(false);
    expect(canAccessMobileData([INSPECTION_JUDGE], INSPECTION_READ)).toBe(false);
    expect(canAccessMobileData([PARTS_APPROVE], PARTS_READ)).toBe(false);
    expect(canAccessMobileData([STOCKTAKE_RECORD], STOCKTAKE_READ)).toBe(false);
  });
});

describe('D-6 兜底：/workbench/todos 已发出而 403 → 显式终态的数据链语义', () => {
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

  it('listMyTodos 遇 403 → 抛 ApiError(403) 且不清会话（isError 分支据此显式报错）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: '租户 tenant-a 内用户无权限码 workbench:read' }),
      };
    });

    const error: unknown = await listMyTodos().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(calls).toEqual(['/workbench/todos']);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(storageBacking.size).toBeGreaterThan(0); // 403 ≠ 401：不清会话、不跳登录
  });
});
