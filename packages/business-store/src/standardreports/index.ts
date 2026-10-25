/**
 * `./standardreports` 子路径公共面：标准报表四事实源适配器（S1 backfill：
 * 0920 #89/#91/#92/#96）。与 `./metric-pack` 同模式：本面引入 @prisma/client
 * （需 prisma generate 后 typecheck/build），主入口保持纯数据面。
 */
export {
  connectStandardReportsSources,
  PgInventoryMovementsMetricSource,
  PgLaborEntryMetricSource,
  PgPartDispatchMetricSource,
  PgProductionReceiptMetricSource,
} from './pg-standardreports-sources.js';
export type {
  MetricSource,
  MetricSourceRequest,
  MetricSourceRow,
  StandardReportsSourcesHandle,
  StandardReportsSourcesOptions,
} from './pg-standardreports-sources.js';
