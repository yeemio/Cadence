/**
 * reporting 模块品牌化 ID（M2-W7，05-reporting.md §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（与 workorder/baseline/
 * listing/dispatch 同一机制，不改 business-core）。运行时口径与既有品牌一致：
 * 非空字符串 1~128；具体前缀由本模块 id 生成器叠加（wr-/rau- + uuidv7，人读可
 * 辨聚合类型）。dispatchId / operationCode / workOrderId 一律作跨模块 opaque
 * 字符串（不品牌化）——聚合锚定在 dispatch / baseline / workorder 侧。
 */
import { defineId } from '@smes/business-core';

/** 报工单（WorkReport）id——五类（零件/装配/电气/售后/零工）之一，挂 DispatchId。 */
export const WorkReportId = defineId('WorkReportId');
export type WorkReportId = ReturnType<typeof WorkReportId.create>;

/** 核查记录（ReportAudit）id——编辑/审核/撤销的动作留痕行。 */
export const ReportAuditId = defineId('ReportAuditId');
export type ReportAuditId = ReturnType<typeof ReportAuditId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 dispatch-ids / listing-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 dispatch-ids.ts 同实现口径——
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

/** 报工单 id：wr-<uuidv7>。 */
export function newWorkReportId(): string {
  return `wr-${uuidv7()}`;
}

/** 核查记录 id：rau-<uuidv7>。 */
export function newReportAuditId(): string {
  return `rau-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
