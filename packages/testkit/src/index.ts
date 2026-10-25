/**
 * @smes/testkit 公共 API。
 *
 * 对账测试三件套（ADR-0002 #3 行为等价的机器化身）：
 *   1. 夹具（fixtures/）：场景输入 + 参考输出 + 比对策略（录制-回放）
 *   2. Comparator：字段级深度比对（纯函数）
 *   3. ReconcileHarness：目标适配器 × 参考源 × 比对器 → 报告
 */
export { compareJson, renderValue, type DiffEntry, type DiffKind } from './comparator/comparator.js';
export {
  jsonTypeName,
  matchesShapeType,
  type ArrayRule,
  type CompareStrategy,
  type JsonTypeName,
  type NumericTolerance,
} from './comparator/strategy.js';
export { NodeFetchTargetAdapter, type NodeFetchTargetOptions } from './adapters/node-fetch-target-adapter.js';
export { StaticFixtureSource } from './adapters/static-fixture-source.js';
export {
  FixtureValidationError,
  loadFixtureDir,
  loadFixtureFile,
  validateFixtureShape,
} from './fixtures/load.js';
export {
  FIXTURE_FILE_SUFFIX,
  FIXTURE_FORMAT,
  HTTP_METHODS,
  SHAPE_TYPE_NAMES,
  type FixtureFileShape,
  type FixtureHttpMethod,
  type ShapeTypeName,
} from './fixtures/types.js';
export {
  ReconcileHarness,
  reconcileOutcome,
  type HarnessDeps,
  type ReconcileReport,
  type ScenarioResult,
} from './harness.js';
export {
  canonicalStringify,
  omitPaths,
  pathMatches,
  pathMatchesAny,
  patternToRegExp,
  renderPath,
  type PathSegment,
} from './paths.js';
export { recordFixtures, type RecordFixturesOptions, type RecordResult } from './record.js';
export { formatTextReport } from './report.js';

// ---- workorder 联动夹具（M2-W1：跨模块端口假实现，真实端口由兄弟模块合流提供） ----
export {
  FakeCustomerDirectoryPort,
  FakeInventoryAvailabilityPort,
  FakeListingRequirementPort,
  FakePartsIssuePort,
  FakeProgressFactPort,
} from './workorder-fixtures.js';
export type {
  ReferenceOutcome,
  ReferenceSource,
  ReconcileFixture,
  ReconcileScenario,
  TargetAdapter,
  TargetRequest,
  TargetResponse,
} from './types.js';

// ---- baseline 对账夹具（M2-W2 P1：命令提交体基线 + 物品库种子 + 判定期望） ----
export {
  BASELINE_RECON_THRESHOLDS,
  baselineItemLibrarySeeds,
  equipmentRegisterSubmission,
  expectedJudgments,
  materialValidateSubmission,
  nextBaselineOperationId,
  outsourcingRuleSetSubmission,
  processDefineSubmission,
  processReviseSubmission,
} from './baseline-fixtures.js';
export type {
  BaselineCommandSubmission,
  ExpectedJudgment,
  ItemSeed,
} from './baseline-fixtures.js';

// ---- inspection 联动夹具（M2-W4：放行/IM 假端口 + 三来源事实构造器，真实端口由兄弟模块合流提供） ----
export {
  FakeNotifyChannel,
  FakeStockReleasePort,
  finalReportFact,
  goodsReceiptFact,
  outsourcingReturnFact,
} from './inspection-fixtures.js';
export type {
  FixtureInspectionKind,
  FixtureInspectionSourceFact,
  FixtureInspectionSourceType,
  FixtureNotifyMessage,
  FixtureStockReleaseFact,
} from './inspection-fixtures.js';

// ---- listing 联动夹具（M2-W3：workorder 订阅 / inventory 可用量与入库 / 物料校验 / Excel 源） ----
export {
  FakeInventoryReceiptPort,
  FakeListingInventoryPort,
  FakeMaterialValidationExecutor,
  FakeWorkOrderCreatedFeed,
  LISTING_EXCEL_CN_HEADER,
  listingExcelSource,
} from './listing-fixtures.js';
export type {
  FixtureExcelSheet,
  FixtureInventoryReceiptCommand,
  FixtureListingKind,
  FixtureWorkOrderCreatedMessage,
} from './listing-fixtures.js';

// ---- dispatch 联动夹具（M2-W6：workorder 齐套读 / baseline 取价 / inspection 回厂 / 打印） ----
export {
  FakeDispatchInspectionIntake,
  FakeDispatchPrintPort,
  FakeKitCheckReadPort,
  FakeOutsourcingPriceSource,
} from './dispatch-fixtures.js';
export type {
  FixtureDispatchPrintDocument,
  FixtureDispatchSourceFact,
  FixtureKitCheckFact,
  FixtureOutsourcingPriceQuote,
} from './dispatch-fixtures.js';

// ---- inventory 联动夹具（M2-W5：ShippingConfirmed 订阅 / 放行事实种子） ----
export {
  FakeShippingConfirmedFeed,
  releasePhaseOf,
  seedReleaseFact,
  warehouseDefineFixture,
} from './inventory-fixtures.js';
export type {
  FixtureShippingConfirmedMessage,
  FixtureShippingLine,
  InventoryReleaseFactSeed,
} from './inventory-fixtures.js';

// ---- reporting 联动夹具（M2-W7：dispatch 有效单读 / baseline 工序合法性与末道 / inspection 末道触发） ----
export {
  FakeFinalOperationJudge,
  FakeOperationValidity,
  FakeReportInspectionIntake,
  FakeValidDispatchSource,
} from './reporting-fixtures.js';
export type {
  FixtureDispatchFactForReport,
  FixtureReportIntakeReceipt,
  FixtureReportSourceFact,
} from './reporting-fixtures.js';

// ---- hours 联动夹具（M2-W6：reporting verified/revoked 订阅 / baseline 额定对标） ----
export {
  FakeReportEventFeed,
  FakeStandardTimeLookup,
  fixtureVerifiedPayload,
} from './hours-fixtures.js';
export type {
  FixtureReportEventMessage,
  FixtureReportEventPayload,
  FixtureReportKind,
} from './hours-fixtures.js';

// ---- costing 联动夹具（M2-W6：inventory 材料金额 / dispatch 外协价格 / workorder 主体） ----
export {
  FakeMaterialCostSource,
  FakeOutsourcingCostSource,
  FakeWorkOrderSubject,
} from './costing-fixtures.js';
export type {
  FixtureMaterialCostLine,
  FixtureOutsourcingCostLine,
} from './costing-fixtures.js';

// ---- payroll 联动夹具（M3：hours 已审核工时事实源 PayrollSource 假实现 + 提交体基线） ----
export {
  FakePayrollLaborSource,
  fixtureVerifiedLaborFact,
  rulePublishSubmission,
  runMonthSubmission,
} from './payroll-fixtures.js';
export type {
  FixtureLaborKind,
  FixturePayrollLaborRequest,
  FixturePeriodSubmission,
  FixtureRulePublishSubmission,
  FixtureVerifiedLaborFact,
} from './payroll-fixtures.js';

// ---- metric-pack 联动夹具（M3：六种 sourceKind 事实源假实现 + 激活/求值提交体基线） ----
export {
  FIXTURE_MIN_PACK,
  FakeMetricSourceSet,
  activateSubmission,
  evaluateSubmission,
  fixtureMetricSourceRows,
} from './metric-pack-fixtures.js';
export type {
  FixtureActivateSubmission,
  FixtureEvaluateSubmission,
  FixtureMetricSource,
  FixtureMetricSourceRequest,
  FixtureMetricSourceRow,
} from './metric-pack-fixtures.js';

// ---- drawing 联动夹具（M3：钉版引用结构同形镜像 + 发布提交体基线） ----
export {
  fixtureDrawingRef,
  fixtureDrawingViewer,
  publishDrawingSubmission,
} from './drawing-fixtures.js';
export type {
  FixtureDrawingRef,
  FixtureDrawingViewer,
  FixturePublishSubmission,
} from './drawing-fixtures.js';

// ---- maintenance 联动夹具（M3：baseline FaultReported/FaultResolved 消费面假订阅 + 提交体基线） ----
export {
  FakeFaultReportedFeed,
  fixtureFaultReportedFact,
  planPublishSubmission,
  taskCreateSubmission,
  recordAppendSubmission,
} from './maintenance-fixtures.js';
export type {
  FixtureFaultReportedFact,
  FixtureFaultResolvedFact,
  FixtureMaintenanceCycle,
  FixturePlanPublishSubmission,
  FixtureTaskCreateSubmission,
  FixtureRecordAppendSubmission,
} from './maintenance-fixtures.js';
