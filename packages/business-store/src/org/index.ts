/**
 * `./org` 子路径公共面：组织/用户/角色/会话管理的 PG 存储实现（M1 增量 3-D；
 * 收尾波-③ 增会话存储；M4 正式线增 RLS session 接线）。与主入口分离的原因：
 * 本面引入 @prisma/client（需 prisma generate 后 typecheck/build），主入口保持
 * 纯数据面（typecheck/test 零 generate、零活库）。
 */
export {
  connectBusinessStore,
  PgDepartmentStore,
  PgLoginAttemptStore,
  PgPolicyStore,
  PgPositionStore,
  PgRoleStore,
  PgSessionStore,
  PgUserStore,
} from './pg-org-stores.js';
export type {
  BusinessStoreHandle,
  BusinessStoreOptions,
  PgLoginAttemptStoreParams,
} from './pg-org-stores.js';
export {
  policyRuleKey,
  policyRuleToRow,
  policyRowToRule,
} from './policy-mapping.js';
export type { PolicyRecordDbRow, PolicyRecordRow } from './policy-mapping.js';
export {
  currentRlsTenant,
  runWithRlsTenant,
  rlsSessionEnabled,
  rlsSessionOperation,
  withRlsTenantSession,
  TENANT_SESSION_VAR,
  SMES_RLS_SESSION_ENV,
} from '../rls-session.js';
export type {
  RlsSessionOperationParams,
  RlsSessionTx,
} from '../rls-session.js';
