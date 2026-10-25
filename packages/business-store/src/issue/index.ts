/**
 * `./issue` 子路径公共面：发料任务/发料记录的 PG 存储实现（U 波 A11）。
 * 与 `./listing` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。子路径导出登记归总控合流
 * （package.json exports 本波不追加——同树并行冲突面收敛）。
 */
export {
  connectIssueStore,
  PgIssueTaskStore,
  PgIssueTaskLineStore,
  PgIssueRecordStore,
  PgIssueExpressStore,
  PgIssueOperationStore,
  PgIssueDomainEventStore,
} from './pg-issue-stores.js';
export type {
  IssueStoreOptions,
  IssueStoreHandle,
} from './pg-issue-stores.js';
