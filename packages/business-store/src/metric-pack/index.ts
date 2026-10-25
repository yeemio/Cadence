/**
 * `./metric-pack` 子路径公共面：装载三端口的 PG 存储实现 + 六种 sourceKind 事实
 * 源适配器（M3）。与 `./payroll` 同模式：本面引入 @prisma/client（需 prisma
 * generate 后 typecheck/build），主入口保持纯数据面。
 *
 * 依赖取舍（pro-pack-tier-edges）：本面不 import @smes/metric-pack——行/端口
 * 形状用本地结构同形镜像类型承载（见 pg-metric-pack-stores.ts 头注），组合根
 * 注入时由 TypeScript 结构校验兼容 MetricPackService 的槽位；MetricSource 接口
 * 来自 @smes/engine-reporting（store-tier-edges 明文允许 engine-*）。
 */
export {
  connectMetricPackStore,
  connectMetricSourceBundle,
  PgMetricPackActivationStore,
  PgMetricPackDomainEventStore,
  PgMetricPackOperationLedger,
  PgWorkOrderAttachmentMetricSource,
  PgWorkOrderDeliveryMetricSource,
  PgOutsourcingDeliveryMetricSource,
  PgPurchaseOverdueMetricSource,
  PgPurchaseAmountMetricSource,
  PgCostingEntryMetricSource,
} from './pg-metric-pack-stores.js';
export type {
  MetricPackStoreHandle,
  MetricPackStoreOptions,
  MetricSourceBundleHandle,
} from './pg-metric-pack-stores.js';
