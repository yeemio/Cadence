export { defineId } from './branding.js';
export type { Brand, IdBrand } from './branding.js';
export {
  TenantId,
  UserId,
  WorkOrderId,
  DispatchId,
  ReportId,
  InspectionId,
  OperationId,
  EventId,
} from './ids.js';
export type {
  TenantId as TenantIdType,
  UserId as UserIdType,
  WorkOrderId as WorkOrderIdType,
  DispatchId as DispatchIdType,
  ReportId as ReportIdType,
  InspectionId as InspectionIdType,
  OperationId as OperationIdType,
  EventId as EventIdType,
} from './ids.js';
export {
  COMMAND_ENVELOPE_CONTRACT,
  makeCommandEnvelope,
  isCommandEnvelope,
} from './envelope/command-envelope.js';
export type {
  CommandEnvelope,
  CommandEnvelopeInput,
  ExpectedRevision,
} from './envelope/command-envelope.js';
export type {
  CommandOutcome,
  CommittedOutcome,
  RejectedOutcome,
  IndeterminateOutcome,
} from './envelope/command-outcome.js';
export {
  makeBusinessEvent,
  isBusinessEvent,
} from './events/business-event.js';
export type {
  BusinessEvent,
  BusinessEventInput,
  EventAggregateRef,
} from './events/business-event.js';
export type { OutboxRecord } from './events/outbox.js';
export type { EvidenceColumns } from './evidence/evidence-columns.js';
// 租户解析 SaaS 形状出口（ADR-0005 M4 正式线接线：组合根 main.ts 消费
// hostBasedTenantResolver；预研时按 tenant/index.ts 头注取舍留到本波补此行）。
export {
  hostBasedTenantResolver,
  singleTenantResolver,
  TenantResolutionError,
} from './tenant/index.js';
export type { HostBasedTenantResolverOptions, TenantResolutionReason } from './tenant/index.js';
