/**
 * `./inspection` 子路径公共面：inspection 模块五端口的 PG 存储实现（M2-W4）。
 * 与 `./workorder` 同模式：本面引入 @prisma/client 与 @smes/engine-flow（机器
 * 事件端口的 PG 实现——ADR-0011 允许 business-store 依赖 engine-*），主入口
 * 保持纯数据面。
 */
export {
  connectInspectionStore,
  PgInspectionDomainEventStore,
  PgInspectionMachineEventStore,
  PgInspectionOperationStore,
  PgInspectionOrderStore,
  PgNonconformStore,
  rowToInspectionEvent,
  rowToInspectionOrder,
  rowToNonconform,
} from './pg-inspection-stores.js';
export type {
  InspectionStoreHandle,
  InspectionStoreOptions,
} from './pg-inspection-stores.js';
