/**
 * `./workbench` 子路径公共面：工作台待办的 PG 存储实现（M1 增量 4-I）。
 * 与 `./org` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。
 */
export { connectWorkbenchStore, PgTodoStore } from './pg-workbench-stores.js';
export type {
  WorkbenchStoreHandle,
  WorkbenchStoreOptions,
} from './pg-workbench-stores.js';
