/**
 * listing 模块品牌化 ID（M2-W3，03-listing.md §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（与 workorder/baseline
 * 同一机制，不改 business-core）。运行时口径与既有品牌一致：非空字符串
 * 1~128；具体前缀由本模块 id 生成器叠加（ls-/ll-/preq-/po-/prt- + uuidv7，
 * 人读可辨聚合类型）。workOrderId 一律作跨模块 opaque 字符串（不品牌化）——
 * 聚合锚定在 workorder 侧。
 */
import { defineId } from '@smes/business-core';

/** 清单（ListingSheet）id——四类清单之一的单据头。 */
export const ListingSheetId = defineId('ListingSheetId');
export type ListingSheetId = ReturnType<typeof ListingSheetId.create>;

/** 清单行 id。 */
export const ListingLineId = defineId('ListingLineId');
export type ListingLineId = ReturnType<typeof ListingLineId.create>;

/** 采购申请 id（三类：非标件/标准配件/设备）。 */
export const PurchaseRequestId = defineId('PurchaseRequestId');
export type PurchaseRequestId = ReturnType<typeof PurchaseRequestId.create>;

/** 采购订单 id（五态机）。 */
export const PurchaseOrderId = defineId('PurchaseOrderId');
export type PurchaseOrderId = ReturnType<typeof PurchaseOrderId.create>;

/** 退货单 id。 */
export const PurchaseReturnId = defineId('PurchaseReturnId');
export type PurchaseReturnId = ReturnType<typeof PurchaseReturnId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 workorder-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 workorder-ids.ts 同实现口径——
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

/** 清单 id：ls-<uuidv7>。 */
export function newListingSheetId(): string {
  return `ls-${uuidv7()}`;
}

/** 清单行 id：ll-<uuidv7>。 */
export function newListingLineId(): string {
  return `ll-${uuidv7()}`;
}

/** 采购申请 id：preq-<uuidv7>。 */
export function newPurchaseRequestId(): string {
  return `preq-${uuidv7()}`;
}

/** 采购订单 id：po-<uuidv7>。 */
export function newPurchaseOrderId(): string {
  return `po-${uuidv7()}`;
}

/** 退货单 id：prt-<uuidv7>。 */
export function newPurchaseReturnId(): string {
  return `prt-${uuidv7()}`;
}

/** 缺口核查快照 id：gap-<uuidv7>。 */
export function newGapCheckId(): string {
  return `gap-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
