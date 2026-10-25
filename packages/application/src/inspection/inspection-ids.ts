/**
 * inspection 模块品牌化 ID 增补（M2-W4）。
 *
 * InspectionId 已在 business-core M0 立桩（ids.ts）——直接复用；本文件只按需
 * 增补模块内实体 ID（defineId 机制不变，ADR-0003 #2）。运行时口径与既有品牌
 * 一致：非空字符串 1~128 字符；具体前缀格式由本模块 id 生成器叠加
 * （insp- / nc- / evt- + uuid，人读可辨聚合类型）。uuidv7 为与
 * workorder-ids 同款的自带实现（business-store 的 uuid 工具不可用：依赖方向
 * application ← business-store；事实表 id 需时间有序，evidence-columns.v1；
 * 复制小工具而非跨模块 import——模块间只经端口互调，通用合同纪律 6）。
 */
import { defineId } from '@smes/business-core';

/** 不合格处置 ID（不合格明细：原因/处置枚举/闭环状态）。 */
export const NonconformId = defineId('NonconformId');
export type NonconformId = ReturnType<typeof NonconformId.create>;

/**
 * 极小 uuidv7 生成器（RFC 9562）：48 位 unix 毫秒 + ver7 + 74 位随机。
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

/** 质检单 id：insp-<uuidv7>。 */
export function newInspectionId(): string {
  return `insp-${uuidv7()}`;
}

/** 不合格处置 id：nc-<uuidv7>。 */
export function newNonconformId(): string {
  return `nc-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
