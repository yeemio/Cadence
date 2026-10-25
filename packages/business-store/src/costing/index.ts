/**
 * `./costing` 子路径公共面：成本账五端口的 PG 存储实现（M2-W6）+ U7 项目成本
 * 三端口（A5 六块成本：段事实/六块快照/录入价格）。与 `./hours` / `./baseline`
 * 同模式：本面引入 @prisma/client（需 prisma generate 后 typecheck/build），
 * 主入口保持纯数据面。
 */
export {
  connectCostingStore,
  PgCostEntryStore,
  PgCostSnapshotStore,
  PgCostingDomainEventStore,
  PgCostingModelStore,
  PgCostingOperationLedger,
} from './pg-costing-stores.js';
export type {
  CostingStoreHandle,
  CostingStoreOptions,
} from './pg-costing-stores.js';
export {
  connectProjectCostStore,
  PgCostProjectEntryStore,
  PgCostProjectSnapshotStore,
  PgCostPriceEntryStore,
} from './pg-project-cost-stores.js';
