/**
 * `./maintenance` 子路径公共面：维保执行域五端口的 PG 存储实现（M3）。
 * 与 `./payroll` / `./drawing` 同模式：本面引入 @prisma/client（需 prisma
 * generate 后 typecheck/build），主入口保持纯数据面。
 *
 * 依赖取舍（pro-pack-tier-edges）：本面不 import @smes/maintenance——行/端口形状
 * 用本地结构同形镜像类型承载（见 pg-maintenance-stores.ts 头注），组合根注入时由
 * TypeScript 结构校验兼容 MaintenanceService 的 MaintenanceStores 槽位。
 */
export {
  connectMaintenanceStore,
  PgMaintenanceDomainEventStore,
  PgMaintenanceOperationLedger,
  PgMaintenancePlanStore,
  PgMaintenanceTaskStore,
  PgMaintenanceActivityStore,
} from './pg-maintenance-stores.js';
export type {
  MaintenanceStoreHandle,
  MaintenanceStoreOptions,
} from './pg-maintenance-stores.js';
