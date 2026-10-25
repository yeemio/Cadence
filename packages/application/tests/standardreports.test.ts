/**
 * 标准报表测试（S1 backfill：0920 #89/#91/#92/#96）：
 * 口径包形状（四 metric 齐全 + 清洁室口径描述含降级标注）、四报表端到端求值
 * （内存事实源 → 引擎求值 → 分组/过滤/时间窗语义）、维度切片、未绑定源诚实
 * 失败、未知口径 404、输入解析边界、控制器权限码与模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { TenantId } from '@smes/business-core';
import {
  createInMemoryMetricSource,
  type MetricSource,
  type MetricSourceRow,
} from '@smes/engine-reporting';
import {
  parseReportQueryInput,
  PERMISSION_METADATA_KEY,
  StandardReportsController,
  StandardReportsInputError,
  StandardReportsModule,
  StandardReportsNotFoundError,
  StandardReportsService,
  StandardReportsSourceError,
  STANDARD_REPORTS_PACK,
  STANDARD_REPORTS_PACK_ID,
  reportSourceProviderOf,
} from '../src/index.js';

const t1 = TenantId.create('t1');

/** 求值用的最小行集（三时间列对齐证据口径；occurredAt 恒有）。 */
function row(fields: Record<string, unknown>): MetricSourceRow {
  return {
    occurredAt: fields['occurredAt'] ?? '2026-10-01T08:00:00.000Z',
    businessTime: fields['businessTime'] ?? null,
    availableTime: null,
    ...fields,
  } as unknown as MetricSourceRow;
}

describe('口径包形状（清洁室重述，0920 #89/#91/#92/#96）', () => {
  it('packId=standard-reports v1，四 metric 齐全且版本化字段齐备', () => {
    expect(STANDARD_REPORTS_PACK.packId).toBe(STANDARD_REPORTS_PACK_ID);
    expect(STANDARD_REPORTS_PACK.version).toBe(1);
    expect(STANDARD_REPORTS_PACK.metrics.map((metric) => metric.metricId)).toEqual([
      'inventory-movements',
      'workorder-labor-hours',
      'part-dispatch-report',
      'production-receipt-daily',
    ]);
    for (const metric of STANDARD_REPORTS_PACK.metrics) {
      expect(metric.version).toBe(1);
      expect(metric.sourceKind).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('口径描述 = 0920 功能说明重述，降级项如实标注（不硬造）', () => {
    const byId = new Map(STANDARD_REPORTS_PACK.metrics.map((metric) => [metric.metricId, metric]));
    expect(byId.get('inventory-movements')?.description).toContain('#89');
    expect(byId.get('inventory-movements')?.description).toContain('待数据面补齐'); // 期初余快照缺
    expect(byId.get('workorder-labor-hours')?.description).toContain('#91');
    expect(byId.get('part-dispatch-report')?.description).toContain('#92');
    expect(byId.get('part-dispatch-report')?.description).toContain('待数据面补齐'); // 设备/模块维度缺
    expect(byId.get('production-receipt-daily')?.description).toContain('#96');
    expect(byId.get('production-receipt-daily')?.description).toContain('待数据面补齐'); // 图号产出降级
  });

  it('#91 根过滤锚定：workOrderId ne null（无归属行不进口径——misc 幻影行回归的口径侧防线）', () => {
    const metric = STANDARD_REPORTS_PACK.metrics.find((m) => m.metricId === 'workorder-labor-hours');
    expect(metric?.filter).toEqual({ kind: 'compare', op: 'ne', field: 'workOrderId', value: null });
  });

  it('#92 机制陈述如实：doneQty 为派工侧终态量，撤销不回滚两域未联动（不得宣称"撤销单不计"的联动机制）', () => {
    const metric = STANDARD_REPORTS_PACK.metrics.find((m) => m.metricId === 'part-dispatch-report');
    expect(metric?.description).toContain('不回滚');
    expect(metric?.description).toContain('对账阶段校正');
    expect(metric?.description).not.toContain('撤销单不计');
  });
});

describe('四报表求值（内存事实源 → 引擎）', () => {
  function serviceOf(sources: Record<string, MetricSource | null | undefined>): StandardReportsService {
    return new StandardReportsService(
      STANDARD_REPORTS_PACK,
      reportSourceProviderOf(sources),
    );
  }

  it('#89 库存报表：按物料归集收/发/净；时间窗（business 口径）裁剪行', async () => {
    const source = createInMemoryMetricSource('stock-movement-facts', [
      row({ itemId: 'i-1', receivedQty: 10, issuedQty: 0, netQty: 10, businessTime: '2026-10-01T09:00:00.000Z' }),
      row({ itemId: 'i-1', receivedQty: 0, issuedQty: 4, netQty: -4, businessTime: '2026-10-05T09:00:00.000Z' }),
      row({ itemId: 'i-2', receivedQty: 7, issuedQty: 2, netQty: 5, businessTime: '2026-10-02T09:00:00.000Z' }),
      row({ itemId: 'i-2', receivedQty: 3, issuedQty: 0, netQty: 3, businessTime: '2026-11-01T09:00:00.000Z' }), // 窗外
    ]);
    const service = serviceOf({ 'stock-movement-facts': source });
    const result = await service.query(t1, {
      metricId: 'inventory-movements',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
    });
    expect(result.metric).toEqual({ metricId: 'inventory-movements', version: 1 });
    expect(result.timeBasis).toBe('business');
    expect(result.rows).toHaveLength(2);
    const i1 = result.rows.find((r) => r.key['itemId'] === 'i-1')!;
    expect(i1.values).toEqual({ 'received-qty': 10, 'issued-qty': 4, 'net-qty': 6, 'movement-count': 2 });
    const i2 = result.rows.find((r) => r.key['itemId'] === 'i-2')!;
    expect(i2.values['net-qty']).toBe(5); // 11 月行被时间窗裁掉
  });

  it('#91 工作令工时报表：四工种分列 + 合计净额（冲销负值计入）；零工/无主行不产幻影分组（回归：misc workOrderId=null 曾产出 {workOrderId:null} 幻影行）', async () => {
    const source = createInMemoryMetricSource('labor-entry-facts', [
      row({ workOrderId: 'w-1', machiningHours: 8, assemblyHours: 0, electricalHours: 0, aftercareHours: 0, netHours: 8 }),
      row({ workOrderId: 'w-1', machiningHours: 0, assemblyHours: 6, electricalHours: 2, aftercareHours: 0, netHours: 8 }),
      row({ workOrderId: 'w-1', machiningHours: -2, assemblyHours: 0, electricalHours: 0, aftercareHours: 0, netHours: -2 }), // 冲销
      row({ workOrderId: 'w-2', machiningHours: 0, assemblyHours: 0, electricalHours: 0, aftercareHours: 4, netHours: 4 }),
      // 零工（misc 不挂工作令——workOrderId 缺失读作 null）+ 显式 null 归属行：
      // 根过滤 workOrderId ne null 必须全部排除，不产生 {workOrderId: null} 分组
      row({ trade: 'misc', machiningHours: 0, assemblyHours: 0, electricalHours: 0, aftercareHours: 0, netHours: 5 }),
      row({ workOrderId: null, machiningHours: 3, assemblyHours: 0, electricalHours: 0, aftercareHours: 0, netHours: 3 }),
    ]);
    const service = serviceOf({ 'labor-entry-facts': source });
    const result = await service.query(t1, { metricId: 'workorder-labor-hours' });
    expect(result.rows).toHaveLength(2); // 仅 w-1 / w-2——无 null 幻影行
    expect(result.rows.some((r) => r.key['workOrderId'] === null)).toBe(false);
    const w1 = result.rows.find((r) => r.key['workOrderId'] === 'w-1')!;
    expect(w1.values).toEqual({
      'machining-hours': 6,
      'assembly-hours': 6,
      'electrical-hours': 2,
      'aftercare-hours': 0,
      'total-hours': 14,
      'entry-count': 3,
    });
    const w2 = result.rows.find((r) => r.key['workOrderId'] === 'w-2')!;
    expect(w2.values['total-hours']).toBe(4); // misc/无主行的 5+3 未混入任何分组
  });

  it('#91 纯零工源 → 空行集（全部行被根过滤排除，不产 null 总量行）', async () => {
    const source = createInMemoryMetricSource('labor-entry-facts', [
      row({ trade: 'misc', machiningHours: 0, assemblyHours: 0, electricalHours: 0, aftercareHours: 0, netHours: 5 }),
    ]);
    const service = serviceOf({ 'labor-entry-facts': source });
    const result = await service.query(t1, { metricId: 'workorder-labor-hours' });
    expect(result.rows).toEqual([]);
  });

  it('#92 派工报工报表：只计 kind=part（根过滤）；三维分组；occurred 口径', async () => {
    const source = createInMemoryMetricSource('part-dispatch-report-facts', [
      row({ kind: 'part', workOrderId: 'w-1', drawingNo: 'D-100', operationCode: 'OP-10', dispatchedQty: 20, reportedQty: 12, occurredAt: '2026-10-03T08:00:00.000Z' }),
      row({ kind: 'part', workOrderId: 'w-1', drawingNo: 'D-100', operationCode: 'OP-20', dispatchedQty: 10, reportedQty: 0, occurredAt: '2026-10-04T08:00:00.000Z' }),
      row({ kind: 'assembly', workOrderId: 'w-1', drawingNo: 'D-100', operationCode: 'OP-10', dispatchedQty: 5, reportedQty: 5 }), // 非自制件：根过滤排除
    ]);
    const service = serviceOf({ 'part-dispatch-report-facts': source });
    const result = await service.query(t1, { metricId: 'part-dispatch-report' });
    expect(result.timeBasis).toBe('occurred');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.key['operationCode']).sort()).toEqual(['OP-10', 'OP-20']);
    const op10 = result.rows.find((r) => r.key['operationCode'] === 'OP-10')!;
    expect(op10.values).toEqual({ 'dispatched-qty': 20, 'reported-qty': 12, 'order-count': 1 });

    // 维度切片：只看 OP-20
    const sliced = await service.query(t1, {
      metricId: 'part-dispatch-report',
      dimensionSlice: { operationCode: ['OP-20'] },
    });
    expect(sliced.rows).toHaveLength(1);
    expect(sliced.rows[0]!.values['dispatched-qty']).toBe(10);
  });

  it('#96 入库日报表：只计 production-in；按日分组；distinct-count 工作令', async () => {
    const source = createInMemoryMetricSource('production-receipt-facts', [
      row({ kind: 'production-in', periodDay: '2026-10-20', workOrderId: 'w-1', receiptQty: 15, businessTime: '2026-10-20T10:00:00.000Z' }),
      row({ kind: 'production-in', periodDay: '2026-10-20', workOrderId: 'w-2', receiptQty: 5, businessTime: '2026-10-20T15:00:00.000Z' }),
      row({ kind: 'purchase-in', periodDay: '2026-10-20', workOrderId: 'w-9', receiptQty: 99, businessTime: '2026-10-20T16:00:00.000Z' }), // 采购入库：根过滤排除
      row({ kind: 'production-in', periodDay: '2026-10-21', workOrderId: 'w-1', receiptQty: 8, businessTime: '2026-10-21T10:00:00.000Z' }),
    ]);
    const service = serviceOf({ 'production-receipt-facts': source });
    const result = await service.query(t1, { metricId: 'production-receipt-daily' });
    expect(result.rows).toHaveLength(2);
    const d20 = result.rows.find((r) => r.key['periodDay'] === '2026-10-20')!;
    expect(d20.values).toEqual({ 'received-qty': 20, 'movement-count': 2, 'work-order-count': 2 });
    const d21 = result.rows.find((r) => r.key['periodDay'] === '2026-10-21')!;
    expect(d21.values['work-order-count']).toBe(1);
  });

  it('空集：零数据面返回空行集（而非报错）；无下界查询 = 全量净额', async () => {
    const service = serviceOf({
      'stock-movement-facts': createInMemoryMetricSource('stock-movement-facts', []),
    });
    const result = await service.query(t1, { metricId: 'inventory-movements' });
    expect(result.rows).toEqual([]);
  });
});

describe('诚实失败与引用解析', () => {
  it('未绑定源（零 DB 形态）求值 → StandardReportsSourceError（不静默空结果）', async () => {
    const service = new StandardReportsService(); // 缺省 UNBOUND 源
    await expect(service.query(t1, { metricId: 'inventory-movements' })).rejects.toThrow(
      StandardReportsSourceError,
    );
  });

  it('源集缺该 sourceKind 适配器 → 未绑定显式抛错', async () => {
    const service = new StandardReportsService(
      STANDARD_REPORTS_PACK,
      reportSourceProviderOf({ 'stock-movement-facts': null }),
    );
    await expect(service.query(t1, { metricId: 'workorder-labor-hours' })).rejects.toThrow(
      StandardReportsSourceError,
    );
  });

  it('未知 metricId → StandardReportsNotFoundError（404 语义）', async () => {
    const service = new StandardReportsService();
    expect(() => service.listMetrics().find((m) => m.metricId === 'nope')).toBeDefined();
    await expect(service.query(t1, { metricId: 'nope' })).rejects.toThrow(StandardReportsNotFoundError);
  });
});

describe('输入解析、权限码与模块装配', () => {
  it('非法查询体拒绝：缺 metricId / 非法 timeBasis / 时间窗颠倒 / 切片含非标量', () => {
    expect(() => parseReportQueryInput({})).toThrow(StandardReportsInputError);
    expect(() => parseReportQueryInput({ metricId: 'x', timeBasis: 'nope' })).toThrow(StandardReportsInputError);
    expect(() =>
      parseReportQueryInput({ metricId: 'x', from: '2027-01-02T00:00:00Z', to: '2027-01-01T00:00:00Z' }),
    ).toThrow(StandardReportsInputError);
    expect(() =>
      parseReportQueryInput({ metricId: 'x', dimensionSlice: { itemId: [{ deep: true }] } }),
    ).toThrow(StandardReportsInputError);
    const ok = parseReportQueryInput({ metricId: 'x', dimensionSlice: { itemId: ['i-1', null] } });
    expect(ok.metricId).toBe('x');
    expect(ok.dimensionSlice).toEqual({ itemId: ['i-1', null] });
  });

  it('两端点均 report:read；模块装配标准报表控制器；口径清单含降级描述', () => {
    const proto = StandardReportsController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, proto['listMetrics'] as object)).toBe('report:read');
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, proto['query'] as object)).toBe('report:read');
    const dynamic = StandardReportsModule.register();
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, dynamic) as unknown[];
    expect(controllers).toContain(StandardReportsController);

    const service = new StandardReportsService();
    const catalog = service.listMetrics();
    expect(catalog.map((entry) => entry.metricId)).toHaveLength(4);
    expect(catalog.every((entry) => entry.description !== undefined)).toBe(true);
  });
});
