/**
 * `./reporting` 子路径公共面：reporting 模块五端口的 PG 存储实现（M2-W7）。
 * 与 `./dispatch` / `./listing` 同模式：本面引入 @prisma/client 与
 * @smes/engine-flow（机器事件端口的 PG 实现——ADR-0011 允许 business-store
 * 依赖 engine-*），主入口保持纯数据面。
 */
export {
  connectReportingStore,
  PgReportAuditStore,
  PgReportDomainEventStore,
  PgReportingMachineEventStore,
  PgReportOperationStore,
  PgWorkReportStore,
  rowToReportAudit,
  rowToReportingEvent,
  rowToWorkReport,
} from './pg-reporting-stores.js';
export type {
  ReportingStoreHandle,
  ReportingStoreOptions,
} from './pg-reporting-stores.js';
