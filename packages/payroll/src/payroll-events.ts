/**
 * payroll 域事件构造（M3，m3-drafts/01-payroll.md §6：append-only + Outbox +
 * 证据列）。事件词汇两个（合同冻结）：PayrollRulePublished / PayRunComputed。
 * eventType 守 business-core BusinessEvent 命名：smes.<环节>.v<n>.<过去式动作>。
 * PayRunComputed 携规则版本集与周期键（供对账与报表溯源）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { PayRunRow, PayrollRuleRow } from './payroll-stores.js';

/** 事件类型（合同 §6 词汇）。 */
export const PAYROLL_EVENT_TYPES = {
  payrollRulePublished: 'smes.payroll.v1.payroll-rule-published',
  payRunComputed: 'smes.payroll.v1.pay-run-computed',
} as const;

/** 聚合类型（事件表 aggregate_type 列口径）。 */
export const PAYROLL_AGGREGATE_TYPES = {
  payrollRule: 'payroll-rule',
  payRun: 'pay-run',
} as const;

/** 溯源载荷（evidence-columns provenance JSONB 的 payroll 约定形状）。 */
export type PayrollEventProvenance = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly issuedBy: string;
  readonly commandKind: string;
  readonly contract: 'smes.command.v1';
};

/** 规则版本发布事件载荷（发布/修订共形；supersedes 携带链位）。 */
export interface PayrollRulePublishedPayload {
  readonly ruleId: string;
  readonly name: string | null;
  readonly basis: string;
  readonly rateMinor: number;
  readonly coefficient: number;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly objectVersion: number;
  readonly supersedes: string | null;
  readonly rowId: string;
}

/** 核算批次事件载荷（changed=false = 幂等重算未追加新版本行）。 */
export interface PayRunComputedPayload {
  readonly payRunId: string;
  readonly personId: string;
  readonly periodKey: string;
  /** 本批次规则版本集（溯源：按当时规则版本可复算）。 */
  readonly ruleVersions: readonly { readonly ruleId: string; readonly ruleVersion: number }[];
  readonly totalQuantity: number;
  readonly totalAmountMinor: number;
  readonly lineCount: number;
  readonly objectVersion: number;
  readonly changed: boolean;
  readonly computedBy: string;
}

export function makePayrollRulePublishedEvent(
  tenant: TenantId,
  rule: PayrollRuleRow,
  provenance: PayrollEventProvenance,
  occurredAt: string,
): BusinessEvent<PayrollRulePublishedPayload> {
  return makeBusinessEvent<PayrollRulePublishedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: PAYROLL_EVENT_TYPES.payrollRulePublished,
    tenantId: tenant,
    aggregate: {
      id: rule.ruleId,
      type: PAYROLL_AGGREGATE_TYPES.payrollRule,
      revision: rule.objectVersion,
    },
    occurredAt,
    ...(rule.businessTime === undefined ? {} : { businessTime: rule.businessTime }),
    provenance,
    payload: {
      ruleId: rule.ruleId,
      name: rule.name,
      basis: rule.basis,
      rateMinor: rule.rateMinor,
      coefficient: rule.coefficient,
      scope: rule.scope as Readonly<Record<string, unknown>>,
      objectVersion: rule.objectVersion,
      supersedes: rule.supersedes,
      rowId: rule.id,
    },
  });
}

export function makePayRunComputedEvent(
  tenant: TenantId,
  run: PayRunRow,
  changed: boolean,
  provenance: PayrollEventProvenance,
  occurredAt: string,
): BusinessEvent<PayRunComputedPayload> {
  return makeBusinessEvent<PayRunComputedPayload>({
    eventId: EventId.create(`evt-${crypto.randomUUID()}`),
    eventType: PAYROLL_EVENT_TYPES.payRunComputed,
    tenantId: tenant,
    aggregate: {
      id: `${run.personId}|${run.periodKey}`,
      type: PAYROLL_AGGREGATE_TYPES.payRun,
      revision: run.objectVersion,
    },
    occurredAt,
    businessTime: `${run.periodKey}-01`,
    provenance,
    payload: {
      payRunId: run.id,
      personId: run.personId,
      periodKey: run.periodKey,
      ruleVersions: run.ruleVersions.map((ref) => ({ ruleId: ref.ruleId, ruleVersion: ref.ruleVersion })),
      totalQuantity: run.totalQuantity,
      totalAmountMinor: run.totalAmountMinor,
      lineCount: run.lineCount,
      objectVersion: run.objectVersion,
      changed,
      computedBy: run.computedBy,
    },
  });
}
