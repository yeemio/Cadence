/**
 * 移动数据层接缝测试（M5 首波，node 纯逻辑 + fetch/window stub）：钉住
 * hoursApi / inventoryApi → apiClient → 真实端点的确切 HTTP 形状——
 * - GET /hours/my（month 查询参数编码；空 month = 不带参数全量口径）；
 * - GET /inventory/stock（itemId trim + 查询参数编码；空 = 全部物料行）；
 * - Bearer 会话头注入；响应经 product-ui 视图模型解析（坏形状抛错）。
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
  clear: () => storageBacking.clear(),
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

const { fetchMyHours } = await import('../src/data/hoursApi.js');
const { fetchStockLevels } = await import('../src/data/inventoryApi.js');

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => Promise<unknown>) | null = null;

function respond(body: unknown, status = 200): void {
  responder = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: 'user-e2e' as never,
    tenantId: 'tenant-e2e' as never,
    displayName: 'e2e',
    permissions: [],
    token: 'token-e2e-abc',
    expiresAt: '2026-10-25T16:00:00.000Z',
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMyHours：GET /hours/my HTTP 形状与解析', () => {
  it('带 month 查询参数（YYYY-MM 编码直传）+ Bearer + 视图解析', async () => {
    respond({
      my: {
        workerId: 'user-e2e',
        month: '2026-10',
        days: [{ workDate: '2026-10-21', totalHours: 7.5 }],
        totalHours: 7.5,
      },
    });
    const view = await fetchMyHours('2026-10');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/hours/my?month=2026-10');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer token-e2e-abc');
    expect(view.totalHours).toBe(7.5);
    expect(view.days[0]).toEqual({ workDate: '2026-10-21', totalHours: 7.5 });
  });

  it('month 空串 = 不带查询参数（全量口径）', async () => {
    respond({ my: { workerId: 'user-e2e', month: null, days: [], totalHours: 0 } });
    const view = await fetchMyHours('');
    expect(calls[0]?.url).toBe('/hours/my');
    expect(view.month).toBeNull();
  });

  it('响应坏形状（缺 my）抛视图错误', async () => {
    respond({});
    await expect(fetchMyHours('2026-10')).rejects.toThrow();
  });
});

describe('fetchStockLevels：GET /inventory/stock HTTP 形状与解析', () => {
  it('itemId trim + 查询参数编码 + Bearer + 视图解析', async () => {
    respond({
      levels: [
        {
          itemId: 'itm-seed-0001',
          warehouseId: 'wh-seed-0001',
          qtyOnHand: 120,
          qtyReserved: 20,
          availableQty: 100,
        },
      ],
    });
    const levels = await fetchStockLevels(' itm-seed-0001 ');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/inventory/stock?itemId=itm-seed-0001');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer token-e2e-abc');
    expect(levels[0]?.availableQty).toBe(100);
  });

  it('itemId 空/空白 = 不带查询参数（全部物料行——移动页"查全部"口径）', async () => {
    respond({ levels: [] });
    await fetchStockLevels('  ');
    expect(calls[0]?.url).toBe('/inventory/stock');
  });

  it('响应坏形状（缺 levels）抛视图错误', async () => {
    respond({});
    await expect(fetchStockLevels('itm-1')).rejects.toThrow();
  });
});
