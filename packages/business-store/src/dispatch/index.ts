/**
 * `./dispatch` 子路径公共面：dispatch 模块五端口的 PG 存储实现（M2-W6）。
 * 与 `./listing` / `./workorder` 同模式：本面引入 @prisma/client 与
 * @smes/engine-flow（机器事件端口的 PG 实现——ADR-0011 允许 business-store
 * 依赖 engine-*），主入口保持纯数据面。
 */
export {
  connectDispatchStore,
  PgDispatchDomainEventStore,
  PgDispatchMachineEventStore,
  PgDispatchOperationStore,
  PgDispatchOrderStore,
  PgOutsourcingLineStore,
  rowToDispatchEvent,
  rowToDispatchOrder,
  rowToOutsourcingLine,
} from './pg-dispatch-stores.js';
export type {
  DispatchStoreHandle,
  DispatchStoreOptions,
} from './pg-dispatch-stores.js';
// U5 aftercare claim 售后报销（A12：一单一投影 + 明细行；与派工单族共享装配工厂）
export { PgAftercareClaimStore, rowToAftercareClaimLine } from './pg-aftercare-claim-stores.js';
