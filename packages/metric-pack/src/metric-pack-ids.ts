/**
 * metric-pack 模块品牌化 ID（M3，m3-drafts/04-metric-pack.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本包内增补（与 payroll/hours/costing 同一
 * 机制，business-core 零污染）。合同 §2：装载记录实体（MetricPackActivation）
 * 是本包唯一新增实体；MetricDefinition / MetricPack / MetricQuery / MetricResult
 * 引用 engine-reporting 既有类型（引用不重复定义）。
 *
 * 语义分工：
 *  - MetricPackActivationId = 装载记录行 id（mpa-<uuidv7>；租户×packId@version
 *    的激活事实行——升级=新记录 supersedes 前任，历史包只读可复算）。
 */
import { defineId } from '@smes/business-core';

/** 装载记录（MetricPackActivation）行 id——激活事实行，append-only。 */
export const MetricPackActivationId = defineId('MetricPackActivationId');
export type MetricPackActivationId = ReturnType<typeof MetricPackActivationId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 payroll-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 payroll-ids 同实现口径——
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

/** 装载记录行 id：mpa-<uuidv7>。 */
export function newMetricPackActivationId(): MetricPackActivationId {
  return MetricPackActivationId.create(`mpa-${uuidv7()}`);
}

/** 域事件 id：evt-<uuidv7>（与既有模块域事件同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
