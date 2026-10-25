/**
 * U7 项目成本域事件（沿 costing-events 体例：append-only + Outbox + 证据列；
 * eventType 守 business-core 命名 smes.<环节>.v<n>.<过去式动作>）。
 *
 * 事件词汇三个（本文件新增，不改既有 COSTING_EVENT_TYPES 冻结面）：
 *   CostProjectEntryCommitted  段事实入账（首记与 delta 共形，deltaOf 携带判别）
 *   CostProjectSnapshotRebuilt 六块快照重算（changed=false = 幂等重算未加行）
 *   CostPriceEntryRecorded     录入价格落账（含同零件联动批量行）
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { CostPriceEntryRow, CostProjectEntryRow, CostProjectSnapshotRow } from './project-cost-stores.js';
import type { CostingEventProvenance } from './costing-events.js';

/** 事件类型（U7 词汇）。 */
export const PROJECT_COST_EVENT_TYPES = {
  costProjectEntryCommitted: 'smes.costing.v1.cost-project-entry-committed',
  costProjectSnapshotRebuilt: 'smes.costing.v1.cost-project-snapshot-rebuilt',
  costPriceEntryRecorded: 'smes.costing.v1.cost-price-entry-recorded',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const PROJECT_COST_AGGREGATE_TYPES = {
  costProjectEntry: 'costing-project-entry',
  costProjectSnapshot: 'costing-project-snapshot',
  costPriceEntry: 'costing-price-entry',
} as const;

/** 段事实事件载荷（首记与 delta 共形）。 */
export interface CostProjectEntryCommittedPayload {
  readonly entryId: string;
  readonly workOrderId: string;
  readonly block: string;
  readonly segment: string | null;
  readonly lineKind: string | null;
  readonly amountMinor: number | null;
  readonly quantity: number | null;
  readonly trade: string | null;
  readonly supplierRef: string | null;
  readonly equipmentRef: string | null;
  readonly sourceType: string;
  readonly sourceRefId: string;
  readonly sourceKey: string;
  readonly deltaOf: string | null;
  readonly recordedBy: string;
}

/** 六块快照重算事件载荷。 */
export interface CostProjectSnapshotRebuiltPayload {
  readonly workOrderId: string;
  readonly modelCode: string;
  readonly modelVersion: number;
  readonly totals: CostProjectSnapshotRow['totals'];
  readonly objectVersion: number;
  readonly changed: boolean;
  readonly rebuiltBy: string;
}

/** 录入价格事件载荷。 */
export interface CostPriceEntryRecordedPayload {
  readonly workOrderId: string;
  /** 本批落账行数（含同零件联动行）。 */
  readonly rowCount: number;
  /** 联动锚（改单价触发的同 sourceLineId 联动；无联动 null）。 */
  readonly linkedSourceLineIds: readonly string[];
  readonly recordedBy: string;
}

export function makeCostProjectEntryCommittedEvent(
  tenant: TenantId,
  entry: CostProjectEntryRow,
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostProjectEntryCommittedPayload> {
  return makeBusinessEvent<CostProjectEntryCommittedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: PROJECT_COST_EVENT_TYPES.costProjectEntryCommitted,
    tenantId: tenant,
    aggregate: { id: entry.id, type: PROJECT_COST_AGGREGATE_TYPES.costProjectEntry, revision: 1 },
    occurredAt,
    ...(entry.workDate === null ? {} : { businessTime: entry.workDate }),
    provenance,
    payload: {
      entryId: entry.id,
      workOrderId: entry.workOrderId,
      block: entry.block,
      segment: entry.segment,
      lineKind: entry.lineKind,
      amountMinor: entry.amountMinor,
      quantity: entry.quantity,
      trade: entry.trade,
      supplierRef: entry.supplierRef,
      equipmentRef: entry.equipmentRef,
      sourceType: entry.sourceType,
      sourceRefId: entry.sourceRefId,
      sourceKey: entry.sourceKey,
      deltaOf: entry.deltaOf,
      recordedBy: entry.recordedBy,
    },
  });
}

export function makeCostProjectSnapshotRebuiltEvent(
  tenant: TenantId,
  snapshot: CostProjectSnapshotRow,
  changed: boolean,
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostProjectSnapshotRebuiltPayload> {
  return makeBusinessEvent<CostProjectSnapshotRebuiltPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: PROJECT_COST_EVENT_TYPES.costProjectSnapshotRebuilt,
    tenantId: tenant,
    aggregate: {
      id: `${snapshot.workOrderId}|${snapshot.modelCode}|${snapshot.modelVersion}`,
      type: PROJECT_COST_AGGREGATE_TYPES.costProjectSnapshot,
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

export function makeCostPriceEntryRecordedEvent(
  tenant: TenantId,
  rows: readonly CostPriceEntryRow[],
  linkedSourceLineIds: readonly string[],
  provenance: CostingEventProvenance,
  occurredAt: string,
): BusinessEvent<CostPriceEntryRecordedPayload> {
  return makeBusinessEvent<CostPriceEntryRecordedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: PROJECT_COST_EVENT_TYPES.costPriceEntryRecorded,
    tenantId: tenant,
    aggregate: {
      id: rows[0] === undefined ? '(empty)' : `${rows[0]!.workOrderId}|price-entries`,
      type: PROJECT_COST_AGGREGATE_TYPES.costPriceEntry,
      revision: 1,
    },
    occurredAt,
    provenance,
    payload: {
      workOrderId: rows[0]?.workOrderId ?? '',
      rowCount: rows.length,
      linkedSourceLineIds,
      recordedBy: rows[0]?.recordedBy ?? '',
    },
  });
}
