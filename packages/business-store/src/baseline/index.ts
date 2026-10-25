/**
 * `./baseline` 子路径公共面：技术准备 P1 六端口 + P2/P3 件四端口的 PG 存储实现
 * （M2-W2 / M2-W7）。与 `./org` / `./masterdata` / `./approval` 同模式：本面引入
 * @prisma/client（需 prisma generate 后 typecheck/build），主入口保持纯数据面。
 */
export {
  connectBaselineStore,
  PgBaselineEventStore,
  PgBaselineOperationLedger,
  PgEquipmentStore,
  PgFaultMachineEventStore,
  PgFaultReportStore,
  PgMaterialValidationRunStore,
  PgOutsourcingPriceRuleStore,
  PgProcessDefStore,
  PgRoutingStore,
  PgStandardTimeStore,
} from './pg-baseline-stores.js';
export { rowToFaultReport } from './pg-baseline-stores.js';
export type {
  BaselineStoreHandle,
  BaselineStoreOptions,
} from './pg-baseline-stores.js';
