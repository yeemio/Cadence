/**
 * `./attachment` 子路径公共面：附件中心的 PG 元数据存储实现（U 波 A13）
 * + 对象字节 PG 适配器（fix-wave-4 W4-2 / D-3）。
 * 与 `./notifications` 同模式：本面引入 @prisma/client（需 prisma generate 后
 * typecheck/build），主入口保持纯数据面。子路径导出登记归总控合流
 * （package.json exports 本波不追加——同树并行冲突面收敛，同 `./issue`）。
 */
export { connectAttachmentStore, PgAttachmentStore } from './pg-attachment-stores.js';
export type {
  AttachmentStoreOptions,
  AttachmentStoreHandle,
} from './pg-attachment-stores.js';
export {
  connectAttachmentObjectStorage,
  PgObjectStorage,
  PG_STORAGE_KIND,
} from './pg-object-storage.js';
export type {
  AttachmentObjectStorageOptions,
  AttachmentObjectStorageHandle,
  PgObjectStorageOptions,
} from './pg-object-storage.js';
