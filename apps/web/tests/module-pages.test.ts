/**
 * 九循环模块页面装配测试（S2 批次，node 纯逻辑 + fetch/window stub）：
 * 每模块一组——
 * 1. 页面组件真实存在且挂进 PAGE_BY_CODE（菜单路由 ↔ 装配表无漂移）；
 * 2. 代表性读端点钉住确切 HTTP 形状（路径 + 查询串 + envelope 键）；
 * 3. 代表性命令端点钉住 smes.command.v1 信封（kind + expectedRevision 口径）。
 * 端点/权限码全部按 packages/application/src 各控制器实态（不猜）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandOutcomeView } from '../src/data/commandClient.js';

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

// stub 之后动态 import（模块级 window.localStorage 读取发生在加载时）
const { PAGE_BY_CODE } = await import('../src/pages/assembly.js');
const workorderApi = await import('../src/data/workorderApi.js');
const listingApi = await import('../src/data/listingApi.js');
const dispatchApi = await import('../src/data/dispatchApi.js');
const reportingApi = await import('../src/data/reportingApi.js');
const inspectionApi = await import('../src/data/inspectionApi.js');
const inventoryApi = await import('../src/data/inventoryApi.js');
const { businessIdsOfOutcome } = await import('../src/data/commandClient.js');
const hoursApi = await import('../src/data/hoursApi.js');
const costingApi = await import('../src/data/costingApi.js');
const baselineApi = await import('../src/data/baselineApi.js');
const orgApi = await import('../src/data/orgApi.js');
const masterdataApi = await import('../src/data/masterdataApi.js');
const auditApi = await import('../src/data/auditApi.js');
const standardReportsApi = await import('../src/data/standardReportsApi.js');
const aiQueryApi = await import('../src/data/aiQueryApi.js');
const { menuRoutes } = await import('../src/menu.js');
const { MOBILE_PAGE_BY_CODE } = await import('../src/pages/assembly.js');
const { mobileRoutes } = await import('../src/mobile.js');

/** 记录 fetch 调用并按序回放响应。 */
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => Promise<unknown>) | null = null;

function respond(body: unknown, status = 200): void {
  responder = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** S3-a 批次七页（主数据/审计/标准报表）页面码。 */
const S3A_PAGE_CODES = [
  'masterdata-customer',
  'masterdata-supplier',
  'masterdata-unit',
  'system-department',
  'system-position',
  'system-audit',
  'standard-reports',
] as const;

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** S2 批次九模块的全部页面码（与 menu.ts/assembly.ts 同源对照表）。 */
const S2_PAGE_CODES = [
  'workorder',
  'workorder-parts',
  'listing-sheets',
  'listing-gap-checks',
  'dispatch',
  'outsourcing-lines',
  'reports',
  'report-verification',
  'purchase-requests',
  'purchase-orders',
  'purchase-returns',
  'purchase-details',
  'inspections',
  'nonconformities',
  'warehouses',
  'stock-levels',
  'stock-operations',
  'stocktakes',
  'shipping-orders',
  'hours-stats',
  'costing',
  'baseline-processes',
  'baseline-routings',
  'baseline-standard-times',
  'baseline-equipment',
  'baseline-fault-reports',
  'baseline-outsourcing-rules',
  'baseline-material-validations',
] as const;

describe('S2 装配总纲：九模块页面码全量挂接（菜单 ↔ 注册表无漂移）', () => {
  it('每个 S2 菜单码都有真实页面（不是 ModulePagePlaceholder）', () => {
    for (const code of S2_PAGE_CODES) {
      expect(PAGE_BY_CODE[code], `装配表缺 '${code}'`).toBeDefined();
      expect(typeof PAGE_BY_CODE[code]).toBe('function');
      expect(menuRoutes.some((route) => route.code === code), `菜单缺 '${code}' 路由`).toBe(true);
    }
  });

  it('装配表不虚构路由：PAGE_BY_CODE 键全部在菜单路由清单内（除 m.* 移动组）', () => {
    const routeCodes = new Set(menuRoutes.map((route) => route.code));
    for (const code of Object.keys(PAGE_BY_CODE)) {
      expect(routeCodes.has(code), `装配表键 '${code}' 无菜单路由`).toBe(true);
    }
  });

  it('九模块页占位退役：全路由仅剩 system-session 一处占位（hideInMenu 审计页）', () => {
    const unwired = menuRoutes
      .filter((route) => PAGE_BY_CODE[route.code] === undefined)
      .map((route) => route.code);
    expect(unwired).toEqual(['system-session']);
  });
});

describe('S3-d 移动装配总纲：11 子页全量挂接（mobileRoutes ↔ MOBILE_PAGE_BY_CODE 无漂移）', () => {
  it('移动路由清单 15 码全部有真实页面（4 标签 + 11 子页，不渲染 null）', () => {
    expect(mobileRoutes).toHaveLength(15);
    for (const route of mobileRoutes) {
      expect(MOBILE_PAGE_BY_CODE[route.code], `移动装配表缺 '${route.code}'`).toBeDefined();
      expect(typeof MOBILE_PAGE_BY_CODE[route.code]).toBe('function');
    }
  });

  it('移动装配表不虚构路由：MOBILE_PAGE_BY_CODE 键与 mobileRoutes 码严格相等', () => {
    expect(Object.keys(MOBILE_PAGE_BY_CODE).sort()).toEqual(
      mobileRoutes.map((route) => route.code).sort(),
    );
  });
});

// ---- workorder ----

describe('workorder 模块装配（#24-30）', () => {
  it('页面：工作令列表/操作页 + 配件申请页挂接', () => {
    expect(typeof PAGE_BY_CODE['workorder']).toBe('function');
    expect(typeof PAGE_BY_CODE['workorder-parts']).toBe('function');
  });

  it('列表：GET /workorder/work-orders?state=（envelope=orders）', async () => {
    respond({ orders: [{ id: 'wo-1' }] });
    const rows = await workorderApi.listWorkOrders({ state: 'in_progress' });
    expect(calls[0]?.url).toBe('/workorder/work-orders?state=in_progress');
    expect(rows).toEqual([{ id: 'wo-1' }]);
  });

  it('流转命令：POST :id/transitions，kind=workorder.transition.v1，乐观锁取行 objectVersion', async () => {
    respond({ status: 'committed' });
    const outcome = await workorderApi.transitionWorkOrder('wo-1', { objectVersion: 3 }, { targetState: 'in_progress' });
    expect(calls[0]?.url).toBe('/workorder/work-orders/wo-1/transitions');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(3);
    expect((body['command'] as { kind: string }).kind).toBe('workorder.transition.v1');
    expect(outcome.committed).toBe(true);
  });
});

// ---- listing ----

describe('listing 模块装配（#31-34/54-62/73-76）', () => {
  it('页面：清单/缺口核查/采购四页挂接', () => {
    for (const code of ['listing-sheets', 'listing-gap-checks', 'purchase-requests', 'purchase-orders', 'purchase-returns', 'purchase-details']) {
      expect(typeof PAGE_BY_CODE[code]).toBe('function');
    }
  });

  it('清单列表：GET /listing/sheets?workOrderId=（workOrderId 必填——控制器实态）', async () => {
    respond({ sheets: [] });
    await listingApi.listSheets('wo-1');
    expect(calls[0]?.url).toBe('/listing/sheets?workOrderId=wo-1');
  });

  it('缺口核查命令：POST /listing/work-orders/:id/gap-checks，kind=gap.check.v1，expectedRevision=initial', async () => {
    respond({ status: 'committed' });
    await listingApi.runGapCheck('wo-1');
    expect(calls[0]?.url).toBe('/listing/work-orders/wo-1/gap-checks');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe('initial');
    expect((body['command'] as { kind: string }).kind).toBe('gap.check.v1');
  });
});

// ---- dispatch ----

describe('dispatch 模块装配（#38-43）', () => {
  it('页面：派工单列表/操作页 + 外协明细页挂接', () => {
    expect(typeof PAGE_BY_CODE['dispatch']).toBe('function');
    expect(typeof PAGE_BY_CODE['outsourcing-lines']).toBe('function');
  });

  it('列表：GET /dispatch/orders?kind=&state=（envelope=orders）', async () => {
    respond({ orders: [] });
    await dispatchApi.listDispatchOrders({ kind: 'part', state: 'assigned' });
    expect(calls[0]?.url).toBe('/dispatch/orders?kind=part&state=assigned');
  });

  it('创建命令：POST /dispatch/orders，kind=dispatch.create.v1（六类判别载荷）', async () => {
    respond({ status: 'committed' });
    await dispatchApi.createDispatchOrder({ kind: 'part', quantity: 2, drawingNo: 'DW-01', operationCode: 'OP-10' });
    expect(calls[0]?.url).toBe('/dispatch/orders');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('dispatch.create.v1');
  });

  // ---- fix-wave-6 6a-1 增量端点钉形 ----

  it('转单命令：POST :id/transfer，kind=dispatch.transfer.v1，乐观锁取行 objectVersion', async () => {
    respond({ status: 'committed' });
    await dispatchApi.transferDispatchOrder(
      'dsp-1',
      { objectVersion: 3 },
      { assignee: 'u-worker-02', operationCode: 'proc-mill' },
    );
    expect(calls[0]?.url).toBe('/dispatch/orders/dsp-1/transfer');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(3);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('dispatch.transfer.v1');
    expect(command.payload).toMatchObject({ assignee: 'u-worker-02', operationCode: 'proc-mill' });
  });

  it('导出与统计：GET /dispatch/orders/export 与 /stats（状态统计不含 state 维）', async () => {
    respond({ kind: 'json-tables', sheets: [] });
    await dispatchApi.exportDispatchOrders({ kind: 'part', state: 'draft' });
    expect(calls[0]?.url).toBe('/dispatch/orders/export?kind=part&state=draft');
    respond({ counts: { draft: 2 } });
    await dispatchApi.getDispatchOrderStats({ kind: 'part' });
    expect(calls[1]?.url).toBe('/dispatch/orders/stats?kind=part');
  });

  it('批操作：POST batch-assign/batch-cancel（批 operationId + 行级 expectedRevision 数组）', async () => {
    respond({ status: 'committed', items: [] });
    await dispatchApi.batchAssignDispatchOrders({
      assignee: 'u-worker-01',
      items: [{ id: 'dsp-1', expectedRevision: 1 }],
    });
    expect(calls[0]?.url).toBe('/dispatch/orders/batch-assign');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(typeof body['operationId']).toBe('string');
    expect(body['assignee']).toBe('u-worker-01');
    expect(body['items']).toEqual([{ id: 'dsp-1', expectedRevision: 1 }]);
    respond({ status: 'committed', items: [] });
    await dispatchApi.batchCancelDispatchOrders({ items: [{ id: 'dsp-1', expectedRevision: 1 }] });
    expect(calls[1]?.url).toBe('/dispatch/orders/batch-cancel');
  });

  it('取消外协明细：POST :id/cancel，kind=outsourcing.line.cancel.v1（原因选填）', async () => {
    respond({ status: 'committed' });
    await dispatchApi.cancelOutsourcingLine('osl-1', { objectVersion: 1 }, { reason: '供应商取消' });
    expect(calls[0]?.url).toBe('/outsourcing/lines/osl-1/cancel');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(1);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('outsourcing.line.cancel.v1');
    expect(command.payload).toMatchObject({ reason: '供应商取消' });
  });
});

// ---- reporting ----

describe('reporting 模块装配（#44-53）', () => {
  it('页面：报工单列表页 + 待核查队列页挂接', () => {
    expect(typeof PAGE_BY_CODE['reports']).toBe('function');
    expect(typeof PAGE_BY_CODE['report-verification']).toBe('function');
  });

  it('待核查队列：GET /reports/pending-verification（具名路由在 :id 之前）', async () => {
    respond({ reports: [] });
    await reportingApi.listPendingVerification();
    expect(calls[0]?.url).toBe('/reports/pending-verification');
  });

  it('核查命令：POST :id/verify，kind=report.verify.v1，乐观锁取行 objectVersion', async () => {
    respond({ status: 'committed' });
    await reportingApi.verifyReport('rpt-1', { objectVersion: 2 }, '核对无误');
    expect(calls[0]?.url).toBe('/reports/rpt-1/verify');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(2);
    expect((body['command'] as { kind: string }).kind).toBe('report.verify.v1');
  });
});

// ---- inspection ----

describe('inspection 模块装配（#63-66）', () => {
  it('页面：质检队列/判定页 + 不合格处置页挂接', () => {
    expect(typeof PAGE_BY_CODE['inspections']).toBe('function');
    expect(typeof PAGE_BY_CODE['nonconformities']).toBe('function');
  });

  it('队列：GET /inspection/orders?kind=&state=（envelope=orders）', async () => {
    respond({ orders: [] });
    await inspectionApi.listInspectionOrders({ kind: 'self_outsourced', state: 'pending' });
    expect(calls[0]?.url).toBe('/inspection/orders?kind=self_outsourced&state=pending');
  });

  it('判定命令：POST :id/judgment，kind=inspection.judge.v1（passedQty/failedQty 载荷）', async () => {
    respond({ status: 'committed' });
    await inspectionApi.judgeInspectionOrder('insp-1', { objectVersion: 1 }, { passedQty: 8, failedQty: 2 });
    expect(calls[0]?.url).toBe('/inspection/orders/insp-1/judgment');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('inspection.judge.v1');
  });

  // W7 UX-QC-03：特采确认走既有命令通道（inspection.controllers.ts 实态）。
  it('特采确认：POST :id/concession，kind=inspection.concession.v1（quantity 载荷 + 乐观锁）', async () => {
    respond({ status: 'committed' });
    await inspectionApi.confirmConcession('insp-1', { objectVersion: 3 }, { quantity: 2 });
    expect(calls[0]?.url).toBe('/inspection/orders/insp-1/concession');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(3);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('inspection.concession.v1');
    expect(command.payload['quantity']).toBe(2);
  });

  it('特采视图：GET /inspection/orders/:id/concession（直返对象）', async () => {
    respond({ inspectionId: 'insp-1', failedQty: 5, concessionQuantity: 0, remainingConcessionQty: 5 });
    const view = await inspectionApi.getConcessionView('insp-1');
    expect(calls[0]?.url).toBe('/inspection/orders/insp-1/concession');
    expect(view['remainingConcessionQty']).toBe(5);
  });

  // M2 R1 岗位入口补齐：判定撤销走既有命令通道（inspection.controllers.ts 实态）。
  it('判定撤销：POST :id/revocation，kind=inspection.revoke.v1（remark 载荷 + 乐观锁）', async () => {
    respond({ status: 'committed' });
    await inspectionApi.revokeInspection('insp-1', { objectVersion: 4 }, { remark: '判定录入错误' });
    expect(calls[0]?.url).toBe('/inspection/orders/insp-1/revocation');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(4);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('inspection.revoke.v1');
    expect(command.payload['remark']).toBe('判定录入错误');
  });

  it('判定撤销：remark 留空提交 null（服务端默认留痕口径）', async () => {
    respond({ status: 'committed' });
    await inspectionApi.revokeInspection('insp-1', { objectVersion: 4 }, { remark: null });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(4);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('inspection.revoke.v1');
    expect(command.payload['remark']).toBeNull();
  });
});

// ---- inventory ----

describe('inventory 模块装配（#14/71-72/77-83）', () => {
  it('页面：仓库/库存/收发存/盘点/发货五页挂接', () => {
    for (const code of ['warehouses', 'stock-levels', 'stock-operations', 'stocktakes', 'shipping-orders']) {
      expect(typeof PAGE_BY_CODE[code]).toBe('function');
    }
  });

  it('流水：GET /inventory/movements?itemId=&warehouseId=（envelope=movements）', async () => {
    respond({ movements: [] });
    await inventoryApi.fetchMovements({ itemId: 'item-1' });
    expect(calls[0]?.url).toBe('/inventory/movements?itemId=item-1');
  });

  it('入库命令：POST /inventory/stock/receipts，kind=stock.receive.v1', async () => {
    respond({ status: 'committed' });
    await inventoryApi.receiveStock({ kind: 'purchase', itemId: 'item-1', warehouseId: 'wh-1', quantity: 5, receiptKey: 'rc-1' });
    expect(calls[0]?.url).toBe('/inventory/stock/receipts');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('stock.receive.v1');
  });

  // W7 UX-WH-02：committed 回执携带聚合视图 → 业务单号回显抽取。
  it('命令回执单号抽取：movement 单条 / movements 两腿（调拨）', async () => {
    respond({ status: 'committed', movement: { id: 'mv-01a17b3f-a2a8-79df-9f43-0ab7c720735b' } });
    const outcome = await inventoryApi.receiveStock({
      kind: 'production',
      itemId: 'item-1',
      warehouseId: 'wh-1',
      quantity: 5,
    });
    expect(outcome.committed).toBe(true);
    expect(businessIdsOfOutcome(outcome)).toEqual(['mv-01a17b3f-a2a8-79df-9f43-0ab7c720735b']);
    const transferOutcome: CommandOutcomeView = {
      committed: true,
      reason: null,
      status: 'committed',
      body: { status: 'committed', movements: [{ id: 'mv-out' }, { id: 'mv-in' }] },
    };
    expect(businessIdsOfOutcome(transferOutcome)).toEqual(['mv-out', 'mv-in']);
  });
});

// ---- hours ----

describe('hours 模块装配（#84-85）', () => {
  it('页面：工时统计页挂接', () => {
    expect(typeof PAGE_BY_CODE['hours-stats']).toBe('function');
  });

  it('机加工时统计：GET /hours/machining/stats?workOrderId=（envelope=stats）', async () => {
    respond({ stats: [] });
    await hoursApi.fetchMachiningStats({ workOrderId: 'wo-1' });
    expect(calls[0]?.url).toBe('/hours/machining/stats?workOrderId=wo-1');
  });

  it('月度重算命令：POST /hours/rebuild-month，kind=hours.rebuild-month.v1', async () => {
    respond({ status: 'committed' });
    await hoursApi.rebuildMonth('2026-10');
    expect(calls[0]?.url).toBe('/hours/rebuild-month');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('hours.rebuild-month.v1');
  });
});

// ---- costing ----

describe('costing 模块装配（成本核算，0920 外 R7 增量）', () => {
  it('页面：成本核算页挂接', () => {
    expect(typeof PAGE_BY_CODE['costing']).toBe('function');
  });

  it('三分类汇总：GET /costing/work-orders/:id/summary（envelope=summary）', async () => {
    respond({ summary: {} });
    await costingApi.getWorkOrderCostSummary('wo-1');
    expect(calls[0]?.url).toBe('/costing/work-orders/wo-1/summary');
  });

  it('重算命令：POST /costing/rebuild，kind=costing.rebuild.v1', async () => {
    respond({ status: 'committed' });
    await costingApi.rebuildCosting({ workOrderId: 'wo-1' });
    expect(calls[0]?.url).toBe('/costing/rebuild');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('costing.rebuild.v1');
  });
});

// ---- baseline ----

describe('baseline 模块装配（#10/12/13/16/20/35/36）', () => {
  it('页面：工序/路线/额定工时/设备/故障/外协计价/物料校验七页挂接', () => {
    for (const code of [
      'baseline-processes',
      'baseline-routings',
      'baseline-standard-times',
      'baseline-equipment',
      'baseline-fault-reports',
      'baseline-outsourcing-rules',
      'baseline-material-validations',
    ]) {
      expect(typeof PAGE_BY_CODE[code], `缺 ${code}`).toBe('function');
    }
  });

  it('故障列表：GET /baseline/fault-reports?state=（envelope=faultReports）', async () => {
    respond({ faultReports: [] });
    await baselineApi.listFaultReports('open');
    expect(calls[0]?.url).toBe('/baseline/fault-reports?state=open');
  });

  it('故障上报命令：POST /baseline/fault-reports/commands，kind=baseline.fault.report.v1（上报即派修）', async () => {
    respond({ status: 'committed' });
    await baselineApi.reportFault({ equipmentCode: 'EQ-01', description: '主轴异响', assignee: 'user-1' });
    expect(calls[0]?.url).toBe('/baseline/fault-reports/commands');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect((body['command'] as { kind: string }).kind).toBe('baseline.fault.report.v1');
  });

  it('物料校验运行：GET /baseline/material-validations（envelope=runs）', async () => {
    respond({ runs: [] });
    await baselineApi.listValidationRuns();
    expect(calls[0]?.url).toBe('/baseline/material-validations');
  });
});

// ---- S3-a：主数据 backfill / 审计 / 标准报表 ----

describe('S3-a 装配总纲：backfill 七页码全量挂接', () => {
  it('每个 S3-a 菜单码都有真实页面且路由存在', () => {
    for (const code of S3A_PAGE_CODES) {
      expect(PAGE_BY_CODE[code], `装配表缺 '${code}'`).toBeDefined();
      expect(typeof PAGE_BY_CODE[code]).toBe('function');
      expect(menuRoutes.some((route) => route.code === code), `菜单缺 '${code}' 路由`).toBe(true);
    }
  });
});

describe('机构/岗位管理装配（0920 #3/#7）', () => {
  it('机构列表：GET /org/departments（envelope=departments）', async () => {
    respond({ departments: [] });
    await orgApi.listDepartments();
    expect(calls[0]?.url).toBe('/org/departments');
  });

  it('创建机构：POST /org/departments 直连 REST 体（无命令信封；空白 parentId 不送）', async () => {
    respond({ id: 'depa-1' });
    await orgApi.createDepartment({ code: 'ORG-01', name: '机加工车间', parentId: '  ' });
    expect(calls[0]?.url).toBe('/org/departments');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'ORG-01', name: '机加工车间' });
  });

  it('机构软停用：PUT /org/departments/:id 期望态 {active:false}', async () => {
    respond({ id: 'depa-1', active: false });
    await orgApi.updateDepartment('depa-1', { active: false });
    expect(calls[0]?.url).toBe('/org/departments/depa-1');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ active: false });
  });

  it('岗位列表/创建/软停用：/org/positions 三端点形状', async () => {
    respond({ positions: [] });
    await orgApi.listPositions();
    expect(calls[0]?.url).toBe('/org/positions');

    respond({ id: 'pos-1' });
    await orgApi.createPosition({ code: 'POS-01', name: '数控操作工', departmentRef: 'depa-1' });
    expect(calls[1]?.url).toBe('/org/positions');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      code: 'POS-01',
      name: '数控操作工',
      departmentRef: 'depa-1',
    });

    respond({ id: 'pos-1', active: false });
    await orgApi.updatePosition('pos-1', { active: false });
    expect(calls[2]?.url).toBe('/org/positions/pos-1');
    expect(calls[2]?.init?.method).toBe('PUT');
  });
});

describe('客户/供应商/计量单位装配（0920 #8/#9/#100）', () => {
  it('客户三端点：GET customers / POST 直连体（contact 可选送）/ PUT 软停用', async () => {
    respond({ customers: [] });
    await masterdataApi.listCustomers();
    expect(calls[0]?.url).toBe('/masterdata/customers');

    respond({ id: 'cust-1' });
    await masterdataApi.createCustomer({ code: 'CUS-01', name: '某某重工', contact: ' 0571-8888888 ' });
    expect(calls[1]?.url).toBe('/masterdata/customers');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      code: 'CUS-01',
      name: '某某重工',
      contact: '0571-8888888',
    });

    respond({ id: 'cust-1', active: false });
    await masterdataApi.updateCustomer('cust-1', { active: false });
    expect(calls[2]?.url).toBe('/masterdata/customers/cust-1');
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ active: false });
  });

  it('供应商三端点：GET suppliers / POST / PUT 软停用', async () => {
    respond({ suppliers: [] });
    await masterdataApi.listSuppliers();
    expect(calls[0]?.url).toBe('/masterdata/suppliers');

    respond({ id: 'sup-1' });
    await masterdataApi.createSupplier({ code: 'SUP-01', name: '某某热处理厂' });
    expect(calls[1]?.url).toBe('/masterdata/suppliers');

    respond({ id: 'sup-1', active: false });
    await masterdataApi.updateSupplier('sup-1', { active: false });
    expect(calls[2]?.url).toBe('/masterdata/suppliers/sup-1');
  });

  it('计量单位两端点：GET units / POST（symbol 空白不送；字典无停用端点）', async () => {
    respond({ units: [] });
    await masterdataApi.listUnits();
    expect(calls[0]?.url).toBe('/masterdata/units');

    respond({ id: 'unit-1' });
    await masterdataApi.createUnit({ code: 'PCS', name: '件', symbol: ' ' });
    expect(calls[1]?.url).toBe('/masterdata/units');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ code: 'PCS', name: '件' });
  });
});

describe('操作日志装配（0920 #103）', () => {
  it('过滤查询：GET /audit/logs?from=&to=&userId=&limit=（envelope=logs）', async () => {
    respond({ logs: [] });
    await auditApi.queryAuditLogs({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', userId: 'user-1', limit: 50 });
    expect(calls[0]?.url).toBe(
      '/audit/logs?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-26T00%3A00%3A00.000Z&userId=user-1&limit=50',
    );
  });

  it('空过滤：无查询串直打 /audit/logs', async () => {
    respond({ logs: [] });
    await auditApi.queryAuditLogs();
    expect(calls[0]?.url).toBe('/audit/logs');
  });
});

describe('标准报表装配（0920 #89/#91/#92/#96）', () => {
  it('口径清单：GET /standard-reports/metrics（packId+四 metric 元数据）', async () => {
    respond({
      packId: 'standard-reports',
      version: 1,
      metrics: [
        {
          metricId: 'inventory-movements',
          version: 1,
          display: '库存报表（按物料收发存）',
          description: '口径重述（#89）…',
          timeBasis: 'business',
          sourceKind: 'stock-movement-facts',
          dimensionFields: ['itemId'],
          measureIds: ['received-qty', 'issued-qty', 'net-qty', 'movement-count'],
        },
      ],
    });
    const catalog = await standardReportsApi.listStandardReportMetrics();
    expect(calls[0]?.url).toBe('/standard-reports/metrics');
    expect(catalog.packId).toBe('standard-reports');
    expect(catalog.metrics).toHaveLength(1);
    expect(catalog.metrics[0]?.dimensionFields).toEqual(['itemId']);
    expect(catalog.metrics[0]?.description).toBe('口径重述（#89）…');
  });

  it('求值：POST /standard-reports/query 体={metricId,from,to}（响应自描述解析）', async () => {
    respond({
      metric: { metricId: 'inventory-movements', version: 1 },
      timeBasis: 'business',
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' },
      dimensionFields: ['itemId'],
      measureIds: ['received-qty'],
      rows: [{ key: { itemId: 'item-1' }, values: { 'received-qty': 12 } }],
    });
    const result = await standardReportsApi.queryStandardReport({
      metricId: 'inventory-movements',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
    });
    expect(calls[0]?.url).toBe('/standard-reports/query');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      metricId: 'inventory-movements',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
    });
    // 响应自描述：列结构（维度+度量）与口径溯源直接来自 MetricResult
    expect(result.metricId).toBe('inventory-movements');
    expect(result.metricVersion).toBe(1);
    expect(result.dimensionFields).toEqual(['itemId']);
    expect(result.measureIds).toEqual(['received-qty']);
    expect(result.rows[0]?.key).toEqual({ itemId: 'item-1' });
    expect(result.rows[0]?.values['received-qty']).toBe(12);
  });

  it('求值入参：窗口可省略（仅 metricId）', async () => {
    respond({
      metric: { metricId: 'production-receipt-daily', version: 1 },
      timeBasis: 'business',
      window: {},
      dimensionFields: ['periodDay'],
      measureIds: ['received-qty'],
      rows: [],
    });
    await standardReportsApi.queryStandardReport({ metricId: 'production-receipt-daily' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ metricId: 'production-receipt-daily' });
  });
});

// ---- AI 问数（CONTRACT v1 · WP-C） ----

describe('ai-query 模块装配（AI 问数页）', () => {
  it('页面：AI 问数页挂接且路由存在（菜单码 ai-query）', () => {
    expect(typeof PAGE_BY_CODE['ai-query']).toBe('function');
    expect(menuRoutes.some((route) => route.code === 'ai-query')).toBe(true);
  });

  it('能力目录：GET /ai-query/capabilities（envelope=items）', async () => {
    respond({ items: [{ capabilityId: 'workorder-progress', version: '1', status: 'ready' }] });
    const items = await aiQueryApi.listCapabilities();
    expect(calls[0]?.url).toBe('/ai-query/capabilities');
    expect(items).toHaveLength(1);
    expect(items[0]?.capabilityId).toBe('workorder-progress');
  });

  it('问数：POST /ai-query/ask 直连体（无命令信封），恒 200 五态 kind 透传', async () => {
    respond({ kind: 'clarify', sessionId: 'sess-1', prompt: '请选择时间范围', options: [{ id: 'today', label: '今日', description: '' }] });
    const clarify = await aiQueryApi.ask({ question: '最近的返工情况' });
    expect(calls[0]?.url).toBe('/ai-query/ask');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ question: '最近的返工情况' });
    expect(clarify.kind).toBe('clarify');

    respond({ kind: 'denied', sessionId: 'sess-1', reason: 'no_permission', missingPermissions: ['listing:read'], hint: '' });
    const denied = await aiQueryApi.ask({ sessionId: 'sess-1', question: 'WO-1 缺料吗', selectedOptionId: 'opt-2' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      sessionId: 'sess-1',
      question: 'WO-1 缺料吗',
      selectedOptionId: 'opt-2',
    });
    expect(denied.kind).toBe('denied');
  });

  it('会话：GET /ai-query/sessions（envelope=items）与 /sessions/:id（turns 线程）', async () => {
    respond({ items: [{ sessionId: 'sess-1', lastActivityAt: '2026-10-28T02:00:00.000Z', turnCount: 2 }] });
    const sessions = await aiQueryApi.listSessions();
    expect(calls[0]?.url).toBe('/ai-query/sessions');
    expect(sessions[0]?.turnCount).toBe(2);

    respond({ items: [{ sessionId: 'sess-9', turnCount: 1 }] });
    await aiQueryApi.listSessions(10);
    expect(calls[1]?.url).toBe('/ai-query/sessions?limit=10');

    respond({
      sessionId: 'sess-1',
      createdAt: '2026-10-28T01:00:00.000Z',
      lastActivityAt: '2026-10-28T02:00:00.000Z',
      turns: [{ question: 'WO-1 缺料吗', kind: 'answer', response: { kind: 'answer', sessionId: 'sess-1' } }],
    });
    const detail = await aiQueryApi.getSession('sess-1');
    expect(calls[2]?.url).toBe('/ai-query/sessions/sess-1');
    expect(detail.sessionId).toBe('sess-1');
    expect(detail.turns[0]?.kind).toBe('answer');
  });
});
