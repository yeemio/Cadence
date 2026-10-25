/**
 * `./workorder` 子路径公共面：workorder 模块七端口的 PG 存储实现（M2-W1）。
 * 与 `./approval` / `./baseline` 同模式：本面引入 @prisma/client 与
 * @smes/engine-flow（机器事件端口的 PG 实现——ADR-0011 允许 business-store
 * 依赖 engine-*），主入口保持纯数据面。
 */
export {
  connectWorkOrderStore,
  PgKitCheckStore,
  PgPartsRequestStore,
  PgWorkOrderAttachmentStore,
  PgWorkOrderDomainEventStore,
  PgWorkOrderMachineEventStore,
  PgWorkOrderOperationStore,
  PgWorkOrderStore,
  rowToAttachment,
  rowToKitCheck,
  rowToPartsRequest,
  rowToWorkOrder,
  rowToWorkorderEvent,
} from './pg-workorder-stores.js';
export type {
  WorkOrderStoreHandle,
  WorkOrderStoreOptions,
} from './pg-workorder-stores.js';
