/**
 * `./approval` 子路径公共面：审批案件 + 决策记录 + 迁移事件的 PG 存储实现
 * （M1 收尾波-①）。与 `./org` 同模式：本面引入 @prisma/client 与
 * @smes/engine-flow（记录/事件端口的 PG 实现——ADR-0011 允许 business-store
 * 依赖 engine-*），主入口保持纯数据面。
 */
export {
  connectApprovalStore,
  PgApprovalCaseStore,
  PgApprovalEventStore,
  PgApprovalRecordStore,
  rowToApprovalCase,
  rowToApprovalEvent,
  rowToApprovalRecordEntry,
} from './pg-approval-stores.js';
export type {
  ApprovalStoreHandle,
  ApprovalStoreOptions,
} from './pg-approval-stores.js';
