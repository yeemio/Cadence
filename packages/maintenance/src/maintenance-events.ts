/**
 * maintenance 域事件构造（M3，m3-drafts/02-maintenance.md §6：append-only + Outbox +
 * 证据列）。事件词汇七个（合同冻结）：MaintenancePlanPublished /
 * MaintenanceTaskCreated/Started/Completed/Cancelled（→执行人待办）/
 * MaintenanceActivityAppended（kind 判别三态）/ CheckpointFailed（点检不合格→
 * 待办推送维修跟进，功能项 19 留存结果+联动）。eventType 守 business-core
 * BusinessEvent 命名：smes.<环节>.v<n>.<过去式动作>。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { MaintenanceActivityRow, MaintenancePlanRow, MaintenanceTaskRow } from './maintenance-stores.js';
import { newDomainEventId } from './maintenance-ids.js';

/** 事件类型（合同 §6 词汇）。 */
export const MAINTENANCE_EVENT_TYPES = {
  planPublished: 'smes.maintenance.v1.plan-published',
  taskCreated: 'smes.maintenance.v1.task-created',
  taskStarted: 'smes.maintenance.v1.task-started',
  taskCompleted: 'smes.maintenance.v1.task-completed',
  taskCancelled: 'smes.maintenance.v1.task-cancelled',
  activityAppended: 'smes.maintenance.v1.activity-appended',
  checkpointFailed: 'smes.maintenance.v1.checkpoint-failed',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const MAINTENANCE_AGGREGATE_TYPES = {
  plan: 'maintenance-plan',
  task: 'maintenance-task',
  activity: 'maintenance-activity',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 maintenance 约定形状）。 */
export type MaintenanceEventProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

/** 计划版本发布事件载荷（发布/修订共形；supersedes 携带链位）。 */
export interface MaintenancePlanPublishedPayload {
  readonly planId: string;
  readonly name: string | null;
  readonly resourceRef: string;
  /** 周期（daily / interval-days——判据与动作清单是数据，合同 §2）。 */
  readonly cycle: Readonly<Record<string, unknown>>;
  readonly checkpointIds: readonly string[];
  readonly upkeepActions: readonly string[];
  readonly objectVersion: number;
  readonly supersedes: string | null;
  readonly rowId: string;
}

/** 任务创建事件载荷（三来源共形：plan-due/fault/manual；→执行人待办）。 */
export interface MaintenanceTaskCreatedPayload {
  readonly taskId: string;
  readonly source: string;
  readonly kind: string;
  readonly resourceRef: string;
  readonly faultRef: string | null;
  readonly planId: string | null;
  readonly planVersion: number | null;
  readonly dueKey: string | null;
  readonly dueAt: string | null;
  readonly assignee: string | null;
  readonly state: string;
  readonly createdBy: string;
}

/** 任务迁移事件载荷（start/complete/cancel 共形；from→to 留痕）。 */
export interface MaintenanceTaskTransitionedPayload {
  readonly taskId: string;
  readonly source: string;
  readonly kind: string;
  readonly resourceRef: string;
  readonly from: string;
  readonly to: string;
  readonly objectVersion: number;
  readonly actor: string;
  readonly reason: string | null;
  readonly transitionedAt: string;
}

/** 三态记录追加事件载荷（kind 判别三态，合同 §6）。 */
export interface MaintenanceActivityAppendedPayload {
  readonly recordId: string;
  readonly kind: string;
  readonly resourceRef: string;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planVersion: number | null;
  readonly performedBy: string;
  readonly performedAt: string;
  /** checkpoint：'pass'|'fail'；upkeep：动作清单；repair：restored 布尔。 */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** 点检不合格事件载荷（→待办推送维修跟进；不合格转故障上报由人触发，不自动）。 */
export interface CheckpointFailedPayload {
  readonly recordId: string;
  readonly resourceRef: string;
  readonly checkpointId: string;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly expectation: string | null;
  readonly performedBy: string;
  readonly performedAt: string;
  readonly note: string | null;
}

function nextEventId(): EventId {
  return EventId.create(newDomainEventId());
}

export function makeMaintenancePlanPublishedEvent(
  tenant: TenantId,
  plan: MaintenancePlanRow,
  provenance: MaintenanceEventProvenance,
  occurredAt: string,
): BusinessEvent<MaintenancePlanPublishedPayload> {
  return makeBusinessEvent<MaintenancePlanPublishedPayload>({
    eventId: nextEventId(),
    eventType: MAINTENANCE_EVENT_TYPES.planPublished,
    tenantId: tenant,
    aggregate: {
      id: plan.planId,
      type: MAINTENANCE_AGGREGATE_TYPES.plan,
      revision: plan.objectVersion,
    },
    occurredAt,
    ...(plan.businessTime === undefined ? {} : { businessTime: plan.businessTime }),
    provenance,
    payload: {
      planId: plan.planId,
      name: plan.name,
      resourceRef: plan.resourceRef,
      cycle: plan.cycle as unknown as Readonly<Record<string, unknown>>,
      checkpointIds: plan.checkpoints.map((checkpoint) => checkpoint.checkpointId),
      upkeepActions: [...plan.upkeepActions],
      objectVersion: plan.objectVersion,
      supersedes: plan.supersedes,
      rowId: plan.id,
    },
  });
}

export function makeMaintenanceTaskCreatedEvent(
  tenant: TenantId,
  task: MaintenanceTaskRow,
  provenance: MaintenanceEventProvenance,
  occurredAt: string,
): BusinessEvent<MaintenanceTaskCreatedPayload> {
  return makeBusinessEvent<MaintenanceTaskCreatedPayload>({
    eventId: nextEventId(),
    eventType: MAINTENANCE_EVENT_TYPES.taskCreated,
    tenantId: tenant,
    aggregate: { id: task.id, type: MAINTENANCE_AGGREGATE_TYPES.task, revision: task.objectVersion },
    occurredAt,
    businessTime: task.createdAt,
    provenance,
    payload: {
      taskId: task.id,
      source: task.source,
      kind: task.kind,
      resourceRef: task.resourceRef,
      faultRef: task.faultRef ?? null,
      planId: task.planId ?? null,
      planVersion: task.planVersion ?? null,
      dueKey: task.dueKey ?? null,
      dueAt: task.dueAt ?? null,
      assignee: task.assignee ?? null,
      state: task.state,
      createdBy: task.createdBy,
    },
  });
}

/** 任务迁移事件（start/complete/cancel 共形构造；eventType 由调用方给定）。 */
export function makeMaintenanceTaskTransitionedEvent(
  tenant: TenantId,
  eventType: string,
  task: MaintenanceTaskRow,
  from: string,
  actor: string,
  reason: string | null,
  transitionedAt: string,
  provenance: MaintenanceEventProvenance,
): BusinessEvent<MaintenanceTaskTransitionedPayload> {
  return makeBusinessEvent<MaintenanceTaskTransitionedPayload>({
    eventId: nextEventId(),
    eventType,
    tenantId: tenant,
    aggregate: { id: task.id, type: MAINTENANCE_AGGREGATE_TYPES.task, revision: task.objectVersion },
    occurredAt: transitionedAt,
    provenance,
    payload: {
      taskId: task.id,
      source: task.source,
      kind: task.kind,
      resourceRef: task.resourceRef,
      from,
      to: task.state,
      objectVersion: task.objectVersion,
      actor,
      reason,
      transitionedAt,
    },
  });
}

export function makeMaintenanceActivityAppendedEvent(
  tenant: TenantId,
  activity: MaintenanceActivityRow,
  provenance: MaintenanceEventProvenance,
  occurredAt: string,
): BusinessEvent<MaintenanceActivityAppendedPayload> {
  const detail: Record<string, unknown> =
    activity.kind === 'checkpoint'
      ? { result: activity.result }
      : activity.kind === 'upkeep'
        ? { actionsDone: [...(activity.actionsDone ?? [])] }
        : { faultRef: activity.faultRef ?? null, restored: activity.restored };
  return makeBusinessEvent<MaintenanceActivityAppendedPayload>({
    eventId: nextEventId(),
    eventType: MAINTENANCE_EVENT_TYPES.activityAppended,
    tenantId: tenant,
    aggregate: { id: activity.id, type: MAINTENANCE_AGGREGATE_TYPES.activity, revision: activity.objectVersion },
    occurredAt,
    businessTime: activity.performedAt,
    provenance,
    payload: {
      recordId: activity.id,
      kind: activity.kind,
      resourceRef: activity.resourceRef,
      taskId: activity.taskId ?? null,
      planId: activity.planId ?? null,
      planVersion: activity.planVersion ?? null,
      performedBy: activity.performedBy,
      performedAt: activity.performedAt,
      detail,
    },
  });
}

export function makeCheckpointFailedEvent(
  tenant: TenantId,
  record: Extract<MaintenanceActivityRow, { kind: 'checkpoint' }>,
  expectation: string | null,
  provenance: MaintenanceEventProvenance,
  occurredAt: string,
): BusinessEvent<CheckpointFailedPayload> {
  return makeBusinessEvent<CheckpointFailedPayload>({
    eventId: nextEventId(),
    eventType: MAINTENANCE_EVENT_TYPES.checkpointFailed,
    tenantId: tenant,
    aggregate: { id: record.id, type: MAINTENANCE_AGGREGATE_TYPES.activity, revision: record.objectVersion },
    occurredAt,
    businessTime: record.performedAt,
    provenance,
    payload: {
      recordId: record.id,
      resourceRef: record.resourceRef,
      checkpointId: record.checkpointId,
      taskId: record.taskId ?? null,
      planId: record.planId ?? null,
      expectation,
      performedBy: record.performedBy,
      performedAt: record.performedAt,
      note: record.note ?? null,
    },
  });
}
