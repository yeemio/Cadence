/**
 * 运营总览数据层接缝测试（T 波 #1，node 纯逻辑 + fetch/window stub）：钉住
 * overviewApi → apiClient → 四源端点的确切 HTTP 形状与"四源解析+聚合"链路：
 * - GET /workbench/summary、/workorder/delivery-situation、/inspection/summary、
 *   /hours/machining/stats 四请求并行、Bearer 注入；
 * - 响应经 product-ui overview-views 解析（坏形状抛 OverviewViewsError）；
 * - 任一源 HTTP 失败 → 聚合整体失败（ApiError 携状态）。
 * 真实落库由容器 e2e 实证（不在本文件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_SESSION_STORAGE_KEY, createBrowserTokenSessionStore } from '@smes/product-ui';

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

const { fetchOverviewSources, fetchOverviewView } = await import('../src/data/overviewApi.js');

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: ((url: string) => Promise<unknown>) | null = null;

/** 按 URL 分发响应体（四端点各配各的实态形状）。 */
function respondByRoute(routes: Record<string, unknown>, statusOf?: (url: string) => number): void {
  responder = async (url) => {
    const path = url.split('?')[0] ?? url;
    if (!(path in routes)) throw new TypeError(`fetch 未配置响应：${path}`);
    const status = statusOf?.(path) ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => routes[path] };
  };
}

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: 'user-ops' as never,
    tenantId: 'tenant-ops' as never,
    displayName: 'ops',
    permissions: [],
    token: 'token-ops-abc',
    expiresAt: '2026-10-26T00:00:00.000Z',
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder(url) as Promise<Response>;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const workbenchBody = {
  user: 'user-ops',
  openTotal: 5,
  bySource: [
    { source: 'inspection', open: 3 },
    { source: 'workorder', open: 2 },
  ],
};

const deliveryBody = {
  orders: [
    {
      workOrderId: 'wo-0002',
      projectName: 'B 项目',
      state: 'in_progress',
      plannedDeliveryAt: '2026-10-20T00:00:00.000Z',
      daysToDelivery: -5,
      riskLevel: 'overdue',
    },
    {
      workOrderId: 'wo-0001',
      projectName: 'A 项目',
      state: 'not_started',
      plannedDeliveryAt: '2026-10-28T00:00:00.000Z',
      daysToDelivery: 3,
      riskLevel: 'at_risk',
    },
  ],
  distribution: { not_started: 1, in_progress: 1 },
  generatedAt: '2026-10-25T02:00:00.000Z',
};

const inspectionBody = {
  pendingCount: 4,
  passedCount: 10,
  failedCount: 2,
  closedCount: 1,
  judgedCount: 13,
  passRate: 0.7692,
  nonconformOpenCount: 2,
  nonconformClosedCount: 0,
  overdueCount: 1,
  byKind: [
    { kind: 'self_outsourced', pending: 2, passed: 5, failed: 1, closed: 0, judgedCount: 6, passRate: 0.8333, nonconformOpen: 1 },
    { kind: 'nonstandard_purchase', pending: 2, passed: 5, failed: 1, closed: 1, judgedCount: 7, passRate: 0.7143, nonconformOpen: 1 },
    { kind: 'standard_purchase', pending: 0, passed: 0, failed: 0, closed: 0, judgedCount: 0, passRate: null, nonconformOpen: 0 },
    { kind: 'equipment_purchase', pending: 0, passed: 0, failed: 0, closed: 0, judgedCount: 0, passRate: null, nonconformOpen: 0 },
  ],
  generatedAt: '2026-10-25T02:00:00.000Z',
};

const machiningBody = {
  stats: [
    { workOrderId: 'wo-0001', drawingNo: 'DWG-A01', totalHours: 128.5, totalOutput: 40 },
    { workOrderId: null, drawingNo: 'DWG-B02', totalHours: 7.5, totalOutput: 3 },
  ],
};

const fourRoutes: Record<string, unknown> = {
  '/workbench/summary': workbenchBody,
  '/workorder/delivery-situation': deliveryBody,
  '/inspection/summary': inspectionBody,
  '/hours/machining/stats': machiningBody,
};

describe('fetchOverviewView：四源 GET 形状 + Bearer + 解析聚合', () => {
  it('四请求并行直连四端点，全部注入 Bearer，聚合出卡片与下钻分组', async () => {
    respondByRoute(fourRoutes);
    const view = await fetchOverviewView();

    expect(calls.map((call) => call.url).sort()).toEqual([
      '/hours/machining/stats',
      '/inspection/summary',
      '/workbench/summary',
      '/workorder/delivery-situation',
    ]);
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer token-ops-abc');
    }

    expect(view.todo).toEqual({ openTotal: 5, bySource: workbenchBody.bySource });
    expect(view.delivery).toEqual({ activeOrders: 2, overdue: 1, atRisk: 1, onTrack: 0 });
    expect(view.inspection).toEqual({
      pendingCount: 4,
      passRate: 0.7692,
      nonconformOpenCount: 2,
      overdueCount: 1,
    });
    expect(view.machining).toEqual({
      workOrderCount: 1,
      unassignedCount: 1,
      totalHours: 136,
      totalOutput: 43,
    });
    expect(view.riskGroups.map((group) => group.riskLevel)).toEqual(['overdue', 'at_risk']);
    expect(view.machiningGroups.map((row) => row.workOrderId)).toEqual(['wo-0001', null]);
  });

  it('fetchOverviewSources：四源解析后原样返回（不聚合）', async () => {
    respondByRoute(fourRoutes);
    const sources = await fetchOverviewSources();
    expect(sources.workbench.openTotal).toBe(5);
    expect(sources.delivery.orders).toHaveLength(2);
    expect(sources.inspection.byKind).toHaveLength(4);
    expect(sources.machining).toHaveLength(2);
  });
});

describe('失败语义（全量聚合：任一源失败整体失败）', () => {
  it('源响应坏形状 → OverviewViewsError 抛出（不静默）', async () => {
    respondByRoute({
      ...fourRoutes,
      '/inspection/summary': { ...inspectionBody, byKind: undefined },
    });
    const error: unknown = await fetchOverviewView().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ name: 'OverviewViewsError' });
  });

  it('源 HTTP 403 → ApiError(403) 整体失败且不清会话', async () => {
    respondByRoute(fourRoutes, (url) => (url === '/hours/machining/stats' ? 403 : 200));
    const error: unknown = await fetchOverviewView().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ name: 'ApiError', status: 403 });
    expect(storageBacking.size).toBeGreaterThan(0); // 403 不触发会话清除
  });
});
