/**
 * payroll 模块品牌化 ID（M3，m3-drafts/01-payroll.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本包内增补（与 hours/costing 同一
 * 机制，business-core 零污染）。差异表 #2：草案的 kebab 裸字符串升级为品牌化
 * PayrollRuleId / PayRunId / EarningsRecordId（Brand<T,Name>，m2 通用纪律 5）。
 *
 * 语义分工（对齐 costing 版本化主数据体例）：
 *  - PayrollRuleId = 计薪规则的**业务身份**（跨版本稳定，人读 kebab 码，
 *    如 'part-hourly'）；每个版本是一行（行 id 为 prl-<uuidv7>），
 *    (tenant, ruleId, objectVersion) 唯一；
 *  - PayRunId = 核算批次快照行 id（pr-<uuidv7>；人×月的可重算快照版本行）；
 *  - EarningsRecordId = 薪酬记录 append-only 行 id（ern-<uuidv7>）。
 */
import { defineId } from '@smes/business-core';

/** 计薪规则业务身份（ruleId：跨版本稳定的 kebab 码；版本化主数据的 code 位）。 */
export const PayrollRuleId = defineId('PayrollRuleId');
export type PayrollRuleId = ReturnType<typeof PayrollRuleId.create>;

/** 核算批次（PayRun）快照行 id——人×月核算快照（幂等重算锚，supersedes 链）。 */
export const PayRunId = defineId('PayRunId');
export type PayRunId = ReturnType<typeof PayRunId.create>;

/** 薪酬记录（EarningsRecord）行 id——核算产出的 append-only 事实行。 */
export const EarningsRecordId = defineId('EarningsRecordId');
export type EarningsRecordId = ReturnType<typeof EarningsRecordId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 hours-ids/costing-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 hours-ids/costing-ids 同实现口径——
 * business-store 的 uuid 工具不可用（依赖方向），事实表 id 需时间有序
 * （evidence-columns.v1），毫秒级时间序已满足本模块排序口径。
 */
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 计薪规则版本行 id：prl-<uuidv7>。 */
export function newPayrollRuleRowId(): string {
  return `prl-${uuidv7()}`;
}

/** 核算批次快照行 id：pr-<uuidv7>。 */
export function newPayRunId(): PayRunId {
  return PayRunId.create(`pr-${uuidv7()}`);
}

/** 薪酬记录行 id：ern-<uuidv7>。 */
export function newEarningsRecordId(): EarningsRecordId {
  return EarningsRecordId.create(`ern-${uuidv7()}`);
}

/** 域事件 id：evt-<uuidv7>（与既有模块域事件同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
