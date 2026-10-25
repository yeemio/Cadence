/**
 * issue 域事件（U1）。公开事件 = business-core BusinessEvent 形状（append-only
 * 事件表 event_records + Outbox，复用 M1 既有表——同 listing/dispatch 取舍）。
 * 命名空间 smes.issue.v1.<过去式动作>；事件清单（本波最小集 2 个）：
 *   IssueConfirmed（确认发料落账——含库存联动回执摘要）
 *   IssueRevoked（整单撤销——含回滚回执摘要）
 *
 * 派工同步（issue.sync）是幂等投影维护（create-or-append，自然键去重），本波
 * 不发域事件：无本波消费者（dispatch 钩子/清单行锁定接线归合流，届时按需增补
 * IssueTaskSynced）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { IssueDispatchKind, IssueLineKind } from './issue-config.js';

// ---- 聚合类型 ----

export const ISSUE_TASK_AGGREGATE_TYPE = 'issue-task';
export const ISSUE_RECORD_AGGREGATE_TYPE = 'issue-record';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns provenance 口径）。 */
export interface IssueEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

export function provenanceOf(operationId: string, command: string, actor: string): IssueEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名 ----

export const ISSUE_EVENT_TYPES = {
  issueConfirmed: 'smes.issue.v1.issue-confirmed',
  issueRevoked: 'smes.issue.v1.issue-revoked',
} as const;

// ---- 载荷形状 ----

/** 确认发料事件载荷（聚合 = 发料记录）。 */
export interface IssueConfirmedPayload {
  readonly recordId: string;
  readonly recordNo: string;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly dispatchKind: IssueDispatchKind;
  readonly rollup: boolean;
  readonly lineKind: IssueLineKind;
  /** 参与行数与本次合计数量。 */
  readonly lineCount: number;
  readonly totalQty: number;
  /** 快递单（发货头）id；无发货头为 null。 */
  readonly expressId: string | null;
  /** 库存联动回执摘要（standard/electrical 行：各 issueKey 的扣减合计）。 */
  readonly stockReceipts: readonly {
    readonly issueKey: string;
    readonly itemId: string;
    readonly totalQty: number;
    readonly reservedConsumedQty: number;
    readonly availableConsumedQty: number;
  }[];
  /** 回写后的任务汇总（状态 + 进度）。 */
  readonly taskState: string;
  readonly taskTotalRequiredQty: number;
  readonly taskTotalIssuedQty: number;
  readonly objectVersion: number;
  readonly actor: string;
}

/** 撤销发料事件载荷（聚合 = 发料记录）。 */
export interface IssueRevokedPayload {
  readonly recordId: string;
  readonly recordNo: string;
  readonly taskId: string;
  readonly workOrderId: string;
  readonly lineKind: IssueLineKind;
  /** 库存回滚回执摘要（standard/electrical 行）。 */
  readonly stockRollbacks: readonly { readonly issueKey: string; readonly rolled: boolean }[];
  /** 回写后的任务汇总。 */
  readonly taskState: string;
  readonly taskTotalRequiredQty: number;
  readonly taskTotalIssuedQty: number;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: IssueEventProvenance;
}

export function makeIssueConfirmedEvent(
  base: DomainEventInput,
  payload: IssueConfirmedPayload,
): BusinessEvent<IssueConfirmedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: ISSUE_EVENT_TYPES.issueConfirmed,
    tenantId: base.tenant,
    aggregate: { id: payload.recordId, type: ISSUE_RECORD_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeIssueRevokedEvent(
  base: DomainEventInput,
  payload: IssueRevokedPayload,
): BusinessEvent<IssueRevokedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: ISSUE_EVENT_TYPES.issueRevoked,
    tenantId: base.tenant,
    aggregate: { id: payload.recordId, type: ISSUE_RECORD_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}
