/**
 * 运营总览视图模型测试（T 波 #1）：四源解析 + 聚合纯函数。响应形状镜像
 * packages/application 实态：workbench.service WorkbenchSummary、
 * workorder.service WorkOrderDeliverySituation、inspection-summary
 * InspectionSummary、hours.service MachiningStatRow（{ stats } 信封）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildOverviewView,
  OverviewViewsError,
  OVERVIEW_REQUIRED_PERMISSIONS,
  parseDeliverySituationResponse,
  parseInspectionSummaryResponse,
  parseMachiningStatsResponse,
  parseWorkbenchSummaryResponse,
} from '../src/overview-views.js';
import type { OverviewSources } from '../src/overview-views.js';

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
    {
      workOrderId: 'wo-0003',
      projectName: 'C 项目',
      state: 'in_progress',
      plannedDeliveryAt: '2026-12-30T00:00:00.000Z',
      daysToDelivery: 66,
      riskLevel: 'on_track',
    },
  ],
  distribution: {
    not_started: 1,
    in_progress: 2,
    ready_to_ship: 0,
    shipped: 0,
    in_acceptance: 0,
    in_maintenance: 0,
    in_aftermarket: 0,
    completed: 0,
    closed: 0,
  },
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
    { kind: 'nonstandard_purchase', pending: 1, passed: 3, failed: 1, closed: 1, judgedCount: 5, passRate: 0.6, nonconformOpen: 1 },
    { kind: 'standard_purchase', pending: 1, passed: 2, failed: 0, closed: 0, judgedCount: 2, passRate: 1, nonconformOpen: 0 },
    { kind: 'equipment_purchase', pending: 0, passed: 0, failed: 0, closed: 0, judgedCount: 0, passRate: null, nonconformOpen: 0 },
  ],
  generatedAt: '2026-10-25T02:00:00.000Z',
};

const machiningBody = {
  stats: [
    { workOrderId: 'wo-0001', drawingNo: 'DWG-A01', totalHours: 0.1, totalOutput: 1 },
    { workOrderId: null, drawingNo: 'DWG-B02', totalHours: 0.2, totalOutput: 0 },
    { workOrderId: 'wo-0009', drawingNo: 'DWG-C03', totalHours: 100.5, totalOutput: 7 },
  ],
};

function buildSources(overrides: Partial<OverviewSources> = {}): OverviewSources {
  return {
    workbench: parseWorkbenchSummaryResponse(workbenchBody),
    delivery: parseDeliverySituationResponse(deliveryBody),
    inspection: parseInspectionSummaryResponse(inspectionBody),
    machining: parseMachiningStatsResponse(machiningBody),
    ...overrides,
  };
}

describe('四源响应解析（镜像后端实态形状）', () => {
  it('workbench summary：openTotal + bySource（复用既有解析器）', () => {
    const view = parseWorkbenchSummaryResponse(workbenchBody);
    expect(view.openTotal).toBe(5);
    expect(view.bySource).toEqual([
      { source: 'inspection', open: 3 },
      { source: 'workorder', open: 2 },
    ]);
  });

  it('delivery-situation：orders 行（含 null 计划交付）+ 九态分布 + generatedAt', () => {
    const view = parseDeliverySituationResponse({
      ...deliveryBody,
      orders: [
        ...deliveryBody.orders,
        { workOrderId: 'wo-0004', projectName: 'D 项目', state: 'ready_to_ship', plannedDeliveryAt: null, daysToDelivery: null, riskLevel: 'on_track' },
      ],
    });
    expect(view.orders).toHaveLength(4);
    expect(view.orders[0]).toEqual({
      workOrderId: 'wo-0002',
      projectName: 'B 项目',
      state: 'in_progress',
      plannedDeliveryAt: '2026-10-20T00:00:00.000Z',
      daysToDelivery: -5,
      riskLevel: 'overdue',
    });
    expect(view.orders[3]?.plannedDeliveryAt).toBeNull();
    expect(view.orders[3]?.daysToDelivery).toBeNull();
    expect(view.distribution['in_progress']).toBe(2);
    expect(view.generatedAt).toBe('2026-10-25T02:00:00.000Z');
  });

  it('inspection summary：计数 + passRate（null/小数合法）+ byKind', () => {
    const view = parseInspectionSummaryResponse(inspectionBody);
    expect(view.pendingCount).toBe(4);
    expect(view.passRate).toBe(0.7692);
    expect(view.byKind).toHaveLength(4);
    expect(view.byKind[3]).toEqual({
      kind: 'equipment_purchase',
      pending: 0,
      passed: 0,
      failed: 0,
      closed: 0,
      judgedCount: 0,
      passRate: null,
      nonconformOpen: 0,
    });
  });

  it('machining stats：{ stats } 信封，null 工作令/图号合法', () => {
    const rows = parseMachiningStatsResponse(machiningBody);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.workOrderId).toBeNull();
    expect(rows[1]?.drawingNo).toBe('DWG-B02');
    expect(rows[2]?.totalHours).toBe(100.5);
  });
});

describe('非法形状拒绝（坏形状抛错不静默）', () => {
  it('delivery：缺 orders / 坏 riskLevel / 分布非计数', () => {
    expect(() => parseDeliverySituationResponse({ distribution: {}, generatedAt: 'x' })).toThrow(OverviewViewsError);
    expect(() =>
      parseDeliverySituationResponse({
        ...deliveryBody,
        orders: [{ ...deliveryBody.orders[0], riskLevel: 'late' }],
      }),
    ).toThrow(OverviewViewsError);
    expect(() =>
      parseDeliverySituationResponse({
        ...deliveryBody,
        distribution: { not_started: '1' },
      }),
    ).toThrow(OverviewViewsError);
  });

  it('inspection：缺 byKind / passRate 越界 / 计数为负', () => {
    const { byKind: _k, ...noByKind } = inspectionBody;
    expect(() => parseInspectionSummaryResponse(noByKind)).toThrow(OverviewViewsError);
    expect(() =>
      parseInspectionSummaryResponse({ ...inspectionBody, passRate: 1.5 }),
    ).toThrow(OverviewViewsError);
    expect(() =>
      parseInspectionSummaryResponse({ ...inspectionBody, pendingCount: -1 }),
    ).toThrow(OverviewViewsError);
  });

  it('machining：缺 stats / 非数值净额', () => {
    expect(() => parseMachiningStatsResponse({})).toThrow(OverviewViewsError);
    expect(() =>
      parseMachiningStatsResponse({ stats: [{ workOrderId: 'wo-1', drawingNo: null, totalHours: '8', totalOutput: 0 }] }),
    ).toThrow(OverviewViewsError);
  });
});

describe('四源聚合 buildOverviewView（卡片 + 下钻分组）', () => {
  it('四卡片计数与下钻分组（风险定序空组略过 / 机加工时降序未关联置底 / 合计两位小数）', () => {
    const view = buildOverviewView(buildSources());

    expect(view.todo).toEqual({ openTotal: 5, bySource: workbenchBody.bySource });

    expect(view.delivery).toEqual({ activeOrders: 3, overdue: 1, atRisk: 1, onTrack: 1 });

    expect(view.inspection).toEqual({
      pendingCount: 4,
      passRate: 0.7692,
      nonconformOpenCount: 2,
      overdueCount: 1,
    });

    // 100.5 + 0.1 + 0.2 = 100.80000000000001（浮点尘）→ round2 100.8
    expect(view.machining).toEqual({
      workOrderCount: 2,
      unassignedCount: 1,
      totalHours: 100.8,
      totalOutput: 8,
    });

    expect(view.riskGroups.map((group) => group.riskLevel)).toEqual(['overdue', 'at_risk', 'on_track']);
    expect(view.riskGroups[0]?.orders[0]?.workOrderId).toBe('wo-0002');

    // 净工时降序；并列时工作令升序、null 行置底（0.2 > 0.1 仍排最后）
    expect(view.machiningGroups.map((row) => row.workOrderId)).toEqual(['wo-0009', 'wo-0001', null]);

    // 质检下钻：四类分桶行原序透传（后端 INSPECTION_KINDS 定序）
    expect(view.inspectionByKind.map((row) => row.kind)).toEqual([
      'self_outsourced',
      'nonstandard_purchase',
      'standard_purchase',
      'equipment_purchase',
    ]);
    expect(view.inspectionByKind[0]?.passRate).toBe(0.8333);

    expect(view.stateDistribution['in_progress']).toBe(2);
    expect(view.freshness).toEqual({
      delivery: '2026-10-25T02:00:00.000Z',
      inspection: '2026-10-25T02:00:00.000Z',
    });
  });

  it('空组略过：全部 on_track 时风险分组仅一组', () => {
    const view = buildOverviewView(
      buildSources({
        delivery: parseDeliverySituationResponse({
          ...deliveryBody,
          orders: [deliveryBody.orders[2]],
        }),
      }),
    );
    expect(view.riskGroups).toHaveLength(1);
    expect(view.riskGroups[0]?.riskLevel).toBe('on_track');
    expect(view.delivery).toEqual({ activeOrders: 1, overdue: 0, atRisk: 0, onTrack: 1 });
  });

  it('空态：零源不出卡片异常（0 值 + 空分组）', () => {
    const view = buildOverviewView(
      buildSources({
        workbench: parseWorkbenchSummaryResponse({ user: 'u', openTotal: 0, bySource: [] }),
        delivery: parseDeliverySituationResponse({ orders: [], distribution: {}, generatedAt: '2026-10-25T02:00:00.000Z' }),
        inspection: parseInspectionSummaryResponse({ ...inspectionBody, pendingCount: 0, passRate: null, nonconformOpenCount: 0, overdueCount: 0 }),
        machining: parseMachiningStatsResponse({ stats: [] }),
      }),
    );
    expect(view.todo.openTotal).toBe(0);
    expect(view.delivery.activeOrders).toBe(0);
    expect(view.inspection.passRate).toBeNull();
    expect(view.machining).toEqual({ workOrderCount: 0, unassignedCount: 0, totalHours: 0, totalOutput: 0 });
    expect(view.riskGroups).toEqual([]);
    expect(view.machiningGroups).toEqual([]);
  });
});

describe('总览权限码（四端点一一对应）', () => {
  it('OVERVIEW_REQUIRED_PERMISSIONS = workbench/workorder/inspection/hours 四读码', () => {
    expect(OVERVIEW_REQUIRED_PERMISSIONS).toEqual([
      'workbench:read',
      'workorder:read',
      'inspection:read',
      'hours:read',
    ]);
  });
});
