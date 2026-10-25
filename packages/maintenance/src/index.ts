/**
 * @smes/maintenance —— 维保专业包（M3 实施，m3-drafts/02-maintenance.md v1.0 冻结合同）。
 *
 * 激活开关语义（合同 §1）：开关关闭时 18/19 入口与 125/126 移动 API、权限码
 * （maintenance:read / plan-write / task-arrange / record）、计划到期扫描全不
 * 出现；故障上报（baseline）不受影响——**注册面（app-registry / 组合根接线 /
 * 权限策略登记）归总控**，本包只保证不被接线即不可见（零副作用构造 + 内存回落）。
 *
 * 包身份：计划性维保的**执行域**——把设备台账上的设备按版本化计划生成维保任务
 * （维修/保养/点检），执行留痕为三态 append-only 记录；到期扫描生成任务、
 * 点检 fail 联动待办、维修任务可挂故障引用。
 *
 * 依赖铁律（pro-pack-tier-edges）：仅依赖 @smes/business-core 与
 * @smes/engine-flow（任务状态机配置）；不 import @smes/application 与任何 M2
 * 模块；baseline 消费只经形状引用（ResourceRef / FaultRef / Fault*Fact 结构
 * 同形镜像，ports.ts）与 Outbox 事件（组合根粘合，R-M3 差异表 #4）；
 * business-store 的 PG 适配不 import 本包（结构同形镜像，见 maintenance-errors
 * 的跨包防线注）。
 */
export type {
  ResourceRef,
  FaultRef,
  FaultReportedFact,
  FaultResolvedFact,
  FaultTaskSuggestion,
} from './ports.js';

export {
  MAINTENANCE_TASK_FLOW_ID,
  MAINTENANCE_TASK_STATE_IDS,
  MAINTENANCE_TASK_STATES,
  MAINTENANCE_TASK_SOURCES,
  MAINTENANCE_TASK_SOURCE_LABELS,
  MAINTENANCE_TASK_KINDS,
  MAINTENANCE_TASK_KIND_LABELS,
  MAINTENANCE_PERMISSIONS,
  TASK_TRANSITION_EVENTS,
  DEFAULT_MAINTENANCE_TASK_FLOW_CONFIG,
  MAX_INTERVAL_DAYS,
  MAX_CHECKPOINTS,
  MAX_UPKEEP_ACTIONS,
  MAX_DUE_OCCURRENCES_PER_SCAN,
  MAINTENANCE_PLAN_AUDIT_STATUS_PUBLISHED,
  MAINTENANCE_ACTIVITY_AUDIT_STATUS_RECORDED,
  maintenanceTaskStateLabel,
  resolveTaskTransition,
  isTaskSource,
  isTaskKind,
  planDueTaskKind,
  dueOccurrences,
  isValidCycle,
  isIsoDateTime,
  cycleLabel,
  requireBoundedInt,
  type MaintenanceTaskState,
  type MaintenanceTaskSource,
  type MaintenanceTaskKind,
  type MaintenanceActivityKind,
  type MaintenanceCycle,
  type MaintenancePermission,
} from './maintenance-config.js';

export {
  MaintenancePlanId,
  MaintenanceTaskId,
  CheckpointRecordId,
  UpkeepRecordId,
  RepairRecordId,
  newMaintenanceTaskId,
  newCheckpointRecordId,
  newUpkeepRecordId,
  newRepairRecordId,
  newMaintenancePlanRowId,
  uuidv7,
} from './maintenance-ids.js';

export {
  MaintenanceInputError,
  MaintenanceNotFoundError,
  MaintenanceConflictError,
  isMaintenanceConflict,
} from './maintenance-errors.js';

export {
  MAINTENANCE_EVENT_TYPES,
  MAINTENANCE_AGGREGATE_TYPES,
  makeMaintenancePlanPublishedEvent,
  makeMaintenanceTaskCreatedEvent,
  makeMaintenanceTaskTransitionedEvent,
  makeMaintenanceActivityAppendedEvent,
  makeCheckpointFailedEvent,
  type MaintenanceEventProvenance,
  type MaintenancePlanPublishedPayload,
  type MaintenanceTaskCreatedPayload,
  type MaintenanceTaskTransitionedPayload,
  type MaintenanceActivityAppendedPayload,
  type CheckpointFailedPayload,
} from './maintenance-events.js';

export type {
  CheckpointDef,
  MaintenancePlanRow,
  CreateMaintenancePlanInput,
  MaintenancePlanStore,
  MaintenanceTaskAdvance,
  ListMaintenanceTasksFilter,
  MaintenanceTaskRow,
  CreateMaintenanceTaskInput,
  MaintenanceTaskStore,
  CheckpointActivityRow,
  UpkeepActivityRow,
  RepairActivityRow,
  MaintenanceActivityRow,
  AppendMaintenanceActivityInput,
  MaintenanceActivityQuery,
  MaintenanceActivityStore,
  MaintenanceDomainEventStore,
  MaintenanceOperationStore,
  MaintenanceStores,
} from './maintenance-stores.js';

export {
  MAINTENANCE_COMMAND_KINDS,
  parseCommandEnvelopeBody,
  parseCommandBodyForKind,
  parsePlanPublishPayload,
  parseDueScanPayload,
  parseTaskCreatePayload,
  parseTaskRefPayload,
  parseTaskCancelPayload,
  parseRecordAppendPayload,
  parseCycle,
  parseIdParam,
  parseOptionalIsoParam,
  requirePlanId,
  requireTaskId,
  requireIsoDateTime,
  type MaintenanceCommandKind,
  type MaintenanceCommand,
  type MaintenanceCommandEnvelope,
  type MaintenanceEnvelopeBody,
  type MaintenancePlanPublishPayload,
  type MaintenanceDueScanPayload,
  type MaintenanceTaskCreatePayload,
  type MaintenanceTaskRefPayload,
  type MaintenanceTaskCancelPayload,
  type MaintenanceRecordAppendPayload,
} from './maintenance-input.js';

export {
  MaintenanceService,
  currentPlanVersions,
  planAnchors,
  type MaintenanceServiceOptions,
  type MaintenanceCommandResult,
  type MaintenanceCommitted,
  type MaintenancePlanView,
  type MaintenanceDueScanResult,
} from './maintenance.service.js';

export {
  InMemoryMaintenancePlanStore,
  InMemoryMaintenanceTaskStore,
  InMemoryMaintenanceActivityStore,
  InMemoryMaintenanceDomainEventStore,
  InMemoryMaintenanceOperationStore,
  inMemoryMaintenanceStores,
} from './in-memory-maintenance-stores.js';
