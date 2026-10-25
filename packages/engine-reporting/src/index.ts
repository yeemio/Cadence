/**
 * @smes/engine-reporting —— 口径驱动报表引擎（自研薄层，决策簿 ~25 人日：
 * 口径定义即数据、可版本化可售卖；口径包 = 商业资产，**不做通用 BI**）。
 *
 * 分层（与 engine-flow 同哲学：定义即数据、校验后冻结、机制吃配置）：
 * - filter.ts      过滤谓词（纯数据可序列化：比较/在集合内/区间/与或非）+ 求值纯函数
 * - definition.ts  口径定义（版本化：时间口径/维度/度量/过滤）+ 校验即深冻结
 * - pack.ts        口径包（可售卖单元载体：packId + 包版本 + 口径清单 + 元数据）
 * - source.ts      数据源端口（按源种类+时间口径+时间窗+过滤取行）+ 内存实现
 * - evaluate.ts    计算端口：MetricQuery → MetricResult（口径溯源）+ 纯函数求值
 */
export { METRIC_DEFINITION_SCHEMA_VERSION, defineMetricDefinition } from './definition.js';
export type {
  MetricDefinition,
  MetricDefinitionSchemaVersion,
  TimeBasis,
  AggregationKind,
  DimensionDef,
  MeasureDef,
  NumberFormat,
} from './definition.js';
export { METRIC_PACK_SCHEMA_VERSION, defineMetricPack, findMetric } from './pack.js';
export type { MetricPack, MetricPackSchemaVersion } from './pack.js';
export { validateMetricFilter, evaluateMetricFilter, readRowField } from './filter.js';
export type {
  MetricFilter,
  MetricCompareFilter,
  MetricInSetFilter,
  MetricRangeFilter,
  MetricAndFilter,
  MetricOrFilter,
  MetricNotFilter,
  FilterOperator,
  FilterValue,
} from './filter.js';
export { createInMemoryMetricSource } from './source.js';
export type { MetricSource, MetricSourceRow, MetricSourceRequest } from './source.js';
export { evaluateMetric, buildSourceRequest } from './evaluate.js';
export type { MetricQuery, MetricResult, MetricResultRow } from './evaluate.js';
