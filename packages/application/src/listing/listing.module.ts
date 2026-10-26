/**
 * ListingModule —— 清单与采购模块（M2-W3，03-listing.md"需求→获取"环节）。
 *
 * 体例与 WorkOrderModule 同一模式：存储端口注入点 + 缺省内存回落（零 DB boot
 * 语义完整）；机器事件账本采用 engine-flow 端口形状（ADR-0011：application
 * 可依赖 engine-*）；待办端口复用 workbench TodoStore——组合根保证与
 * Workbench/Approval 模块注入同一实例。跨模块端口（workorder 订阅/inventory
 * 可用量与入库/Excel/物料校验）缺省空实现或显式拒绝实现，兄弟模块合流时经
 * register 注入真实端口——本模块只经端口互调（依赖铁律）。
 *
 * 配置注入形状：订单/申请/退货三份 engine-flow 配置整体可注入（换配置 =
 * 换合法集/审核链层级，编排代码零改动，ADR-0010 条 2）；缺口类目与审批待办
 * 指派人为初版口径参数。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   listing: (stores) =>
 *     ListingModule.register({
 *       sheetStore: stores.listingSheetStore, // …PG 注入点，余类推
 *       todoStore: stores.todoStore,
 *       // 跨模块端口（合流接线）：
 *       workOrderFeed, inventory, receipt, inspectionIntake, excel, materialValidation,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import {
  InMemoryGapCheckStore,
  InMemoryListingDomainEventStore,
  InMemoryListingLineStore,
  InMemoryListingOperationStore,
  InMemoryListingSheetStore,
  InMemoryPurchaseOrderStore,
  InMemoryPurchaseRequestStore,
  InMemoryPurchaseReturnStore,
} from './in-memory-listing-stores.js';
import { InMemoryProcessMaterialLinkStore } from './in-memory-process-material-stores.js';
import type {
  GapCheckStore,
  ListingDomainEventStore,
  ListingLineStore,
  ListingOperationStore,
  ListingSheetStore,
  PurchaseOrderStore,
  PurchaseRequestStore,
  PurchaseReturnStore,
} from './listing-stores.js';
import {
  EMPTY_WORK_ORDER_CREATED_FEED,
  LISTING_EMPTY_INVENTORY_PORT,
  LISTING_NOOP_INSPECTION_INTAKE,
  LISTING_NOOP_RECEIPT_PORT,
  LISTING_UNWIRED_MATERIAL_VALIDATION,
  type InventoryAvailabilityPort,
  type InventoryReceiptPort,
  type MaterialValidationExecutor,
  type WorkOrderCreatedFeedPort,
} from './listing-ports.js';
import type { InspectionIntakePort } from '../inspection/inspection-ports.js';
import { JsonTablesExcelPort, type ExcelPort } from './excel-port.js';
import {
  ListingSheetsController,
  PurchaseOrdersController,
  PurchaseQueriesController,
  PurchaseRequestsController,
  PurchaseReturnsController,
} from './listing.controllers.js';
import { ListingService, type ListingServiceOptions } from './listing.service.js';
import { ProcessMaterialsController } from './process-material.controllers.js';
import { ProcessMaterialService } from './process-material.service.js';
import type { ProcessMaterialLinkStore } from './process-material-stores.js';

export const LISTING_SHEET_STORE = Symbol('smes.listing.sheetStore');
export const LISTING_LINE_STORE = Symbol('smes.listing.lineStore');
export const LISTING_GAP_STORE = Symbol('smes.listing.gapStore');
export const LISTING_REQUEST_STORE = Symbol('smes.listing.requestStore');
export const LISTING_ORDER_STORE = Symbol('smes.listing.orderStore');
export const LISTING_RETURN_STORE = Symbol('smes.listing.returnStore');
export const LISTING_OPERATION_STORE = Symbol('smes.listing.operationStore');
export const LISTING_DOMAIN_EVENT_STORE = Symbol('smes.listing.domainEventStore');
export const LISTING_MACHINE_EVENT_STORE = Symbol('smes.listing.machineEventStore');
export const LISTING_PROCESS_MATERIAL_STORE = Symbol('smes.listing.processMaterialStore');
export const LISTING_TODO_STORE = Symbol('smes.listing.todoStore');
export const LISTING_WORK_ORDER_FEED = Symbol('smes.listing.workOrderFeed');
export const LISTING_INVENTORY_PORT = Symbol('smes.listing.inventoryPort');
export const LISTING_RECEIPT_PORT = Symbol('smes.listing.receiptPort');
export const LISTING_INSPECTION_INTAKE = Symbol('smes.listing.inspectionIntake');
export const LISTING_EXCEL_PORT = Symbol('smes.listing.excelPort');
export const LISTING_MATERIAL_VALIDATION = Symbol('smes.listing.materialValidation');
export const LISTING_SERVICE_OPTIONS = Symbol('smes.listing.serviceOptions');

export interface ListingModuleOptions {
  /** 清单单据头存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly sheetStore?: ListingSheetStore | undefined;
  /** 清单行存储；缺省 = 内存实现。 */
  readonly lineStore?: ListingLineStore | undefined;
  /** 缺口核查快照存储；缺省 = 内存实现。 */
  readonly gapStore?: GapCheckStore | undefined;
  /** 采购申请投影存储；缺省 = 内存实现。 */
  readonly requestStore?: PurchaseRequestStore | undefined;
  /** 采购订单投影存储；缺省 = 内存实现。 */
  readonly orderStore?: PurchaseOrderStore | undefined;
  /** 退货单投影存储；缺省 = 内存实现。 */
  readonly returnStore?: PurchaseReturnStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: ListingOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: ListingDomainEventStore | undefined;
  /** 工序×原材料关联存储（U4）；缺省 = 内存实现。与 operationStore/domainEventStore
   * 共用注入实例（ProcessMaterialService 幂等记账与事件发布走 listing 同一套账面）。 */
  readonly processMaterialStore?: ProcessMaterialLinkStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** workorder WorkOrderCreated 订阅端口；缺省 = 空实现（骨架生成走四类缺省）。 */
  readonly workOrderFeed?: WorkOrderCreatedFeedPort | undefined;
  /** inventory 可用量端口（缺口核查）；缺省 = 空实现。 */
  readonly inventoryPort?: InventoryAvailabilityPort | undefined;
  /** inventory 入库指令端口（收货联动）；缺省 = 恒放行（合流替换）。 */
  readonly receiptPort?: InventoryReceiptPort | undefined;
  /** inspection 采购质检投递端口（收货→三类采购质检，RQ-019）；缺省 = 空实现（不投递）。 */
  readonly inspectionIntake?: InspectionIntakePort | undefined;
  /** Excel 导入导出端口；缺省 = JsonTablesExcelPort（json-tables 源；ExcelJS 适配器合流替换）。 */
  readonly excelPort?: ExcelPort | undefined;
  /** baseline 物料校验执行端口；缺省 = 显式拒绝实现（导入命令接线前不可用）。 */
  readonly materialValidation?: MaterialValidationExecutor | undefined;
  /** 服务选项（三份状态机配置/缺口类目/审批人/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<ListingServiceOptions> | undefined;
}

@Module({})
export class ListingModule {
  static register(options: ListingModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<ListingServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: LISTING_SHEET_STORE, useValue: options.sheetStore ?? new InMemoryListingSheetStore() },
      { provide: LISTING_LINE_STORE, useValue: options.lineStore ?? new InMemoryListingLineStore() },
      { provide: LISTING_GAP_STORE, useValue: options.gapStore ?? new InMemoryGapCheckStore() },
      { provide: LISTING_REQUEST_STORE, useValue: options.requestStore ?? new InMemoryPurchaseRequestStore() },
      { provide: LISTING_ORDER_STORE, useValue: options.orderStore ?? new InMemoryPurchaseOrderStore() },
      { provide: LISTING_RETURN_STORE, useValue: options.returnStore ?? new InMemoryPurchaseReturnStore() },
      {
        provide: LISTING_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryListingOperationStore(),
      },
      {
        provide: LISTING_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryListingDomainEventStore(),
      },
      {
        provide: LISTING_PROCESS_MATERIAL_STORE,
        useValue: options.processMaterialStore ?? new InMemoryProcessMaterialLinkStore(),
      },
      {
        provide: ProcessMaterialService,
        useFactory: (
          materialStore: ProcessMaterialLinkStore,
          lines: ListingLineStore,
          operations: ListingOperationStore,
          domainEvents: ListingDomainEventStore,
        ) => new ProcessMaterialService(materialStore, lines, operations, domainEvents),
        inject: [
          LISTING_PROCESS_MATERIAL_STORE,
          LISTING_LINE_STORE,
          LISTING_OPERATION_STORE,
          LISTING_DOMAIN_EVENT_STORE,
        ],
      },
      {
        provide: LISTING_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: LISTING_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      { provide: LISTING_WORK_ORDER_FEED, useValue: options.workOrderFeed ?? EMPTY_WORK_ORDER_CREATED_FEED },
      { provide: LISTING_INVENTORY_PORT, useValue: options.inventoryPort ?? LISTING_EMPTY_INVENTORY_PORT },
      { provide: LISTING_RECEIPT_PORT, useValue: options.receiptPort ?? LISTING_NOOP_RECEIPT_PORT },
      {
        provide: LISTING_INSPECTION_INTAKE,
        useValue: options.inspectionIntake ?? LISTING_NOOP_INSPECTION_INTAKE,
      },
      { provide: LISTING_EXCEL_PORT, useValue: options.excelPort ?? new JsonTablesExcelPort() },
      {
        provide: LISTING_MATERIAL_VALIDATION,
        useValue: options.materialValidation ?? LISTING_UNWIRED_MATERIAL_VALIDATION,
      },
      { provide: LISTING_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: ListingService,
        useFactory: (
          sheets: ListingSheetStore,
          lines: ListingLineStore,
          gapChecks: GapCheckStore,
          requests: PurchaseRequestStore,
          orders: PurchaseOrderStore,
          returns: PurchaseReturnStore,
          operations: ListingOperationStore,
          domainEvents: ListingDomainEventStore,
          machineEvents: ApprovalEventStore,
          todos: TodoStore,
          workOrderFeed: WorkOrderCreatedFeedPort,
          inventory: InventoryAvailabilityPort,
          receipt: InventoryReceiptPort,
          inspectionIntake: InspectionIntakePort,
          excel: ExcelPort,
          materialValidation: MaterialValidationExecutor,
          serviceOpts: Partial<ListingServiceOptions>,
        ) =>
          new ListingService(
            sheets,
            lines,
            gapChecks,
            requests,
            orders,
            returns,
            operations,
            domainEvents,
            machineEvents,
            todos,
            { workOrderFeed, inventory, receipt, inspectionIntake, excel, materialValidation },
            serviceOpts,
          ),
        inject: [
          LISTING_SHEET_STORE,
          LISTING_LINE_STORE,
          LISTING_GAP_STORE,
          LISTING_REQUEST_STORE,
          LISTING_ORDER_STORE,
          LISTING_RETURN_STORE,
          LISTING_OPERATION_STORE,
          LISTING_DOMAIN_EVENT_STORE,
          LISTING_MACHINE_EVENT_STORE,
          LISTING_TODO_STORE,
          LISTING_WORK_ORDER_FEED,
          LISTING_INVENTORY_PORT,
          LISTING_RECEIPT_PORT,
          LISTING_INSPECTION_INTAKE,
          LISTING_EXCEL_PORT,
          LISTING_MATERIAL_VALIDATION,
          LISTING_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: ListingModule,
      controllers: [
        ListingSheetsController,
        PurchaseRequestsController,
        PurchaseOrdersController,
        PurchaseReturnsController,
        PurchaseQueriesController,
        ProcessMaterialsController,
      ],
      providers,
    };
  }
}
