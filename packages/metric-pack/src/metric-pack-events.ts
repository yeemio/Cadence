/**
 * metric-pack 域事件构造（M3，m3-drafts/04-metric-pack.md §8：append-only +
 * Outbox + 证据列）。事件词汇一个（合同冻结）：MetricPackActivated。
 * eventType 守 business-core BusinessEvent 命名：smes.<环节>.v<n>.<过去式动作>。
 * 求值/导出只读不发事件（合同 §8）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { MetricPackActivationRow } from './metric-pack-stores.js';

/** 事件类型（合同 §8 词汇）。 */
export const METRIC_PACK_EVENT_TYPES = {
  metricPackActivated: 'smes.metric-pack.v1.metric-pack-activated',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const METRIC_PACK_AGGREGATE_TYPES = {
  metricPackActivation: 'metric-pack-activation',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 metric-pack 约定形状）。 */
export type MetricPackEventProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

/** 装载事件载荷（升级留痕：supersedes 携带前任装载记录 id）。 */
export interface MetricPackActivatedPayload {
  readonly activationId: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly title: string;
  /** 包内口径清单（metricId@version；溯源：历史包按装载快照可复算）。 */
  readonly metrics: readonly { readonly metricId: string; readonly version: number }[];
  /** 本记录取代的前任装载记录 id（首装为 null）。 */
  readonly supersedes: string | null;
  readonly activatedBy: string;
}

export function makeMetricPackActivatedEvent(
  tenant: TenantId,
  activation: MetricPackActivationRow,
  provenance: MetricPackEventProvenance,
  occurredAt: string,
): BusinessEvent<MetricPackActivatedPayload> {
  const metrics = activation.metricRefs.map((ref) => ({ metricId: ref.metricId, version: ref.version }));
  return makeBusinessEvent<MetricPackActivatedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: METRIC_PACK_EVENT_TYPES.metricPackActivated,
    tenantId: tenant,
    aggregate: {
      id: activation.packId,
      type: METRIC_PACK_AGGREGATE_TYPES.metricPackActivation,
      revision: activation.packVersion,
    },
    occurredAt,
    businessTime: activation.activatedAt,
    provenance,
    payload: {
      activationId: activation.id,
      packId: activation.packId,
      packVersion: activation.packVersion,
      title: activation.title,
      metrics,
      supersedes: activation.supersedes,
      activatedBy: activation.activatedBy,
    },
  });
}
