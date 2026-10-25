/**
 * dispatch 售后报销域事件（U5 A12）。公开事件 = business-core BusinessEvent
 * 形状（append-only event_records + Outbox，经 DispatchDomainEventStore 落账）。
 * 命名空间沿用 smes.dispatch.v1；事件清单（本模块 2 个）：
 *   AftercareClaimFiled   报销填报（新增落账——A5 售后成本块初值信号）
 *   AftercareClaimUpdated 报销修订（费用重写——A5 售后成本块重算信号）
 * 聚合类型 aftercare-claim（挂 acl- id；revision = 报销单 objectVersion）。
 * 不改既有 DISPATCH_EVENT_TYPES（dispatch-events.ts 是既有冻结面）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { AftercareClaim } from './aftercare-claim-stores.js';
import { aftercareClaimTotalMinor, aftercareLineTotalMinor } from './aftercare-claim-stores.js';

// ---- 聚合类型 ----

export const AFTERCARE_CLAIM_AGGREGATE_TYPE = 'aftercare-claim';

// ---- 事件类型名 ----

export const AFTERCARE_CLAIM_EVENT_TYPES = {
  aftercareClaimFiled: 'smes.dispatch.v1.aftercare-claim-filed',
  aftercareClaimUpdated: 'smes.dispatch.v1.aftercare-claim-updated',
} as const;

// ---- 载荷形状 ----

/** 报销行的事件投影（身份快照 + 四费 + 行小计）。 */
export interface AftercareClaimEventLine {
  readonly lineNo: number;
  readonly reportId: string;
  readonly worker: string;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  /** 行小计 = 四费之和（文档 §2.4.3 小计列）。 */
  readonly totalMinor: number;
}

export interface AftercareClaimFiledPayload {
  readonly dispatchId: string;
  readonly lineCount: number;
  readonly lines: readonly AftercareClaimEventLine[];
  /** 报销合计（文档 §2.4.3 自动合计）。 */
  readonly claimTotalMinor: number;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface AftercareClaimUpdatedPayload {
  readonly dispatchId: string;
  readonly lineCount: number;
  readonly lines: readonly AftercareClaimEventLine[];
  readonly claimTotalMinor: number;
  /** 修订前报销合计（A5 成本块重算的差值口径）。 */
  readonly previousClaimTotalMinor: number;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: { operationId: string; command: string; actor: string };
}

function eventLinesOf(claim: AftercareClaim): AftercareClaimEventLine[] {
  return claim.lines.map((line) => ({
    lineNo: line.lineNo,
    reportId: line.reportId,
    worker: `${line.worker}`,
    lodgingMinor: line.lodgingMinor,
    trafficMinor: line.trafficMinor,
    overtimeMinor: line.overtimeMinor,
    otherMinor: line.otherMinor,
    totalMinor: aftercareLineTotalMinor(line),
  }));
}

export function makeAftercareClaimFiledEvent(
  base: DomainEventInput,
  claim: AftercareClaim,
): BusinessEvent<AftercareClaimFiledPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: AFTERCARE_CLAIM_EVENT_TYPES.aftercareClaimFiled,
    tenantId: base.tenant,
    aggregate: { id: claim.id, type: AFTERCARE_CLAIM_AGGREGATE_TYPE, revision: claim.objectVersion },
    occurredAt: base.occurredAt,
    payload: {
      dispatchId: claim.dispatchId,
      lineCount: claim.lines.length,
      lines: eventLinesOf(claim),
      claimTotalMinor: aftercareClaimTotalMinor(claim),
      objectVersion: claim.objectVersion,
      actor: base.provenance.actor,
    },
    provenance: base.provenance,
  });
}

export function makeAftercareClaimUpdatedEvent(
  base: DomainEventInput,
  claim: AftercareClaim,
  previousClaimTotalMinor: number,
): BusinessEvent<AftercareClaimUpdatedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: AFTERCARE_CLAIM_EVENT_TYPES.aftercareClaimUpdated,
    tenantId: base.tenant,
    aggregate: { id: claim.id, type: AFTERCARE_CLAIM_AGGREGATE_TYPE, revision: claim.objectVersion },
    occurredAt: base.occurredAt,
    payload: {
      dispatchId: claim.dispatchId,
      lineCount: claim.lines.length,
      lines: eventLinesOf(claim),
      claimTotalMinor: aftercareClaimTotalMinor(claim),
      previousClaimTotalMinor,
      objectVersion: claim.objectVersion,
      actor: base.provenance.actor,
    },
    provenance: base.provenance,
  });
}
