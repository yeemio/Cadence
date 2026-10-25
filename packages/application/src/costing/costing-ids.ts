/**
 * costing 模块品牌化 ID（M2-W6，09-costing.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（与既有模块同一机制，
 * 不改 business-core）。前缀：ce-（成本条目）/ csm-（口径版本）/ cs-（成本快照）
 * + uuidv7。跨模块引用（workOrderId / movementId / dispatchId / 劳动条目 id）
 * 一律作 opaque 字符串。
 */
import { defineId } from '@smes/business-core';

/** 成本条目（CostEntry）id——工作令×类别×金额×来源单据引用的 append-only 行。 */
export const CostEntryId = defineId('CostEntryId');
export type CostEntryId = ReturnType<typeof CostEntryId.create>;

/** 口径版本（CostingModel）id——类别映射/单价来源/分摊规则的声明式定义版本行。 */
export const CostingModelId = defineId('CostingModelId');
export type CostingModelId = ReturnType<typeof CostingModelId.create>;

/** 成本快照（CostSnapshot）id——工作令×口径版本的重算结果行。 */
export const CostSnapshotId = defineId('CostSnapshotId');
export type CostSnapshotId = ReturnType<typeof CostSnapshotId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 listing-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 workorder-ids/listing-ids 同实现口径——
 * business-store 的 uuid 工具不可用（依赖方向），事实表 id 需时间有序
 * （evidence-columns.v1）。
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

/** 成本条目行 id：ce-<uuidv7>。 */
export function newCostEntryId(): string {
  return `ce-${uuidv7()}`;
}

/** 口径版本行 id：csm-<uuidv7>。 */
export function newCostingModelId(): string {
  return `csm-${uuidv7()}`;
}

/** 成本快照行 id：cs-<uuidv7>。 */
export function newCostSnapshotId(): string {
  return `cs-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
