/**
 * DispatchModule —— 六类派工模块（M2-W6，04-dispatch.md"任务派发"环节）。
 *
 * 体例与 ListingModule 同一模式：存储端口注入点 + 缺省内存回落（零 DB boot
 * 语义完整）；机器事件账本采用 engine-flow 端口形状（ADR-0011：application
 * 可依赖 engine-*）；待办端口复用 workbench TodoStore——组合根保证与
 * Workbench/其他环节模块注入同一实例。跨模块端口（workorder KitCheck 齐套读 /
 * baseline 外协取价 / inspection 回厂触发 / integration-print 打印）缺省空或
 * 拒绝实现，兄弟模块与边缘包合流时经 register 注入真实端口——本模块只经端口
 * 互调（依赖铁律；application 禁依赖 integration-*，打印走业务侧最小镜像）。
 *
 * 配置注入形状：派工状态机配置整体可注入（换配置 = 换合法集，ADR-0010 条 2）；
 * 齐套拦截覆盖 kind 集为初版口径参数（默认装配/电气，客户口径整体替换）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   dispatch: (stores) =>
 *     DispatchModule.register({
 *       orderStore: stores.dispatchOrderStore, // …PG 注入点，余类推
 *       todoStore: stores.todoStore,
 *       // 跨模块端口（合流接线）：
 *       kitCheck, priceSource, inspectionIntake, print,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import {
  InMemoryDispatchDomainEventStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchOrderStore,
  InMemoryOutsourcingLineStore,
} from './in-memory-dispatch-stores.js';
import type {
  DispatchDomainEventStore,
  DispatchOperationStore,
  DispatchOrderStore,
  OutsourcingLineStore,
} from './dispatch-stores.js';
import {
  DISPATCH_EMPTY_PRICE_SOURCE,
  DISPATCH_NOOP_INSPECTION_INTAKE,
  DISPATCH_NOOP_PRINT_PORT,
  EMPTY_KIT_CHECK_PORT,
  type DispatchPrintPort,
  type InspectionIntakePort,
  type KitCheckReadPort,
  type OutsourcingPriceSource,
} from './dispatch-ports.js';
import { DispatchOrdersController, DispatchTasksController, OutsourcingController } from './dispatch.controllers.js';
import { DispatchService, type DispatchServiceOptions } from './dispatch.service.js';

export const DISPATCH_ORDER_STORE = Symbol('smes.dispatch.orderStore');
export const DISPATCH_OUTSOURCING_LINE_STORE = Symbol('smes.dispatch.outsourcingLineStore');
export const DISPATCH_OPERATION_STORE = Symbol('smes.dispatch.operationStore');
export const DISPATCH_DOMAIN_EVENT_STORE = Symbol('smes.dispatch.domainEventStore');
export const DISPATCH_MACHINE_EVENT_STORE = Symbol('smes.dispatch.machineEventStore');
export const DISPATCH_TODO_STORE = Symbol('smes.dispatch.todoStore');
export const DISPATCH_KIT_CHECK_PORT = Symbol('smes.dispatch.kitCheckPort');
export const DISPATCH_PRICE_SOURCE = Symbol('smes.dispatch.priceSource');
export const DISPATCH_INSPECTION_INTAKE = Symbol('smes.dispatch.inspectionIntake');
export const DISPATCH_PRINT_PORT = Symbol('smes.dispatch.printPort');
export const DISPATCH_SERVICE_OPTIONS = Symbol('smes.dispatch.serviceOptions');

export interface DispatchModuleOptions {
  /** 派工单投影存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly orderStore?: DispatchOrderStore | undefined;
  /** 外协明细投影存储；缺省 = 内存实现。 */
  readonly outsourcingLineStore?: OutsourcingLineStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: DispatchOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: DispatchDomainEventStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** workorder KitCheck 齐套读端口（装配/电气创建放行）；缺省 = 空（fail-closed 拒绝）。 */
  readonly kitCheck?: KitCheckReadPort | undefined;
  /** baseline 外协取价端口；缺省 = 空实现（未定价待补录）。 */
  readonly priceSource?: OutsourcingPriceSource | undefined;
  /** inspection 回厂触发端口；缺省 = 空实现（回执 created:false，完工不阻塞）。 */
  readonly inspectionIntake?: InspectionIntakePort | undefined;
  /** 打印端口（外协加工单）；缺省 = 空实现（打印数据查询仍完整可用）。 */
  readonly print?: DispatchPrintPort | undefined;
  /** 服务选项（状态机配置/齐套拦截 kind 集/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<DispatchServiceOptions> | undefined;
}

@Module({})
export class DispatchModule {
  static register(options: DispatchModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<DispatchServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: DISPATCH_ORDER_STORE, useValue: options.orderStore ?? new InMemoryDispatchOrderStore() },
      {
        provide: DISPATCH_OUTSOURCING_LINE_STORE,
        useValue: options.outsourcingLineStore ?? new InMemoryOutsourcingLineStore(),
      },
      {
        provide: DISPATCH_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryDispatchOperationStore(),
      },
      {
        provide: DISPATCH_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryDispatchDomainEventStore(),
      },
      {
        provide: DISPATCH_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: DISPATCH_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      { provide: DISPATCH_KIT_CHECK_PORT, useValue: options.kitCheck ?? EMPTY_KIT_CHECK_PORT },
      { provide: DISPATCH_PRICE_SOURCE, useValue: options.priceSource ?? DISPATCH_EMPTY_PRICE_SOURCE },
      { provide: DISPATCH_INSPECTION_INTAKE, useValue: options.inspectionIntake ?? DISPATCH_NOOP_INSPECTION_INTAKE },
      { provide: DISPATCH_PRINT_PORT, useValue: options.print ?? DISPATCH_NOOP_PRINT_PORT },
      { provide: DISPATCH_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: DispatchService,
        useFactory: (
          orders: DispatchOrderStore,
          outsourcingLines: OutsourcingLineStore,
          operations: DispatchOperationStore,
          domainEvents: DispatchDomainEventStore,
          machineEvents: ApprovalEventStore,
          todos: TodoStore,
          kitCheck: KitCheckReadPort,
          priceSource: OutsourcingPriceSource,
          inspectionIntake: InspectionIntakePort,
          print: DispatchPrintPort,
          serviceOpts: Partial<DispatchServiceOptions>,
        ) =>
          new DispatchService(
            orders,
            outsourcingLines,
            operations,
            domainEvents,
            machineEvents,
            todos,
            { kitCheck, priceSource, inspectionIntake, print },
            serviceOpts,
          ),
        inject: [
          DISPATCH_ORDER_STORE,
          DISPATCH_OUTSOURCING_LINE_STORE,
          DISPATCH_OPERATION_STORE,
          DISPATCH_DOMAIN_EVENT_STORE,
          DISPATCH_MACHINE_EVENT_STORE,
          DISPATCH_TODO_STORE,
          DISPATCH_KIT_CHECK_PORT,
          DISPATCH_PRICE_SOURCE,
          DISPATCH_INSPECTION_INTAKE,
          DISPATCH_PRINT_PORT,
          DISPATCH_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: DispatchModule,
      controllers: [DispatchOrdersController, DispatchTasksController, OutsourcingController],
      providers,
    };
  }
}
