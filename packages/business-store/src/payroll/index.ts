/**
 * `./payroll` 子路径公共面：薪酬账五端口的 PG 存储实现（M3）。
 * 与 `./hours` / `./costing` 同模式：本面引入 @prisma/client（需 prisma
 * generate 后 typecheck/build），主入口保持纯数据面。
 *
 * 依赖取舍（pro-pack-tier-edges）：本面不 import @smes/payroll——行/端口形状
 * 用本地结构同形镜像类型承载（见 pg-payroll-stores.ts 头注），组合根注入时由
 * TypeScript 结构校验兼容 PayrollService 的 PayrollStores 槽位。
 */
export {
  connectPayrollStore,
  PgPayrollDomainEventStore,
  PgPayrollOperationLedger,
  PgPayrollRuleStore,
  PgPayRunStore,
  PgEarningsRecordStore,
} from './pg-payroll-stores.js';
export type {
  PayrollStoreHandle,
  PayrollStoreOptions,
} from './pg-payroll-stores.js';
