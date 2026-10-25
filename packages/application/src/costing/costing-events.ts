/**
 * costing 域事件构造（M2-W6，09-costing.md §6：append-only + Outbox + 证据列）。
 *
 * 事件词汇三个（合同冻结）：CostEntryCommitted / CostingModelPublished /
 * CostSnapshotRebuilt。eventType 守 business-core 命名：
 * smes.<环节>.v<n>.<过去式动作>。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { CostEntryRow, CostSnapshotRow, CostingModelRow } from './costing-stores.js';

/** 事件类型（合同 §6 词汇）。 */
export const COSTING_EVENT_TYPES = {
  costEntryCommitted: 'smes.costing.v1.cost-entry-committed',
  costingModelPublished: 'smes.costing.v1.costing-model-published',
  costSnapshotRebuilt: 'smes.costing.v1.cost-snapshot-rebuilt',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const COSTING_AGGREGATE_TYPES = {
  costEntry: 'costing-cost-entry',
  costingModel: 'costing-model',
  costSnapshot: 'costing-cost-snapshot',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 costing 约定形状）。 */
export type CostingEventProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

/** 成本条目事件载荷（首记与 delta 共形；deltaOf 携带判别）。 */
export interface CostEntryCommittedPayload {
  readonly entryId: string;
  readonly workOrderId: string;
  readonly category: string;
  readonly amountMinor: number | null;
  readonly quantity: number | null;
  readonly trade: string | null;
  readonly sourceType: string;
  readonly sourceRefId: string;
  readonly sourceKey: string;
  readonly deltaOf: string | null;
  readonly recordedBy: string;
}

/** 口径版本发布事件载荷。 */
export interface CostingModelPublishedPayload {
  readonly code: string;
  readonly name: string | null;
  readonly objectVersion: number;
  readonly status: string;
  readonly supersedes: string | null;
  readonly definition: unknown;
}

/** 快照重算事件载荷（changed=false = 幂等重算未追加新版本行）。 */
export interface CostSnapshotRebuiltPayload {
  readonly workOrderId: string;
  readonly modelCode: string;
  readonly modelVersion: number;
  readonly totals: CostSnapshotRow['totals'];
  readonly objectVersion: number;
  readonly changed: boolean;
  readonly rebuiltBy: string;
}

export function makeCostEntryCommittedEvent(
  tenant: TenantId,
  entry: CostEntryRow,
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostEntryCommittedPayload> {
  return makeBusinessEvent<CostEntryCommittedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: COSTING_EVENT_TYPES.costEntryCommitted,
    tenantId: tenant,
    aggregate: { id: entry.id, type: COSTING_AGGREGATE_TYPES.costEntry, revision: 1 }, // 执行事实无修正链
    occurredAt,
    ...(entry.workDate === null ? {} : { businessTime: entry.workDate }),
    provenance,
    payload: {
      entryId: entry.id,
      workOrderId: entry.workOrderId,
      category: entry.category,
      amountMinor: entry.amountMinor,
      quantity: entry.quantity,
      trade: entry.trade,
      sourceType: entry.sourceType,
      sourceRefId: entry.sourceRefId,
      sourceKey: entry.sourceKey,
      deltaOf: entry.deltaOf,
      recordedBy: entry.recordedBy,
    },
  });
}

export function makeCostingModelPublishedEvent(
  tenant: TenantId,
  model: CostingModelRow,
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostingModelPublishedPayload> {
  return makeBusinessEvent<CostingModelPublishedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: COSTING_EVENT_TYPES.costingModelPublished,
    tenantId: tenant,
    aggregate: { id: model.code, type: COSTING_AGGREGATE_TYPES.costingModel, revision: model.objectVersion },
    occurredAt,
    ...(model.businessTime === undefined ? {} : { businessTime: model.businessTime }),
    provenance,
    payload: {
      code: model.code,
      name: model.name,
      objectVersion: model.objectVersion,
      status: model.status,
      supersedes: model.supersedes,
      definition: model.definition,
    },
  });
}

export function makeCostSnapshotRebuiltEvent(
  tenant: TenantId,
  snapshot: CostSnapshotRow,
  changed: boolean,
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostSnapshotRebuiltPayload> {
  return makeBusinessEvent<CostSnapshotRebuiltPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: COSTING_EVENT_TYPES.costSnapshotRebuilt,
    tenantId: tenant,
    aggregate: {
      id: `${snapshot.workOrderId}|${snapshot.modelCode}|${snapshot.modelVersion}`,
      type: COSTING_AGGREGATE_TYPES.costSnapshot,
      revision: snapshot.objectVersion,
    },
    occurredAt,
    provenance,
    payload: {
      workOrderId: snapshot.workOrderId,
      modelCode: snapshot.modelCode,
      modelVersion: snapshot.modelVersion,
      totals: snapshot.totals,
      objectVersion: snapshot.objectVersion,
      changed,
      rebuiltBy: snapshot.rebuiltBy,
    },
  });
}
