/**
 * 移动作业读取薄数据层接缝测试（S3 移动呈现，node 纯逻辑 + fetch/window
 * stub）：钉住 mobile-ops → commandClient → 真实端点的确切 HTTP 形状——
 * GET /reports/mine、/reports/pending-verification、/inspection/orders、
 * /workorder/parts-requests?state=submitted、/inventory/stocktakes 系、
 * /workorder/work-orders/:id/progress、/reporting/drawings/:drawingNo/
 * operation-progress；Bearer 会话头注入；响应经 product-ui 视图模型解析
 * （坏形状抛错）。真实落库由容器 e2e 实证（不在本文件）。
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

const {
  fetchDrawingOperationProgress,
  fetchInspectionQueue,
  fetchMyReports,
  fetchPartsRequests,
  fetchPendingVerification,
  fetchStocktakeDetail,
  fetchStocktakeList,
  fetchWorkOrderProgress,
} = await import('../src/data/mobile-ops.js');

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

function bearerOfCall(index: number): string {
  const headers = calls[index]?.init?.headers as Record<string, string>;
  return headers['authorization'] ?? '';
}

describe('报工读取面：mine / pending-verification', () => {
  it('GET /reports/mine 无查询参数 + Bearer + 视图解析', async () => {
    respond({ reports: [reportRowFixture()] });
    const rows = await fetchMyReports();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/reports/mine');
    expect(bearerOfCall(0)).toBe('Bearer token-e2e-abc');
    expect(rows[0]?.id).toBe('wr-0192');
    expect(rows[0]?.kind).toBe('part');
  });

  it('GET /reports/pending-verification 视图解析', async () => {
    respond({ reports: [reportRowFixture()] });
    const rows = await fetchPendingVerification();
    expect(calls[0]?.url).toBe('/reports/pending-verification');
    expect(rows).toHaveLength(1);
  });

  it('响应坏形状（缺 reports）抛视图错误', async () => {
    respond({});
    await expect(fetchMyReports()).rejects.toThrow();
  });
});

describe('质检队列读取面', () => {
  it('缺省全队列；kind/state 过滤编码直传', async () => {
    respond({ orders: [] });
    await fetchInspectionQueue();
    expect(calls[0]?.url).toBe('/inspection/orders');

    respond({ orders: [] });
    await fetchInspectionQueue({ kind: 'self_outsourced', state: 'pending' });
    expect(calls[1]?.url).toBe('/inspection/orders?kind=self_outsourced&state=pending');
  });

  it('四类 kind 行解析', async () => {
    respond({ orders: [{ ...inspectionRowFixture(), kind: 'equipment_purchase' }] });
    const rows = await fetchInspectionQueue();
    expect(rows[0]?.kind).toBe('equipment_purchase');
    expect(rows[0]?.objectVersion).toBe(1);
  });
});

describe('配件申请读取面', () => {
  it('缺省 state=submitted 待审队列；显式 state 覆盖', async () => {
    respond({ partsRequests: [] });
    await fetchPartsRequests();
    expect(calls[0]?.url).toBe('/workorder/parts-requests?state=submitted');

    respond({ partsRequests: [] });
    await fetchPartsRequests('approved');
    expect(calls[1]?.url).toBe('/workorder/parts-requests?state=approved');
  });

  it('行解析含乐观锁锚点', async () => {
    respond({ partsRequests: [partsRowFixture()] });
    const rows = await fetchPartsRequests();
    expect(rows[0]?.id).toBe('pr-0001');
    expect(rows[0]?.objectVersion).toBe(2);
  });
});

describe('盘点读取面', () => {
  it('台账缺省无查询参数；state 过滤；详情 id 编码', async () => {
    respond({ stocktakes: [] });
    await fetchStocktakeList();
    expect(calls[0]?.url).toBe('/inventory/stocktakes');

    respond({ stocktakes: [] });
    await fetchStocktakeList('counting');
    expect(calls[1]?.url).toBe('/inventory/stocktakes?state=counting');

    respond({ stocktake: stocktakeRowFixture(), milestones: [] });
    const detail = await fetchStocktakeDetail('st-0001');
    expect(calls[2]?.url).toBe('/inventory/stocktakes/st-0001');
    expect(detail.stocktake.lines).toHaveLength(1);
  });

  it('详情坏形状（缺 milestones）抛视图错误', async () => {
    respond({ stocktake: stocktakeRowFixture() });
    await expect(fetchStocktakeDetail('st-0001')).rejects.toThrow();
  });
});

describe('进度读取面', () => {
  it('工作令进度：id 编码 + 直返对象解析', async () => {
    respond(progressBodyFixture());
    const view = await fetchWorkOrderProgress('wo 0001');
    expect(calls[0]?.url).toBe('/workorder/work-orders/wo%200001/progress');
    expect(view.projectName).toBe('示范项目一');
    expect(view.daysToDelivery).toBe(36);
  });

  it('图号工序进度：drawingNo 编码 + 行解析', async () => {
    respond({ rows: [operationProgressRowFixture()] });
    const rows = await fetchDrawingOperationProgress('DWG-A01');
    expect(calls[0]?.url).toBe('/reporting/drawings/DWG-A01/operation-progress');
    expect(rows[0]?.netDoneQty).toBe(30);
    expect(rows[0]?.operationCode).toBe('OP-10');
  });

  it('进度坏形状抛视图错误', async () => {
    respond({});
    await expect(fetchDrawingOperationProgress('DWG-A01')).rejects.toThrow();
  });
});

// ---- 夹具（形状镜像后端投影行；词沿 ADR-0010 通用词纪律） ----

function reportRowFixture() {
  return {
    id: 'wr-0192',
    tenant: 'tenant-e2e',
    dispatchId: 'dsp-0001',
    kind: 'part',
    flowConfigId: 'flow-1',
    state: 'reported',
    objectVersion: 2,
    doneQty: 10,
    laborMinutes: 120,
    reporter: 'user-e2e',
    workOrderId: 'wo-0001',
    drawingNo: 'DWG-A01',
    operationCode: 'OP-10',
    supersedes: null,
    businessTime: '2026-10-25T01:00:00.000Z',
    remark: null,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:00.000Z',
  };
}

function inspectionRowFixture() {
  return {
    id: 'ins-0001',
    tenant: 'tenant-e2e',
    flowConfigId: 'flow-1',
    state: 'pending',
    objectVersion: 1,
    kind: 'self_outsourced',
    sourceType: null,
    sourceRefId: null,
    itemId: 'itm-seed-0001',
    drawingNo: 'DWG-A01',
    quantity: 20,
    passedQty: null,
    failedQty: null,
    judgeRemark: null,
    closeDueAt: null,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:00.000Z',
  };
}

function partsRowFixture() {
  return {
    id: 'pr-0001',
    tenant: 'tenant-e2e',
    workOrderId: 'wo-0001',
    flowConfigId: 'flow-1',
    state: 'submitted',
    objectVersion: 2,
    itemId: 'itm-seed-0001',
    quantity: 5,
    requester: 'user-e2e',
    remark: null,
    shipmentRef: null,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:00.000Z',
  };
}

function stocktakeRowFixture() {
  return {
    id: 'st-0001',
    tenant: 'tenant-e2e',
    warehouseId: 'wh-seed-0001',
    flowConfigId: 'flow-1',
    state: 'counting',
    objectVersion: 2,
    lines: [{ itemId: 'itm-seed-0001', systemQty: 120, countedQty: null, countedAt: null, countedBy: null }],
    openedBy: 'user-e2e',
    approvedBy: null,
    remark: null,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:00.000Z',
  };
}

function progressBodyFixture() {
  return {
    workOrderId: 'wo-0001',
    projectName: '示范项目一',
    state: 'in_production',
    plannedDeliveryAt: '2026-11-30T00:00:00.000Z',
    packagingArrivalAt: null,
    daysToDelivery: 36,
    milestones: [],
  };
}

function operationProgressRowFixture() {
  return {
    drawingNo: 'DWG-A01',
    operationCode: 'OP-10',
    netDoneQty: 30,
    verifiedQty: 20,
    netLaborMinutes: 480,
    verifiedLaborMinutes: 320,
    reportCount: 3,
    lastReportedAt: '2026-10-25T01:00:00.000Z',
  };
}
