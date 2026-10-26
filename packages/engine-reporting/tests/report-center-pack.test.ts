/**
 * 报表中心口径包测试（U 波 r2/r7/r12/r13）：包形状与幂等 + 逐报表求值口径
 * （夹具按各 metric description 的源适配器物化字段构造——引擎只认行形状）。
 */
import { describe, expect, it } from 'vitest';
import { defineMetricPack, evaluateMetric, findMetric, type MetricSourceRow } from '../src/index.js';
import { REPORT_CENTER_PACK, REPORT_CENTER_PACK_ID } from '../src/packs/report-center-pack.js';

const OCTOBER = { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' };
const SEPTEMBER = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' };

describe('报表中心口径包 · 包形状', () => {
  it('九条口径（六报表：日/月、主表/子表、明细行快照、汇总/下钻粒度分立）冻结且 metricId 唯一', () => {
    expect(REPORT_CENTER_PACK.packId).toBe(REPORT_CENTER_PACK_ID);
    expect(REPORT_CENTER_PACK.version).toBe(3); // v2 纯追加 r8；v3 纯追加 r9+r7 下钻，既有不变
    expect(REPORT_CENTER_PACK.metrics.map((metric) => `${metric.metricId}@v${metric.version}`)).toEqual([
      'work-order-delivery@v1',
      'outsource-delivery-monthly@v1',
      'quality-summary-daily@v1',
      'quality-summary-monthly@v1',
      'hours-summary-daily@v1',
      'hours-summary-process@v1',
      'purchase-overdue-daily@v1',
      'purchase-parts-summary@v1',
      'outsource-delivery-late-detail@v1',
    ]);
    expect(Object.isFrozen(REPORT_CENTER_PACK)).toBe(true);
    expect(Object.isFrozen(REPORT_CENTER_PACK.metrics)).toBe(true);
  });

  it('findMetric 按口径引用命中；序列化往返再构包等价（幂等）', () => {
    expect(findMetric(REPORT_CENTER_PACK, 'quality-summary-monthly', 1)?.display).toContain('按月');
    expect(findMetric(REPORT_CENTER_PACK, 'quality-summary-monthly', 2)).toBeUndefined();
    const rebuilt = defineMetricPack(JSON.parse(JSON.stringify(REPORT_CENTER_PACK)) as unknown);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(REPORT_CENTER_PACK));
  });
});

describe('r2 工作令交付（work-order-delivery）', () => {
  /** businessTime=实际交付（wo2 未交付 businessTime 缺失→回落 occurredAt）。 */
  const rows: MetricSourceRow[] = [
    {
      occurredAt: '2026-09-01T08:00:00Z', businessTime: '2026-10-05T00:00:00Z',
      workOrderNo: 'WO-001', workOrderName: '项目甲', workOrderStatus: 8,
      planDeliveryDate: '2026-09-30', actualDeliveryDate: '2026-10-05',
    },
    {
      occurredAt: '2026-10-10T08:00:00Z',
      workOrderNo: 'WO-002', workOrderName: '项目乙', workOrderStatus: 2,
      planDeliveryDate: '2026-10-20', actualDeliveryDate: null,
    },
    {
      occurredAt: '2026-08-15T08:00:00Z', businessTime: '2026-09-20T00:00:00Z',
      workOrderNo: 'WO-003', workOrderName: '项目丙', workOrderStatus: 8,
      planDeliveryDate: '2026-09-10', actualDeliveryDate: '2026-09-20',
    },
  ];

  it('一行一工作令：business 窗口=实际交付月，未交付行回落创建时刻入窗，空实际交付为 null 键', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'work-order-delivery', 1);
    expect(definition).toBeDefined();
    const result = evaluateMetric(definition!, { metricId: 'work-order-delivery', version: 1, ...OCTOBER }, rows);
    expect(result.rows.map((row) => row.key.workOrderNo)).toEqual(['WO-001', 'WO-002']);
    expect(result.rows[0]?.key.actualDeliveryDate).toBe('2026-10-05');
    expect(result.rows[1]?.key.actualDeliveryDate).toBeNull(); // Web 显示「—」
    expect(result.rows.map((row) => row.values['work-order-count'])).toEqual([1, 1]);
  });

  it('查询层过滤：状态多选（in-set）与计划交付范围（range）独立作用', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'work-order-delivery', 1)!;
    const byStatus = evaluateMetric(
      definition,
      {
        metricId: 'work-order-delivery', version: 1, ...OCTOBER,
        filter: { kind: 'in-set', field: 'workOrderStatus', values: [8] },
      },
      rows,
    );
    expect(byStatus.rows.map((row) => row.key.workOrderNo)).toEqual(['WO-001']);
    const byPlanRange = evaluateMetric(
      definition,
      {
        metricId: 'work-order-delivery', version: 1, ...OCTOBER,
        filter: { kind: 'range', field: 'planDeliveryDate', min: '2026-10-01', max: '2026-10-31' },
      },
      rows,
    );
    expect(byPlanRange.rows.map((row) => row.key.workOrderNo)).toEqual(['WO-002']);
  });
});

describe('r7 外协交货汇总（outsource-delivery-monthly）', () => {
  /**
   * 明细行夹具（源适配器已物化：statMonth/drawingKey/lateDrawingKey/逾期判定按
   * asOfDate=2026-10-24 快照）。r5 状态未下发、r6 计划交货日空 → 根过滤剔除。
   */
  const rows: MetricSourceRow[] = [
    { // O1·S1·D1 已质检且按期（qc 09-09 ≤ planned 09-10）
      occurredAt: '2026-09-01T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O1', drawingKey: 'W1::D1', lateDrawingKey: null,
      dispatchStatus: 2, dispatchTime: '2026-09-01T08:00:00Z', plannedDeliveryDate: '2026-09-10',
    },
    { // O2·S1·同工作令同图号 D1 再派工：未质检且 asOf 10-24 > planned 09-10 → 逾期；drawingKey 去重仍计 1
      occurredAt: '2026-09-02T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O2', drawingKey: 'W1::D1', lateDrawingKey: 'W1::D1',
      dispatchStatus: 2, dispatchTime: '2026-09-02T08:00:00Z', plannedDeliveryDate: '2026-09-10',
    },
    { // O2·S1·D2 已质检但 qc 09-15 > planned 09-10 → 逾期
      occurredAt: '2026-09-02T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O2', drawingKey: 'W2::D2', lateDrawingKey: 'W2::D2',
      dispatchStatus: 2, dispatchTime: '2026-09-02T08:00:00Z', plannedDeliveryDate: '2026-09-10',
    },
    { // O3·S2·D3 未质检但 asOf 10-24 < planned 11-05 → 未逾期
      occurredAt: '2026-10-20T08:00:00Z', businessTime: '2026-11-05T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-11', supplierId: 'S2', orderId: 'O3', drawingKey: 'W3::D3', lateDrawingKey: null,
      dispatchStatus: 2, dispatchTime: '2026-10-20T08:00:00Z', plannedDeliveryDate: '2026-11-05',
    },
    { // O4·S2·图号空 → drawingKey 按明细行唯一键物化；已质检按期
      occurredAt: '2026-10-21T08:00:00Z', businessTime: '2026-11-05T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-11', supplierId: 'S2', orderId: 'O4', drawingKey: 'item:707', lateDrawingKey: null,
      dispatchStatus: 2, dispatchTime: '2026-10-21T08:00:00Z', plannedDeliveryDate: '2026-11-05',
    },
    { // 未下发（status 1）→ 根过滤剔除
      occurredAt: '2026-09-03T08:00:00Z', businessTime: '2026-09-10T00:00:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O5', drawingKey: 'W1::D9', lateDrawingKey: null,
      dispatchStatus: 1, dispatchTime: null, plannedDeliveryDate: '2026-09-10',
    },
    { // 计划交货日空 → 根过滤剔除
      occurredAt: '2026-09-04T08:00:00Z',
      statMonth: null, supplierId: 'S1', orderId: 'O6', drawingKey: 'W1::D8', lateDrawingKey: null,
      dispatchStatus: 2, dispatchTime: '2026-09-04T08:00:00Z', plannedDeliveryDate: null,
    },
  ];

  it('月×供应商分组：单数去重、图号去重（同工作令同图号计 1、空图号按行）、逾期键去重', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'outsource-delivery-monthly', 1)!;
    const result = evaluateMetric(definition, { metricId: 'outsource-delivery-monthly', version: 1 }, rows);
    expect(result.rows.length).toBe(2); // (2026-09,S1) (2026-11,S2)；O5/O6 行被根过滤剔除
    const sepS1 = result.rows.find((row) => row.key.statMonth === '2026-09' && row.key.supplierId === 'S1');
    expect(sepS1?.values).toEqual({ 'order-count': 2, 'drawing-total': 2, 'late-drawing-total': 2 });
    const novS2 = result.rows.find((row) => row.key.statMonth === '2026-11' && row.key.supplierId === 'S2');
    expect(novS2?.values).toEqual({ 'order-count': 2, 'drawing-total': 2, 'late-drawing-total': 0 });
    // 按期率派生（呈现层）：S1 = (2-2)/2 = 0；S2 = (2-0)/2 = 100%
  });

  it('business 窗口锚计划交货月：9 月窗只剩 S1 组', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'outsource-delivery-monthly', 1)!;
    const result = evaluateMetric(
      definition,
      { metricId: 'outsource-delivery-monthly', version: 1, ...SEPTEMBER },
      rows,
    );
    expect(result.rows.map((row) => `${row.key.statMonth}:${row.key.supplierId}`)).toEqual(['2026-09:S1']);
  });
});

describe('r12 质检汇总 · 按日/按月（quality-summary-daily / monthly）', () => {
  /** 三源事实夹具：d 行 completed=false（待质检）→ 根过滤剔除；c 行图号空不计图号去重。 */
  const rows: MetricSourceRow[] = [
    { occurredAt: '2026-09-01T06:00:00Z', businessTime: '2026-09-01T10:00:00Z', inspectDate: '2026-09-01', statMonth: '2026-09', drawingNo: 'D1', inspectQty: 10, unqualifiedQty: 2, completed: true },
    { occurredAt: '2026-09-01T06:30:00Z', businessTime: '2026-09-01T11:00:00Z', inspectDate: '2026-09-01', statMonth: '2026-09', drawingNo: 'D1', inspectQty: 5, unqualifiedQty: 0, completed: true },
    { occurredAt: '2026-09-01T07:00:00Z', businessTime: '2026-09-01T12:00:00Z', inspectDate: '2026-09-01', statMonth: '2026-09', drawingNo: null, inspectQty: 3, unqualifiedQty: 1, completed: true },
    { occurredAt: '2026-09-01T08:00:00Z', businessTime: '2026-09-01T13:00:00Z', inspectDate: '2026-09-01', statMonth: '2026-09', drawingNo: 'D2', inspectQty: 4, unqualifiedQty: 0, completed: false },
    { occurredAt: '2026-09-02T06:00:00Z', businessTime: '2026-09-02T10:00:00Z', inspectDate: '2026-09-02', statMonth: '2026-09', drawingNo: 'D1', inspectQty: 2, unqualifiedQty: 0, completed: true },
  ];

  it('按日：当日去重图号（空图号跳过）、数量合计；无质检日不产行', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'quality-summary-daily', 1)!;
    const result = evaluateMetric(definition, { metricId: 'quality-summary-daily', version: 1 }, rows);
    expect(result.rows.length).toBe(2);
    const day1 = result.rows.find((row) => row.key.inspectDate === '2026-09-01');
    // a/b 同图号 D1 去重计 1；c 空图号跳过；d 待质检整行剔除
    expect(day1?.values).toEqual({ 'drawing-count': 1, 'total-qty': 18, 'unqualified-qty': 3 });
    const day2 = result.rows.find((row) => row.key.inspectDate === '2026-09-02');
    expect(day2?.values).toEqual({ 'drawing-count': 1, 'total-qty': 2, 'unqualified-qty': 0 });
  });

  it('按月：当月去重图号 ≠ 各日图号数相加（1 ≠ 2+1）；数量为当月合计', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'quality-summary-monthly', 1)!;
    const result = evaluateMetric(definition, { metricId: 'quality-summary-monthly', version: 1 }, rows);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.key.statMonth).toBe('2026-09');
    expect(result.rows[0]?.values).toEqual({ 'drawing-count': 1, 'total-qty': 20, 'unqualified-qty': 3 });
  });
});

describe('r13 工时汇总 · 主表/工序子表（hours-summary-daily / process）', () => {
  /** 岗位报工夹具：m2 机加工无法解析工序（processId null，工时仍进主表）；m3 未审核被根过滤剔除。 */
  const rows: MetricSourceRow[] = [
    { occurredAt: '2026-09-01T18:00:00Z', businessTime: '2026-09-01T17:00:00Z', position: 1, statDate: '2026-09-01', hours: 1.5, approvalStatus: 2, processId: 'p10' },
    { occurredAt: '2026-09-01T18:10:00Z', businessTime: '2026-09-01T17:10:00Z', position: 1, statDate: '2026-09-01', hours: 0.5, approvalStatus: 2, processId: null },
    { occurredAt: '2026-09-01T18:20:00Z', businessTime: '2026-09-01T17:20:00Z', position: 1, statDate: '2026-09-01', hours: 9, approvalStatus: 1, processId: 'p20' },
    { occurredAt: '2026-09-01T18:30:00Z', businessTime: '2026-09-01T16:30:00Z', position: 2, statDate: '2026-09-01', hours: 2, approvalStatus: 2, processId: null },
    { occurredAt: '2026-09-02T18:00:00Z', businessTime: '2026-09-02T17:00:00Z', position: 3, statDate: '2026-09-02', hours: 3, approvalStatus: 2, processId: null },
  ];

  it('主表：岗位×日合计含无法解析工序工时；未审核剔除；无数据日不产行', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'hours-summary-daily', 1)!;
    const result = evaluateMetric(definition, { metricId: 'hours-summary-daily', version: 1 }, rows);
    expect(result.rows.map((row) => `${row.key.position}:${row.key.statDate}:${String(row.values['total-hours'])}`)).toEqual([
      '1:2026-09-01:2',
      '2:2026-09-01:2',
      '3:2026-09-02:3',
    ]);
  });

  it('工序子表：仅机加工已审核且工序可解行；按 processId 归集', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'hours-summary-process', 1)!;
    const result = evaluateMetric(definition, { metricId: 'hours-summary-process', version: 1 }, rows);
    expect(result.rows.map((row) => `${row.key.processId}:${row.key.statDate}:${String(row.values['work-hours'])}`)).toEqual([
      'p10:2026-09-01:1.5',
    ]);
  });

  it('按月=呈现层粗化前的同口径窗口 SUM：9 月窗主表逐岗位合计可由日行精确加总', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'hours-summary-daily', 1)!;
    const result = evaluateMetric(definition, { metricId: 'hours-summary-daily', version: 1, ...SEPTEMBER }, rows);
    const byPosition = new Map<number, number>();
    for (const row of result.rows) {
      byPosition.set(row.key.position as number, (byPosition.get(row.key.position as number) ?? 0) + (row.values['total-hours'] as number));
    }
    expect([...byPosition.entries()].sort()).toEqual([[1, 2], [2, 2], [3, 3]]);
  });
});

describe('r8 逾期交货采购件（purchase-overdue-daily）', () => {
  /**
   * 明细行日快照夹具（源适配器物化自跑批结果表，statDate=2026-10-24 一批）：
   * L1 逾期未收齐（部分收货）；L2 手工清单行（无工作令/图号 → null 组）；
   * L3 已收齐但晚于计划到货日完成（固化留存，unInboundQty=0）；
   * L4 违反快照面不变量的行（overdueQty=0）→ 根过滤剔除。
   */
  const rows: MetricSourceRow[] = [
    {
      occurredAt: '2026-10-24T00:10:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:10:00Z',
      orderLineId: 'po-1#1', purchaseOrderId: 'po-1', workOrderId: 'wo-1', partType: 1,
      drawingNo: 'DWG-A', itemId: 'item-a', purchaseDate: '2026-08-01', planArrivalDate: '2026-09-10',
      purchaseQty: 10, unInboundQty: 4, overdueQty: 6, supplierName: '供应商甲', statDate: '2026-10-24',
    },
    {
      occurredAt: '2026-10-24T00:10:00Z', businessTime: '2026-10-05T00:00:00Z', availableTime: '2026-10-24T00:10:00Z',
      orderLineId: 'po-2#1', purchaseOrderId: 'po-2', workOrderId: null, partType: 4,
      drawingNo: null, itemId: 'item-m', purchaseDate: '2026-09-25', planArrivalDate: '2026-10-05',
      purchaseQty: 5, unInboundQty: 5, overdueQty: 5, supplierName: '供应商乙', statDate: '2026-10-24',
    },
    {
      occurredAt: '2026-10-24T00:10:00Z', businessTime: '2026-09-20T00:00:00Z', availableTime: '2026-10-24T00:10:00Z',
      orderLineId: 'po-3#2', purchaseOrderId: 'po-3', workOrderId: 'wo-2', partType: 3,
      drawingNo: 'DWG-C', itemId: 'item-c', purchaseDate: '2026-08-10', planArrivalDate: '2026-09-20',
      purchaseQty: 8, unInboundQty: 0, overdueQty: 8, supplierName: '供应商甲', statDate: '2026-10-24',
    },
    {
      occurredAt: '2026-10-24T00:10:00Z', businessTime: '2026-09-15T00:00:00Z', availableTime: '2026-10-24T00:10:00Z',
      orderLineId: 'po-4#1', purchaseOrderId: 'po-4', workOrderId: 'wo-1', partType: 2,
      drawingNo: null, itemId: 'item-d', purchaseDate: '2026-08-20', planArrivalDate: '2026-09-15',
      purchaseQty: 3, unInboundQty: 0, overdueQty: 0, supplierName: '供应商丙', statDate: '2026-10-24',
    },
  ];

  it('一行一明细行：固化留存行（unInbound=0, overdueQty>0）保留；overdueQty=0 违反快照面不变量被根过滤剔除；手工行 null 组', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'purchase-overdue-daily', 1)!;
    const result = evaluateMetric(definition, { metricId: 'purchase-overdue-daily', version: 1 }, rows);
    expect(result.rows.map((row) => row.key.orderLineId)).toEqual(['po-1#1', 'po-2#1', 'po-3#2']); // L4 剔除
    expect(result.rows.map((row) => row.values)).toEqual([
      { 'purchase-qty': 10, 'un-inbound-qty': 4, 'overdue-qty': 6 },
      { 'purchase-qty': 5, 'un-inbound-qty': 5, 'overdue-qty': 5 },
      { 'purchase-qty': 8, 'un-inbound-qty': 0, 'overdue-qty': 8 },
    ]);
    const manual = result.rows[1]?.key;
    expect(manual?.workOrderId).toBeNull(); // 手工清单无工作令 → null 组（Web 显示「—」）
    expect(manual?.drawingNo).toBeNull();
    expect(manual?.partType).toBe(4);
  });

  it('Web 清单来源筛选 = partType 维度切片：单选 4 只剩手工清单行', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'purchase-overdue-daily', 1)!;
    const result = evaluateMetric(
      definition,
      { metricId: 'purchase-overdue-daily', version: 1, dimensionSlice: { partType: [4] } },
      rows,
    );
    expect(result.rows.map((row) => row.key.orderLineId)).toEqual(['po-2#1']);
  });

  it('工作令筛选（查询过滤 workOrderId 非空）不含手工行；business 窗口锚计划到货月（9 月窗只剩 9 月到货行）', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'purchase-overdue-daily', 1)!;
    const byWorkOrder = evaluateMetric(
      definition,
      { metricId: 'purchase-overdue-daily', version: 1, filter: { kind: 'compare', op: 'ne', field: 'workOrderId', value: null } },
      rows,
    );
    expect(byWorkOrder.rows.map((row) => row.key.orderLineId)).toEqual(['po-1#1', 'po-3#2']);
    const september = evaluateMetric(
      definition,
      { metricId: 'purchase-overdue-daily', version: 1, ...SEPTEMBER },
      rows,
    );
    expect(september.rows.map((row) => row.key.orderLineId)).toEqual(['po-1#1', 'po-3#2']); // L2 计划到货 10-05 出窗
  });
});

describe('r9 采购件情况汇总（purchase-parts-summary）', () => {
  /**
   * 事实行夹具（源适配器已物化：lineAmountMinor = receivedQty × unitPriceMinor
   * half-up 到分；partType 两分；draft 态订单与未定价行不归集——行集取舍在
   * 源侧，引擎只认行形状）。businessTime = 订单承诺到货时刻。
   */
  const rows: MetricSourceRow[] = [
    { // wo-1×非标件：po-1 一行
      occurredAt: '2026-09-01T08:00:00Z', businessTime: '2026-09-20T00:00:00Z',
      workOrderId: 'wo-1', partType: 'drawing-part', orderId: 'po-1', orderLineId: 'po-1#1',
      lineAmountMinor: 10000,
    },
    { // wo-1×非标件：po-2 首行（同单两行 → order-count 去重计 1、金额累加）
      occurredAt: '2026-09-05T08:00:00Z', businessTime: '2026-10-10T00:00:00Z',
      workOrderId: 'wo-1', partType: 'drawing-part', orderId: 'po-2', orderLineId: 'po-2#1',
      lineAmountMinor: 5000,
    },
    { // wo-1×非标件：po-2 次行
      occurredAt: '2026-09-05T08:00:00Z', businessTime: '2026-10-10T00:00:00Z',
      workOrderId: 'wo-1', partType: 'drawing-part', orderId: 'po-2', orderLineId: 'po-2#2',
      lineAmountMinor: 3000,
    },
    { // wo-1×标准件（同单跨类目行 → 独立分组）
      occurredAt: '2026-09-06T08:00:00Z', businessTime: '2026-10-10T00:00:00Z',
      workOrderId: 'wo-1', partType: 'standard-part', orderId: 'po-2', orderLineId: 'po-2#3',
      lineAmountMinor: 2000,
    },
    { // 无工作令（手工类目 → null 组，Web 显示「—」）
      occurredAt: '2026-10-01T08:00:00Z', businessTime: '2026-11-01T00:00:00Z',
      workOrderId: null, partType: 'standard-part', orderId: 'po-3', orderLineId: 'po-3#1',
      lineAmountMinor: 800,
    },
  ];

  it('工作令×零件类型：一张采购单跨行只计一次（distinct-count）；金额按分合计；无工作令落 null 组', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'purchase-parts-summary', 1)!;
    const result = evaluateMetric(definition, { metricId: 'purchase-parts-summary', version: 1 }, rows);
    expect(result.rows.map((row) => `${String(row.key.workOrderId)}:${String(row.key.partType)}`)).toEqual([
      'wo-1:drawing-part',
      'wo-1:standard-part',
      'null:standard-part',
    ]);
    const drawing = result.rows.find((row) => row.key.workOrderId === 'wo-1' && row.key.partType === 'drawing-part');
    expect(drawing?.values).toEqual({ 'purchase-amount-minor': 18000, 'order-count': 2 }); // po-1 + po-2（po-2 两行计 1）
    const standard = result.rows.find((row) => row.key.workOrderId === 'wo-1' && row.key.partType === 'standard-part');
    expect(standard?.values).toEqual({ 'purchase-amount-minor': 2000, 'order-count': 1 });
    const noWorkOrder = result.rows.find((row) => row.key.workOrderId === null);
    expect(noWorkOrder?.values).toEqual({ 'purchase-amount-minor': 800, 'order-count': 1 });
  });

  it('business 窗口锚承诺到货：10 月窗只剩 po-2 三行（同单两非标行去重计 1）', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'purchase-parts-summary', 1)!;
    const result = evaluateMetric(
      definition,
      { metricId: 'purchase-parts-summary', version: 1, ...OCTOBER },
      rows,
    );
    expect(result.rows.map((row) => `${String(row.key.workOrderId)}:${String(row.key.partType)}`)).toEqual([
      'wo-1:drawing-part',
      'wo-1:standard-part',
    ]);
    expect(result.rows[0]?.values).toEqual({ 'purchase-amount-minor': 8000, 'order-count': 1 }); // 5000+3000，po-2 去重计 1
  });
});

describe('r7 下钻 未按期交货明细（outsource-delivery-late-detail）', () => {
  /**
   * 明细行夹具（源适配器已物化，统计截止日 asOf=2026-10-24——与 r7 主口径
   * 夹具同一批派工事实）：
   * L1/L2 同键两行（O2×D2×OP10 同计划/实际交货日）→ 合并 line-count=2；
   * L3 未质检逾期（asOf 10-24 > 计划 09-10，迟 14 日）→ 实际交货日 null 组；
   * L4 未逾期（lateDrawingKey null）→ 根过滤剔除；L5 未下发（status 1）→ 剔除。
   */
  const rows: MetricSourceRow[] = [
    { // O2×D2 已质检 09-15 > 计划 09-10 → 迟 5 日（行 1）
      occurredAt: '2026-09-02T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O2', drawingNo: 'D2', processCode: 'OP10',
      plannedDeliveryDate: '2026-09-10', actualInspectDate: '2026-09-15',
      drawingKey: 'W2::D2', lateDrawingKey: 'W2::D2', lateDays: 5,
      dispatchStatus: 2, dispatchTime: '2026-09-02T08:00:00Z', lineId: 'l-1',
    },
    { // O2×D2 同键第二行（line-count 计 2；late-days 同值 max）
      occurredAt: '2026-09-02T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O2', drawingNo: 'D2', processCode: 'OP10',
      plannedDeliveryDate: '2026-09-10', actualInspectDate: '2026-09-15',
      drawingKey: 'W2::D2', lateDrawingKey: 'W2::D2', lateDays: 5,
      dispatchStatus: 2, dispatchTime: '2026-09-02T08:00:00Z', lineId: 'l-2',
    },
    { // O2×D1 未质检、asOf 10-24 > 计划 09-10 → 迟 14 日；实际交货日 null 组
      occurredAt: '2026-09-02T08:00:00Z', businessTime: '2026-09-10T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O2', drawingNo: 'D1', processCode: 'OP10',
      plannedDeliveryDate: '2026-09-10', actualInspectDate: null,
      drawingKey: 'W1::D1', lateDrawingKey: 'W1::D1', lateDays: 14,
      dispatchStatus: 2, dispatchTime: '2026-09-02T08:00:00Z', lineId: 'l-3',
    },
    { // O3×D3 未质检且 asOf 10-24 < 计划 11-05 → 未逾期（lateDrawingKey null）→ 根过滤剔除
      occurredAt: '2026-10-20T08:00:00Z', businessTime: '2026-11-05T00:00:00Z', availableTime: '2026-10-24T00:05:00Z',
      statMonth: '2026-11', supplierId: 'S2', orderId: 'O3', drawingNo: 'D3', processCode: 'OP20',
      plannedDeliveryDate: '2026-11-05', actualInspectDate: null,
      drawingKey: 'W3::D3', lateDrawingKey: null, lateDays: null,
      dispatchStatus: 2, dispatchTime: '2026-10-20T08:00:00Z', lineId: 'l-4',
    },
    { // O5 未下发（status 1）→ 根过滤剔除
      occurredAt: '2026-09-03T08:00:00Z', businessTime: '2026-09-10T00:00:00Z',
      statMonth: '2026-09', supplierId: 'S1', orderId: 'O5', drawingNo: 'D9', processCode: 'OP10',
      plannedDeliveryDate: '2026-09-10', actualInspectDate: null,
      drawingKey: 'W1::D9', lateDrawingKey: 'W1::D9', lateDays: 21,
      dispatchStatus: 1, dispatchTime: null, lineId: 'l-5',
    },
  ];

  it('仅未按期行：同键多行合并（line-count=2、late-days 同值 max）；未质检逾期实际交货日落 null 组', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'outsource-delivery-late-detail', 1)!;
    const result = evaluateMetric(definition, { metricId: 'outsource-delivery-late-detail', version: 1 }, rows);
    expect(
      result.rows.map(
        (row) => `${row.key.supplierId}:${String(row.key.orderId)}:${String(row.key.drawingNo)}:${String(row.key.actualInspectDate)}`,
      ),
    ).toEqual(['S1:O2:D2:2026-09-15', 'S1:O2:D1:null']); // L4 未逾期、L5 未下发 → 剔除
    expect(result.rows[0]?.values).toEqual({ 'late-days': 5, 'line-count': 2 }); // L1+L2 同键合并
    expect(result.rows[1]?.values).toEqual({ 'late-days': 14, 'line-count': 1 });
  });

  it('business 窗口锚计划交货月：11 月窗空（唯一 11 月行本就未逾期被根过滤剔除）', () => {
    const definition = findMetric(REPORT_CENTER_PACK, 'outsource-delivery-late-detail', 1)!;
    const result = evaluateMetric(
      definition,
      {
        metricId: 'outsource-delivery-late-detail', version: 1,
        from: '2026-11-01T00:00:00Z', to: '2026-11-30T23:59:59Z',
      },
      rows,
    );
    expect(result.rows).toEqual([]);
  });
});
