/**
 * `./masterdata` 子路径公共面：物品/资源主数据的 PG 存储实现（M1 增量 4-I；
 * S1 backfill 增客户/供应商/计量单位：0920 #8/#9/#100；fix-wave-6 6b-1 S9 增
 * 物品价格台账只读读面：RREQ-MD-019/020）。与 `./org` 同模式：本面引入
 * @prisma/client（需 prisma generate 后 typecheck/build），主入口保持纯数据面。
 */
export {
  connectMasterdataStore,
  PgCustomerStore,
  PgItemPriceLedgerStore,
  PgItemStore,
  PgResourceStore,
  PgSupplierStore,
  PgUnitStore,
} from './pg-masterdata-stores.js';
export type {
  MasterdataStoreHandle,
  MasterdataStoreOptions,
} from './pg-masterdata-stores.js';
