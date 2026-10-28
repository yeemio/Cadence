/**
 * InspectionModule —— 四类质检模块（M2-W4，06-inspection.md v1.0 全量）。
 *
 * 体例与 WorkOrderModule 同一模式（Wave-1 纵贯样板）：存储端口注入点 + 缺省
 * 内存回落（零 DB boot 语义完整）；机器事件账本采用 engine-flow 端口形状
 * （ADR-0011：application 可依赖 engine-*；质检单/不合格处置两类聚合共用）；
 * 待办端口复用 workbench TodoStore——组合根保证与 WorkbenchModule 注入同一
 * 实例。跨模块端口（放行事实 → inventory、IM 点名 → integration-im）缺省
 * no-op，兄弟模块合流时经 register 注入——本模块只经端口互调（依赖铁律）；
 * 来源入口（InspectionIntakePort）由本模块 service 实现，组合根把 reporting
 * 末道报工 / dispatch 外协回厂 / listing 收货的来源事件路由进来。
 *
 * 配置注入形状：质检单/不合格处置两份 engine-flow 配置整体可注入（换配置 =
 * 换合法集，编排代码零改动，ADR-0010 条 2）；闭环超时阈值与处置枚举为初版
 * 口径参数（默认配置层）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   inspection: (stores) =>
 *     InspectionModule.register({
 *       orderStore: stores.inspectionOrderStore, // …PG 注入点，余类推
 *       todoStore: stores.todoStore,
 *     }),
 */
import { InMemoryItemStore } from '../masterdata/in-memory-masterdata-stores.js';
import type { ItemStore } from '../masterdata/masterdata-stores.js';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import {
  InMemoryInspectionDomainEventStore,
  InMemoryInspectionOperationStore,
  InMemoryInspectionOrderStore,
  InMemoryNonconformStore,
} from './in-memory-inspection-stores.js';
import type {
  InspectionDomainEventStore,
  InspectionOperationStore,
  InspectionOrderStore,
  NonconformStore,
} from './inspection-stores.js';
import type { InspectionRevokeGuardPort, NotifyChannel, StockReleasePort } from './inspection-ports.js';
import {
  FAIL_CLOSED_INSPECTION_REVOKE_GUARD,
  NOOP_NOTIFY_CHANNEL,
  NOOP_STOCK_RELEASE_PORT,
} from './inspection-ports.js';
import {
  InspectionQueriesController,
  InspectionsController,
  NonconformitiesController,
} from './inspection.controllers.js';
import { InspectionService, type InspectionServiceOptions } from './inspection.service.js';

export const INSPECTION_ORDER_STORE = Symbol('smes.inspection.orderStore');
export const INSPECTION_NONCONFORM_STORE = Symbol('smes.inspection.nonconformStore');
export const INSPECTION_OPERATION_STORE = Symbol('smes.inspection.operationStore');
export const INSPECTION_DOMAIN_EVENT_STORE = Symbol('smes.inspection.domainEventStore');
export const INSPECTION_MACHINE_EVENT_STORE = Symbol('smes.inspection.machineEventStore');
export const INSPECTION_TODO_STORE = Symbol('smes.inspection.todoStore');
export const INSPECTION_STOCK_RELEASE_PORT = Symbol('smes.inspection.stockReleasePort');
export const INSPECTION_NOTIFY_CHANNEL = Symbol('smes.inspection.notifyChannel');
export const INSPECTION_REVOKE_GUARD_PORT = Symbol('smes.inspection.revokeGuardPort');
export const INSPECTION_SERVICE_OPTIONS = Symbol('smes.inspection.serviceOptions');

export interface InspectionModuleOptions {
  readonly itemLibrary?: ItemStore | undefined;
  /** 质检单投影存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly orderStore?: InspectionOrderStore | undefined;
  /** 不合格处置投影存储；缺省 = 内存实现。 */
  readonly nonconformStore?: NonconformStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: InspectionOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: InspectionDomainEventStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** 放行事实端口（inventory 实现合流注入）；缺省 = no-op（仅事件通道）。 */
  readonly stockReleasePort?: StockReleasePort | undefined;
  /** IM 点名端口（integration-im / 组合根实现）；缺省 = no-op。 */
  readonly notifyChannel?: NotifyChannel | undefined;
  /**
   * 撤销质检前置闸门端口（RQ-037：入库未完成/下一道闸门/工时已审三项跨域
   * 校验接缝）；缺省 = fail-closed（未接线拒绝撤销——组合根接线后替换）。
   */
  readonly revokeGuardPort?: InspectionRevokeGuardPort | undefined;
  /** 服务选项（两份状态机配置/闭环超时阈值/处置枚举/点名经办人/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<InspectionServiceOptions> | undefined;
}

@Module({})
export class InspectionModule {
  static register(options: InspectionModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<InspectionServiceOptions> = { ...options.serviceOptions, itemLibrary: options.itemLibrary ?? new InMemoryItemStore() };
    const providers: Provider[] = [
      { provide: INSPECTION_ORDER_STORE, useValue: options.orderStore ?? new InMemoryInspectionOrderStore() },
      {
        provide: INSPECTION_NONCONFORM_STORE,
        useValue: options.nonconformStore ?? new InMemoryNonconformStore(),
      },
      {
        provide: INSPECTION_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryInspectionOperationStore(),
      },
      {
        provide: INSPECTION_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryInspectionDomainEventStore(),
      },
      {
        provide: INSPECTION_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: INSPECTION_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      { provide: INSPECTION_STOCK_RELEASE_PORT, useValue: options.stockReleasePort ?? NOOP_STOCK_RELEASE_PORT },
      { provide: INSPECTION_NOTIFY_CHANNEL, useValue: options.notifyChannel ?? NOOP_NOTIFY_CHANNEL },
      {
        provide: INSPECTION_REVOKE_GUARD_PORT,
        useValue: options.revokeGuardPort ?? FAIL_CLOSED_INSPECTION_REVOKE_GUARD,
      },
      { provide: INSPECTION_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: InspectionService,
        useFactory: (
          orders: InspectionOrderStore,
          nonconforms: NonconformStore,
          operations: InspectionOperationStore,
          domainEvents: InspectionDomainEventStore,
          machineEvents: ApprovalEventStore,
          todos: TodoStore,
          stockRelease: StockReleasePort,
          notify: NotifyChannel,
          revokeGuard: InspectionRevokeGuardPort,
          serviceOpts: Partial<InspectionServiceOptions>,
        ) =>
          new InspectionService(
            orders,
            nonconforms,
            operations,
            domainEvents,
            machineEvents,
            todos,
            { stockRelease, notify, revokeGuard },
            serviceOpts,
          ),
        inject: [
          INSPECTION_ORDER_STORE,
          INSPECTION_NONCONFORM_STORE,
          INSPECTION_OPERATION_STORE,
          INSPECTION_DOMAIN_EVENT_STORE,
          INSPECTION_MACHINE_EVENT_STORE,
          INSPECTION_TODO_STORE,
          INSPECTION_STOCK_RELEASE_PORT,
          INSPECTION_NOTIFY_CHANNEL,
          INSPECTION_REVOKE_GUARD_PORT,
          INSPECTION_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: InspectionModule,
      controllers: [InspectionsController, InspectionQueriesController, NonconformitiesController],
      providers,
    };
  }
}
