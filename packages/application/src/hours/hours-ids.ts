/**
 * hours 模块品牌化 ID（M2-W6，08-hours.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（与 workorder/baseline/
 * listing 同一机制，不改 business-core）。运行时口径与既有品牌一致：非空字符串
 * 1~128；前缀由本模块 id 生成器叠加（le-/hlm- + uuidv7，人读可辨聚合类型）。
 * 跨模块引用（reportId/dispatchId/workOrderId）一律作 opaque 字符串——聚合
 * 锚定在来源模块侧，本模块不重复品牌化。
 */
import { defineId } from '@smes/business-core';

/** 工时账目（LaborEntry）id——人×日期×工序/工种×工时×来源报工单的 append-only 行。 */
export const LaborEntryId = defineId('LaborEntryId');
export type LaborEntryId = ReturnType<typeof LaborEntryId.create>;

/** 月度归集（LaborLedgerMonth）id——人×月×工种汇总快照（可重算，supersedes）。 */
export const LaborLedgerMonthId = defineId('LaborLedgerMonthId');
export type LaborLedgerMonthId = ReturnType<typeof LaborLedgerMonthId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 listing-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 workorder-ids/listing-ids 同实现口径——
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

/** 工时账目行 id：le-<uuidv7>。 */
export function newLaborEntryId(): string {
  return `le-${uuidv7()}`;
}

/** 月度归集快照行 id：hlm-<uuidv7>。 */
export function newLaborLedgerMonthId(): string {
  return `hlm-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与既有模块域事件同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
