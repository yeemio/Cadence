/**
 * workorder 模块品牌化 ID 增补（M2-W1）。
 *
 * WorkOrderId 已在 business-core M0 立桩（ids.ts）——直接复用；本文件只按需
 * 增补模块内实体 ID（defineId 机制不变，ADR-0003 #2）。运行时口径与既有
 * 品牌一致：非空字符串 1~128 字符；具体前缀格式由本模块 id 生成器叠加
 * （wo- / att- / pr- / kc- + uuid，人读可辨聚合类型）。
 */
import { defineId } from '@smes/business-core';

/** 附件 ID（图纸等文件挂接）。 */
export const WorkOrderAttachmentId = defineId('WorkOrderAttachmentId');
export type WorkOrderAttachmentId = ReturnType<typeof WorkOrderAttachmentId.create>;

/** 配件申请 ID（售后配件申请→审批→发货闭环）。 */
export const PartsRequestId = defineId('PartsRequestId');
export type PartsRequestId = ReturnType<typeof PartsRequestId.create>;

/** 齐套检查快照 ID（每次刷新一条不可变快照）。 */
export const KitCheckId = defineId('KitCheckId');
export type KitCheckId = ReturnType<typeof KitCheckId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：人读前缀 + 时间有序，证据列 id 口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：48 位 unix 毫秒 + ver7 + 74 位随机。
 * business-store 的 uuid 工具不可用（依赖方向 application ← business-store），
 * 事实表 id 需时间有序（evidence-columns.v1），故本模块内自带等价实现；
 * 同毫秒不保证严格单调（毫秒级时间序已满足本模块排序口径）。
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

/** 工作令 id：wo-<uuidv7>。 */
export function newWorkOrderId(): string {
  return `wo-${uuidv7()}`;
}

/** 附件 id：att-<uuidv7>。 */
export function newAttachmentId(): string {
  return `att-${uuidv7()}`;
}

/** 配件申请 id：pr-<uuidv7>。 */
export function newPartsRequestId(): string {
  return `pr-${uuidv7()}`;
}

/** 齐套检查快照 id：kc-<uuidv7>。 */
export function newKitCheckId(): string {
  return `kc-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
