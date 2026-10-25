/**
 * @smes/payroll —— 薪酬专业包（M3 实施，m3-drafts/01-payroll.md v1.0 冻结合同）。
 *
 * 激活开关语义（合同 §1）：开关关闭时人员时薪与工资核算入口、权限码
 * （payroll:read / payroll:rule-manage / payroll:run / payroll:export）、事件
 * 消费全部不可见——**注册面（app-registry / 组合根接线 / 权限策略登记）归
 * 总控**，本包只保证不被接线即不可见（零副作用构造 + 缺省空源/内存回落）。
 *
 * 包身份：工时事实的金额化层——把 hours 的"已审核工时×人×月"事实按版本化
 * 计薪规则核算为薪酬事实；规则=数据（改价=发新版本，历史可复算）。
 *
 * 依赖铁律（pro-pack-tier-edges）：仅依赖 @smes/business-core（engine-* 允许
 * 但 v1 无需）；不 import @smes/application 与任何 M2 模块；hours 消费只经
 * PayrollSource 端口（组合根适配，R-M3-3）；business-store 的 PG 适配不
 * import 本包（结构同形镜像，见 payroll-errors 的跨包防线注）。
 */
export type {
  PayPeriod,
  PayPeriodKind,
  EarningsBasis,
  VerifiedLaborFact,
  PayrollLaborRequest,
  PayrollSource,
} from './ports.js';
export { EMPTY_PAYROLL_SOURCE } from './ports.js';

export {
  LABOR_KINDS,
  LABOR_KIND_LABELS,
  PAYROLL_PERMISSIONS,
  isLaborKind,
  earningsAmountMinor,
  roundHalfUp,
  isMonth,
  type LaborKind,
  type PayrollPermission,
} from './payroll-config.js';

export {
  PayrollRuleId,
  PayRunId,
  EarningsRecordId,
  newPayRunId,
  newEarningsRecordId,
  newPayrollRuleRowId,
  uuidv7,
} from './payroll-ids.js';

export {
  PayrollInputError,
  PayrollNotFoundError,
  PayrollConflictError,
  isPayrollConflict,
} from './payroll-errors.js';

export {
  PAYROLL_EVENT_TYPES,
  PAYROLL_AGGREGATE_TYPES,
  makePayrollRulePublishedEvent,
  makePayRunComputedEvent,
  type PayrollEventProvenance,
  type PayrollRulePublishedPayload,
  type PayRunComputedPayload,
} from './payroll-events.js';

export type {
  PayrollRuleScope,
  PayrollRuleRow,
  CreatePayrollRuleInput,
  PayRunRuleRef,
  PayRunRow,
  AppendPayRunInput,
  EarningsRecordRow,
  AppendEarningsRecordInput,
  ListEarningsRecordsFilter,
  PayrollRuleStore,
  PayRunStore,
  EarningsRecordStore,
  PayrollDomainEventStore,
  PayrollOperationStore,
  PayrollStores,
} from './payroll-stores.js';

export {
  PAYROLL_COMMAND_KINDS,
  parseCommandEnvelopeBody,
  parseCommandBodyForKind,
  parsePayrollRulePublishPayload,
  parsePayrollRunMonthPayload,
  parsePayrollExportPayload,
  parseMonthParam,
  parseIdParam,
  requireRuleId,
  requireRateMinor,
  requireCoefficient,
  requireLaborKind,
  requirePeriodHours,
  type PayrollCommandKind,
  type PayrollCommand,
  type PayrollCommandEnvelope,
  type PayrollEnvelopeBody,
  type PayrollRulePublishPayload,
  type PayrollRunMonthPayload,
  type PayrollExportPayload,
} from './payroll-input.js';

export type { PayrollExportSheet, PayrollExportOutput } from './payroll-export-shapes.js';
export { JsonTablesPayrollExportPort, type PayrollExportPort } from './payroll-export.js';

export {
  PayrollService,
  currentRuleVersions,
  matchPayrollRule,
  type PayrollServiceOptions,
  type PayrollCommandResult,
  type PayrollCommitted,
  type PayrollRuleView,
  type PayRunGroupResult,
  type EarningsLineView,
  type PersonRunView,
  type RuleMatchResult,
  type RuleComparison,
  type RuleVersionDiff,
} from './payroll.service.js';

export {
  InMemoryPayrollRuleStore,
  InMemoryPayRunStore,
  InMemoryEarningsRecordStore,
  InMemoryPayrollDomainEventStore,
  InMemoryPayrollOperationStore,
  inMemoryPayrollStores,
} from './in-memory-payroll-stores.js';
