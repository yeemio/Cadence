/**
 * `./inventory` 子路径公共面：inventory 模块十端口的 PG 存储实现（M2-W5）。
 * 与 `./listing` / `./workorder` 同模式：本面引入 @prisma/client 与
 * @smes/engine-flow（机器事件端口的 PG 实现——ADR-0011 允许 business-store
 * 依赖 engine-*），主入口保持纯数据面。
 */
export {
  connectInventoryStore,
  PgInventoryDomainEventStore,
  PgInventoryMachineEventStore,
  PgInventoryOperationStore,
  PgReleaseFactStore,
  PgShippingOrderStore,
  PgStockAccountStore,
  PgStockLocationBalanceStore,
  PgStockMovementStore,
  PgStockReservationStore,
  PgStocktakeStore,
  PgWarehouseStore,
  rowToInventoryEvent,
  rowToReleaseFact,
  rowToShippingOrder,
  rowToStockMovement,
  rowToStocktake,
} from './pg-inventory-stores.js';
export type {
  InventoryStoreHandle,
  InventoryStoreOptions,
} from './pg-inventory-stores.js';
