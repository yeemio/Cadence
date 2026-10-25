/**
 * metric-pack 默认配置层（M3，m3-drafts/04-metric-pack.md v1.0 §2 分层标注第三层）。
 *
 * 六种事实源 sourceKind 词汇、口径包标识、权限码与呈现词汇（交付判定三词）
 * 是**默认配置/机加垂直初版**（实施时按客户口径调整值域，不属内核）；装载/
 * 版本化/求值纪律（定义即数据、append-only、跨版本不可变）在引擎与本包服务层。
 *
 * 量纲冻结（对齐全仓口径）：金额=分（整数）；数量=件（不取整，聚合语义归引擎）。
 */

// ---- 六种事实源 sourceKind（合同 §5 事实源绑定；kebab，引擎按名绑定） ----

/**
 * 事实源种类词汇（六张口径 ↔ 六种事实源）。行形状契约（引擎 source.ts 锁的
 * 三时间列 + occurredAt + 领域字段；动态判定字段由适配器物化为数据字段，合同 §4）：
 *
 * | sourceKind | 事实源（只读） | 领域字段（维度/度量/过滤引用面） |
 * |---|---|---|
 * | workorder-attachment-facts | workorder 附件事实 | workOrderId, drawingNo, attachmentId, kind |
 * | workorder-delivery-facts | workorder 工作令交付日期事实 | workOrderId, periodMonth, deliveryVerdict, plannedDeliveryAt, actualDeliveryAt |
 * | outsourcing-delivery-facts | dispatch 外协行 + inspection 回厂事实 | supplierId, periodMonth, drawingNo, onTimeFlag, dispatchId, lineId, promisedAt, returnedAt |
 * | purchase-overdue-facts | listing 采购订单行（已收数量回填） | orderLineId, orderId, itemId, drawingNo, outstandingQty, isOverdue, promisedAt |
 * | purchase-amount-facts | listing 采购订单行（已定价×已收） | workOrderId, partType, orderId, orderLineId, lineAmountMinor, receivedQty, unitPriceMinor |
 * | costing-entry-facts | costing CostEntry 事实 | workOrderId, category, amountMinor, entryId |
 */
export const METRIC_PACK_SOURCE_KINDS = [
  'workorder-attachment-facts',
  'workorder-delivery-facts',
  'outsourcing-delivery-facts',
  'purchase-overdue-facts',
  'purchase-amount-facts',
  'costing-entry-facts',
] as const;

export type MetricPackSourceKind = (typeof METRIC_PACK_SOURCE_KINDS)[number];

/** sourceKind 人读标签（呈现层用；代码内只用稳定码）。 */
export const METRIC_PACK_SOURCE_KIND_LABELS: Readonly<Record<MetricPackSourceKind, string>> = {
  'workorder-attachment-facts': '工作令附件事实',
  'workorder-delivery-facts': '工作令交付事实',
  'outsourcing-delivery-facts': '外协交货事实',
  'purchase-overdue-facts': '采购逾期事实',
  'purchase-amount-facts': '采购金额事实',
  'costing-entry-facts': '成本条目事实',
};

/** sourceKind 合法性判定（词汇表门禁；未知词显式拒绝，不静默归类）。 */
export function isMetricPackSourceKind(value: string): value is MetricPackSourceKind {
  return (METRIC_PACK_SOURCE_KINDS as readonly string[]).includes(value);
}

// ---- 机加垂直口径包标识（合同 §5 建议包） ----

/** 建议包：机加垂直口径集（六张口径报表 + 两条下钻明细口径）。 */
export const MACHINING_CALIB_PACK_ID = 'smes-machining-calib';

/** 建议包首版（装载示例与测试基线；定义见 machining-calib-pack.ts）。 */
export const MACHINING_CALIB_PACK_VERSION = 1;

// ---- 呈现词汇（动态判定物化字段的值域，默认配置层） ----

/**
 * 工作令交付判定三词（90 表格物化字段 deliveryVerdict 值域；适配器按
 * 计划 vs 实际交付日期物化——合同 §5"判定字段由适配器物化"）：
 *  - on-time    实际交付 <= 计划交付（含同日，按期）；
 *  - delayed    实际交付 > 计划交付；
 *  - undelivered 尚无实际交付时点（在制/未交付）。
 */
export const DELIVERY_VERDICTS = ['on-time', 'delayed', 'undelivered'] as const;
export type DeliveryVerdict = (typeof DELIVERY_VERDICTS)[number];

/**
 * 采购件类型两分（95 表格 partType 维度物化值域，v1 行为重述初版——按订单行
 * 是否挂图号两分"图号件/标准件"；对账阶段按活系统校正，开放问题登记合同 §12）。
 */
export const PURCHASE_PART_TYPES = ['drawing-part', 'standard-part'] as const;
export type PurchasePartType = (typeof PURCHASE_PART_TYPES)[number];

/**
 * 成本类别三词（97 表格 category 维度；与 M2 costing CostEntry 的类别
 * material/labor/outsourcing 逐词一致——本口径只消费 costing 事实不重定义）。
 */
export const COST_CATEGORIES = ['material', 'labor', 'outsourcing'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

// ---- 审核状态 ----

/** 装载记录审核状态：激活即 activated（配置装载域，无业务流转）。 */
export const METRIC_PACK_AUDIT_STATUS_ACTIVATED = 'activated';

// ---- 权限码（合同 §7 最小集） ----

/**
 * metric-pack 权限码（登记进 casbin 策略面归组合根/总控；此处冻结词汇）。
 *
 *   - metric-pack:read     口径求值/下钻/导出（金额敏感类口径对齐 costing 先例，
 *                          建议默认角色：厂长/财务）；
 *   - metric-pack:activate 口径包装载/升级（租户管理员）。
 */
export const METRIC_PACK_PERMISSIONS = {
  read: 'metric-pack:read',
  activate: 'metric-pack:activate',
} as const;

export type MetricPackPermission = (typeof METRIC_PACK_PERMISSIONS)[keyof typeof METRIC_PACK_PERMISSIONS];
