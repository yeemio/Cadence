/**
 * `./hours` 子路径公共面：工时账四端口的 PG 存储实现（M2-W6）。
 * 与 `./baseline` / `./inventory` 同模式：本面引入 @prisma/client（需 prisma
 * generate 后 typecheck/build），主入口保持纯数据面。
 */
export {
  connectHoursStore,
  PgHoursDomainEventStore,
  PgHoursOperationLedger,
  PgLaborEntryStore,
  PgLaborLedgerMonthStore,
} from './pg-hours-stores.js';
export type {
  HoursStoreHandle,
  HoursStoreOptions,
} from './pg-hours-stores.js';
