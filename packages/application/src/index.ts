// 占位：见 architecture/status.md 与 ADR-0003/0004。落地里程碑见仓库 README。
export const APPLICATION_PLACEHOLDER = 'application:stub';

// ---- core（必装基础层，ADR-0004） ----
export {
  DEFAULT_TENANT_ID,
  TenantContext,
  fixedDefaultTenant,
} from './core/tenant-context.js';
export type { TenantResolver } from './core/tenant-context.js';
export { CoreService } from './core/core.service.js';
export { CoreModule } from './core/core.module.js';
export type { CoreModuleOptions } from './core/core.module.js';

// ---- core/auth：RBAC 鉴权基座（M1 增量 2-B，casbin 域模型 + 策略端口） ----
export {
  ADMIN_ROLE,
  AUTHORIZATION_MODEL,
  AUTHORIZATION_MODEL_V1,
  AUTHORIZATION_MODEL_VERSION,
} from './core/auth/authorization-model.js';
export {
  isPermissionCode,
  permissionCode,
  PermissionCodeError,
} from './core/auth/permission-code.js';
export type { PermissionCode } from './core/auth/permission-code.js';
export { splitPermissionCode } from './core/auth/permission-code.js';
export {
  parsePolicyRule,
  POLICY_STORE,
  PolicyRuleError,
  roleName,
} from './core/auth/policy-store.js';
export type { PolicyRule, PolicyStore, RoleName } from './core/auth/policy-store.js';
export { InMemoryPolicyStore } from './core/auth/in-memory-policy-store.js';
export { CasbinPolicyAdapter } from './core/auth/casbin-policy-adapter.js';
export { UnsupportedPolicyOperationError } from './core/auth/casbin-policy-adapter.js';
export { PermissionService } from './core/auth/permission.service.js';
export type { PermissionServiceOptions } from './core/auth/permission.service.js';
export {
  PERMISSION_METADATA_KEY,
  RequirePermission,
} from './core/auth/require-permission.decorator.js';
export {
  REQUEST_USER_KEY,
  type AuthenticatedRequest,
} from './core/auth/request-user.js';

// ---- auth：真实认证（M1 收尾波-③：密码 + opaque token 会话 + 登录流） ----
export { hashPassword, verifyPassword } from './auth/password.js';
export {
  SCRYPT_KEYLEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
} from './auth/password.js';
export { digestSessionToken, generateSessionToken } from './auth/token.js';
export { InMemorySessionStore } from './auth/session-stores.js';
export type {
  CreateSessionInput,
  SessionRecord,
  SessionRevoker,
  SessionStore,
} from './auth/session-stores.js';
export { AuthCredentialsError, AuthInputError } from './auth/auth-errors.js';
export { parseLoginInput, requireBearerToken } from './auth/auth-input.js';
export type { LoginPayload } from './auth/auth-input.js';
export {
  SESSION_REFRESH_WINDOW_MS,
  SESSION_TOKEN_TTL_MS,
} from './auth/auth.service.js';
export type {
  AuthAccountView,
  AuthServiceOptions,
  IssuedSession,
} from './auth/auth.service.js';
export { AuthService } from './auth/auth.service.js';
export { AuthController } from './auth/auth.controller.js';
export { AUTH_SESSION_STORE, AUTH_USER_STORE, AuthModule } from './auth/auth.module.js';
export type { AuthModuleOptions } from './auth/auth.module.js';

// ---- demo（示例环节模块壳，ADR-0004 按需启停） ----
export { DemoController } from './demo/demo.controller.js';
export { DemoModule } from './demo/demo.module.js';
export type { DemoModuleOptions } from './demo/demo.module.js';

// ---- org：组织/用户/角色管理（M1 增量 3-D，core 基础层章程） ----
export {
  OrgModule,
  ORG_ROLE_STORE,
  ORG_USER_STORE,
  ORG_DEPARTMENT_STORE,
  ORG_POSITION_STORE,
} from './org/org.module.js';
export type { OrgModuleOptions } from './org/org.module.js';
export { OrgService } from './org/org.service.js';
export type { GrantDiff, RoleGrantView } from './org/org.service.js';
export {
  InMemoryDepartmentStore,
  InMemoryPositionStore,
  InMemoryRoleStore,
  InMemoryUserStore,
} from './org/in-memory-org-stores.js';
export {
  OrgConflictError,
  OrgInputError,
  OrgNotFoundError,
} from './org/org-errors.js';
export {
  parseBackfillIdParam,
  parseCreateDepartmentInput,
  parseCreatePositionInput,
  parseCreateRoleInput,
  parseCreateUserInput,
  parsePermissionCodesInput,
  parseRoleNameParam,
  parseRoleNamesInput,
  parseUpdateDepartmentInput,
  parseUpdatePositionInput,
  parseUserIdParam,
  parseUserStatusInput,
} from './org/org-input.js';
export type {
  CreateDepartmentInput,
  CreatePositionInput,
  CreateRoleInput,
  CreateUserInput,
  DepartmentMaster,
  DepartmentStore,
  PositionMaster,
  PositionStore,
  RoleDefinition,
  RoleStore,
  UpdateDepartmentInput,
  UpdatePositionInput,
  UserAccount,
  UserCredentials,
  UserStore,
} from './org/org-stores.js';
export type {
  CreateDepartmentPayload,
  CreatePositionPayload,
  CreateRolePayload,
  CreateUserPayload,
  UpdateDepartmentPayload,
  UpdatePositionPayload,
  UserStatusPayload,
} from './org/org-input.js';

// ---- masterdata：物品/资源/客户/供应商/计量单位主数据（M1 4-I + S1 backfill #8/#9/#100） ----
export {
  MasterdataModule,
  MASTERDATA_ITEM_STORE,
  MASTERDATA_RESOURCE_STORE,
  MASTERDATA_CUSTOMER_STORE,
  MASTERDATA_SUPPLIER_STORE,
  MASTERDATA_UNIT_STORE,
} from './masterdata/masterdata.module.js';
export type { MasterdataModuleOptions } from './masterdata/masterdata.module.js';
export { MasterdataService } from './masterdata/masterdata.service.js';
export {
  InMemoryCustomerStore,
  InMemoryItemStore,
  InMemoryResourceStore,
  InMemorySupplierStore,
  InMemoryUnitStore,
} from './masterdata/in-memory-masterdata-stores.js';
export {
  MasterdataConflictError,
  MasterdataInputError,
  MasterdataNotFoundError,
} from './masterdata/masterdata-errors.js';
export {
  parseCreateCustomerInput,
  parseCreateItemInput,
  parseCreateResourceInput,
  parseCreateSupplierInput,
  parseCreateUnitInput,
  parseIdParam,
  parseUpdateCustomerInput,
  parseUpdateItemInput,
  parseUpdateResourceInput,
  parseUpdateSupplierInput,
  parseUpdateUnitInput,
} from './masterdata/masterdata-input.js';
export type {
  CreateCustomerInput,
  CreateItemInput,
  CreateResourceInput,
  CreateSupplierInput,
  CreateUnitInput,
  CustomerMaster,
  CustomerStore,
  ItemMaster,
  ItemStore,
  ResourceMaster,
  ResourceStore,
  SupplierMaster,
  SupplierStore,
  UnitMaster,
  UnitStore,
  UpdateCustomerInput,
  UpdateItemInput,
  UpdateResourceInput,
  UpdateSupplierInput,
  UpdateUnitInput,
} from './masterdata/masterdata-stores.js';
export type {
  CreateCustomerPayload,
  CreateItemPayload,
  CreateResourcePayload,
  CreateSupplierPayload,
  CreateUnitPayload,
  UpdateCustomerPayload,
  UpdateItemPayload,
  UpdateResourcePayload,
  UpdateSupplierPayload,
  UpdateUnitPayload,
} from './masterdata/masterdata-input.js';

// ---- audit：操作日志（S1 backfill：0920 #103，系统管理域） ----
export { AuditModule, AUDIT_LOG_STORE } from './audit/audit.module.js';
export type { AuditModuleOptions } from './audit/audit.module.js';
export { AuditService } from './audit/audit.service.js';
export { AuditController } from './audit/audit.controller.js';
export { AuditWriteInterceptor } from './audit/audit-write.interceptor.js';
export {
  InMemoryAuditLogStore,
  auditSummaryOf,
} from './audit/in-memory-audit-stores.js';
export { AuditInputError } from './audit/audit-errors.js';
export { parseAuditQueryInput, AUDIT_QUERY_DEFAULT_LIMIT, AUDIT_QUERY_MAX_LIMIT } from './audit/audit-input.js';
export type {
  AppendAuditInput,
  AuditLogEntry,
  AuditLogStore,
  AuditQueryFilter,
} from './audit/audit-stores.js';

// ---- standardreports：标准报表（S1 backfill：0920 #89/#91/#92/#96） ----
export {
  StandardReportsModule,
  STANDARD_REPORTS_SOURCE_PROVIDER,
} from './standardreports/standardreports.module.js';
export type { StandardReportsModuleOptions } from './standardreports/standardreports.module.js';
export { StandardReportsService } from './standardreports/standardreports.service.js';
export type { MetricCatalogEntry } from './standardreports/standardreports.service.js';
export { StandardReportsController } from './standardreports/standardreports.controllers.js';
export {
  STANDARD_REPORTS_PACK,
  STANDARD_REPORTS_PACK_ID,
} from './standardreports/standard-reports-pack.js';
export {
  reportSourceProviderOf,
  UNBOUND_REPORT_SOURCE_PROVIDER,
} from './standardreports/standardreports-stores.js';
export type { ReportSourceProvider } from './standardreports/standardreports-stores.js';
export { parseReportQueryInput } from './standardreports/standardreports-input.js';
export {
  StandardReportsInputError,
  StandardReportsNotFoundError,
  StandardReportsSourceError,
} from './standardreports/standardreports-errors.js';

// ---- workbench：工作台/待办（M1 增量 4-I，core 基础层章程） ----
export { WorkbenchModule, WORKBENCH_TODO_STORE } from './workbench/workbench.module.js';
export type { WorkbenchModuleOptions } from './workbench/workbench.module.js';
export { WorkbenchService } from './workbench/workbench.service.js';
export type { TodoSourceCount, WorkbenchSummary } from './workbench/workbench.service.js';
export { InMemoryTodoStore } from './workbench/in-memory-workbench-stores.js';
export {
  WorkbenchInputError,
  WorkbenchNotFoundError,
} from './workbench/workbench-errors.js';
export {
  parseCreateTodoInput,
  parseTodoIdParam,
} from './workbench/workbench-input.js';
export type { CreateTodoPayload } from './workbench/workbench-input.js';
export type { CreateTodoInput, TodoItem, TodoStatus, TodoStore } from './workbench/workbench-stores.js';

// ---- approval：审批（M1 收尾波-①，engine-flow 组合根消费者，ADR-0011） ----
export {
  ApprovalModule,
  APPROVAL_CASE_STORE,
  APPROVAL_EVENT_STORE,
  APPROVAL_RECORD_STORE,
  APPROVAL_TODO_STORE,
} from './approval/approval.module.js';
export type { ApprovalModuleOptions } from './approval/approval.module.js';
export {
  ApprovalService,
  APPROVAL_CASE_AGGREGATE_TYPE,
  APPROVAL_TODO_SOURCE,
} from './approval/approval.service.js';
export type {
  ApprovalActResult,
  ApprovalCaseDetail,
  ApprovalStartResult,
  ApprovalServiceOptions,
} from './approval/approval.service.js';
export { InMemoryApprovalCaseStore } from './approval/in-memory-approval-stores.js';
export {
  ApprovalConflictError,
  ApprovalInputError,
  ApprovalNotFoundError,
  ApprovalStateError,
} from './approval/approval-errors.js';
export {
  parseCaseIdParam,
  parseDecisionInput,
  parseStartApprovalInput,
  parseStateFilter,
} from './approval/approval-input.js';
export type { DecisionPayload, StartApprovalPayload } from './approval/approval-input.js';
export type {
  ApprovalCase,
  ApprovalCaseStore,
  ApprovalSubjectRefView,
  CreateApprovalCaseInput,
  ListApprovalCasesFilter,
} from './approval/approval-stores.js';

// ---- baseline：技术准备环节 P1 子集（M2-W2：工序库/物料校验执行/外协计价/设备台账） ----
export {
  BaselineModule,
  BASELINE_EQUIPMENT_STORE,
  BASELINE_EVENT_STORE,
  BASELINE_ITEM_LIBRARY,
  BASELINE_OPERATION_LEDGER,
  BASELINE_OUTSOURCING_RULE_STORE,
  BASELINE_PROCESS_STORE,
  BASELINE_VALIDATION_RUN_STORE,
} from './baseline/baseline.module.js';
export type {
  BaselineModuleOptions,
  BaselineStoreInputs,
} from './baseline/baseline.module.js';
export { completeBaselineStores, createInMemoryBaselineStores } from './baseline/baseline.module.js';
export {
  BaselineService,
  type MaterialValidationExecutor,
  type OutsourcingPriceLookup,
} from './baseline/baseline.service.js';
export type {
  BaselineServiceOptions,
  EquipmentView,
  MasterDetail,
  MasterVersionView,
  OutsourcingPriceRuleView,
  ProcessDefView,
} from './baseline/baseline.service.js';
export {
  BASELINE_AUDIT_STATUS_UNAUDITED,
  effectiveStatus,
  isSuperseded,
  currentVersion,
  sortByVersion,
} from './baseline/baseline-versioning.js';
export type {
  EffectiveMasterStatus,
  StoredMasterStatus,
  VersionedMasterFields,
} from './baseline/baseline-versioning.js';
export {
  BaselineConflictError,
  BaselineInputError,
  BaselineNotFoundError,
} from './baseline/baseline-errors.js';
export { EquipmentId, OutsourcingPriceRuleId, ProcessId } from './baseline/baseline-ids.js';
export {
  BASELINE_AGGREGATE_TYPES,
  BASELINE_EVENT_TYPES,
  makeEquipmentRegisteredEvent,
  makeMaterialValidatedEvent,
  makeOutsourcingRuleSetEvent,
  makeProcessDefinedEvent,
} from './baseline/baseline-events.js';
export type {
  BaselineProvenance,
  MasterCommandAction,
  MasterEventPayload,
  MaterialValidatedEventPayload,
} from './baseline/baseline-events.js';
export {
  BASELINE_COMMAND_KINDS,
  makeBaselineCommandEnvelope,
  parseCommandSubmission,
} from './baseline/baseline-input.js';
export type {
  BaselineCommand,
  BaselineCommandEnvelope,
  BaselineCommandKind,
  CommandSubmissionFields,
  CommandSubmissionIdentity,
  EquipmentRegisterPayload,
  EquipmentRevisePayload,
  MaterialValidatePayload,
  OutsourcingRuleSetPayload,
  OutsourcingRuleRevisePayload,
  ProcessDefinePayload,
  ProcessRevisePayload,
} from './baseline/baseline-input.js';
export type {
  BaselineEventStore,
  BaselineOperationLedger,
  BaselineStores,
  CreateEquipmentInput,
  CreateOutsourcingPriceRuleInput,
  CreateProcessDefInput,
  EquipmentRow,
  EquipmentStore,
  MaterialValidationRunRow,
  MaterialValidationRunStore,
  MaterialValidationRunSummaryView,
  OutsourcingPriceRuleRow,
  OutsourcingPriceRuleStore,
  ProcessDefRow,
  ProcessDefStore,
} from './baseline/baseline-stores.js';
export {
  InMemoryBaselineEventStore,
  InMemoryBaselineOperationLedger,
  InMemoryEquipmentStore,
  InMemoryMaterialValidationRunStore,
  InMemoryOutsourcingPriceRuleStore,
  InMemoryProcessDefStore,
} from './baseline/in-memory-baseline-stores.js';
export {
  DEFAULT_MATERIAL_VALIDATION_THRESHOLDS,
  bigramDiceSimilarity,
  judgeMaterialLine,
  normalizeName,
  normalizeSpec,
  validateMaterialLines,
} from './baseline/material-validation.js';
export type {
  MaterialJudgment,
  MaterialJudgmentBasis,
  MaterialLineJudgment,
  MaterialValidationLine,
  MaterialValidationSummary,
  MaterialValidationThresholds,
} from './baseline/material-validation.js';
export {
  MAX_MARGIN_PERMYRIAD,
  MAX_UNIT_PRICE_MINOR,
  computeOutsourcingPriceMinor,
  decimalToMinor,
  minorToDecimal,
  parseMarginPermyriad,
  pickActiveRuleForProcess,
  quoteOutsourcingRule,
} from './baseline/outsourcing-price.js';
export type {
  OutsourcingPricePricedRule,
  OutsourcingPriceQuote,
} from './baseline/outsourcing-price.js';
export {
  BaselineEquipmentController,
  BaselineMaterialValidationsController,
  BaselineOutsourcingRulesController,
  BaselineProcessesController,
  BaselineRoutingsController,
  BaselineStandardTimesController,
  BaselineFaultReportsController,
} from './baseline/baseline.controllers.js';

// ---- baseline P2/P3 件（M2-W7：工艺路线 / 额定工时 / 故障上报 / 下图统计事实） ----
export {
  BASELINE_ROUTING_STORE,
  BASELINE_STANDARD_TIME_STORE,
  BASELINE_FAULT_REPORT_STORE,
  BASELINE_FAULT_EVENT_STORE,
  BASELINE_TODO_STORE,
  BASELINE_NOTIFY_CHANNEL,
  BASELINE_WORKORDER_DRAWING_SOURCE,
} from './baseline/baseline.module.js';
export {
  DEFAULT_FAULT_REPORT_FLOW_CONFIG,
  FAULT_REPORT_FLOW_ID,
  FAULT_REPORT_STATE_IDS,
  FAULT_REPORT_STATES,
  faultReportStateLabel,
} from './baseline/baseline-fault-config.js';
export type { FaultReportStateId } from './baseline/baseline-fault-config.js';
export {
  BASELINE_TODO_SOURCE,
  EMPTY_WORKORDER_DRAWING_SOURCE,
} from './baseline/baseline-ports.js';
export type {
  DrawingReceiptFact,
  StandardTimeBenchmark,
  StandardTimeLookup,
  WorkOrderDrawingSource,
} from './baseline/baseline-ports.js';
export { FaultReportId, RoutingId, StandardTimeId, newFaultReportId } from './baseline/baseline-ids.js';
export {
  makeFaultReportedEvent,
  makeFaultResolvedEvent,
  makeRoutingRevisedEvent,
  makeStandardTimeDefinedEvent,
} from './baseline/baseline-events.js';
export type {
  FaultReportedEventPayload,
  FaultResolvedEventPayload,
} from './baseline/baseline-events.js';
export type {
  FaultReportPayload,
  FaultResolvePayload,
  RoutingDefinePayload,
  RoutingRevisePayload,
  RoutingStepInput,
  StandardTimeDefinePayload,
} from './baseline/baseline-input.js';
export { makeBaselineCommandEnvelopeForKind, MAX_STANDARD_SECONDS } from './baseline/baseline-input.js';
export type {
  CreateFaultReportInput,
  CreateRoutingInput,
  CreateStandardTimeInput,
  FaultReport,
  FaultReportAdvanceExtra,
  FaultReportStore,
  ListFaultReportsFilter,
  RoutingRow,
  RoutingStep,
  RoutingStore,
  StandardTimeRow,
  StandardTimeScope,
  StandardTimeStore,
} from './baseline/baseline-stores.js';
export {
  InMemoryFaultReportStore,
  InMemoryRoutingStore,
  InMemoryStandardTimeStore,
} from './baseline/in-memory-baseline-stores.js';
export type { BaselineFaultPorts } from './baseline/baseline.service.js';
export type { RoutingView, StandardTimeView } from './baseline/baseline.service.js';

// ---- workorder：工作令模块（M2-W1：九态全生命周期 + 配件申请 + 齐套检查） ----
export {
  WorkOrderModule,
  WORKORDER_ORDER_STORE,
  WORKORDER_ATTACHMENT_STORE,
  WORKORDER_PARTS_STORE,
  WORKORDER_KIT_STORE,
  WORKORDER_OPERATION_STORE,
  WORKORDER_DOMAIN_EVENT_STORE,
  WORKORDER_MACHINE_EVENT_STORE,
  WORKORDER_TODO_STORE,
  WORKORDER_LISTING_PORT,
  WORKORDER_INVENTORY_PORT,
  WORKORDER_ISSUE_PORT,
  WORKORDER_PROGRESS_PORT,
  WORKORDER_CUSTOMER_PORT,
  WORKORDER_SERVICE_OPTIONS,
} from './workorder/workorder.module.js';
export type { WorkOrderModuleOptions } from './workorder/workorder.module.js';
export { WorkOrderService } from './workorder/workorder.service.js';
export type {
  WorkOrderCommitted,
  WorkOrderCommandResult,
  WorkOrderServiceOptions,
  WorkOrderCrossModulePorts,
  WorkOrderDetail,
  WorkOrderProgressView,
  KitBoardRow,
  WorkOrderDeliverySituation,
  PartsRequestDetail,
} from './workorder/workorder.service.js';
export {
  WorkOrderInputError,
  WorkOrderNotFoundError,
  WorkOrderConflictError,
  WorkOrderStateError,
} from './workorder/workorder-errors.js';
export {
  WORK_ORDER_FLOW_ID,
  WORK_ORDER_STATE_IDS,
  WORK_ORDER_STATES,
  workOrderStateLabel,
  DEFAULT_WORK_ORDER_FLOW_CONFIG,
  PARTS_REQUEST_FLOW_ID,
  PARTS_REQUEST_STATE_IDS,
  DEFAULT_PARTS_REQUEST_FLOW_CONFIG,
  LISTING_KINDS,
  DEFAULT_KIT_SCOPE_KINDS,
} from './workorder/workorder-config.js';
export type {
  WorkOrderStateId,
  PartsRequestStateId,
  ListingKind,
} from './workorder/workorder-config.js';
export {
  WorkOrderAttachmentId,
  PartsRequestId,
  KitCheckId,
  newWorkOrderId,
  newAttachmentId,
  newPartsRequestId,
  newKitCheckId,
  newDomainEventId,
} from './workorder/workorder-ids.js';
export {
  WORK_ORDER_AGGREGATE_TYPE,
  WORK_ORDER_ATTACHMENT_AGGREGATE_TYPE,
  PARTS_REQUEST_AGGREGATE_TYPE,
  KIT_CHECK_AGGREGATE_TYPE,
  WORKORDER_EVENT_TYPES,
  provenanceOf,
  makeWorkOrderCreatedEvent,
  makeWorkOrderUpdatedEvent,
  makeWorkOrderTransitionedEvent,
  makeAttachmentAddedEvent,
  makePartsRequestedEvent,
  makePartsDecidedEvent,
  makePartsShippedEvent,
  makeKitCheckRefreshedEvent,
} from './workorder/workorder-events.js';
export type {
  WorkOrderEventProvenance,
  WorkOrderCreatedPayload,
  WorkOrderUpdatedPayload,
  WorkOrderTransitionedPayload,
  AttachmentAddedPayload,
  PartsRequestedPayload,
  PartsDecision,
  PartsDecidedPayload,
  PartsShippedPayload,
  KitCheckKindSummaryPayload,
  KitCheckLineGapPayload,
  KitCheckRefreshedPayload,
} from './workorder/workorder-events.js';
export {
  WORKORDER_COMMAND_KINDS,
  parseCommandEnvelopeBody,
  parseCommandBodyForKind,
  parseCreateWorkOrderPayload,
  parseUpdateWorkOrderPayload,
  parseTransitionWorkOrderPayload,
  parseCloseWorkOrderPayload,
  parseAttachPayload,
  parsePartsRequestPayload,
  parsePartsDecisionPayload,
  parsePartsShipPayload,
  parseKitRefreshPayload,
  parseIdParam as parseWorkOrderIdParam,
  parseStateFilter as parseWorkorderStateFilter,
} from './workorder/workorder-input.js';
export type {
  WorkOrderCommandKind,
  WorkOrderCommand,
  WorkOrderEnvelopeBody,
  CreateWorkOrderPayload,
  UpdateWorkOrderPayload,
  EvidenceRefInput,
  TransitionWorkOrderPayload,
  CloseWorkOrderPayload,
  AttachPayload,
  PartsRequestPayload,
  PartsDecisionPayload,
  PartsShipPayload,
} from './workorder/workorder-input.js';
export {
  EMPTY_LISTING_PORT,
  EMPTY_INVENTORY_PORT,
  NOOP_PARTS_ISSUE_PORT,
  EMPTY_PROGRESS_PORT,
  EMPTY_CUSTOMER_PORT,
  WORKORDER_TODO_SOURCE,
} from './workorder/workorder-ports.js';
export type {
  ListingRequirementLine,
  ListingRequirementPort,
  InventoryAvailabilityPort,
  PartsIssueReceipt,
  PartsIssueCommand,
  PartsIssuePort,
  ProgressStage,
  ProgressFact,
  ProgressFactPort,
  CustomerDirectoryEntry,
  CustomerDirectoryPort,
} from './workorder/workorder-ports.js';
export {
  rollupMachiningProgress,
  rollupAssemblyProgress,
  milestoneHistory,
  daysToDelivery,
  deliveryRiskLevel,
  stateDistribution,
} from './workorder/workorder-progress.js';
export type {
  MachiningProgressRow,
  AssemblyProgressRow,
  WorkOrderMilestone,
  DeliveryRiskLevel,
  DeliverySituationRow,
} from './workorder/workorder-progress.js';
export type {
  WorkOrder,
  CreateWorkOrderInput,
  UpdateWorkOrderFields,
  ListWorkOrdersFilter,
  WorkOrderStore,
  WorkOrderAttachment,
  AppendAttachmentInput,
  WorkOrderAttachmentStore,
  PartsRequest,
  CreatePartsRequestInput,
  ListPartsRequestsFilter,
  PartsRequestStore,
  KitCheck,
  AppendKitCheckInput,
  KitCheckStore,
  OperationRecord,
  WorkOrderOperationStore,
  WorkOrderDomainEventStore,
} from './workorder/workorder-stores.js';
export {
  InMemoryWorkOrderStore,
  InMemoryWorkOrderAttachmentStore,
  InMemoryPartsRequestStore,
  InMemoryKitCheckStore,
  InMemoryWorkOrderOperationStore,
  InMemoryWorkOrderDomainEventStore,
  ATTACHMENT_AUDIT_STATUS,
  KIT_CHECK_AUDIT_STATUS,
} from './workorder/in-memory-workorder-stores.js';
export {
  WorkOrdersController,
  WorkOrderQueriesController,
  PartsRequestsController,
} from './workorder/workorder.controllers.js';

// ---- inspection 四类质检模块（M2-W4，06-inspection.md v1.0） ----
export {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_INSPECTION_FLOW_CONFIG,
  DEFAULT_NONCONFORM_FLOW_CONFIG,
  INSPECTION_FLOW_ID,
  INSPECTION_KINDS,
  INSPECTION_KIND_LABELS,
  INSPECTION_SOURCE_TYPES,
  INSPECTION_STATE_IDS,
  INSPECTION_STATES,
  NONCONFORM_DISPOSALS,
  NONCONFORM_FLOW_ID,
  NONCONFORM_STATE_IDS,
  NONCONFORM_STATES,
  PURCHASE_INSPECTION_KINDS,
  inspectionKindLabel,
  inspectionStateLabel,
  kindForSourceFact,
  nonconformDisposalLabel,
  nonconformStateLabel,
} from './inspection/inspection-config.js';
export type {
  InspectionKind,
  InspectionSourceType,
  InspectionStateId,
  NonconformDisposal,
  NonconformStateId,
} from './inspection/inspection-config.js';
export {
  NonconformId,
  newInspectionId,
  newNonconformId,
} from './inspection/inspection-ids.js';
export {
  InspectionConflictError,
  InspectionInputError,
  InspectionNotFoundError,
  InspectionStateError,
} from './inspection/inspection-errors.js';
export {
  INSPECTION_AGGREGATE_TYPE,
  INSPECTION_EVENT_TYPES,
  NONCONFORM_AGGREGATE_TYPE,
} from './inspection/inspection-events.js';
export type {
  InspectionCreatedPayload,
  InspectionEventProvenance,
  InspectionJudgePhase,
  InspectionJudgedPayload,
  InspectionOverduePayload,
  InspectionReleasedPayload,
  NonconformClosedPayload,
  NonconformDisposedPayload,
} from './inspection/inspection-events.js';
export {
  EMPTY_INSPECTION_INTAKE_PORT,
  INSPECTION_TODO_SOURCE,
  NOOP_NOTIFY_CHANNEL,
  NOOP_STOCK_RELEASE_PORT,
} from './inspection/inspection-ports.js';
export type {
  InspectionIntakePort,
  InspectionIntakeReceipt,
  InspectionSourceFact,
  NotifyChannel,
  NotifyMessage,
  StockReleaseFact,
  StockReleasePort,
} from './inspection/inspection-ports.js';
export type {
  CreateInspectionInput,
  CreateNonconformInput,
  InspectionDomainEventStore,
  InspectionOperationStore,
  InspectionOrder,
  InspectionOrderStore,
  JudgmentFields,
  ListInspectionsFilter,
  ListNonconformsFilter,
  Nonconform,
  NonconformAdvanceExtra,
  NonconformStore,
  OperationRecord as InspectionOperationRecord,
} from './inspection/inspection-stores.js';
export {
  INSPECTION_COMMAND_KINDS,
} from './inspection/inspection-input.js';
export type {
  CloseNonconformPayload,
  CreateInspectionPayload,
  DisposeNonconformPayload,
  InspectionCommand,
  InspectionCommandKind,
  InspectionEnvelopeBody,
  JudgeInspectionPayload,
} from './inspection/inspection-input.js';
export {
  milestoneHistory as inspectionMilestoneHistory,
  rollupInspectionSummary,
} from './inspection/inspection-summary.js';
export type {
  InspectionKindSummaryRow,
  InspectionMilestone as InspectionMilestoneRow,
  InspectionSummary,
} from './inspection/inspection-summary.js';
export {
  InMemoryInspectionDomainEventStore,
  InMemoryInspectionOperationStore,
  InMemoryInspectionOrderStore,
  InMemoryNonconformStore,
} from './inspection/in-memory-inspection-stores.js';
export {
  InspectionService,
} from './inspection/inspection.service.js';
export type {
  InspectionCommandResult,
  InspectionCommitted,
  InspectionCrossModulePorts,
  InspectionDetail,
  InspectionOverdueNotification,
  InspectionServiceOptions,
  NonconformDetail,
} from './inspection/inspection.service.js';
export {
  InspectionModule,
  INSPECTION_DOMAIN_EVENT_STORE,
  INSPECTION_MACHINE_EVENT_STORE,
  INSPECTION_NONCONFORM_STORE,
  INSPECTION_NOTIFY_CHANNEL,
  INSPECTION_ORDER_STORE,
  INSPECTION_OPERATION_STORE,
  INSPECTION_SERVICE_OPTIONS,
  INSPECTION_STOCK_RELEASE_PORT,
  INSPECTION_TODO_STORE,
} from './inspection/inspection.module.js';
export type { InspectionModuleOptions } from './inspection/inspection.module.js';
export {
  InspectionQueriesController,
  InspectionsController,
  NonconformitiesController,
} from './inspection/inspection.controllers.js';

// ---- listing：清单与采购模块（M2-W3：四类清单/缺口核查/三类申请/订单五态/退货/逾期） ----
export {
  ListingModule,
  LISTING_SHEET_STORE,
  LISTING_LINE_STORE,
  LISTING_GAP_STORE,
  LISTING_REQUEST_STORE,
  LISTING_ORDER_STORE,
  LISTING_RETURN_STORE,
  LISTING_OPERATION_STORE,
  LISTING_DOMAIN_EVENT_STORE,
  LISTING_MACHINE_EVENT_STORE,
  LISTING_TODO_STORE,
  LISTING_WORK_ORDER_FEED,
  LISTING_INVENTORY_PORT,
  LISTING_RECEIPT_PORT,
  LISTING_EXCEL_PORT,
  LISTING_MATERIAL_VALIDATION,
  LISTING_SERVICE_OPTIONS,
} from './listing/listing.module.js';
export type { ListingModuleOptions } from './listing/listing.module.js';
export { ListingService } from './listing/listing.service.js';
export type {
  ListingCommitted,
  ListingCommandResult,
  ListingServiceOptions,
  ListingCrossModulePorts,
  PurchaseOrderDetail,
  PurchaseOverdueRow,
  PurchaseDetailRow,
  PurchaseDetailRows,
} from './listing/listing.service.js';
export {
  ListingInputError,
  ListingNotFoundError,
  ListingConflictError,
  ListingStateError,
} from './listing/listing-errors.js';
export {
  // LISTING_KINDS / ListingKind 已由 workorder 导出块公开（四类清单词汇镜像），
  // 此处不重复导出；listing-config 内的同名常量为模块内规范源。
  DEFAULT_GAP_SCOPE_KINDS,
  listingKindLabel,
  PURCHASE_REQUEST_KINDS,
  requestKindOfListingKind,
  PURCHASE_ORDER_FLOW_ID,
  PURCHASE_ORDER_STATE_IDS,
  PURCHASE_ORDER_STATES,
  purchaseOrderStateLabel,
  DEFAULT_PURCHASE_ORDER_FLOW_CONFIG,
  PURCHASE_REQUEST_FLOW_ID,
  PURCHASE_REQUEST_STATE_IDS,
  PURCHASE_REQUEST_STATES,
  purchaseRequestStateLabel,
  DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG,
  PURCHASE_RETURN_FLOW_ID,
  PURCHASE_RETURN_STATE_IDS,
  PURCHASE_RETURN_STATES,
  purchaseReturnStateLabel,
  DEFAULT_PURCHASE_RETURN_FLOW_CONFIG,
} from './listing/listing-config.js';
export type {
  PurchaseRequestKind,
  PurchaseOrderStateId,
  PurchaseRequestStateId,
  PurchaseReturnStateId,
} from './listing/listing-config.js';
export {
  ListingSheetId,
  ListingLineId,
  PurchaseRequestId,
  PurchaseOrderId,
  PurchaseReturnId,
  newListingSheetId,
  newListingLineId,
  newPurchaseRequestId,
  newPurchaseOrderId,
  newPurchaseReturnId,
  newGapCheckId,
  newDomainEventId as newListingDomainEventId,
} from './listing/listing-ids.js';
export {
  LISTING_SHEET_AGGREGATE_TYPE,
  LISTING_LINE_AGGREGATE_TYPE,
  GAP_CHECK_AGGREGATE_TYPE,
  PURCHASE_REQUEST_AGGREGATE_TYPE,
  PURCHASE_ORDER_AGGREGATE_TYPE,
  PURCHASE_RETURN_AGGREGATE_TYPE,
  LISTING_EVENT_TYPES,
  makeListingImportedEvent,
  makeListingLineValidatedEvent,
  makeListingLineUpdatedEvent,
  makeGapCheckedEvent,
  makePurchaseRequestedEvent,
  makePurchaseOrderTransitionedEvent,
  makePurchaseReturnedEvent,
  makePurchaseOverdueEvent,
} from './listing/listing-events.js';
export type {
  ListingEventProvenance,
  ListingImportedPayload,
  ListingLineValidatedPayload,
  ListingLineValidatedLinePayload,
  ListingLineUpdatedPayload,
  GapCheckedPayload,
  PurchaseRequestedPayload,
  PurchaseOrderSubmittedPayload,
  PurchaseOrderApprovedPayload,
  PurchaseOrderIssuedPayload,
  PurchaseOrderReceivedPayload,
  PurchaseReturnedPayload,
  PurchaseOverduePayload,
  ListingMachineMilestone,
} from './listing/listing-events.js';
export {
  LISTING_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseListingCommandEnvelopeBody,
  parseCommandBodyForKind as parseListingCommandBodyForKind,
  parseListingImportPayload,
  parseUpdateListingLinePayload,
  parsePurchaseRequestCreatePayload,
  parsePurchaseOrderSubmitPayload,
  parsePurchaseOrderDecisionPayload,
  parsePurchaseOrderIssuePayload,
  parsePurchaseOrderReceivePayload,
  parsePurchaseReturnCreatePayload,
  parsePurchaseReturnRevokePayload,
  parseIdParam as parseListingIdParam,
  parseStateFilter as parseListingStateFilter,
  parseWorkOrderFilter,
} from './listing/listing-input.js';
export type {
  ListingCommandKind,
  ListingCommand,
  ListingEnvelopeBody,
  ListingImportPayload,
  ImportFromWorkOrderPayload,
  ImportFromExcelPayload,
  UpdateListingLinePayload,
  PurchaseRequestCreatePayload,
  PurchaseOrderSubmitPayload,
  PurchaseOrderLinePayload,
  PurchaseOrderDecisionPayload,
  PurchaseOrderIssuePayload,
  PurchaseOrderReceivePayload,
  PurchaseReturnCreatePayload,
  PurchaseReturnRevokePayload,
} from './listing/listing-input.js';
export {
  EMPTY_WORK_ORDER_CREATED_FEED,
  LISTING_EMPTY_INVENTORY_PORT,
  LISTING_NOOP_RECEIPT_PORT,
  LISTING_UNWIRED_MATERIAL_VALIDATION,
  LISTING_TODO_SOURCE,
  materialValidationOperationId,
  createListingRequirementAdapter,
} from './listing/listing-ports.js';
export type {
  WorkOrderCreatedEventShape,
  WorkOrderCreatedEventMessage,
  WorkOrderCreatedFeedPort,
  InventoryReceiptCommand,
  InventoryReceiptResult,
  InventoryReceiptPort,
  ListingRequirementSnapshotLine,
  ListingRequirementSource,
} from './listing/listing-ports.js';
export type { InventoryAvailabilityPort as ListingInventoryAvailability } from './listing/listing-ports.js';
export {
  ExcelPort,
  JsonTablesExcelPort,
  LISTING_IMPORT_ALIAS_MAP,
  parseListingTable,
  fileLevelIssues,
  requireExcelSource,
} from './listing/excel-port.js';
export type {
  ExcelSheet,
  ExcelSource,
  ExcelImportRow,
  ExcelParseIssue,
  ExcelParseResult,
  ExcelExport,
  ListingImportColumn,
} from './listing/excel-port.js';
export type {
  ListingSheet,
  CreateListingSheetInput,
  ListingSheetStore,
  ListingLine,
  AppendListingLineInput,
  UpdateListingLineFields,
  ListingLineStore,
  ListingLineValidationStatus,
  ListingLineJudgmentBasis,
  ListingLineSource,
  GapLine,
  GapKindSummary,
  GapCheck,
  AppendGapCheckInput,
  GapCheckStore,
  PurchaseRequest,
  CreatePurchaseRequestInput,
  ListPurchaseRequestsFilter,
  PurchaseRequestSource,
  PurchaseRequestStore,
  PurchaseOrder,
  PurchaseOrderLine,
  CreatePurchaseOrderInput,
  ListPurchaseOrdersFilter,
  PurchaseOrderStore,
  PurchaseReturn,
  PurchaseReturnLine,
  CreatePurchaseReturnInput,
  PurchaseReturnStore,
  ListingOperationRecord,
  ListingOperationStore,
  ListingDomainEventStore,
  ListingRowIssue,
} from './listing/listing-stores.js';
export {
  InMemoryListingSheetStore,
  InMemoryListingLineStore,
  InMemoryGapCheckStore,
  InMemoryPurchaseRequestStore,
  InMemoryPurchaseOrderStore,
  InMemoryPurchaseReturnStore,
  InMemoryListingOperationStore,
  InMemoryListingDomainEventStore,
  GAP_CHECK_AUDIT_STATUS,
} from './listing/in-memory-listing-stores.js';
export {
  ListingSheetsController,
  PurchaseRequestsController,
  PurchaseOrdersController,
  PurchaseReturnsController,
  PurchaseQueriesController,
} from './listing/listing.controllers.js';

// ---- dispatch：六类派工模块（M2-W6：零件/外协/装配/电气/售后/零工 + 外协链路） ----
export {
  DispatchModule,
  DISPATCH_ORDER_STORE,
  DISPATCH_OUTSOURCING_LINE_STORE,
  DISPATCH_OPERATION_STORE,
  DISPATCH_DOMAIN_EVENT_STORE,
  DISPATCH_MACHINE_EVENT_STORE,
  DISPATCH_TODO_STORE,
  DISPATCH_KIT_CHECK_PORT,
  DISPATCH_PRICE_SOURCE,
  DISPATCH_INSPECTION_INTAKE,
  DISPATCH_PRINT_PORT,
  DISPATCH_SERVICE_OPTIONS,
} from './dispatch/dispatch.module.js';
export type { DispatchModuleOptions } from './dispatch/dispatch.module.js';
export { DispatchService } from './dispatch/dispatch.service.js';
export type {
  DispatchCommitted,
  DispatchCommandResult,
  DispatchServiceOptions,
  DispatchCrossModulePorts,
  DispatchDetail,
  OutsourcingSupplierRow,
} from './dispatch/dispatch.service.js';
export {
  DispatchInputError,
  DispatchNotFoundError,
  DispatchConflictError,
  DispatchStateError,
} from './dispatch/dispatch-errors.js';
export {
  DEFAULT_DISPATCH_FLOW_CONFIG,
  DEFAULT_KIT_GATED_KINDS,
  DISPATCH_CANCELLABLE_STATES,
  DISPATCH_FLOW_ID,
  DISPATCH_KINDS,
  DISPATCH_STATE_IDS,
  DISPATCH_STATES,
  dispatchKindLabel,
  dispatchStateLabel,
  progressStageOfDispatchKind,
} from './dispatch/dispatch-config.js';
export type { DispatchKind, DispatchStateId } from './dispatch/dispatch-config.js';
export {
  DispatchId,
  OutsourcingLineId,
  newDispatchOrderId,
  newOutsourcingLineId,
  newDomainEventId as newDispatchDomainEventId,
} from './dispatch/dispatch-ids.js';
export {
  DISPATCH_ORDER_AGGREGATE_TYPE,
  OUTSOURCING_LINE_AGGREGATE_TYPE,
  DISPATCH_EVENT_TYPES,
  makeDispatchCreatedEvent,
  makeDispatchAssignedEvent,
  makeDispatchStartedEvent,
  makeDispatchCompletedEvent,
  makeDispatchCancelledEvent,
  makeOutsourcingPricedEvent,
  provenanceOf as dispatchProvenanceOf,
} from './dispatch/dispatch-events.js';
export type {
  DispatchEventProvenance,
  DispatchCreatedPayload,
  DispatchAssignedPayload,
  DispatchStartedPayload,
  DispatchCompletedPayload,
  DispatchCancelledPayload,
  OutsourcingPricedPayload,
  DispatchProgressFactPayload,
  InspectionIntakeReceiptPayload,
  DispatchMachineMilestone,
} from './dispatch/dispatch-events.js';
export {
  DISPATCH_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseDispatchCommandEnvelopeBody,
  parseCommandBodyForKind as parseDispatchCommandBodyForKind,
  parseDispatchCreatePayload,
  parseDispatchAssignPayload,
  parseDispatchStartPayload,
  parseDispatchCompletePayload,
  parseDispatchCancelPayload,
  parseOutsourcingPriceBackfillPayload,
  parseIdParam as parseDispatchIdParam,
  parseStateFilter as parseDispatchStateFilter,
  parseKindFilter,
  parseWorkOrderFilter as parseDispatchWorkOrderFilter,
  parseAssigneeFilter,
  parseSupplierFilter,
} from './dispatch/dispatch-input.js';
export type {
  DispatchCommandKind,
  DispatchCommand,
  DispatchEnvelopeBody,
  DispatchCreatePayload,
  OutsourcingLinePayload,
  DispatchAssignPayload,
  DispatchStartPayload,
  DispatchCompletePayload,
  DispatchCancelPayload,
  OutsourcingPriceBackfillPayload,
} from './dispatch/dispatch-input.js';
export {
  EMPTY_KIT_CHECK_PORT,
  DISPATCH_EMPTY_PRICE_SOURCE,
  DISPATCH_NOOP_INSPECTION_INTAKE,
  DISPATCH_NOOP_PRINT_PORT,
  DISPATCH_TODO_SOURCE,
  DISPATCH_TODO_REF_TYPE,
  toKitCheckFact,
  createDispatchProgressAdapter,
} from './dispatch/dispatch-ports.js';
export type {
  KitCheckFact,
  KitCheckReadPort,
  KitCheckSnapshotLike,
  OutsourcingPriceSource,
  DispatchPrintDocument,
  DispatchPrintReceipt,
  DispatchPrintPort,
  DispatchProgressFact,
  DispatchProgressSource,
} from './dispatch/dispatch-ports.js';
export type { InspectionIntakePort as DispatchInspectionIntakePort } from './dispatch/dispatch-ports.js';
export type {
  DispatchOrder,
  CreateDispatchOrderInput,
  ListDispatchOrdersFilter,
  DispatchOrderStore,
  OutsourcingLine,
  AppendOutsourcingLineInput,
  BackfillOutsourcingPriceFields,
  OutsourcingLineStore,
  OutsourcingPriceSource as OutsourcingLinePriceSource,
  DispatchOperationRecord,
  DispatchOperationStore,
  DispatchDomainEventStore,
} from './dispatch/dispatch-stores.js';
export {
  InMemoryDispatchOrderStore,
  InMemoryOutsourcingLineStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchDomainEventStore,
} from './dispatch/in-memory-dispatch-stores.js';
export {
  DispatchOrdersController,
  DispatchTasksController,
  OutsourcingController,
} from './dispatch/dispatch.controllers.js';

// ---- inventory：库存环节模块（M2-W5：收发存/预占恒等式/盘点/发货执行） ----
export {
  InventoryModule,
  INVENTORY_WAREHOUSE_STORE,
  INVENTORY_ACCOUNT_STORE,
  INVENTORY_LOCATION_BALANCE_STORE,
  INVENTORY_MOVEMENT_STORE,
  INVENTORY_RESERVATION_STORE,
  INVENTORY_STOCKTAKE_STORE,
  INVENTORY_SHIPPING_STORE,
  INVENTORY_RELEASE_FACT_STORE,
  INVENTORY_OPERATION_STORE,
  INVENTORY_DOMAIN_EVENT_STORE,
  INVENTORY_MACHINE_EVENT_STORE,
  INVENTORY_SERVICE_OPTIONS,
} from './inventory/inventory.module.js';
export type { InventoryModuleOptions } from './inventory/inventory.module.js';
export { InventoryService } from './inventory/inventory.service.js';
export type {
  InventoryCommitted,
  InventoryCommandResult,
  InventoryServiceOptions,
  StockLevelView,
} from './inventory/inventory.service.js';
export {
  InventoryInputError,
  InventoryNotFoundError,
  InventoryConflictError,
  InventoryStateError,
} from './inventory/inventory-errors.js';
export {
  DEFAULT_NEGATIVE_STOCK_POLICY,
  DEFAULT_SHIPPING_FLOW_CONFIG,
  DEFAULT_STOCKTAKE_FLOW_CONFIG,
  ISSUE_PURPOSES,
  NEGATIVE_STOCK_POLICIES,
  RECEIPT_SOURCE_KINDS,
  RESERVATION_STATUSES,
  SHIPPING_FLOW_ID,
  SHIPPING_STATE_IDS,
  SHIPPING_STATES,
  STOCKTAKE_FLOW_ID,
  STOCKTAKE_STATE_IDS,
  STOCKTAKE_STATES,
  STOCK_MOVEMENT_KINDS,
  movementDirection,
  movementKindLabel,
  receiptKindLabel,
  shippingStateLabel,
  stocktakeStateLabel,
} from './inventory/inventory-config.js';
export type {
  IssuePurpose,
  NegativeStockPolicy,
  ReceiptSourceKind,
  ReservationStatus,
  ShippingStateId,
  StockMovementDirection,
  StockMovementKind,
  StocktakeStateId,
} from './inventory/inventory-config.js';
export {
  WarehouseId,
  LocationId,
  StockAccountId,
  StockMovementId,
  StocktakeId,
  TransferId,
  ShippingOrderId,
  newWarehouseId,
  newLocationId,
  newStockAccountId,
  newStockMovementId,
  newStocktakeId,
  newTransferId,
  newShippingOrderId,
  newLocationBalanceId,
  newDomainEventId as newInventoryDomainEventId,
} from './inventory/inventory-ids.js';
export {
  INVENTORY_EVENT_TYPES,
  SHIPPING_ORDER_AGGREGATE_TYPE,
  STOCK_MOVEMENT_AGGREGATE_TYPE,
  STOCKTAKE_AGGREGATE_TYPE,
  makeShippingConfirmedEvent,
  makeStockIssuedEvent,
  makeStockReceivedEvent,
  makeStockTransferredEvent,
  makeStocktakeAdjustedEvent,
  provenanceOf as inventoryProvenanceOf,
} from './inventory/inventory-events.js';
export type {
  InventoryEventProvenance,
  InventoryMachineMilestone,
  ShippingConfirmedPayload,
  StockIssuedPayload,
  StockReceivedPayload,
  StocktakeAdjustedPayload,
  StockTransferredPayload,
} from './inventory/inventory-events.js';
export {
  INVENTORY_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseInventoryCommandEnvelopeBody,
  parseCommandBodyForKind as parseInventoryCommandBodyForKind,
  parseWarehouseDefinePayload,
  parseStockReceivePayload,
  parseStockIssuePayload,
  parseStockTransferPayload,
  parseStocktakeOpenPayload,
  parseStocktakeRecordPayload,
  parseStocktakeApprovePayload,
  parseShippingExecutePayload,
  parseShippingConfirmPayload,
  parseIdParam as parseInventoryIdParam,
  parseStateFilter as parseInventoryStateFilter,
} from './inventory/inventory-input.js';
export type {
  InventoryCommandKind,
  InventoryCommand,
  InventoryEnvelopeBody,
  WarehouseDefinePayload,
  StockReceivePayload,
  StockIssuePayload,
  StockTransferPayload,
  StocktakeOpenPayload,
  StocktakeRecordPayload,
  StocktakeRecordLinePayload,
  StocktakeApprovePayload,
  ShippingExecutePayload,
  ShippingExecuteLinePayload,
  ShippingConfirmPayload,
} from './inventory/inventory-input.js';
export {
  createInventoryAvailabilityAdapter,
  createInventoryReceiptAdapter,
  createPartsIssueAdapter,
  createStockReleaseRecorder,
  INVENTORY_TODO_SOURCE,
  SHIPPING_TODO_REF_TYPE,
} from './inventory/inventory-ports.js';
export type {
  InventoryAvailabilitySource,
  InventoryPartsIssueSurface,
  InventoryPurchaseReceiptSurface,
  InspectionReleaseSink,
  StockReleaseCommand,
  StockReserveCommand,
  StockReserveReceipt,
  StockReservationPort,
} from './inventory/inventory-ports.js';
export type {
  Warehouse,
  WarehouseLocation,
  DefineWarehouseInput,
  WarehouseStore,
  StockAdjustLine,
  StockAccount,
  ListStockAccountsFilter,
  StockAdjustGuard,
  StockAccountStore,
  StockLocationBalance,
  ListLocationBalancesFilter,
  StockLocationBalanceStore,
  StockMovement,
  AppendStockMovementInput,
  StockMovementAppendReceipt,
  ListStockMovementsFilter,
  StockMovementStore,
  StockReservation,
  CreateStockReservationInput,
  StockReservationCreateReceipt,
  StockReservationStore,
  StocktakeLine,
  Stocktake,
  CreateStocktakeInput,
  StocktakeStore,
  TransferLeg,
  ShippingLine,
  ShippingOrder,
  CreateShippingOrderInput,
  ShippingOrderStore,
  ReleaseFact,
  AppendReleaseFactInput,
  ReleaseFactStore,
  InventoryOperationRecord,
  InventoryOperationStore,
  InventoryDomainEventStore,
} from './inventory/inventory-stores.js';
export {
  RELEASE_FACT_AUDIT_STATUS,
  STOCK_MOVEMENT_AUDIT_STATUS,
} from './inventory/inventory-stores.js';
export {
  InMemoryWarehouseStore,
  InMemoryStockAccountStore,
  InMemoryStockLocationBalanceStore,
  InMemoryStockMovementStore,
  InMemoryStockReservationStore,
  InMemoryStocktakeStore,
  InMemoryShippingOrderStore,
  InMemoryReleaseFactStore,
  InMemoryInventoryOperationStore,
  InMemoryInventoryDomainEventStore,
} from './inventory/in-memory-inventory-stores.js';
export {
  WarehousesController,
  StockMovementCommandsController,
  StocktakingController,
  ShippingOrdersController,
  InventoryQueriesController,
} from './inventory/inventory.controllers.js';

// ---- reporting：五类报工与核查模块（M2-W7：零件/装配/电气/售后/零工 + 核查链） ----
export {
  ReportingModule,
  WORK_REPORT_STORE,
  REPORT_AUDIT_STORE,
  REPORT_OPERATION_STORE,
  REPORT_DOMAIN_EVENT_STORE,
  REPORT_MACHINE_EVENT_STORE,
  REPORT_VALID_DISPATCH_SOURCE,
  REPORT_OPERATION_VALIDITY,
  REPORT_FINAL_OPERATION,
  REPORT_INSPECTION_INTAKE,
  REPORTING_SERVICE_OPTIONS,
} from './reporting/reporting.module.js';
export type { ReportingModuleOptions } from './reporting/reporting.module.js';
export { ReportingService } from './reporting/reporting.service.js';
export type {
  ReportCommitted,
  ReportCommandResult,
  ReportingServiceOptions,
  ReportingCrossModulePorts,
  ReportDetail,
  DrawingOperationProgressRow,
  OutputTrendFact,
  OutputTrendDailyPoint,
} from './reporting/reporting.service.js';
export {
  ReportInputError,
  ReportNotFoundError,
  ReportConflictError,
  ReportStateError,
} from './reporting/reporting-errors.js';
export {
  DEFAULT_REPORT_FLOW_CONFIG,
  DEFAULT_REPORTABLE_DISPATCH_STATES,
  DEFAULT_REPORT_BATCH_LIMIT,
  DEFAULT_FINAL_INSPECTION_KINDS,
  REPORT_FLOW_ID,
  REPORT_KINDS,
  REPORT_STATE_IDS,
  REPORT_STATES,
  REPORT_OUTPUT_STATES,
  reportKindLabel,
  reportStateLabel,
} from './reporting/reporting-config.js';
export type { ReportKind, ReportStateId } from './reporting/reporting-config.js';
export {
  WorkReportId,
  ReportAuditId,
  newWorkReportId,
  newReportAuditId,
  newDomainEventId as newReportingDomainEventId,
} from './reporting/reporting-ids.js';
export {
  WORK_REPORT_AGGREGATE_TYPE,
  REPORT_BATCH_AGGREGATE_TYPE,
  REPORT_EVENT_TYPES,
  makeReportSubmittedEvent,
  makeBatchSubmittedEvent,
  makeReportCorrectedEvent,
  makeReportVerifiedEvent,
  makeReportRevokedEvent,
  provenanceOf as reportingProvenanceOf,
} from './reporting/reporting-events.js';
export type {
  ReportEventProvenance,
  ReportSubmittedPayload,
  BatchSubmittedPayload,
  ReportCorrectedPayload,
  ReportVerifiedPayload,
  ReportRevokedPayload,
  ReportCraftSnapshot,
  ReportFieldChange,
  InspectionIntakeReceiptPayload as ReportInspectionIntakeReceiptPayload,
  ReportMachineMilestone,
} from './reporting/reporting-events.js';
export {
  REPORT_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseReportCommandEnvelopeBody,
  parseCommandBodyForKind as parseReportCommandBodyForKind,
  parseReportSubmitPayload,
  parseReportSubmitBatchPayload,
  parseReportAuditEditPayload,
  parseReportVerifyPayload,
  parseReportRevokePayload,
  parseIdParam as parseReportIdParam,
  parseStateFilter as parseReportStateFilter,
  parseKindFilter as parseReportKindFilter,
  parseDispatchFilter,
  parseReporterFilter,
  parseDrawingFilter,
  parseTrendDaysFilter,
  requireLaborMinutes,
} from './reporting/reporting-input.js';
export type {
  ReportCommandKind,
  ReportCommand,
  ReportEnvelopeBody,
  ReportSubmitPayload,
  BatchReportLinePayload,
  ReportSubmitBatchPayload,
  ReportAuditEditPayload,
  ReportVerifyPayload,
  ReportRevokePayload,
} from './reporting/reporting-input.js';
export {
  EMPTY_VALID_DISPATCH_SOURCE,
  ALL_OPERATIONS_VALID,
  NEVER_FINAL_OPERATION,
  REPORTING_NOOP_INSPECTION_INTAKE,
  toDispatchFactForReport,
} from './reporting/reporting-ports.js';
export type {
  DispatchFactForReport,
  ValidDispatchSource,
  DispatchOrderLike,
  OperationValidityPort,
  FinalOperationJudgePort,
} from './reporting/reporting-ports.js';
export type { InspectionIntakePort as ReportingInspectionIntakePort } from './reporting/reporting-ports.js';
export type {
  WorkReport,
  CreateWorkReportInput,
  ListWorkReportsFilter,
  WorkReportStore,
  ReportAuditRow,
  ReportAuditAction,
  ReportAuditStore,
  ReportOperationRecord,
  ReportOperationStore,
  ReportDomainEventStore,
} from './reporting/reporting-stores.js';
export {
  InMemoryWorkReportStore,
  InMemoryReportAuditStore,
  InMemoryReportOperationStore,
  InMemoryReportDomainEventStore,
} from './reporting/in-memory-reporting-stores.js';
export {
  ReportsController,
  ReportingQueriesController,
} from './reporting/reporting.controllers.js';

// ============================================================================
// hours 工时账（M2-W6，08-hours.md v1.0）
// ============================================================================

export { LaborEntryId, LaborLedgerMonthId } from './hours/hours-ids.js';
export type { LaborEntryId as LaborEntryIdType, LaborLedgerMonthId as LaborLedgerMonthIdType } from './hours/hours-ids.js';
export {
  HOURS_TRADES,
  HOURS_TRADE_LABELS,
  REPORT_KINDS as HOURS_REPORT_KINDS,
  REPORT_KIND_TO_TRADE,
  HOURS_AUDIT_STATUS_VERIFIED,
  HOURS_MONTH_AUDIT_STATUS_REBUILT,
  MAX_HOURS_PER_ENTRY,
  MAX_REPORT_MINUTES,
  isReportKind,
  minutesToHours,
  isMonth,
  monthOfDate,
} from './hours/hours-config.js';
export type { HoursTrade, ReportKind as HoursReportKind } from './hours/hours-config.js';
export { HoursInputError, HoursNotFoundError, HoursConflictError } from './hours/hours-errors.js';
export {
  HOURS_EVENT_TYPES,
  HOURS_AGGREGATE_TYPES,
  makeLaborEntryEvent,
  makeLaborMonthRebuiltEvent,
} from './hours/hours-events.js';
export type {
  HoursEventProvenance,
  LaborEntryEventPayload,
  LaborMonthRebuiltPayload,
} from './hours/hours-events.js';
export {
  EMPTY_REPORT_EVENT_FEED,
  EMPTY_STANDARD_TIME,
} from './hours/hours-ports.js';
export type {
  ReportEventPayloadShape,
  ReportEventMessage,
  ReportEventFeedPort,
  StandardTimeRef,
  StandardTimePort,
} from './hours/hours-ports.js';
export type {
  LaborEntryRow,
  LaborEntryDirection,
  AppendLaborEntryInput,
  ListLaborEntriesFilter,
  LaborEntryStore,
  LaborLedgerMonthRow,
  AppendLaborLedgerMonthInput,
  LaborLedgerMonthStore,
  HoursDomainEventStore,
  HoursOperationStore,
  HoursStores,
} from './hours/hours-stores.js';
export {
  HOURS_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseHoursCommandEnvelopeBody,
  parseCommandBodyForKind as parseHoursCommandBodyForKind,
  parseHoursIngestPayload,
  parseHoursRebuildMonthPayload,
  parseHoursAdjustEntryPayload,
  parseMonthParam,
  parseIdParam as parseHoursIdParam,
  parseOptionalIdParam as parseHoursOptionalIdParam,
  parseDateRange,
  requireHours,
  requireTrade,
  requireReportKind,
  requireWorkDate,
} from './hours/hours-input.js';
export type {
  HoursCommandKind,
  HoursCommand,
  HoursCommandEnvelope,
  HoursEnvelopeBody,
  HoursIngestPayload,
  HoursRebuildMonthPayload,
  HoursAdjustAction,
  HoursAdjustEntryPayload,
} from './hours/hours-input.js';
export {
  InMemoryLaborEntryStore,
  InMemoryLaborLedgerMonthStore,
  InMemoryHoursDomainEventStore,
  InMemoryHoursOperationStore,
  createInMemoryHoursStores,
} from './hours/in-memory-hours-stores.js';
export {
  HoursService,
  netAggregate as netHoursAggregate,
} from './hours/hours.service.js';
export type {
  HoursCommitted,
  HoursCommandResult,
  HoursServiceOptions,
  HoursCrossModulePorts,
  MachiningStatRow,
  MonthSummaryRow,
  MyHoursView,
  LaborLedgerMonthView,
  WorkOrderTradeLine,
  WorkOrderProcessLine,
  WorkOrderHoursView,
  MonthRebuildGroupResult,
} from './hours/hours.service.js';
export { HoursLedgerController } from './hours/hours.controllers.js';
export { HoursModule } from './hours/hours.module.js';
export type { HoursModuleOptions } from './hours/hours.module.js';

// ============================================================================
// costing 项目成本账（M2-W6，09-costing.md v1.0）
// ============================================================================

export { CostEntryId, CostingModelId, CostSnapshotId } from './costing/costing-ids.js';
export type {
  CostEntryId as CostEntryIdType,
  CostingModelId as CostingModelIdType,
  CostSnapshotId as CostSnapshotIdType,
} from './costing/costing-ids.js';
export {
  COST_CATEGORIES,
  COST_CATEGORY_LABELS,
  COST_SOURCE_TYPES,
  DEFAULT_COSTING_MODEL_CODE,
  DEFAULT_COSTING_MODEL_DEFINITION,
  parseHourlyRates,
  parseCostingModelDefinition,
  laborAmountMinor,
} from './costing/costing-model.js';
export type {
  CostCategory,
  CostSourceType,
  HourlyRateTable,
  AllocationRule,
  CostingModelDefinition,
  CostTotals,
} from './costing/costing-model.js';
export { CostingInputError, CostingNotFoundError, CostingConflictError } from './costing/costing-errors.js';
export {
  COSTING_EVENT_TYPES,
  COSTING_AGGREGATE_TYPES,
  makeCostEntryCommittedEvent,
  makeCostingModelPublishedEvent,
  makeCostSnapshotRebuiltEvent,
} from './costing/costing-events.js';
export type {
  CostingEventProvenance,
  CostEntryCommittedPayload,
  CostingModelPublishedPayload,
  CostSnapshotRebuiltPayload,
} from './costing/costing-events.js';
export {
  EMPTY_MATERIAL_COST_SOURCE,
  EMPTY_LABOR_COST_SOURCE,
  EMPTY_OUTSOURCING_COST_SOURCE,
  ALWAYS_WORK_ORDER_SUBJECT,
  createHoursCostSource,
  emptyCostingSourcePorts,
  outsourcingSourceRef,
} from './costing/costing-ports.js';
export type {
  MaterialCostLine,
  MaterialCostSourcePort,
  LaborCostLine,
  LaborCostSourcePort,
  HoursCostSourceSurface,
  OutsourcingCostLine,
  OutsourcingCostSourcePort,
  WorkOrderSubjectPort,
  CostingSourcePorts,
} from './costing/costing-ports.js';
export type {
  CostEntryRow,
  AppendCostEntryInput,
  ListCostEntriesFilter,
  CostEntryStore,
  CostingModelRow,
  CreateCostingModelInput,
  CostingModelStore,
  CostingModelStatus,
  CostSnapshotRow,
  AppendCostSnapshotInput,
  CostSnapshotStore,
  CostingDomainEventStore,
  CostingOperationStore,
  CostingStores,
} from './costing/costing-stores.js';
export {
  COSTING_COMMAND_KINDS,
  parseCommandEnvelopeBody as parseCostingCommandEnvelopeBody,
  parseCommandBodyForKind as parseCostingCommandBodyForKind,
  parseCostingModelPublishPayload,
  parseWorkOrderSelectorPayload,
  parseIdParam as parseCostingIdParam,
  parseOptionalIdParam as parseCostingOptionalIdParam,
  parseOptionalIntParam,
  parseCategoryFilter,
} from './costing/costing-input.js';
export type {
  CostingCommandKind,
  CostingCommand,
  CostingCommandEnvelope,
  CostingEnvelopeBody,
  CostingModelPublishPayload,
  CostingWorkOrderSelectorPayload,
} from './costing/costing-input.js';
export { JsonTablesCostingExcelPort } from './costing/costing-excel-port.js';
export type { CostingExcelPort } from './costing/costing-excel-port.js';
export {
  InMemoryCostEntryStore,
  InMemoryCostingModelStore,
  InMemoryCostSnapshotStore,
  InMemoryCostingDomainEventStore,
  InMemoryCostingOperationStore,
  createInMemoryCostingStores,
} from './costing/in-memory-costing-stores.js';
export {
  CostingService,
  aggregateThroughModel,
  sameTotals,
} from './costing/costing.service.js';
export type {
  CostingCommitted,
  CostingCommandResult,
  CostingServiceOptions,
  CostingModelView,
  CostSnapshotView,
  ModelComparison,
} from './costing/costing.service.js';
export {
  CostingModelsController,
  CostingLedgerController,
} from './costing/costing.controllers.js';
export { CostingModule } from './costing/costing.module.js';
export type { CostingModuleOptions } from './costing/costing.module.js';
