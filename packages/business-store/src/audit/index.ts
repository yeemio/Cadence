/**
 * `./audit` 子路径公共面：操作日志的 PG 存储实现（S1 backfill：0920 #103）。
 * 与 `./org` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。
 */
export { connectAuditStore, PgAuditLogStore, pgAuditSummaryOf } from './pg-audit-stores.js';
export type { AuditStoreHandle, AuditStoreOptions } from './pg-audit-stores.js';
