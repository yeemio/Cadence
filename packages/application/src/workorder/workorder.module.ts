/**
 * WorkOrderModule —— 工作令模块（M2-W1，02-workorder.md 全生命周期环节）。
 *
 * 体例与 ApprovalModule 同一模式（M1 收尾波纵贯样板）：存储端口注入点 +
 * 缺省内存回落（零 DB boot 语义完整）；机器事件账本采用 engine-flow 端口形状
 * （ADR-0011：application 可依赖 engine-*）；待办端口复用 workbench
 * TodoStore——组合根保证与 WorkbenchModule 注入同一实例（待办联动与工作台
 * 端点同源）。跨模块端口（listing/inventory/progress/customer）缺省空实现，
 * 兄弟模块合流时经 register 注入真实端口——本模块只经端口互调（依赖铁律）。
 *
 * 配置注入形状：九态/配件两份 engine-flow 配置整体可注入（换配置 = 换合法集，
 * 编排代码零改动，ADR-0010 条 2）；齐套类目与风险窗口为初版口径参数；配件
 * 审批链（S6：级数 1/2/3 + 二三级角色，缺省单级零回归）与角色解析端口
 * 见 WorkOrderServiceOptions.partsApprovalChain / approverPort。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   workorder: (stores) =>
 *     WorkOrderModule.register({
 *       orderStore: stores.workOrderStore, // …PG 注入点，余类推
 *       todoStore: stores.todoStore,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import {
  InMemoryKitCheckStore,
  InMemoryPartsRequestStore,
  InMemoryWorkOrderAttachmentStore,
  InMemoryWorkOrderDomainEventStore,
  InMemoryWorkOrderOperationStore,
  InMemoryWorkOrderStore,
} from './in-memory-workorder-stores.js';
import type {
  KitCheckStore,
  PartsRequestStore,
  WorkOrderAttachmentStore,
  WorkOrderDomainEventStore,
  WorkOrderOperationStore,
  WorkOrderStore,
} from './workorder-stores.js';
import type {
  CustomerDirectoryPort,
  InventoryAvailabilityPort,
  ListingRequirementPort,
  PartsApproverDirectoryPort,
  PartsIssuePort,
  ProgressFactPort,
} from './workorder-ports.js';
import {
  EMPTY_CUSTOMER_PORT,
  EMPTY_INVENTORY_PORT,
  EMPTY_LISTING_PORT,
  EMPTY_PARTS_APPROVER_DIRECTORY,
  EMPTY_PROGRESS_PORT,
  NOOP_PARTS_ISSUE_PORT,
} from './workorder-ports.js';
import {
  WorkOrdersController,
  WorkOrderQueriesController,
  PartsRequestsController,
} from './workorder.controllers.js';
import { WorkOrderService, type WorkOrderServiceOptions } from './workorder.service.js';

export const WORKORDER_ORDER_STORE = Symbol('smes.workorder.orderStore');
export const WORKORDER_ATTACHMENT_STORE = Symbol('smes.workorder.attachmentStore');
export const WORKORDER_PARTS_STORE = Symbol('smes.workorder.partsStore');
export const WORKORDER_KIT_STORE = Symbol('smes.workorder.kitStore');
export const WORKORDER_OPERATION_STORE = Symbol('smes.workorder.operationStore');
export const WORKORDER_DOMAIN_EVENT_STORE = Symbol('smes.workorder.domainEventStore');
export const WORKORDER_MACHINE_EVENT_STORE = Symbol('smes.workorder.machineEventStore');
export const WORKORDER_TODO_STORE = Symbol('smes.workorder.todoStore');
export const WORKORDER_LISTING_PORT = Symbol('smes.workorder.listingPort');
export const WORKORDER_INVENTORY_PORT = Symbol('smes.workorder.inventoryPort');
export const WORKORDER_ISSUE_PORT = Symbol('smes.workorder.issuePort');
export const WORKORDER_PROGRESS_PORT = Symbol('smes.workorder.progressPort');
export const WORKORDER_CUSTOMER_PORT = Symbol('smes.workorder.customerPort');
export const WORKORDER_APPROVER_PORT = Symbol('smes.workorder.approverPort');
export const WORKORDER_SERVICE_OPTIONS = Symbol('smes.workorder.serviceOptions');

export interface WorkOrderModuleOptions {
  /** 工作令投影存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly orderStore?: WorkOrderStore | undefined;
  /** 附件事实存储；缺省 = 内存实现。 */
  readonly attachmentStore?: WorkOrderAttachmentStore | undefined;
  /** 配件申请投影存储；缺省 = 内存实现。 */
  readonly partsStore?: PartsRequestStore | undefined;
  /** 齐套快照存储；缺省 = 内存实现。 */
  readonly kitStore?: KitCheckStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: WorkOrderOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: WorkOrderDomainEventStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** listing 清单需求行端口；缺省 = 空实现（齐套刷新得零行全齐套）。 */
  readonly listingPort?: ListingRequirementPort | undefined;
  /** inventory 可用量端口；缺省 = 空实现。 */
  readonly inventoryPort?: InventoryAvailabilityPort | undefined;
  /** inventory 配件出库端口；缺省 = 恒放行（合流替换）。 */
  readonly issuePort?: PartsIssuePort | undefined;
  /** reporting/dispatch 进度事实端口；缺省 = 空实现。 */
  readonly progressPort?: ProgressFactPort | undefined;
  /** masterdata 客户目录端口；缺省 = 空实现（客户名解析降级 null）。 */
  readonly customerPort?: CustomerDirectoryPort | undefined;
  /**
   * 配件审批链角色解析端口（S6 / RREQ-IS-037）；缺省 = 空目录（多级链
   * 二/三级审批明确拒绝）。组合根可用 createOrgPartsApproverDirectory
   * 接 org 域 PolicyStore/UserStore 实时解析。
   */
  readonly approverPort?: PartsApproverDirectoryPort | undefined;
  /** 服务选项（状态机配置/审批链/齐套类目/风险窗口/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<WorkOrderServiceOptions> | undefined;
}

@Module({})
export class WorkOrderModule {
  static register(options: WorkOrderModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<WorkOrderServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: WORKORDER_ORDER_STORE, useValue: options.orderStore ?? new InMemoryWorkOrderStore() },
      {
        provide: WORKORDER_ATTACHMENT_STORE,
        useValue: options.attachmentStore ?? new InMemoryWorkOrderAttachmentStore(),
      },
      { provide: WORKORDER_PARTS_STORE, useValue: options.partsStore ?? new InMemoryPartsRequestStore() },
      { provide: WORKORDER_KIT_STORE, useValue: options.kitStore ?? new InMemoryKitCheckStore() },
      {
        provide: WORKORDER_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryWorkOrderOperationStore(),
      },
      {
        provide: WORKORDER_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryWorkOrderDomainEventStore(),
      },
      {
        provide: WORKORDER_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: WORKORDER_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      { provide: WORKORDER_LISTING_PORT, useValue: options.listingPort ?? EMPTY_LISTING_PORT },
      { provide: WORKORDER_INVENTORY_PORT, useValue: options.inventoryPort ?? EMPTY_INVENTORY_PORT },
      { provide: WORKORDER_ISSUE_PORT, useValue: options.issuePort ?? NOOP_PARTS_ISSUE_PORT },
      { provide: WORKORDER_PROGRESS_PORT, useValue: options.progressPort ?? EMPTY_PROGRESS_PORT },
      { provide: WORKORDER_CUSTOMER_PORT, useValue: options.customerPort ?? EMPTY_CUSTOMER_PORT },
      { provide: WORKORDER_APPROVER_PORT, useValue: options.approverPort ?? EMPTY_PARTS_APPROVER_DIRECTORY },
      { provide: WORKORDER_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: WorkOrderService,
        useFactory: (
          orders: WorkOrderStore,
          attachments: WorkOrderAttachmentStore,
          parts: PartsRequestStore,
          kitChecks: KitCheckStore,
          operations: WorkOrderOperationStore,
          domainEvents: WorkOrderDomainEventStore,
          machineEvents: ApprovalEventStore,
          todos: TodoStore,
          listing: ListingRequirementPort,
          inventory: InventoryAvailabilityPort,
          issue: PartsIssuePort,
          progress: ProgressFactPort,
          customer: CustomerDirectoryPort,
          approvers: PartsApproverDirectoryPort,
          serviceOpts: Partial<WorkOrderServiceOptions>,
        ) =>
          new WorkOrderService(
            orders,
            attachments,
            parts,
            kitChecks,
            operations,
            domainEvents,
            machineEvents,
            todos,
            { listing, inventory, issue, progress, customer, approvers },
            serviceOpts,
          ),
        inject: [
          WORKORDER_ORDER_STORE,
          WORKORDER_ATTACHMENT_STORE,
          WORKORDER_PARTS_STORE,
          WORKORDER_KIT_STORE,
          WORKORDER_OPERATION_STORE,
          WORKORDER_DOMAIN_EVENT_STORE,
          WORKORDER_MACHINE_EVENT_STORE,
          WORKORDER_TODO_STORE,
          WORKORDER_LISTING_PORT,
          WORKORDER_INVENTORY_PORT,
          WORKORDER_ISSUE_PORT,
          WORKORDER_PROGRESS_PORT,
          WORKORDER_CUSTOMER_PORT,
          WORKORDER_APPROVER_PORT,
          WORKORDER_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: WorkOrderModule,
      controllers: [WorkOrdersController, WorkOrderQueriesController, PartsRequestsController],
      providers,
    };
  }
}
