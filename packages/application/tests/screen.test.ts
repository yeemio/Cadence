/**
 * 数字运营大屏域测试（A8/A10 首波，6a-3 裁决 4：screen 域零测试补齐）：
 *  - MachiningDailyStatsService / InMemoryMachiningDailyStatsStore：A10 日表
 *    「生成→刷新（覆盖）→唯一一天一行」幂等口径 + 降序窗口 + 租户收口；
 *  - DigitalOperationScreenService.buildFrame 核心口径抽样：小时桶（08~20 窗）、
 *    在制去重键（m:/o:/a: 前缀 COUNT DISTINCT）、小时合格前缀和、12 天产出
 *    缺日补 0、KPI 消费面（KPI⑥ 读 A10 最新行）、报工排名显示名回退、
 *    读面缺失 pendingFields='source' 占位登记（不虚构 0）；
 *  - 导出纯函数锚定：hourBucketOf / screenDispatchStatusCode / riskLevelOf。
 */
import { describe, expect, it } from 'vitest';
import { InspectionId, TenantId, UserId, WorkOrderId } from '@smes/business-core';
import {
  DigitalOperationScreenService,
  InMemoryMachiningDailyStatsStore,
  MACHINING_DAILY_PENDING_REASONS,
  MachiningDailyStatsService,
  hourBucketOf,
  riskLevelOf,
  screenDispatchStatusCode,
  type DispatchOrder,
  type InspectionOrder,
  type OutsourcingLine,
  type WorkOrder,
  type WorkReport,
} from '../src/index.js';

const tenant = TenantId.create('t1');
/** 锚定"今天"：2026-10-26（UTC）；小时桶/日窗断言全部围绕本值。 */
const NOW = '2026-10-26T12:00:00.000Z';
const TODAY = '2026-10-26';

// ---- 夹具构造（各实体最小合法形状 + 覆写） ----

function workOrder(fields: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: WorkOrderId.create('wo-1'),
    tenant,
    flowConfigId: 'wo-flow',
    state: 'released',
    objectVersion: 1,
    customerRef: null,
    projectName: 'P-1',
    salesRep: null,
    manager: null,
    plannedDeliveryAt: null,
    packagingArrivalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function dispatch(fields: Partial<DispatchOrder> & { kind: DispatchOrder['kind'] }): DispatchOrder {
  return {
    id: 'dsp-1',
    tenant,
    workOrderId: null,
    flowConfigId: 'dsp-flow',
    state: 'assigned',
    objectVersion: 1,
    title: 'T',
    drawingNo: null,
    operationCode: null,
    material: null,
    sizeSpec: null,
    quantity: 10,
    doneQty: 0,
    assignee: null,
    dueAt: null,
    remark: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function outsourcingLine(fields: Partial<OutsourcingLine> = {}): OutsourcingLine {
  return {
    id: 'osl-1',
    tenant,
    dispatchId: 'dsp-1',
    lineNo: 1,
    processCode: 'op-x',
    drawingNo: null,
    supplierRef: 'sup-1',
    supplierName: null,
    quantity: 1,
    unitPriceMinor: null,
    priceSource: null,
    marginPermyriad: null,
    promisedAt: null,
    sourceListingLineId: null,
    cancelledAt: null,
    cancelReason: null,
    objectVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function report(fields: Partial<WorkReport> = {}): WorkReport {
  return {
    id: 'wr-1',
    tenant,
    dispatchId: 'dsp-1',
    kind: 'part',
    flowConfigId: 'wr-flow',
    state: 'reported',
    objectVersion: 2,
    doneQty: 1,
    laborMinutes: 60,
    reporter: UserId.create('u-1'),
    workOrderId: null,
    drawingNo: null,
    operationCode: null,
    supersedes: null,
    businessTime: NOW,
    verifiedBy: null,
    verifiedAt: null,
    revokedBy: null,
    revokedAt: null,
    revokeReason: null,
    remark: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function inspection(fields: Partial<InspectionOrder> = {}): InspectionOrder {
  return {
    id: InspectionId.create('insp-1'),
    tenant,
    flowConfigId: 'insp-flow',
    state: 'pending',
    objectVersion: 1,
    kind: 'self_outsourced',
    sourceType: 'report',
    sourceRefId: null,
    itemId: null,
    drawingNo: null,
    quantity: 1,
    passedQty: null,
    failedQty: null,
    judgeRemark: null,
    judgedBy: null,
    judgedAt: null,
    closeDueAt: null,
    overdueNotifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

describe('A10 机加日统计（MachiningDailyStatsService + 内存存储）', () => {
  it('runDaily 缺省统计日 = 跑批时刻前一自然日（UTC）；dayOffset/statisticsDate 可显式覆盖', async () => {
    const service = new MachiningDailyStatsService(new InMemoryMachiningDailyStatsStore());
    const first = await service.runDaily(tenant, { now: NOW });
    expect(first.row.statisticsDate).toBe('2026-10-25');
    expect(first.created).toBe(true);

    const today = await service.runDaily(tenant, { now: NOW, dayOffset: 0 });
    expect(today.row.statisticsDate).toBe(TODAY);
    const explicit = await service.runDaily(tenant, { now: NOW, statisticsDate: '2026-10-01' });
    expect(explicit.row.statisticsDate).toBe('2026-10-01');
  });

  it('两指标读面缺失 = null + 冻结原因登记（不虚构数值）；重复跑幂等覆盖（created 分叉）', async () => {
    const service = new MachiningDailyStatsService(new InMemoryMachiningDailyStatsStore());
    const first = await service.runDaily(tenant, { now: NOW, statisticsDate: '2026-10-25' });
    expect(first.row.surfaceTreatmentDrawingCount).toBeNull();
    expect(first.row.pendingMachiningCount).toBeNull();
    expect(first.row.pendingReasons).toEqual(MACHINING_DAILY_PENDING_REASONS);
    expect(first.row.computedBy).toBe('machining-daily-job');

    const second = await service.runDaily(tenant, { now: NOW, statisticsDate: '2026-10-25' });
    expect(second.created).toBe(false); // 唯一天一行的 upsert 覆盖语义
    expect(second.row.computedAt).toBe(NOW);
  });

  it('listRecent 按统计日降序 + days 截断；findLatest 取最新行；租户收口', async () => {
    const store = new InMemoryMachiningDailyStatsStore();
    const service = new MachiningDailyStatsService(store);
    for (const day of ['2026-10-20', '2026-10-26', '2026-10-23']) {
      await service.runDaily(tenant, { now: NOW, statisticsDate: day });
    }
    // 另一租户的行不可见
    await service.runDaily(TenantId.create('t2'), { now: NOW, statisticsDate: '2026-10-26' });

    const recent = await service.listRecent(tenant, 2);
    expect(recent.map((row) => row.statisticsDate)).toEqual(['2026-10-26', '2026-10-23']);
    const latest = await service.findLatest(tenant);
    expect(latest?.statisticsDate).toBe('2026-10-26');
    expect((await store.listRecent(TenantId.create('t2'), 30))).toHaveLength(1);
  });
});

describe('DigitalOperationScreenService 核心口径抽样（buildFrame）', () => {
  it('小时桶：08~20 窗内入桶，窗外/非当日 null；13 槽 08:00~20:00', async () => {
    expect(hourBucketOf('2026-10-26T07:59:00.000Z', TODAY)).toBeNull();
    expect(hourBucketOf('2026-10-26T08:00:00.000Z', TODAY)).toBe(8);
    expect(hourBucketOf('2026-10-26T20:59:00.000Z', TODAY)).toBe(20);
    expect(hourBucketOf('2026-10-26T21:00:00.000Z', TODAY)).toBeNull();
    expect(hourBucketOf('2026-10-25T10:00:00.000Z', TODAY)).toBeNull();
    expect(hourBucketOf(null, TODAY)).toBeNull();

    const service = new DigitalOperationScreenService({});
    const frame = await service.buildFrame(tenant, NOW);
    expect(frame.payload.hourlyOutputWipPoints.map((point) => point.hourLabel)).toEqual([
      '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
      '15:00', '16:00', '17:00', '18:00', '19:00', '20:00',
    ]);
  });

  it('在制去重键：m:图号 同图号两单计 1；o: 明细行图号去重（跨单不重）；a:单id；窗内状态（assigned/executing/done）才入桶', async () => {
    const dispatches: DispatchOrder[] = [
      // 09 点两单同图号 DW-1（kind=part）→ m:DW-1 去重 = 1
      dispatch({ kind: 'part', id: 'dsp-m1', state: 'executing', drawingNo: 'DW-1', createdAt: '2026-10-26T09:05:00.000Z' }),
      dispatch({ kind: 'part', id: 'dsp-m2', state: 'assigned', drawingNo: 'DW-1', createdAt: '2026-10-26T09:30:00.000Z' }),
      // draft 不入桶（源口径 dispatch_status > 1）
      dispatch({ kind: 'part', id: 'dsp-m3', state: 'draft', drawingNo: 'DW-9', createdAt: '2026-10-26T09:40:00.000Z' }),
      // 10 点外协单：两明细行同图号 DW-2 计 1；无图号明细回退 i+id
      dispatch({ kind: 'outsourcing', id: 'dsp-o1', state: 'done', createdAt: '2026-10-26T10:00:00.000Z' }),
      // 11 点装配单 → a:dsp-a1
      dispatch({ kind: 'assembly', id: 'dsp-a1', state: 'executing', createdAt: '2026-10-26T11:00:00.000Z' }),
      // 售后单不进三域在制口径
      dispatch({ kind: 'aftermarket', id: 'dsp-x1', state: 'executing', createdAt: '2026-10-26T11:30:00.000Z' }),
    ];
    const outsourcingLines: OutsourcingLine[] = [
      outsourcingLine({ id: 'osl-1', dispatchId: 'dsp-o1', lineNo: 1, drawingNo: 'DW-2' }),
      outsourcingLine({ id: 'osl-2', dispatchId: 'dsp-o1', lineNo: 2, drawingNo: 'DW-2' }),
    ];
    const service = new DigitalOperationScreenService({
      dispatchOrders: { list: async () => dispatches },
      outsourcingLines: { listByDispatch: async (_tenant, dispatchId) => outsourcingLines.filter((line) => line.dispatchId === dispatchId) },
    });
    const { payload } = await service.buildFrame(tenant, NOW);
    const byHour = new Map(payload.hourlyOutputWipPoints.map((point) => [point.hourFrom, point.wipDrawingDistinctCount]));
    expect(byHour.get(9)).toBe(1); // m:DW-1 ×2 去重
    expect(byHour.get(10)).toBe(1); // o:DW-2 ×2 明细去重
    expect(byHour.get(11)).toBe(1); // a:dsp-a1（售后单不计）
    expect(payload.hourlyOutputWipPoints.every((point) => point.qualifiedQuantity === null)).toBe(true); // 质检面缺 → 整列占位
  });

  it('小时合格 + 待检入桶 + 累计前缀和（08:00 起含当前小时）；今日产出=自制报工质检合格 SUM', async () => {
    const inspections: InspectionOrder[] = [
      // 合格：09 点 3 件、11 点 2 件 → 前缀和 09=3 / 10=3 / 11=5
      inspection({ id: InspectionId.create('insp-p1'), state: 'passed', sourceType: 'report', judgedAt: '2026-10-26T09:10:00.000Z', passedQty: 3, createdAt: '2026-10-26T09:00:00.000Z' }),
      inspection({ id: InspectionId.create('insp-p2'), state: 'passed', sourceType: 'report', judgedAt: '2026-10-26T11:10:00.000Z', passedQty: 2, createdAt: '2026-10-26T10:50:00.000Z' }),
      // 待检：08 点收货待检 4 件（sourceType=receipt 三支之一）
      inspection({ id: InspectionId.create('insp-w1'), state: 'pending', sourceType: 'receipt', quantity: 4, createdAt: '2026-10-26T08:20:00.000Z' }),
      // 手工建单 sourceType=null → 不进待检口径
      inspection({ id: InspectionId.create('insp-w2'), state: 'pending', sourceType: null, quantity: 9, createdAt: '2026-10-26T08:30:00.000Z' }),
      // 昨日合格不计入当日
      inspection({ id: InspectionId.create('insp-p3'), state: 'passed', sourceType: 'report', judgedAt: '2026-10-25T09:10:00.000Z', passedQty: 7, createdAt: '2026-10-25T09:00:00.000Z' }),
    ];
    const service = new DigitalOperationScreenService({
      inspections: { list: async () => inspections },
    });
    const { payload } = await service.buildFrame(tenant, NOW);
    const cumulative = payload.hourlyInboundInspectionPoints.map((point) => point.cumulativeQualifiedInspectionQuantity);
    expect(cumulative[1]).toBe(3); // 09:00 含 3
    expect(cumulative[2]).toBe(3); // 10:00 前缀和保持
    expect(cumulative[3]).toBe(5); // 11:00 累入 2
    const pendingByHour = new Map(payload.hourlyInboundInspectionPoints.map((point) => [point.hourFrom, point.pendingInspectionQuantity]));
    expect(pendingByHour.get(8)).toBe(4); // 收货待检 4；手工建单 null 不计
    // 今日产出 = state=passed ∧ kind=self_outsourced ∧ sourceType=report 当日判定 SUM
    expect(payload.machiningOnlineSnapshot.todayQualifiedOutputQuantity).toBe(5);
  });

  it('12 天产出折线：reported/verified 计、revoked 不计、缺日补 0、窗含当天', async () => {
    const reports: WorkReport[] = [
      report({ id: 'wr-1', state: 'reported', doneQty: 3, businessTime: '2026-10-26T08:00:00.000Z' }),
      report({ id: 'wr-2', state: 'verified', doneQty: 4, businessTime: '2026-10-24T08:00:00.000Z' }),
      report({ id: 'wr-3', state: 'revoked', doneQty: 100, businessTime: '2026-10-26T09:00:00.000Z' }),
    ];
    const service = new DigitalOperationScreenService({ workReports: { list: async () => reports } });
    const { payload } = await service.buildFrame(tenant, NOW);
    expect(payload.dailyProductionOutputByWorkReport).toHaveLength(12);
    const byDate = new Map(payload.dailyProductionOutputByWorkReport.map((point) => [point.date, point.quantity]));
    expect(byDate.get('2026-10-26')).toBe(3); // revoked 冲销不计
    expect(byDate.get('2026-10-24')).toBe(4);
    expect(byDate.get('2026-10-15')).toBe(0); // 缺日补 0（窗口首日）
    expect(byDate.get('2026-10-14')).toBeUndefined(); // 窗外不出点
  });

  it('KPI：计划/已发/在制按月与状态；KPI⑥ 读 A10 最新行；排名显示名端口缺省回退 reporter id', async () => {
    const daily = new InMemoryMachiningDailyStatsStore();
    await new MachiningDailyStatsService(daily).runDaily(tenant, { now: NOW, statisticsDate: '2026-10-20' });
    const workOrders: WorkOrder[] = [
      workOrder({ id: WorkOrderId.create('wo-a'), state: 'released', plannedDeliveryAt: '2026-10-10', packagingArrivalAt: '2026-10-12' }),
      workOrder({ id: WorkOrderId.create('wo-b'), state: 'released', plannedDeliveryAt: '2026-11-01' }), // 下月计划不计
      workOrder({ id: WorkOrderId.create('wo-c'), state: 'completed', plannedDeliveryAt: '2026-10-20' }), // 完成不在制
      workOrder({ id: WorkOrderId.create('wo-d'), state: 'closed' }),
    ];
    const reports: WorkReport[] = [
      report({ id: 'wr-u1a', reporter: UserId.create('u-1'), doneQty: 5, businessTime: '2026-10-26T08:00:00.000Z' }),
      report({ id: 'wr-u1b', reporter: UserId.create('u-1'), doneQty: 2, businessTime: '2026-10-26T09:00:00.000Z' }),
      report({ id: 'wr-u2', reporter: UserId.create('u-2'), doneQty: 9, businessTime: '2026-10-26T08:30:00.000Z' }),
    ];
    const service = new DigitalOperationScreenService({
      workOrders: { list: async () => workOrders },
      workReports: { list: async () => reports },
      machiningDailyStats: daily,
    });
    const { payload } = await service.buildFrame(tenant, NOW);
    expect(payload.kpi.monthlyPlannedDeliverySets).toBe(2); // wo-a + wo-c（wo-b 下月）
    expect(payload.kpi.monthlyDeliveredSets).toBe(1); // wo-a packagingArrivalAt 当月
    expect(payload.kpi.inProgressWorkOrders).toBe(2); // wo-a + wo-b（released 非完成/关闭；wo-c/wo-d 出局）
    expect(payload.kpi.pendingMachiningDrawingCount).toBeNull(); // A10 读面缺失两指标 null → 占位（不虚构）
    expect(payload.pendingFields['kpi.pendingMachiningDrawingCount']).toBe('source');
    // 排名：u-2 9 件第一；显示名端口缺 → 回退 reporter id
    expect(payload.todayWorkReportRankRows).toEqual([
      { userName: 'u-2', reporter: 'u-2', quantity: 9 },
      { userName: 'u-1', reporter: 'u-1', quantity: 7 },
    ]);
  });

  it('读面缺失 → 块级 source 占位登记（null 不静默 0）；definition 占位常驻', async () => {
    const service = new DigitalOperationScreenService({});
    const { payload } = await service.buildFrame(tenant, NOW);
    expect(payload.kpi.monthlyPlannedDeliverySets).toBeNull();
    expect(payload.pendingFields['kpi.monthlyPlannedDeliverySets']).toBe('source');
    expect(payload.pendingFields['projectProgressRows']).toBe('source');
    expect(payload.pendingFields['hourlyInboundInspectionPoints.pendingStorageQuantity']).toBe('source');
    // definition 占位（源文档自承假数据）：值照常生成 + 登记
    expect(payload.pendingFields['kpi.milestoneOnTimeRate']).toBe('definition');
    expect(payload.pendingFields['topBar.sixSScore']).toBe('definition');
    expect(typeof payload.topBar.sixSScore).toBe('number');
  });
});

describe('纯函数锚定（状态码表 / 延期风险分档）', () => {
  it('screenDispatchStatusCode：draft=1/assigned=2/executing=3/done=4；cancelled/未知 null', () => {
    expect(screenDispatchStatusCode('draft')).toBe(1);
    expect(screenDispatchStatusCode('assigned')).toBe(2);
    expect(screenDispatchStatusCode('executing')).toBe(3);
    expect(screenDispatchStatusCode('done')).toBe(4);
    expect(screenDispatchStatusCode('cancelled')).toBeNull();
    expect(screenDispatchStatusCode('whatever')).toBeNull();
  });

  it('riskLevelOf：§2.3 选项 A 分档（低 0~7 / 中 8~14 / 高 ≥15 或已逾期；无计划 null）', () => {
    const order = (planned: string | null): WorkOrder => workOrder({ plannedDeliveryAt: planned });
    expect(riskLevelOf(order('2026-10-26'), TODAY)).toBe('low'); // 当天 R=0
    expect(riskLevelOf(order('2026-11-02'), TODAY)).toBe('low'); // R=7 端点
    expect(riskLevelOf(order('2026-11-03'), TODAY)).toBe('mid'); // R=8
    expect(riskLevelOf(order('2026-11-09'), TODAY)).toBe('mid'); // R=14 端点
    expect(riskLevelOf(order('2026-11-10'), TODAY)).toBe('high'); // R=15
    expect(riskLevelOf(order('2026-10-25'), TODAY)).toBe('high'); // 已逾期 R<0
    expect(riskLevelOf(order(null), TODAY)).toBeNull();
  });
});
