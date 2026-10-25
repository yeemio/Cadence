/**
 * inventory 模块品牌化 ID（M2-W5，07-inventory.md §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本模块内增补（与 workorder/listing
 * 同一机制，不改 business-core）。运行时口径与既有品牌一致：非空字符串
 * 1~128；具体前缀由本模块 id 生成器叠加（wh-/loc-/sa-/mv-/st-/trf-/ship- +
 * uuidv7，人读可辨聚合类型）。跨模块引用（itemId/workOrderId/purchaseOrderId/
 * inspectionId）一律作 opaque 字符串（不品牌化）——聚合锚定在各兄弟模块侧。
 */
import { defineId } from '@smes/business-core';

/** 仓库 id（主数据，裁决 R4）。 */
export const WarehouseId = defineId('WarehouseId');
export type WarehouseId = ReturnType<typeof WarehouseId.create>;

/** 库位 id（属于仓库）。 */
export const LocationId = defineId('LocationId');
export type LocationId = ReturnType<typeof LocationId.create>;

/** 库存账 id（物料×仓库 维度的现存量与预占）。 */
export const StockAccountId = defineId('StockAccountId');
export type StockAccountId = ReturnType<typeof StockAccountId.create>;

/** 出入库流水 id（append-only；来源单据引用）。 */
export const StockMovementId = defineId('StockMovementId');
export type StockMovementId = ReturnType<typeof StockMovementId.create>;

/** 盘点单 id（draft→counting→reconciled→adjusted 四态机）。 */
export const StocktakeId = defineId('StocktakeId');
export type StocktakeId = ReturnType<typeof StocktakeId.create>;

/** 调拨/移库关联 id（两条流水共用，台账锚点）。 */
export const TransferId = defineId('TransferId');
export type TransferId = ReturnType<typeof TransferId.create>;

/** 发货任务 id（draft→executing→shipped 三态机）。 */
export const ShippingOrderId = defineId('ShippingOrderId');
export type ShippingOrderId = ReturnType<typeof ShippingOrderId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 workorder/listing ids 同口径） ----

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

/** 仓库 id：wh-<uuidv7>。 */
export function newWarehouseId(): string {
  return `wh-${uuidv7()}`;
}

/** 库位 id：loc-<uuidv7>。 */
export function newLocationId(): string {
  return `loc-${uuidv7()}`;
}

/** 库存账 id：sa-<uuidv7>。 */
export function newStockAccountId(): string {
  return `sa-${uuidv7()}`;
}

/** 出入库流水 id：mv-<uuidv7>。 */
export function newStockMovementId(): string {
  return `mv-${uuidv7()}`;
}

/** 盘点单 id：st-<uuidv7>。 */
export function newStocktakeId(): string {
  return `st-${uuidv7()}`;
}

/** 调拨/移库关联 id：trf-<uuidv7>。 */
export function newTransferId(): string {
  return `trf-${uuidv7()}`;
}

/** 发货任务 id：ship-<uuidv7>。 */
export function newShippingOrderId(): string {
  return `ship-${uuidv7()}`;
}

/** 库位余额行 id：lb-<uuidv7>（库位分布投影行的内部主键）。 */
export function newLocationBalanceId(): string {
  return `lb-${uuidv7()}`;
}

/** 域事件 id：evt-<uuidv7>（与 engine-flow 事件 id 同形）。 */
export function newDomainEventId(): string {
  return `evt-${uuidv7()}`;
}
