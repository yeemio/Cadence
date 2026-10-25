/**
 * listing 工序×原材料关联域事件（U4；命名空间与 listing-events 同族：
 * smes.listing.v1.<过去式动作>）。对外发布事实（BusinessEvent + Outbox），
 * 供 A5 项目成本/发料等下游消费——本波只发布，不接消费方。
 *
 * 聚合口径：aggregate = { id: processId, type: 'process-material' }（一个工序
 * 引用的关联行集是一个聚合）；revision = 替换序（previousCount + 1，≥1 且随
 * 替换单调递增——行集无状态机版本，revision 是事件序号而非乐观锁锚）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';

// ---- 聚合类型 ----

/** 工序×原材料关联行集聚合类型。 */
export const PROCESS_MATERIAL_AGGREGATE_TYPE = 'process-material';

// ---- 事件类型名 ----

export const PROCESS_MATERIAL_EVENT_TYPES = {
  replaced: 'smes.listing.v1.process-material-replaced',
} as const;

// ---- 载荷形状 ----

/** 溯源列形状（同 ListingEventProvenance 口径；本文件自持，不依赖 listing-events）。 */
export interface ProcessMaterialEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

/** 整表替换发布事实：替换前后行数 + 归属锚（行明细读投影面，不进载荷）。 */
export interface ProcessMaterialReplacedPayload {
  readonly listingLineId: string;
  readonly processId: string;
  /** 替换前该工序关联行数（0 = 首次写入）。 */
  readonly previousCount: number;
  /** 替换后行数（0 = 清空）。 */
  readonly replacedCount: number;
  readonly actor: string;
}

// ---- 工厂（makeBusinessEvent 校验 + 深冻结） ----

export interface ProcessMaterialDomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: ProcessMaterialEventProvenance;
}

export function makeProcessMaterialReplacedEvent(
  base: ProcessMaterialDomainEventInput,
  payload: ProcessMaterialReplacedPayload,
): BusinessEvent<ProcessMaterialReplacedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: PROCESS_MATERIAL_EVENT_TYPES.replaced,
    tenantId: base.tenant,
    aggregate: {
      id: payload.processId,
      type: PROCESS_MATERIAL_AGGREGATE_TYPE,
      revision: payload.previousCount + 1, // 替换序（≥1 合同；previousCount=0 首写 → 1）
    },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}
