/**
 * 大屏页接缝测试（A8 首波，6a-3 裁决 3/4：web 大屏页补建的形状锚定）：
 *  - screenApi：GET /screen/digital-operation 的确切 HTTP 形状 + Bearer 注入；
 *    信封宽容解析（null 保留 / pendingFields 种类映射 / 坏形状降级空块不抛）；
 *    SSE 通道 URL 形状（?token= 查询参 + encodeURIComponent）；readScreenToken
 *    会话读取与过期判定；
 *  - screenFrame：1080p 等比缩放计算（min 边适配）与占位标记映射（待定/待接）；
 *  - screenRoutes（O-1 修复锚定）：页面路由 /bigscreen/digital-operation，且
 *    与 API 前缀 /screen/* 零重叠（API 调用面保持 /screen/* 不动——API 归 API）。
 * 体例沿 overview-api.test.ts（node 纯逻辑 + fetch/window stub）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_SESSION_STORAGE_KEY, createBrowserTokenSessionStore } from '@smes/product-ui';

// ---- window / localStorage stub（apiClient/screenApi 模块加载即读 window.localStorage） ----
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

const screenApi = await import('../src/pages/screen/screenApi.js');
const screenFrame = await import('../src/pages/screen/screenFrame.js');
const screenRoutes = await import('../src/pages/screen/screenRoutes.js');

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => unknown) | null = null;

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: 'user-screen' as never,
    tenantId: 'tenant-screen' as never,
    displayName: 'screen-op',
    permissions: [],
    token: 'token-screen-abc',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = responder === null ? null : await Promise.resolve(responder());
    return { ok: true, status: 200, json: async () => body };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 服务端帧契约金样本（screen-payload.ts 形状的极简实例）。 */
function goldenEnvelope(): unknown {
  return {
    type: 'digital_operation.snapshot',
    ts: 1770000000000,
    payload: {
      topBar: {
        companyNameLines: ['某精密制造', '数字运营中心'],
        safeProductionDays: 4312,
        sixSScore: 95.5,
        comprehensiveScore: 93.2,
      },
      kpi: {
        monthlyPlannedDeliverySets: 3,
        monthlyDeliveredSets: null,
        inProgressWorkOrders: 2,
        milestoneOnTimeRate: 0.912,
        yearlyDrawingIntakeCount: null,
        pendingMachiningDrawingCount: null,
        firstPassYieldRate: 0.934,
      },
      projectProgressRows: [],
      machiningOnlineSnapshot: {
        selfDispatchedOrderCount: 1,
        todayQualifiedOutputQuantity: null,
        outsourceDispatchedOrderCount: 0,
        machiningDispatchRows: [
          { orderNo: 'dsp-1', opName: 'OP-10', progress: 40, dispatchStatus: 3, status: '进行中', led: 'warn' },
        ],
        outsourceDispatchRows: [],
      },
      assemblyOnlineSnapshot: { typeCounts: [{ type: '装配', count: 2 }], detailRows: [] },
      dailyProductionOutputByWorkReport: [{ dayLabel: '10-26', date: '2026-10-26', quantity: 7 }],
      hourlyOutputWipPoints: [
        { hourFrom: 8, hourLabel: '08:00', wipDrawingDistinctCount: 2, qualifiedQuantity: null },
      ],
      hourlyInboundInspectionPoints: [
        { hourFrom: 8, hourLabel: '08:00', pendingStorageQuantity: null, pendingInspectionQuantity: 4, cumulativeQualifiedInspectionQuantity: 4 },
      ],
      todayWorkReportRankRows: [{ userName: '张三', reporter: 'u-1', quantity: 9 }],
      pendingFields: {
        'kpi.monthlyDeliveredSets': 'source',
        'kpi.milestoneOnTimeRate': 'definition',
      },
    },
  };
}

describe('screenApi（数据层接缝）', () => {
  it('fetchScreenSnapshot：GET /screen/digital-operation + Bearer 会话注入', async () => {
    responder = () => goldenEnvelope();
    const envelope = await screenApi.fetchScreenSnapshot();
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    expect(first?.url).toBe('/screen/digital-operation');
    expect((first?.init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer token-screen-abc',
    );
    expect(envelope.type).toBe('digital_operation.snapshot');
    expect(envelope.ts).toBe(1770000000000);
  });

  it('parseScreenEnvelope：null 保留不虚构、pendingFields 种类映射、块结构还原', () => {
    const { payload } = screenApi.parseScreenEnvelope(goldenEnvelope());
    expect(payload.kpi.monthlyDeliveredSets).toBeNull();
    expect(payload.kpi.monthlyPlannedDeliverySets).toBe(3);
    expect(payload.pendingFields['kpi.monthlyDeliveredSets']).toBe('source');
    expect(payload.pendingFields['kpi.milestoneOnTimeRate']).toBe('definition');
    expect(payload.machiningOnlineSnapshot.machiningDispatchRows[0]).toMatchObject({
      orderNo: 'dsp-1',
      led: 'warn',
      dispatchStatus: 3,
    });
    const inbound = payload.hourlyInboundInspectionPoints[0];
    expect(inbound).toBeDefined();
    expect(inbound?.pendingStorageQuantity).toBeNull();
  });

  it('parseScreenEnvelope：坏形状宽容降级（呈现面不抛——缺块/类型漂移 → 空块/null）', () => {
    const { payload } = screenApi.parseScreenEnvelope({ unexpected: true });
    expect(payload.kpi.monthlyPlannedDeliverySets).toBeNull();
    expect(payload.projectProgressRows).toEqual([]);
    expect(payload.todayWorkReportRankRows).toEqual([]);
    expect(payload.pendingFields).toEqual({});
    // 完全垃圾输入也不炸
    expect(() => screenApi.parseScreenEnvelope(null)).not.toThrow();
  });

  it('screenStreamUrl：?token= 查询参 + encodeURIComponent（EventSource 无 header 形态）', () => {
    expect(screenApi.screenStreamUrl('tok en/1&2', '')).toBe(
      '/screen/digital-operation/stream?token=tok%20en%2F1%262',
    );
    expect(screenApi.screenStreamUrl('abc', 'https://api.example.com')).toBe(
      'https://api.example.com/screen/digital-operation/stream?token=abc',
    );
  });

  it('readScreenToken：读会话 token；过期/无会话 → null（页面提示登录）', () => {
    expect(screenApi.readScreenToken(Date.parse('2026-10-26T00:00:00.000Z'))).toBe('token-screen-abc');
    // 会话已过期（expiresAt 2099 前提下用超远 now）
    expect(screenApi.readScreenToken(Date.parse('2100-01-01T00:00:00.000Z'))).toBeNull();
    storageBacking.clear();
    expect(screenApi.readScreenToken()).toBeNull();
  });
});

describe('screenRoutes（O-1：前端路由与 API 路径分离）', () => {
  it('大屏页面路由 = /bigscreen/digital-operation（旧 /screen/digital-operation 与 API 同路径已搬家）', () => {
    expect(screenRoutes.screenPageRoute(screenRoutes.SCREEN_SCENE_DIGITAL_OPERATION)).toBe(
      '/bigscreen/digital-operation',
    );
  });

  it('O-1 不变量：页面路由不落在 API 前缀 /screen/ 下，且不与快照/流任一 API 路径相等（API 调用面保持 /screen/*）', async () => {
    const route = screenRoutes.screenPageRoute(screenRoutes.SCREEN_SCENE_DIGITAL_OPERATION);
    expect(route.startsWith('/screen/')).toBe(false);
    // 对照面：API 调用 URL 仍是 /screen/*（API 归 API，不随路由搬家）
    responder = () => goldenEnvelope();
    await screenApi.fetchScreenSnapshot();
    expect(calls[0]?.url).toBe('/screen/digital-operation');
    const streamUrl = screenApi.screenStreamUrl('tok', '');
    expect(streamUrl).toBe('/screen/digital-operation/stream?token=tok');
    expect(route).not.toBe(calls[0]?.url);
    expect(route).not.toBe(streamUrl);
  });
});

describe('screenFrame（1080p 缩放与占位标记）', () => {
  it('computeScale：min 边适配（16:9 等比、超宽/超高取小边）', () => {
    expect(screenFrame.computeScale(1920, 1080)).toBe(1);
    expect(screenFrame.computeScale(3840, 2160)).toBe(2);
    expect(screenFrame.computeScale(960, 540)).toBe(0.5);
    expect(screenFrame.computeScale(1920, 540)).toBe(0.5); // 高度受限
    expect(screenFrame.computeScale(960, 1080)).toBe(0.5); // 宽度受限
    expect(screenFrame.computeScale(0, 0)).toBe(1); // 非法视口守卫
  });

  it('pendingMarker / pendingBadgeText：definition→待定、source→待接、未登记→null', () => {
    const pending = { 'kpi.a': 'definition', 'kpi.b': 'source' } as const;
    expect(screenFrame.pendingMarker(pending, 'kpi.a')).toBe('definition');
    expect(screenFrame.pendingMarker(pending, 'kpi.b')).toBe('source');
    expect(screenFrame.pendingMarker(pending, 'kpi.c')).toBeNull();
    expect(screenFrame.pendingBadgeText('definition')).toBe('待定');
    expect(screenFrame.pendingBadgeText('source')).toBe('待接');
  });

  it('显示格式化：null → 「—」；比率→百分比；入库/总数对；剩余交期逾期语义', () => {
    expect(screenFrame.displayNumber(null)).toBe('—');
    expect(screenFrame.displayNumber(4312)).toBe('4312');
    expect(screenFrame.displayRate(0.912)).toBe('91.2%');
    expect(screenFrame.displayRate(null)).toBe('—');
    expect(screenFrame.displayStoredTotal({ stored: null, total: 5 })).toBe('—/5');
    expect(screenFrame.displayStoredTotal({ stored: 3, total: 5 })).toBe('3/5');
    expect(screenFrame.displayRemainingDays(-3)).toBe('逾期3天');
    expect(screenFrame.displayRemainingDays(7)).toBe('7天');
    expect(screenFrame.displayRemainingDays(null)).toBe('—');
    expect(screenFrame.displayProgress(null)).toBe('—');
    expect(screenFrame.displayProgress(40)).toBe('40%');
    expect(screenFrame.riskLabel('high')).toBe('高');
    expect(screenFrame.riskLabel(null)).toBe('—');
  });
});
