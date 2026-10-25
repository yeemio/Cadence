/**
 * `./menu-config` 子路径公共面：菜单配置的 PG 存储实现（T 波 #98/99）。
 * 与 `./masterdata` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。
 */
export {
  connectMenuConfigStore,
  PgMenuConfigStore,
} from './pg-menu-config-stores.js';
export type {
  MenuConfigStoreHandle,
  MenuConfigStoreOptions,
} from './pg-menu-config-stores.js';
