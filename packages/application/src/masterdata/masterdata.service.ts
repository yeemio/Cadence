/**
 * MasterdataService —— 物品/资源主数据用例（M1 增量 4-I，core 基础层章程）。
 *
 * 零框架业务类（不 import @nestjs/*）：主数据存 ItemStore/ResourceStore 端口；
 * 权限门禁不在用例层（路由 @RequirePermission + AuthGuard 已收口），本类只做
 * 输入解析、端口委托与 404 翻译。列表全量返回（M1 非目标：不做分页/搜索）。
 */
import type { TenantId } from '@smes/business-core';
import { MasterdataNotFoundError } from './masterdata-errors.js';
import {
  parseCreateCustomerInput,
  parseCreateItemInput,
  parseCreateResourceInput,
  parseCreateSupplierInput,
  parseCreateUnitInput,
  parseIdParam,
  parsePriceLedgerPageQuery,
  parseUpdateCustomerInput,
  parseUpdateItemInput,
  parseUpdateResourceInput,
  parseUpdateSupplierInput,
  parseUpdateUnitInput,
} from './masterdata-input.js';
import type {
  CustomerMaster,
  CustomerStore,
  ItemMaster,
  ItemStore,
  ItemPriceLedgerStore,
  ItemPurchasePriceEntry,
  ResourceMaster,
  ResourceStore,
  SupplierMaster,
  SupplierStore,
  UnitMaster,
  UnitStore,
} from './masterdata-stores.js';
import {
  InMemoryCustomerStore,
  InMemoryItemPriceLedgerStore,
  InMemorySupplierStore,
  InMemoryUnitStore,
} from './in-memory-masterdata-stores.js';

/** 价格台账响应（RREQ-MD-019：单端点含物品摘要 + 初始价格 + 分页明细）。 */
export interface ItemPurchasePriceLedgerView {
  readonly itemId: string;
  readonly itemCode: string;
  readonly unit: string | null;
  /** 初始价格（分；RREQ-MD-020——台账弹窗同屏维护口径，null = 未维护）。 */
  readonly initialPriceMinor: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly entries: readonly ItemPurchasePriceEntry[];
}

export class MasterdataService {
  constructor(
    private readonly items: ItemStore,
    private readonly resources: ResourceStore,
    /** 客户/供应商/计量单位存储（S1 backfill：0920 #8/#9/#100；可选尾参兼容既有直接构造）。 */
    private readonly customers: CustomerStore = new InMemoryCustomerStore(),
    private readonly suppliers: SupplierStore = new InMemorySupplierStore(),
    private readonly units: UnitStore = new InMemoryUnitStore(),
    /**
     * 物品价格台账读面（fix-wave-6 6b-1 S9，RREQ-MD-019；可选尾参兼容既有
     * 直接构造——缺省内存实现恒空页，PG 形态由组合根注入 business-store
     * `./masterdata` 的只读实现）。
     */
    private readonly priceLedger: ItemPriceLedgerStore = new InMemoryItemPriceLedgerStore(),
  ) {}

  // ---- 物品 ----

  async createItem(tenant: TenantId, input: unknown): Promise<ItemMaster> {
    return this.items.create({ tenant, ...parseCreateItemInput(input) });
  }

  async listItems(tenant: TenantId): Promise<readonly ItemMaster[]> {
    return this.items.list(tenant);
  }

  async updateItem(tenant: TenantId, idParam: string, input: unknown): Promise<ItemMaster> {
    const id = parseIdParam(idParam, '物品');
    const updated = await this.items.update(tenant, id, parseUpdateItemInput(input));
    if (updated === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在物品 '${id}'`);
    }
    return updated;
  }

  /**
   * 物品价格台账（RREQ-MD-019）：按物品查历史采购成交价明细，分页。
   * 数据源 = 采购域订单明细（priceLedger 读面只读消费，listing 域禁碰）；
   * 单位取物品主数据计量单位（订单明细无单位列，源 §2.4 unitName 同为
   * 物料主数据单位）。与源两端点（§3.10 详情 + §3.11 分页）差异：合并为
   * 单端点（物品摘要/初始价格顺带返回，登记）。
   */
  async listItemPurchasePrices(
    tenant: TenantId,
    idParam: string,
    pageParam: string | null | undefined,
    pageSizeParam: string | null | undefined,
  ): Promise<ItemPurchasePriceLedgerView> {
    const id = parseIdParam(idParam, '物品');
    const item = await this.items.find(tenant, id);
    if (item === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在物品 '${id}'`);
    }
    const { page, pageSize } = parsePriceLedgerPageQuery(pageParam, pageSizeParam);
    const ledgerPage = await this.priceLedger.listByItem(tenant, id, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      itemId: item.id,
      itemCode: item.code,
      unit: item.unit,
      initialPriceMinor: item.initialPriceMinor,
      page,
      pageSize,
      total: ledgerPage.total,
      entries: ledgerPage.entries,
    };
  }

  // ---- 资源 ----

  async createResource(tenant: TenantId, input: unknown): Promise<ResourceMaster> {
    return this.resources.create({ tenant, ...parseCreateResourceInput(input) });
  }

  async listResources(tenant: TenantId): Promise<readonly ResourceMaster[]> {
    return this.resources.list(tenant);
  }

  async updateResource(tenant: TenantId, idParam: string, input: unknown): Promise<ResourceMaster> {
    const id = parseIdParam(idParam, '资源');
    const updated = await this.resources.update(tenant, id, parseUpdateResourceInput(input));
    if (updated === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在资源 '${id}'`);
    }
    return updated;
  }

  // ---- 客户（S1 backfill：0920 #8） ----

  async createCustomer(tenant: TenantId, input: unknown): Promise<CustomerMaster> {
    return this.customers.create({ tenant, ...parseCreateCustomerInput(input) });
  }

  async listCustomers(tenant: TenantId): Promise<readonly CustomerMaster[]> {
    return this.customers.list(tenant);
  }

  async updateCustomer(tenant: TenantId, idParam: string, input: unknown): Promise<CustomerMaster> {
    const id = parseIdParam(idParam, '客户');
    const updated = await this.customers.update(tenant, id, parseUpdateCustomerInput(input));
    if (updated === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在客户 '${id}'`);
    }
    return updated;
  }

  // ---- 供应商（S1 backfill：0920 #9） ----

  async createSupplier(tenant: TenantId, input: unknown): Promise<SupplierMaster> {
    return this.suppliers.create({ tenant, ...parseCreateSupplierInput(input) });
  }

  async listSuppliers(tenant: TenantId): Promise<readonly SupplierMaster[]> {
    return this.suppliers.list(tenant);
  }

  async updateSupplier(tenant: TenantId, idParam: string, input: unknown): Promise<SupplierMaster> {
    const id = parseIdParam(idParam, '供应商');
    const updated = await this.suppliers.update(tenant, id, parseUpdateSupplierInput(input));
    if (updated === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在供应商 '${id}'`);
    }
    return updated;
  }

  // ---- 计量单位（S1 backfill：0920 #100） ----

  async createUnit(tenant: TenantId, input: unknown): Promise<UnitMaster> {
    return this.units.create({ tenant, ...parseCreateUnitInput(input) });
  }

  async listUnits(tenant: TenantId): Promise<readonly UnitMaster[]> {
    return this.units.list(tenant);
  }

  async updateUnit(tenant: TenantId, idParam: string, input: unknown): Promise<UnitMaster> {
    const id = parseIdParam(idParam, '计量单位');
    const updated = await this.units.update(tenant, id, parseUpdateUnitInput(input));
    if (updated === null) {
      throw new MasterdataNotFoundError(`租户 '${tenant}' 内不存在计量单位 '${id}'`);
    }
    return updated;
  }
}
