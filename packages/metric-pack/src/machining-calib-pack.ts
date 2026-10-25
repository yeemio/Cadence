/**
 * 机加垂直口径包 v1（M3，m3-drafts/04-metric-pack.md §5 六张口径形状化——
 * 默认配置层第三层："机加垂直 6 张口径初版（行业口径集=数据，第二行业=另一份
 * 口径包，引擎零改动）"）。
 *
 * 包 = 6 张口径报表主口径 + 2 条下钻明细口径（差异表 #4"下钻收编（维度切片
 * +明细粒度口径）"——93 未按期图号明细 / 95 订单行明细是合同点名的单行粒度
 * 口径；其余四张的下钻 = dimensionSlice 切片 + 查询过滤，引擎原生能力）。
 *
 * 行为重述口径锚（合同 §5 表格逐行；对账阶段按活系统校准数值，合同 §11/§12）：
 *  - 88 下图统计：未激活图纸包 = 附件计数口径 v1（已上图图号数 distinct-count
 *    + 附件数 count；激活图纸包后可演进 v2 增修订维度——口径版本化纪律示例场景）；
 *  - 90 工作令交付：期间(月)×交付判定（判定字段由适配器按计划 vs 实际交付
 *    日期物化为 deliveryVerdict 数据字段，引擎谓词保持静态纯数据）；
 *  - 93 外协交货：供应商×月；准时判定 = 回厂(质检)时点 vs 交期（适配器物化
 *    onTimeFlag 0/1；v1 行集 = 已回厂外协行——准时率分母=已回厂单，在途单
 *    不进口径，对账阶段校准）；
 *  - 94 采购件预期："已逾期且仍有未入库数量" = 根过滤 isOverdue ∧
 *    outstandingQty > 0（适配器物化字段；对齐 listing 逾期催货事实口径）；
 *  - 95 采购金额汇总：默认口径 = 已收货数量 × 单价（对齐 listing 对账要点
 *    amountMinor = receivedQty × unitPriceMinor；下单口径 = 同 metricId 新
 *    版本变体，v1 不发）；金额量纲 = 分（整数，乘积 half-up）；
 *  - 97 项目成本：工作令×成本类别（材料/工时/外协）金额 sum（分）；两层版本
 *    = CostingModel 版本（归集口径，M2 costing）× 本定义版本（呈现口径）；
 *    本口径只消费 costing CostEntry 事实，归集与重算不属本包（R6）。
 *
 * 事实行形状契约见 metric-pack-config.ts sourceKind 词表注。
 */
import { defineMetricDefinition, defineMetricPack, type MetricDefinition, type MetricPack } from '@smes/engine-reporting';
import { MACHINING_CALIB_PACK_ID, MACHINING_CALIB_PACK_VERSION } from './metric-pack-config.js';

// ---- 88 下图统计（v1 附件计数口径） ----

export const DRAWING_INTAKE_PROGRESS_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'drawing-intake-progress',
  version: 1,
  display: '下图统计',
  description:
    '工作令×图号 的上图进度：已上图图号数（distinct-count）与附件行数（count）。v1 = 附件计数口径（图纸包未激活）；图纸包激活后演进 v2 增修订维度（口径版本化纪律的示例场景）。',
  timeBasis: 'business',
  sourceKind: 'workorder-attachment-facts',
  dimensions: [
    { field: 'workOrderId', label: '工作令' },
    { field: 'drawingNo', label: '图号' },
  ],
  measures: [
    { measureId: 'uploaded-drawing-count', aggregation: 'distinct-count', field: 'drawingNo' },
    { measureId: 'attachment-count', aggregation: 'count' },
  ],
});

// ---- 90 工作令交付对比 ----

export const WORKORDER_DELIVERY_COMPARISON_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'workorder-delivery-comparison',
  version: 1,
  display: '工作令交付对比',
  description:
    '期间(月)×交付判定 的工作令数：判定字段（on-time 按时 / delayed 延期 / undelivered 未交付）由事实源适配器按计划交付 vs 实际交付日期物化为数据字段。对账锚：同月同批对照计数与活系统一致。',
  timeBasis: 'business',
  sourceKind: 'workorder-delivery-facts',
  dimensions: [
    { field: 'periodMonth', label: '期间(月)' },
    { field: 'deliveryVerdict', label: '交付判定' },
  ],
  measures: [{ measureId: 'workorder-count', aggregation: 'count' }],
});

// ---- 93 外协零件交货 ----

export const OUTSOURCING_DELIVERY_PERFORMANCE_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'outsourcing-delivery-performance',
  version: 1,
  display: '外协零件交货',
  description:
    '供应商×月 的外协交货表现：外协行数、准时率（回厂质检时点 vs 交期，适配器物化 onTimeFlag 0/1 的均值）、涉及图号数。v1 行集 = 已回厂外协行（准时率分母=已回厂单）；供应商月度评分呈现归本口径，自动联动开放（合同 §12）。',
  timeBasis: 'business',
  sourceKind: 'outsourcing-delivery-facts',
  dimensions: [
    { field: 'supplierId', label: '供应商' },
    { field: 'periodMonth', label: '期间(月)' },
  ],
  measures: [
    { measureId: 'dispatch-line-count', aggregation: 'count' },
    { measureId: 'on-time-rate', aggregation: 'avg', field: 'onTimeFlag', format: { minimumFractionDigits: 0, maximumFractionDigits: 4 } },
    { measureId: 'drawing-count', aggregation: 'distinct-count', field: 'drawingNo' },
  ],
});

// ---- 94 采购件预期（逾期未入库明细） ----

export const PURCHASE_OVERDUE_OUTSTANDING_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'purchase-overdue-outstanding',
  version: 1,
  display: '采购件预期',
  description:
    '"已逾期且仍有未入库数量"的采购订单行明细：根过滤 isOverdue ∧ outstandingQty > 0（适配器物化字段——已收数量由 listing 收货回填，未入库 = 订购 − 已收）。对齐 listing 逾期催货事实口径。',
  timeBasis: 'business',
  sourceKind: 'purchase-overdue-facts',
  dimensions: [{ field: 'orderLineId', label: '订单行' }],
  measures: [
    { measureId: 'outstanding-qty', aggregation: 'sum', field: 'outstandingQty' },
    { measureId: 'line-count', aggregation: 'count' },
  ],
  filter: {
    kind: 'and',
    parts: [
      { kind: 'compare', op: 'eq', field: 'isOverdue', value: true },
      { kind: 'compare', op: 'gt', field: 'outstandingQty', value: 0 },
    ],
  },
});

// ---- 95 采购件金额汇总 ----

export const PURCHASE_AMOUNT_SUMMARY_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'purchase-amount-summary',
  version: 1,
  display: '采购件金额汇总',
  description:
    '工作令×零件类型 的采购金额汇总（分）：默认口径 = 已收货数量 × 单价（适配器物化 lineAmountMinor = receivedQty × unitPriceMinor，half-up 到分；对齐 listing 对账要点）。下单口径 = 同 metricId 新版本变体（v1 不发）。下钻订单行走 purchase-amount-detail 明细口径。',
  timeBasis: 'business',
  sourceKind: 'purchase-amount-facts',
  dimensions: [
    { field: 'workOrderId', label: '工作令' },
    { field: 'partType', label: '零件类型' },
  ],
  measures: [
    { measureId: 'received-amount-minor', aggregation: 'sum', field: 'lineAmountMinor', format: { unit: '分' } },
    { measureId: 'order-count', aggregation: 'distinct-count', field: 'orderId' },
  ],
});

// ---- 97 项目成本 ----

export const PROJECT_COST_SUMMARY_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'project-cost-summary',
  version: 1,
  display: '项目成本',
  description:
    '工作令×成本类别（材料 material / 工时 labor / 外协 outsourcing）的金额汇总（分）。口径可按企业要求配置 = 两层：CostingModel 版本（归集口径，M2 costing）× 本定义版本（呈现口径）；本口径只消费 costing CostEntry 事实。对账锚：三分类总额 = costing 同口径快照。',
  timeBasis: 'business',
  sourceKind: 'costing-entry-facts',
  dimensions: [
    { field: 'workOrderId', label: '工作令' },
    { field: 'category', label: '成本类别' },
  ],
  measures: [{ measureId: 'amount-minor', aggregation: 'sum', field: 'amountMinor', format: { unit: '分' } }],
});

// ---- 下钻明细口径（差异表 #4：维度细化到单行粒度） ----

/** 93 下钻：未按期图号明细（维度细化 供应商×月×图号；"未按期"钉进口径）。 */
export const OUTSOURCING_DELIVERY_DETAIL_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'outsourcing-delivery-detail',
  version: 1,
  display: '外协交货未按期图号明细',
  description:
    '主口径 outsourcing-delivery-performance 的下钻明细：维度细化到 供应商×月×图号（单行粒度），根过滤钉"未按期"（onTimeFlag = 0）。供应商/月份切片经查询 dimensionSlice 施加。',
  timeBasis: 'business',
  sourceKind: 'outsourcing-delivery-facts',
  dimensions: [
    { field: 'supplierId', label: '供应商' },
    { field: 'periodMonth', label: '期间(月)' },
    { field: 'drawingNo', label: '图号' },
  ],
  measures: [{ measureId: 'dispatch-line-count', aggregation: 'count' }],
  filter: { kind: 'compare', op: 'eq', field: 'onTimeFlag', value: 0 },
});

/** 95 下钻：订单行金额明细（维度细化到 工作令×零件类型×订单×订单行）。 */
export const PURCHASE_AMOUNT_DETAIL_V1: MetricDefinition = defineMetricDefinition({
  schemaVersion: 1,
  metricId: 'purchase-amount-detail',
  version: 1,
  display: '采购金额订单行明细',
  description:
    '主口径 purchase-amount-summary 的下钻明细：维度细化到订单行（工作令×零件类型×订单×订单行，单行粒度），行金额 = receivedQty × unitPriceMinor（half-up 到分），与主口径同源同根口径。',
  timeBasis: 'business',
  sourceKind: 'purchase-amount-facts',
  dimensions: [
    { field: 'workOrderId', label: '工作令' },
    { field: 'partType', label: '零件类型' },
    { field: 'orderId', label: '采购订单' },
    { field: 'orderLineId', label: '订单行' },
  ],
  measures: [
    { measureId: 'line-amount-minor', aggregation: 'sum', field: 'lineAmountMinor', format: { unit: '分' } },
    { measureId: 'line-count', aggregation: 'count' },
  ],
});

// ---- 建议包（合同 §5：packId smes-machining-calib v1） ----

/**
 * 机加垂直口径包 v1（六张口径报表主口径 + 两条下钻明细口径；引擎不变量——
 * 包内 metricId 唯一、同 id 不同版本不并存于一个包，演进走包版本）。
 */
export const MACHINING_CALIB_PACK_V1: MetricPack = defineMetricPack({
  schemaVersion: 1,
  packId: MACHINING_CALIB_PACK_ID,
  version: MACHINING_CALIB_PACK_VERSION,
  title: '机加垂直口径包',
  description:
    '机加行业六张口径报表（88 下图统计 / 90 工作令交付 / 93 外协交货 / 94 采购件预期 / 95 采购金额汇总 / 97 项目成本）+ 两条下钻明细口径。口径 = 可售卖单元：装载后报表中心可见，未装载则六张不可见且标准 4 张不受影响。',
  metrics: [
    DRAWING_INTAKE_PROGRESS_V1,
    WORKORDER_DELIVERY_COMPARISON_V1,
    OUTSOURCING_DELIVERY_PERFORMANCE_V1,
    PURCHASE_OVERDUE_OUTSTANDING_V1,
    PURCHASE_AMOUNT_SUMMARY_V1,
    PROJECT_COST_SUMMARY_V1,
    OUTSOURCING_DELIVERY_DETAIL_V1,
    PURCHASE_AMOUNT_DETAIL_V1,
  ],
});

/** 包内主口径清单（六张报表报表中心呈现序）。 */
export const MACHINING_CALIB_MAIN_METRIC_IDS: readonly string[] = [
  'drawing-intake-progress',
  'workorder-delivery-comparison',
  'outsourcing-delivery-performance',
  'purchase-overdue-outstanding',
  'purchase-amount-summary',
  'project-cost-summary',
];
