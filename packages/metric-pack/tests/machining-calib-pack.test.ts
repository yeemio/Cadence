/**
 * 机加垂直口径包 v1 定义测试（M3，m3-drafts/04-metric-pack.md §5 六张口径形状化
 * + §10 差异表 #4 下钻收编）。
 *
 * 覆盖面：
 *  - 包经 defineMetricPack 校验冻结（六主 + 两明细 = 8 条）；
 *  - 包内 metricId 唯一（引擎不变量）；主口径六张清单齐备；
 *  - 六条 sourceKind 落在词表内（事实源绑定纪律）；
 *  - 94 根过滤形状（isOverdue ∧ outstandingQty > 0）；
 *  - 版本化不变性：冻结定义 JSON 往返再校验幂等（跨版本不可变的基础）。
 */
import { describe, expect, it } from 'vitest';
import { defineMetricDefinition, defineMetricPack, findMetric } from '@smes/engine-reporting';
import {
  DRAWING_INTAKE_PROGRESS_V1,
  MACHINING_CALIB_MAIN_METRIC_IDS,
  MACHINING_CALIB_PACK_V1,
  OUTSOURCING_DELIVERY_DETAIL_V1,
  OUTSOURCING_DELIVERY_PERFORMANCE_V1,
  PROJECT_COST_SUMMARY_V1,
  PURCHASE_AMOUNT_DETAIL_V1,
  PURCHASE_AMOUNT_SUMMARY_V1,
  PURCHASE_OVERDUE_OUTSTANDING_V1,
  WORKORDER_DELIVERY_COMPARISON_V1,
} from '../src/machining-calib-pack.js';
import { METRIC_PACK_SOURCE_KINDS, isMetricPackSourceKind } from '../src/metric-pack-config.js';

describe('机加垂直口径包 v1（§5 形状化）', () => {
  it('包经 defineMetricPack 校验冻结：六主 + 两明细 = 8 条口径', () => {
    expect(MACHINING_CALIB_PACK_V1.packId).toBe('smes-machining-calib');
    expect(MACHINING_CALIB_PACK_V1.version).toBe(1);
    expect(MACHINING_CALIB_PACK_V1.metrics).toHaveLength(8);
  });

  it('包内 metricId 唯一（引擎不变量）；主口径六张齐备', () => {
    const ids = MACHINING_CALIB_PACK_V1.metrics.map((metric) => metric.metricId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metricId of MACHINING_CALIB_MAIN_METRIC_IDS) {
      expect(ids).toContain(metricId);
    }
  });

  it('六条主口径的 sourceKind 落在事实源词表内', () => {
    const mainDefs = [
      DRAWING_INTAKE_PROGRESS_V1,
      WORKORDER_DELIVERY_COMPARISON_V1,
      OUTSOURCING_DELIVERY_PERFORMANCE_V1,
      PURCHASE_OVERDUE_OUTSTANDING_V1,
      PURCHASE_AMOUNT_SUMMARY_V1,
      PROJECT_COST_SUMMARY_V1,
    ];
    expect(mainDefs).toHaveLength(6);
    for (const definition of [...mainDefs, OUTSOURCING_DELIVERY_DETAIL_V1, PURCHASE_AMOUNT_DETAIL_V1]) {
      expect(isMetricPackSourceKind(definition.sourceKind)).toBe(true);
    }
    expect(METRIC_PACK_SOURCE_KINDS).toHaveLength(6);
  });

  it('88：工作令×图号 维度 + distinct-count/count 双度量（附件计数口径 v1）', () => {
    expect(DRAWING_INTAKE_PROGRESS_V1.dimensions.map((d) => d.field)).toEqual(['workOrderId', 'drawingNo']);
    expect(DRAWING_INTAKE_PROGRESS_V1.measures.map((m) => `${m.measureId}:${m.aggregation}`)).toEqual([
      'uploaded-drawing-count:distinct-count',
      'attachment-count:count',
    ]);
    expect(DRAWING_INTAKE_PROGRESS_V1.timeBasis).toBe('business');
  });

  it('90：期间(月)×交付判定 维度 + 工作令数 count', () => {
    expect(WORKORDER_DELIVERY_COMPARISON_V1.dimensions.map((d) => d.field)).toEqual([
      'periodMonth',
      'deliveryVerdict',
    ]);
    expect(WORKORDER_DELIVERY_COMPARISON_V1.measures).toHaveLength(1);
  });

  it('93：供应商×月 + 准时率 avg(onTimeFlag)；明细口径钉"未按期"根过滤 + 图号维度', () => {
    expect(OUTSOURCING_DELIVERY_PERFORMANCE_V1.measures.map((m) => m.aggregation)).toContain('avg');
    expect(OUTSOURCING_DELIVERY_PERFORMANCE_V1.dimensions.map((d) => d.field)).toEqual(['supplierId', 'periodMonth']);
    expect(OUTSOURCING_DELIVERY_DETAIL_V1.dimensions.map((d) => d.field)).toEqual([
      'supplierId',
      'periodMonth',
      'drawingNo',
    ]);
    expect(OUTSOURCING_DELIVERY_DETAIL_V1.filter).toEqual({
      kind: 'compare',
      op: 'eq',
      field: 'onTimeFlag',
      value: 0,
    });
  });

  it('94：根过滤 = isOverdue ∧ outstandingQty > 0（适配器物化字段）', () => {
    expect(PURCHASE_OVERDUE_OUTSTANDING_V1.filter).toEqual({
      kind: 'and',
      parts: [
        { kind: 'compare', op: 'eq', field: 'isOverdue', value: true },
        { kind: 'compare', op: 'gt', field: 'outstandingQty', value: 0 },
      ],
    });
    expect(PURCHASE_OVERDUE_OUTSTANDING_V1.dimensions.map((d) => d.field)).toEqual(['orderLineId']);
  });

  it('95：工作令×零件类型 + 金额 sum(分)/订单 distinct-count；明细口径细化到订单行', () => {
    expect(PURCHASE_AMOUNT_SUMMARY_V1.dimensions.map((d) => d.field)).toEqual(['workOrderId', 'partType']);
    expect(PURCHASE_AMOUNT_SUMMARY_V1.measures.map((m) => `${m.measureId}:${m.aggregation}:${m.field ?? ''}`)).toEqual([
      'received-amount-minor:sum:lineAmountMinor',
      'order-count:distinct-count:orderId',
    ]);
    expect(PURCHASE_AMOUNT_DETAIL_V1.dimensions.map((d) => d.field)).toEqual([
      'workOrderId',
      'partType',
      'orderId',
      'orderLineId',
    ]);
  });

  it('97：工作令×成本类别 + 金额 sum（呈现口径消费 costing 事实）', () => {
    expect(PROJECT_COST_SUMMARY_V1.dimensions.map((d) => d.field)).toEqual(['workOrderId', 'category']);
    expect(PROJECT_COST_SUMMARY_V1.measures.map((m) => `${m.aggregation}:${m.field}`)).toEqual(['sum:amountMinor']);
  });

  it('版本化不变性：冻结定义/包 JSON 往返再校验幂等（跨版本不可变基础）', () => {
    for (const metric of MACHINING_CALIB_PACK_V1.metrics) {
      const roundTrip = defineMetricDefinition(JSON.parse(JSON.stringify(metric)) as unknown);
      expect(roundTrip).toEqual(metric);
      expect(Object.isFrozen(roundTrip)).toBe(true);
    }
    const packRoundTrip = defineMetricPack(JSON.parse(JSON.stringify(MACHINING_CALIB_PACK_V1)) as unknown);
    expect(packRoundTrip).toEqual(MACHINING_CALIB_PACK_V1);
    expect(findMetric(packRoundTrip, 'project-cost-summary', 1)?.sourceKind).toBe('costing-entry-facts');
  });
});
