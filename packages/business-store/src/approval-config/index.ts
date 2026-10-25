/**
 * `./approval-config` 子路径公共面：审批流配置的 PG 存储实现（T 波 #102，
 * approval 域）。与 `./masterdata` 同模式：本面引入 @prisma/client（需
 * prisma generate 后 typecheck/build），主入口保持纯数据面。
 */
export {
  connectApprovalConfigStore,
  PgApprovalFlowConfigStore,
} from './pg-approval-config-stores.js';
export type {
  ApprovalConfigStoreHandle,
  ApprovalConfigStoreOptions,
  StoredFlowConfig,
} from './pg-approval-config-stores.js';
