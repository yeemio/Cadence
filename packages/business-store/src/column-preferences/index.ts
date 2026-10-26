/**
 * `./column-preferences` 子路径公共面：用户表格列显隐偏好的 PG 存储实现
 * （fix-wave-6 6b-3，A14 / RREQ-INT-032）。与 `./menu-config` 同模式：本面
 * 引入 @prisma/client（需 prisma generate 后 typecheck/build），主入口保持
 * 纯数据面。
 */
export {
  connectColumnPreferenceStore,
  PgColumnPreferenceStore,
} from './pg-column-preferences-stores.js';
export type {
  ColumnPreferenceStoreHandle,
  ColumnPreferenceStoreOptions,
} from './pg-column-preferences-stores.js';
