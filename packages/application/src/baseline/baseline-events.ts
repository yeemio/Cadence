/**
 * baseline 事件构造（M2-W2 P1 + M2-W7 P2/P3 件；合同 01-baseline.md §6：
 * append-only + Outbox + 证据列。事件词汇冻结：ProcessDefined / RoutingRevised /
 * StandardTimeDefined / EquipmentRegistered / FaultReported（→待办+IM）/
 * FaultResolved / OutsourcingRuleSet；MaterialValidated 为 P1 执行事实附加词汇）。
 *
 * eventType 命名守 business-core BusinessEvent 合同：smes.<环节>.v<n>.<过去式动作>。
 * 修订与首次定义共用同族事件类型（合同事件词汇无 Defined/Revised 双形——
 * payload.action 携带 'define' | 'revise' 判别，不改事件词汇面：Process 族共用
 * process-defined；Routing 族按合同词汇共用 routing-revised）。
 */
import { randomUUID } from 'node:crypto';
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type {
  EquipmentRow,
  FaultReport,
  MaterialValidationRunRow,
  OutsourcingPriceRuleRow,
  ProcessDefRow,
  RoutingRow,
  StandardTimeRow,
} from './baseline-stores.js';

/** 事件类型（合同 §6 词汇 + P1 执行事实附加）。 */
export const BASELINE_EVENT_TYPES = {
  processDefined: 'smes.baseline.v1.process-defined',
  materialValidated: 'smes.baseline.v1.material-validated',
  outsourcingRuleSet: 'smes.baseline.v1.outsourcing-rule-set',
  equipmentRegistered: 'smes.baseline.v1.equipment-registered',
  routingRevised: 'smes.baseline.v1.routing-revised',
  standardTimeDefined: 'smes.baseline.v1.standard-time-defined',
  faultReported: 'smes.baseline.v1.fault-reported',
  faultResolved: 'smes.baseline.v1.fault-resolved',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径；版本化主数据聚合 = 业务码，跨版本稳定）。 */
export const BASELINE_AGGREGATE_TYPES = {
  process: 'baseline-process',
  equipment: 'baseline-equipment',
  outsourcingRule: 'baseline-outsourcing-rule',
  materialValidation: 'baseline-material-validation',
  routing: 'baseline-routing',
  standardTime: 'baseline-standard-time',
  faultReport: 'baseline-fault-report',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 baseline 约定形状；带索引签名以入 JSONB 列）。 */
export type BaselineProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

export type MasterCommandAction = 'define' | 'revise';

export interface MasterEventPayload {
  readonly action: MasterCommandAction;
  readonly code: string;
  readonly objectVersion: number;
  readonly status: string;
  readonly supersedes: string | null;
  readonly rowId: string;
}

export interface MaterialValidatedEventPayload {
  readonly runId: string;
  readonly summary: MaterialValidationRunRow['summary'];
  readonly lines: MaterialValidationRunRow['lines'];
}

/** 故障单上报事件载荷（FaultReported → 待办+IM；state=进入的 assigned 态）。 */
export interface FaultReportedEventPayload {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly description: string;
  readonly reportedBy: string;
  readonly assignee: string;
  readonly state: string;
  readonly objectVersion: number;
  /** 随迁移创建的维修待办 id（待办联动留痕；无待办线时 null）。 */
  readonly todoId: string | null;
}

/** 故障单闭环事件载荷（FaultResolved；state=进入的 resolved 态）。 */
export interface FaultResolvedEventPayload {
  readonly faultReportId: string;
  readonly equipmentCode: string;
  readonly assignee: string | null;
  readonly remark: string | null;
  readonly state: string;
  readonly objectVersion: number;
}

function nextEventId(): EventId {
  return EventId.create(`evt-${randomUUID()}`);
}

/** 工序事件（define/revise 同族；聚合 = 工序业务码，revision = 新版本号）。 */
export function makeProcessDefinedEvent(
  tenant: TenantId,
  row: ProcessDefRow,
  action: MasterCommandAction,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MasterEventPayload> {
  return makeBusinessEvent<MasterEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.processDefined,
    tenantId: tenant,
    aggregate: { id: row.code, type: BASELINE_AGGREGATE_TYPES.process, revision: row.objectVersion },
    occurredAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    provenance,
    payload: {
      action,
      code: row.code,
      objectVersion: row.objectVersion,
      status: row.status,
      supersedes: row.supersedes,
      rowId: row.id,
    },
  });
}

/** 设备台账事件。 */
export function makeEquipmentRegisteredEvent(
  tenant: TenantId,
  row: EquipmentRow,
  action: MasterCommandAction,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MasterEventPayload> {
  return makeBusinessEvent<MasterEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.equipmentRegistered,
    tenantId: tenant,
    aggregate: { id: row.code, type: BASELINE_AGGREGATE_TYPES.equipment, revision: row.objectVersion },
    occurredAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    provenance,
    payload: {
      action,
      code: row.code,
      objectVersion: row.objectVersion,
      status: row.status,
      supersedes: row.supersedes,
      rowId: row.id,
    },
  });
}

/** 外协计价规则事件。 */
export function makeOutsourcingRuleSetEvent(
  tenant: TenantId,
  row: OutsourcingPriceRuleRow,
  action: MasterCommandAction,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MasterEventPayload> {
  return makeBusinessEvent<MasterEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.outsourcingRuleSet,
    tenantId: tenant,
    aggregate: { id: row.code, type: BASELINE_AGGREGATE_TYPES.outsourcingRule, revision: row.objectVersion },
    occurredAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    provenance,
    payload: {
      action,
      code: row.code,
      objectVersion: row.objectVersion,
      status: row.status,
      supersedes: row.supersedes,
      rowId: row.id,
    },
  });
}

/** 物料校验事件（聚合 = 运行 id，revision 恒 1：执行事实无修正链）。 */
export function makeMaterialValidatedEvent(
  tenant: TenantId,
  run: MaterialValidationRunRow,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MaterialValidatedEventPayload> {
  return makeBusinessEvent<MaterialValidatedEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.materialValidated,
    tenantId: tenant,
    aggregate: { id: run.id, type: BASELINE_AGGREGATE_TYPES.materialValidation, revision: run.objectVersion },
    occurredAt,
    ...(run.businessTime === undefined ? {} : { businessTime: run.businessTime }),
    provenance,
    payload: { runId: run.id, summary: run.summary, lines: run.lines },
  });
}

/** 工艺路线事件（define/revise 同族共用 routing-revised；聚合 = 图号）。 */
export function makeRoutingRevisedEvent(
  tenant: TenantId,
  row: RoutingRow,
  action: MasterCommandAction,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MasterEventPayload> {
  return makeBusinessEvent<MasterEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.routingRevised,
    tenantId: tenant,
    aggregate: { id: row.code, type: BASELINE_AGGREGATE_TYPES.routing, revision: row.objectVersion },
    occurredAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    provenance,
    payload: {
      action,
      code: row.code,
      objectVersion: row.objectVersion,
      status: row.status,
      supersedes: row.supersedes,
      rowId: row.id,
    },
  });
}

/** 额定工时事件（聚合 = 额定工时业务码）。 */
export function makeStandardTimeDefinedEvent(
  tenant: TenantId,
  row: StandardTimeRow,
  action: MasterCommandAction,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<MasterEventPayload> {
  return makeBusinessEvent<MasterEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.standardTimeDefined,
    tenantId: tenant,
    aggregate: { id: row.code, type: BASELINE_AGGREGATE_TYPES.standardTime, revision: row.objectVersion },
    occurredAt,
    ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
    provenance,
    payload: {
      action,
      code: row.code,
      objectVersion: row.objectVersion,
      status: row.status,
      supersedes: row.supersedes,
      rowId: row.id,
    },
  });
}

/** 故障单上报事件（聚合 = 故障单 id，revision = 迁移后版本）。 */
export function makeFaultReportedEvent(
  tenant: TenantId,
  report: FaultReport,
  todoId: string | null,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<FaultReportedEventPayload> {
  return makeBusinessEvent<FaultReportedEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.faultReported,
    tenantId: tenant,
    aggregate: { id: report.id, type: BASELINE_AGGREGATE_TYPES.faultReport, revision: report.objectVersion },
    occurredAt,
    provenance,
    payload: {
      faultReportId: report.id,
      equipmentCode: report.equipmentCode,
      description: report.description,
      reportedBy: report.reportedBy,
      assignee: report.assignee ?? '',
      state: report.state,
      objectVersion: report.objectVersion,
      todoId,
    },
  });
}

/** 故障单闭环事件（聚合 = 故障单 id，revision = 迁移后版本）。 */
export function makeFaultResolvedEvent(
  tenant: TenantId,
  report: FaultReport,
  provenance: BaselineProvenance,
  occurredAt: string,
): BusinessEvent<FaultResolvedEventPayload> {
  return makeBusinessEvent<FaultResolvedEventPayload>({
    eventId: nextEventId(),
    eventType: BASELINE_EVENT_TYPES.faultResolved,
    tenantId: tenant,
    aggregate: { id: report.id, type: BASELINE_AGGREGATE_TYPES.faultReport, revision: report.objectVersion },
    occurredAt,
    provenance,
    payload: {
      faultReportId: report.id,
      equipmentCode: report.equipmentCode,
      assignee: report.assignee,
      remark: report.resolutionRemark,
      state: report.state,
      objectVersion: report.objectVersion,
    },
  });
}
