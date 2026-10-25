/**
 * @smes/metric-pack —— 报表口径专业包（M3 实施，m3-drafts/04-metric-pack.md
 * v1.0 冻结合同）。
 *
 * 激活开关语义（合同 §6 #3）：未装载则报表中心六张口径报表不可见、标准 4 张
 * 不受影响——**注册面（app-registry / 组合根接线 / 权限策略登记）归总控**，
 * 本包只保证装载状态即可见性事实（未装载口径求值/导出 = NotFound）。
 *
 * 包身份：口径售卖层——六张口径报表的 MetricDefinition 形状化 + MetricPack
 * （可售卖单元）的装载/版本化纪律；引擎（engine-reporting：defineMetric*
 * /evaluateMetric/MetricSource）已由预热线产出并验收，本包**复用不重造**，
 * 是引擎之上的应用层。口径演进 = 定义/包版本 +1（append-only，历史只读可
 * 复算）；客户差异 = 另一份口径定义/包版本（数据），不是代码分支。
 *
 * 依赖铁律（pro-pack-tier-edges）：仅依赖 @smes/business-core 与
 * @smes/engine-reporting（engine-* 明文允许，ADR-0011）；不 import
 * @smes/application 与任何 M2 模块——六种 sourceKind 的事实源适配器由
 * business-store 实现（结构同形镜像，pg-metric-pack-stores）、apps/server
 * 组合根绑定；business-store 的 PG 适配不 import 本包（跨包防线见
 * metric-pack-errors 的同形类注）。
 */
export {
  METRIC_PACK_SOURCE_KINDS,
  METRIC_PACK_SOURCE_KIND_LABELS,
  MACHINING_CALIB_PACK_ID,
  MACHINING_CALIB_PACK_VERSION,
  DELIVERY_VERDICTS,
  PURCHASE_PART_TYPES,
  COST_CATEGORIES,
  METRIC_PACK_AUDIT_STATUS_ACTIVATED,
  METRIC_PACK_PERMISSIONS,
  isMetricPackSourceKind,
  type MetricPackSourceKind,
  type DeliveryVerdict,
  type PurchasePartType,
  type CostCategory,
  type MetricPackPermission,
} from './metric-pack-config.js';

export {
  MetricPackActivationId,
  newMetricPackActivationId,
  uuidv7,
} from './metric-pack-ids.js';

export {
  MetricPackInputError,
  MetricPackNotFoundError,
  MetricPackConflictError,
  isMetricPackConflict,
} from './metric-pack-errors.js';

export {
  METRIC_PACK_EVENT_TYPES,
  METRIC_PACK_AGGREGATE_TYPES,
  makeMetricPackActivatedEvent,
  type MetricPackEventProvenance,
  type MetricPackActivatedPayload,
} from './metric-pack-events.js';

export type {
  MetricRef,
  MetricPackActivationRow,
  AppendMetricPackActivationInput,
  MetricPackActivationStore,
  MetricPackDomainEventStore,
  MetricPackOperationStore,
  MetricPackStores,
} from './metric-pack-stores.js';

export {
  METRIC_PACK_COMMAND_KINDS,
  parseCommandEnvelopeBody,
  parseCommandBodyForKind,
  parseMetricPackActivatePayload,
  parseMetricPackExportPayload,
  parseMetricQueryShape,
  parseEvaluateQuery,
  parseQueryObject,
  type MetricPackCommandKind,
  type MetricPackCommand,
  type MetricPackCommandEnvelope,
  type MetricPackEnvelopeBody,
  type MetricPackActivatePayload,
  type MetricPackExportPayload,
} from './metric-pack-input.js';

export {
  EMPTY_METRIC_SOURCE_SET,
  metricSourceSetOf,
  routingMetricSource,
  type MetricSourceSet,
} from './metric-pack-source.js';

export type { MetricPackExportSheet, MetricPackExportOutput } from './metric-pack-export-shapes.js';
export { JsonTablesMetricPackExportPort, type MetricPackExportPort } from './metric-pack-export.js';

export {
  DRAWING_INTAKE_PROGRESS_V1,
  WORKORDER_DELIVERY_COMPARISON_V1,
  OUTSOURCING_DELIVERY_PERFORMANCE_V1,
  PURCHASE_OVERDUE_OUTSTANDING_V1,
  PURCHASE_AMOUNT_SUMMARY_V1,
  PROJECT_COST_SUMMARY_V1,
  OUTSOURCING_DELIVERY_DETAIL_V1,
  PURCHASE_AMOUNT_DETAIL_V1,
  MACHINING_CALIB_PACK_V1,
  MACHINING_CALIB_MAIN_METRIC_IDS,
} from './machining-calib-pack.js';

export {
  InMemoryMetricPackActivationStore,
  InMemoryMetricPackDomainEventStore,
  InMemoryMetricPackOperationStore,
  inMemoryMetricPackStores,
} from './in-memory-metric-pack-stores.js';

export {
  MetricPackService,
  type MetricPackServiceOptions,
  type MetricPackCommandResult,
  type MetricPackCommitted,
  type MetricPackActivationView,
  type ResolvedMetric,
} from './metric-pack.service.js';
