/**
 * `./notifications` 子路径公共面：站内通知中心的 PG 存储实现（T 波 #101）。
 * 与 `./workbench` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。
 */
export {
  connectNotificationStore,
  PgNotificationStore,
} from './pg-notification-stores.js';
export type {
  NotificationStoreHandle,
  NotificationStoreOptions,
} from './pg-notification-stores.js';
