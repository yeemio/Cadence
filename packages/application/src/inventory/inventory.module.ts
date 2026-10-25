/**
 * InventoryModule —— 库存环节模块（M2-W5，07-inventory.md"收发存"环节）。
 *
 * 体例与 ListingModule 同一模式：存储端口注入点 + 缺省内存回落（零 DB boot
 * 语义完整）；机器事件账本采用 engine-flow 端口形状（ADR-0011：application
 * 可依赖 engine-*）。跨模块方向全部是**被依赖**（本模块是四个兄弟端口的
 * 实现方，适配器见 inventory-ports.ts；In 方向无兄弟端口注入——放行事实走
 * 本模块 ReleaseFactStore，由组合根把 createStockReleaseRecorder 接给
 * InspectionModule）。预占端口（StockReservationPort）由 InventoryService
 * 天然实现（reserveStock/releaseReservation），组合根注入 dispatch 线消费。
 *
 * 配置注入形状：盘点/发货两份 engine-flow 配置整体可注入（换配置 = 换合法
 * 集，ADR-0010 条 2）；负库存策略与默认仓为初版口径参数（合同 §8）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   inventory: (stores) =>
 *     InventoryModule.register({
 *       warehouseStore: stores.inventoryWarehouseStore, // …PG 注入点，余类推
 *       serviceOptions: { defaultWarehouseId: 'wh-…' },
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import {
  InMemoryInventoryDomainEventStore,
  InMemoryInventoryOperationStore,
  InMemoryReleaseFactStore,
  InMemoryShippingOrderStore,
  InMemoryStockAccountStore,
  InMemoryStockLocationBalanceStore,
  InMemoryStockMovementStore,
  InMemoryStockReservationStore,
  InMemoryStocktakeStore,
  InMemoryWarehouseStore,
} from './in-memory-inventory-stores.js';
import type {
  InventoryDomainEventStore,
  InventoryOperationStore,
  ReleaseFactStore,
  ShippingOrderStore,
  StockAccountStore,
  StockLocationBalanceStore,
  StockMovementStore,
  StockReservationStore,
  StocktakeStore,
  WarehouseStore,
} from './inventory-stores.js';
import {
  InventoryQueriesController,
  ShippingOrdersController,
  StockMovementCommandsController,
  StocktakingController,
  WarehousesController,
} from './inventory.controllers.js';
import { InventoryService, type InventoryServiceOptions } from './inventory.service.js';

export const INVENTORY_WAREHOUSE_STORE = Symbol('smes.inventory.warehouseStore');
export const INVENTORY_ACCOUNT_STORE = Symbol('smes.inventory.accountStore');
export const INVENTORY_LOCATION_BALANCE_STORE = Symbol('smes.inventory.locationBalanceStore');
export const INVENTORY_MOVEMENT_STORE = Symbol('smes.inventory.movementStore');
export const INVENTORY_RESERVATION_STORE = Symbol('smes.inventory.reservationStore');
export const INVENTORY_STOCKTAKE_STORE = Symbol('smes.inventory.stocktakeStore');
export const INVENTORY_SHIPPING_STORE = Symbol('smes.inventory.shippingStore');
export const INVENTORY_RELEASE_FACT_STORE = Symbol('smes.inventory.releaseFactStore');
export const INVENTORY_OPERATION_STORE = Symbol('smes.inventory.operationStore');
export const INVENTORY_DOMAIN_EVENT_STORE = Symbol('smes.inventory.domainEventStore');
export const INVENTORY_MACHINE_EVENT_STORE = Symbol('smes.inventory.machineEventStore');
export const INVENTORY_SERVICE_OPTIONS = Symbol('smes.inventory.serviceOptions');

export interface InventoryModuleOptions {
  /** 仓库/库位主数据存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly warehouseStore?: WarehouseStore | undefined;
  /** 库存账存储；缺省 = 内存实现。 */
  readonly accountStore?: StockAccountStore | undefined;
  /** 库位余额存储；缺省 = 内存实现。 */
  readonly locationBalanceStore?: StockLocationBalanceStore | undefined;
  /** 出入库流水存储；缺省 = 内存实现。 */
  readonly movementStore?: StockMovementStore | undefined;
  /** 预占存储；缺省 = 内存实现。 */
  readonly reservationStore?: StockReservationStore | undefined;
  /** 盘点投影存储；缺省 = 内存实现。 */
  readonly stocktakeStore?: StocktakeStore | undefined;
  /** 发货任务投影存储；缺省 = 内存实现。 */
  readonly shippingStore?: ShippingOrderStore | undefined;
  /** 放行事实登记账存储；缺省 = 内存实现。 */
  readonly releaseFactStore?: ReleaseFactStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: InventoryOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: InventoryDomainEventStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** 服务选项（两份状态机配置/负库存策略/默认仓/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<InventoryServiceOptions> | undefined;
}

@Module({})
export class InventoryModule {
  static register(options: InventoryModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<InventoryServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: INVENTORY_WAREHOUSE_STORE, useValue: options.warehouseStore ?? new InMemoryWarehouseStore() },
      { provide: INVENTORY_ACCOUNT_STORE, useValue: options.accountStore ?? new InMemoryStockAccountStore() },
      {
        provide: INVENTORY_LOCATION_BALANCE_STORE,
        useValue: options.locationBalanceStore ?? new InMemoryStockLocationBalanceStore(),
      },
      { provide: INVENTORY_MOVEMENT_STORE, useValue: options.movementStore ?? new InMemoryStockMovementStore() },
      { provide: INVENTORY_RESERVATION_STORE, useValue: options.reservationStore ?? new InMemoryStockReservationStore() },
      { provide: INVENTORY_STOCKTAKE_STORE, useValue: options.stocktakeStore ?? new InMemoryStocktakeStore() },
      { provide: INVENTORY_SHIPPING_STORE, useValue: options.shippingStore ?? new InMemoryShippingOrderStore() },
      { provide: INVENTORY_RELEASE_FACT_STORE, useValue: options.releaseFactStore ?? new InMemoryReleaseFactStore() },
      {
        provide: INVENTORY_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryInventoryOperationStore(),
      },
      {
        provide: INVENTORY_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryInventoryDomainEventStore(),
      },
      {
        provide: INVENTORY_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: INVENTORY_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: InventoryService,
        useFactory: (
          warehouses: WarehouseStore,
          accounts: StockAccountStore,
          locationBalances: StockLocationBalanceStore,
          movements: StockMovementStore,
          reservations: StockReservationStore,
          stocktakes: StocktakeStore,
          shippings: ShippingOrderStore,
          releaseFacts: ReleaseFactStore,
          operations: InventoryOperationStore,
          domainEvents: InventoryDomainEventStore,
          machineEvents: ApprovalEventStore,
          serviceOpts: Partial<InventoryServiceOptions>,
        ) =>
          new InventoryService(
            warehouses,
            accounts,
            locationBalances,
            movements,
            reservations,
            stocktakes,
            shippings,
            releaseFacts,
            operations,
            domainEvents,
            machineEvents,
            serviceOpts,
          ),
        inject: [
          INVENTORY_WAREHOUSE_STORE,
          INVENTORY_ACCOUNT_STORE,
          INVENTORY_LOCATION_BALANCE_STORE,
          INVENTORY_MOVEMENT_STORE,
          INVENTORY_RESERVATION_STORE,
          INVENTORY_STOCKTAKE_STORE,
          INVENTORY_SHIPPING_STORE,
          INVENTORY_RELEASE_FACT_STORE,
          INVENTORY_OPERATION_STORE,
          INVENTORY_DOMAIN_EVENT_STORE,
          INVENTORY_MACHINE_EVENT_STORE,
          INVENTORY_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: InventoryModule,
      controllers: [
        WarehousesController,
        StockMovementCommandsController,
        StocktakingController,
        ShippingOrdersController,
        InventoryQueriesController,
      ],
      providers,
    };
  }
}
