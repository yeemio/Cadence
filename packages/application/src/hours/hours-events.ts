/**
 * hours 域事件构造（M2-W6，08-hours.md §6：append-only + Outbox + 证据列）。
 *
 * 事件词汇三个（合同冻结）：LaborEntryCommitted / LaborEntryReversed /
 * LaborMonthRebuilt。eventType 守 business-core BusinessEvent 命名：
 * smes.<环节>.v<n>.<过去式动作>。条目 commit/reverse 同为入账动作，分两个
 * 事件类型（冲销是显式信号，消费方按类型分流——costing/薪酬不读负向条目）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { LaborEntryRow, LaborLedgerMonthRow } from './hours-stores.js';

/** 事件类型（合同 §6 词汇）。 */
export const HOURS_EVENT_TYPES = {
  laborEntryCommitted: 'smes.hours.v1.labor-entry-committed',
  laborEntryReversed: 'smes.hours.v1.labor-entry-reversed',
  laborMonthRebuilt: 'smes.hours.v1.labor-month-rebuilt',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const HOURS_AGGREGATE_TYPES = {
  laborEntry: 'hours-labor-entry',
  laborMonth: 'hours-labor-month',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 hours 约定形状）。 */
export type HoursEventProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

/** 条目事件载荷（commit/reverse 共形；direction 携带判别）。 */
export interface LaborEntryEventPayload {
  readonly entryId: string;
  readonly workerId: string;
  readonly workDate: string;
  readonly trade: string;
  readonly processCode: string | null;
  readonly hours: number;
  readonly outputQty: number | null;
  readonly direction: 'commit' | 'reverse';
  readonly sourceReportId: string;
  readonly reverses: string | null;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly dispatchId: string | null;
  readonly sourceKey: string;
  readonly recordedBy: string;
}

/** 月度归集事件载荷（changed=false = 幂等重算未追加新版本行）。 */
export interface LaborMonthRebuiltPayload {
  readonly month: string;
  readonly workerId: string;
  readonly trade: string;
  readonly totalHours: number;
  readonly outputQty: number;
  readonly entryCount: number;
  readonly objectVersion: number;
  readonly changed: boolean;
  readonly rebuiltBy: string;
}

export function makeLaborEntryEvent(
  tenant: TenantId,
  entry: LaborEntryRow,
  eventType: (typeof HOURS_EVENT_TYPES)[keyof typeof HOURS_EVENT_TYPES],
  provenance: HoursEventProvenance,
  occurredAt: string,
): BusinessEvent<LaborEntryEventPayload> {
  return makeBusinessEvent<LaborEntryEventPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType,
    tenantId: tenant,
    aggregate: { id: entry.id, type: HOURS_AGGREGATE_TYPES.laborEntry, revision: 1 }, // 执行事实无修正链
    occurredAt,
    businessTime: entry.workDate,
    provenance,
    payload: {
      entryId: entry.id,
      workerId: entry.workerId,
      workDate: entry.workDate,
      trade: entry.trade,
      processCode: entry.processCode,
      hours: entry.hours,
      outputQty: entry.outputQty,
      direction: entry.direction,
      sourceReportId: entry.sourceReportId,
      reverses: entry.reverses,
      workOrderId: entry.workOrderId,
      drawingNo: entry.drawingNo,
      dispatchId: entry.dispatchId,
      sourceKey: entry.sourceKey,
      recordedBy: entry.recordedBy,
    },
  });
}

export function makeLaborMonthRebuiltEvent(
  tenant: TenantId,
  month: LaborLedgerMonthRow,
  changed: boolean,
  provenance: HoursEventProvenance,
  occurredAt: string,
): BusinessEvent<LaborMonthRebuiltPayload> {
  return makeBusinessEvent<LaborMonthRebuiltPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: HOURS_EVENT_TYPES.laborMonthRebuilt,
    tenantId: tenant,
    aggregate: {
      id: `${month.workerId}|${month.month}|${month.trade}`,
      type: HOURS_AGGREGATE_TYPES.laborMonth,
      revision: month.objectVersion,
    },
    occurredAt,
    businessTime: `${month.month}-01`,
    provenance,
    payload: {
      month: month.month,
      workerId: month.workerId,
      trade: month.trade,
      totalHours: month.totalHours,
      outputQty: month.outputQty,
      entryCount: month.entryCount,
      objectVersion: month.objectVersion,
      changed,
      rebuiltBy: month.rebuiltBy,
    },
  });
}
