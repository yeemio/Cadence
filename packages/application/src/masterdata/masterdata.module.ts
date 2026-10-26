/**
 * MasterdataModule —— 物品/资源/客户/供应商/计量单位主数据模块
 * （M1 增量 4-I + S1 backfill：0920 #8/#9/#100，core 基础层章程）。
 *
 * ADR-0004 定位：基础数据属必装基础层，以独立可启停模块形态落进注册表
 * （MODULE_DEFINITIONS.masterdata，默认装配）。存储端口注入点与
 * OrgModule 同一模式：组合根注入 PG 实现（business-store `./masterdata`），
 * 缺省回落内存实现（零 DB boot 语义完整）。TenantContext 由 CoreModule
 * （global）导出注入。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  InMemoryCustomerStore,
  InMemoryItemPriceLedgerStore,
  InMemoryItemStore,
  InMemoryResourceStore,
  InMemorySupplierStore,
  InMemoryUnitStore,
} from './in-memory-masterdata-stores.js';
import {
  MasterdataCustomersController,
  MasterdataItemsController,
  MasterdataResourcesController,
  MasterdataSuppliersController,
  MasterdataUnitsController,
} from './masterdata.controllers.js';
import { MasterdataService } from './masterdata.service.js';
import type {
  CustomerStore,
  ItemPriceLedgerStore,
  ItemStore,
  ResourceStore,
  SupplierStore,
  UnitStore,
} from './masterdata-stores.js';

export const MASTERDATA_ITEM_STORE = Symbol('smes.masterdata.itemStore');
export const MASTERDATA_RESOURCE_STORE = Symbol('smes.masterdata.resourceStore');
export const MASTERDATA_CUSTOMER_STORE = Symbol('smes.masterdata.customerStore');
export const MASTERDATA_SUPPLIER_STORE = Symbol('smes.masterdata.supplierStore');
export const MASTERDATA_UNIT_STORE = Symbol('smes.masterdata.unitStore');
export const MASTERDATA_ITEM_PRICE_LEDGER_STORE = Symbol('smes.masterdata.itemPriceLedgerStore');

export interface MasterdataModuleOptions {
  /** 物品主数据存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly itemStore?: ItemStore | undefined;
  /** 资源主数据存储；缺省 = 内存实现。显式 undefined 同缺省。 */
  readonly resourceStore?: ResourceStore | undefined;
  /** 客户主数据存储（S1 backfill）；缺省 = 内存实现。 */
  readonly customerStore?: CustomerStore | undefined;
  /** 供应商主数据存储（S1 backfill）；缺省 = 内存实现。 */
  readonly supplierStore?: SupplierStore | undefined;
  /** 计量单位存储（S1 backfill）；缺省 = 内存实现。 */
  readonly unitStore?: UnitStore | undefined;
  /**
   * 物品价格台账读面（fix-wave-6 6b-1 S9，RREQ-MD-019）；缺省 = 内存实现
   * （恒空页）。PG 形态（business-store `./masterdata` 只读消费 listing 采购
   * 表）由组合根注入。
   */
  readonly itemPriceLedgerStore?: ItemPriceLedgerStore | undefined;
}

@Module({})
export class MasterdataModule {
  static register(options: MasterdataModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: MASTERDATA_ITEM_STORE, useValue: options.itemStore ?? new InMemoryItemStore() },
      {
        provide: MASTERDATA_RESOURCE_STORE,
        useValue: options.resourceStore ?? new InMemoryResourceStore(),
      },
      {
        provide: MASTERDATA_CUSTOMER_STORE,
        useValue: options.customerStore ?? new InMemoryCustomerStore(),
      },
      {
        provide: MASTERDATA_SUPPLIER_STORE,
        useValue: options.supplierStore ?? new InMemorySupplierStore(),
      },
      { provide: MASTERDATA_UNIT_STORE, useValue: options.unitStore ?? new InMemoryUnitStore() },
      {
        provide: MASTERDATA_ITEM_PRICE_LEDGER_STORE,
        useValue: options.itemPriceLedgerStore ?? new InMemoryItemPriceLedgerStore(),
      },
      {
        provide: MasterdataService,
        useFactory: (
          items: ItemStore,
          resources: ResourceStore,
          customers: CustomerStore,
          suppliers: SupplierStore,
          units: UnitStore,
          priceLedger: ItemPriceLedgerStore,
        ) => new MasterdataService(items, resources, customers, suppliers, units, priceLedger),
        inject: [
          MASTERDATA_ITEM_STORE,
          MASTERDATA_RESOURCE_STORE,
          MASTERDATA_CUSTOMER_STORE,
          MASTERDATA_SUPPLIER_STORE,
          MASTERDATA_UNIT_STORE,
          MASTERDATA_ITEM_PRICE_LEDGER_STORE,
        ],
      },
    ];

    return {
      module: MasterdataModule,
      controllers: [
        MasterdataItemsController,
        MasterdataResourcesController,
        MasterdataCustomersController,
        MasterdataSuppliersController,
        MasterdataUnitsController,
      ],
      providers,
    };
  }
}
