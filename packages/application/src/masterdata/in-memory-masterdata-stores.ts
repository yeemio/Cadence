/**
 * InMemoryItemStore / InMemoryResourceStore —— 基础数据端口先行实现（M1 增量 4-I）。
 *
 * 重启即失；PG 实现在 business-store（`./masterdata` 子路径）。与
 * InMemoryUserStore 同一形态：无 DATABASE_URL / 未注入存储时组合根回落到
 * 这里，保证零 DB boot 语义完整（模块可装配、端点可用）。
 *
 * id 策略与 PG 行对齐：应用侧权威生成时间有序 id（uuid 包 v7 的简化内联——
 * 不引依赖，用 crypto.randomUUID 前缀 + 计数器即可满足内存形态的
 * 唯一性；真实持久化路径的 uuidv7 在 business-store）。
 */
import { randomUUID } from 'node:crypto';
import { TenantId } from '@smes/business-core';
import { MasterdataConflictError } from './masterdata-errors.js';
import type {
  CreateCustomerInput,
  CreateItemInput,
  CreateResourceInput,
  CreateSupplierInput,
  CreateUnitInput,
  CustomerMaster,
  CustomerStore,
  ItemMaster,
  ItemStore,
  ItemPriceLedgerStore,
  ItemPurchasePriceEntry,
  ItemPurchasePriceQuery,
  ResourceMaster,
  ResourceStore,
  SupplierMaster,
  SupplierStore,
  UnitMaster,
  UnitStore,
  UpdateCustomerInput,
  UpdateItemInput,
  UpdateResourceInput,
  UpdateSupplierInput,
  UpdateUnitInput,
} from './masterdata-stores.js';
import { buildItemPurchasePriceEntries } from './masterdata-stores.js';

let memoryCounter = 0;

/** 内存形态 id：非 uuid 也可（端口合同只要求租户内唯一、创建后稳定）。 */
function nextMemoryId(): string {
  memoryCounter += 1;
  return `md-${randomUUID()}-${memoryCounter.toString(36)}`;
}

interface ItemRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  spec: string | null;
  unit: string | null;
  category: string | null;
  active: boolean;
  initialPriceMinor: number | null;
}

export class InMemoryItemStore implements ItemStore {
  private readonly items = new Map<string, ItemRow>(); // key: `${tenant}|${id}`

  async create(input: CreateItemInput): Promise<ItemMaster> {
    const conflict = [...this.items.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MasterdataConflictError(
        `物品 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: ItemRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      spec: input.spec ?? null,
      unit: input.unit ?? null,
      category: input.category ?? null,
      active: input.active ?? true,
      initialPriceMinor: input.initialPriceMinor ?? null,
    };
    this.items.set(`${row.tenant}|${row.id}`, row);
    return toMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly ItemMaster[]> {
    return [...this.items.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ItemMaster | null> {
    const row = this.items.get(`${tenant}|${id}`);
    return row === undefined ? null : toMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateItemInput): Promise<ItemMaster | null> {
    const row = this.items.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.spec !== undefined) row.spec = input.spec;
    if (input.unit !== undefined) row.unit = input.unit;
    if (input.category !== undefined) row.category = input.category;
    if (input.active !== undefined) row.active = input.active;
    if (input.initialPriceMinor !== undefined) row.initialPriceMinor = input.initialPriceMinor;
    return toMaster(row);
  }
}

interface ResourceRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  type: string | null;
  active: boolean;
}

export class InMemoryResourceStore implements ResourceStore {
  private readonly resources = new Map<string, ResourceRow>(); // key: `${tenant}|${id}`

  async create(input: CreateResourceInput): Promise<ResourceMaster> {
    const conflict = [...this.resources.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MasterdataConflictError(
        `资源 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: ResourceRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      type: input.type ?? null,
      active: input.active ?? true,
    };
    this.resources.set(`${row.tenant}|${row.id}`, row);
    return toResourceMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly ResourceMaster[]> {
    return [...this.resources.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toResourceMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ResourceMaster | null> {
    const row = this.resources.get(`${tenant}|${id}`);
    return row === undefined ? null : toResourceMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateResourceInput,
  ): Promise<ResourceMaster | null> {
    const row = this.resources.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.type !== undefined) row.type = input.type;
    if (input.active !== undefined) row.active = input.active;
    return toResourceMaster(row);
  }
}

function toMaster(row: ItemRow): ItemMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    category: row.category,
    active: row.active,
    initialPriceMinor: row.initialPriceMinor,
  };
}

function toResourceMaster(row: ResourceRow): ResourceMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    type: row.type,
    active: row.active,
  };
}

// ---------------------------------------------------------------------------
// 客户/供应商/计量单位（S1 backfill：0920 #8/#9/#100）——同 InMemoryItemStore 形态。
// ---------------------------------------------------------------------------

interface CustomerRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  contact: string | null;
  active: boolean;
}

export class InMemoryCustomerStore implements CustomerStore {
  private readonly customers = new Map<string, CustomerRow>(); // key: `${tenant}|${id}`

  async create(input: CreateCustomerInput): Promise<CustomerMaster> {
    const conflict = [...this.customers.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MasterdataConflictError(
        `客户 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: CustomerRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      contact: input.contact ?? null,
      active: input.active ?? true,
    };
    this.customers.set(`${row.tenant}|${row.id}`, row);
    return toCustomerMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly CustomerMaster[]> {
    return [...this.customers.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toCustomerMaster);
  }

  async find(tenant: TenantId, id: string): Promise<CustomerMaster | null> {
    const row = this.customers.get(`${tenant}|${id}`);
    return row === undefined ? null : toCustomerMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateCustomerInput): Promise<CustomerMaster | null> {
    const row = this.customers.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.contact !== undefined) row.contact = input.contact;
    if (input.active !== undefined) row.active = input.active;
    return toCustomerMaster(row);
  }
}

interface SupplierRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  active: boolean;
}

export class InMemorySupplierStore implements SupplierStore {
  private readonly suppliers = new Map<string, SupplierRow>(); // key: `${tenant}|${id}`

  async create(input: CreateSupplierInput): Promise<SupplierMaster> {
    const conflict = [...this.suppliers.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MasterdataConflictError(
        `供应商 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: SupplierRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      active: input.active ?? true,
    };
    this.suppliers.set(`${row.tenant}|${row.id}`, row);
    return toSupplierMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly SupplierMaster[]> {
    return [...this.suppliers.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toSupplierMaster);
  }

  async find(tenant: TenantId, id: string): Promise<SupplierMaster | null> {
    const row = this.suppliers.get(`${tenant}|${id}`);
    return row === undefined ? null : toSupplierMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateSupplierInput): Promise<SupplierMaster | null> {
    const row = this.suppliers.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.active !== undefined) row.active = input.active;
    return toSupplierMaster(row);
  }
}

interface UnitRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  symbol: string | null;
}

export class InMemoryUnitStore implements UnitStore {
  private readonly units = new Map<string, UnitRow>(); // key: `${tenant}|${id}`

  async create(input: CreateUnitInput): Promise<UnitMaster> {
    const conflict = [...this.units.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MasterdataConflictError(
        `计量单位 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: UnitRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      symbol: input.symbol ?? null,
    };
    this.units.set(`${row.tenant}|${row.id}`, row);
    return toUnitMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly UnitMaster[]> {
    return [...this.units.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toUnitMaster);
  }

  async find(tenant: TenantId, id: string): Promise<UnitMaster | null> {
    const row = this.units.get(`${tenant}|${id}`);
    return row === undefined ? null : toUnitMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateUnitInput): Promise<UnitMaster | null> {
    const row = this.units.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.symbol !== undefined) row.symbol = input.symbol;
    return toUnitMaster(row);
  }
}

function toCustomerMaster(row: CustomerRow): CustomerMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    contact: row.contact,
    active: row.active,
  };
}

function toSupplierMaster(row: SupplierRow): SupplierMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    active: row.active,
  };
}

function toUnitMaster(row: UnitRow): UnitMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    symbol: row.symbol,
  };
}

// ---------------------------------------------------------------------------
// 物品价格台账内存实现（RREQ-MD-019，fix-wave-6 6b-1 S9）——零 DB boot 语义
// 完整（无采购数据时台账恒空页）。真实数据源在 PG 实现（business-store
// `./masterdata` 只读消费 listing 采购订单/事件表）；内存形态由测试/演示
// 直接喂台账行（构造注入，只读），排序/回落口径复用共享纯函数保证两实现
// 同合同。
// ---------------------------------------------------------------------------

/**
 * 内存台账喂行形状 = 端口行形状 + 归属（tenant, itemId）双键——与其它内存
// store 的租户收口同口径（显式 tenant 列过滤；台账行无独立 id，不用
 * `${tenant}|${id}` 键）。构造后只读——台账是只读投影，无写方法。
 */
export interface InMemoryPriceLedgerRow extends ItemPurchasePriceEntry {
  readonly tenant: TenantId;
  readonly itemId: string;
}

export class InMemoryItemPriceLedgerStore implements ItemPriceLedgerStore {
  private readonly rows: readonly InMemoryPriceLedgerRow[];

  constructor(rows: readonly InMemoryPriceLedgerRow[] = []) {
    this.rows = rows;
  }

  async listByItem(
    tenant: TenantId,
    itemId: string,
    query: ItemPurchasePriceQuery,
  ): Promise<{ total: number; entries: readonly ItemPurchasePriceEntry[] }> {
    const tenantRows = this.rows.filter(
      (row) => row.tenant === tenant && row.itemId === itemId,
    );
    // 排序口径与 PG 实现同一纯函数（端口合同：occurredAt 降序 → 单号降序 → 行号升序）
    const entries = buildItemPurchasePriceEntries(
      toLedgerOrderRows(tenantRows),
      approvedAtByRows(tenantRows),
      itemId,
    );
    return {
      total: entries.length,
      entries: entries.slice(query.offset, query.offset + query.limit),
    };
  }
}

/** 内存台账行 → 物化纯函数的订单形状（按订单聚合行集）。 */
function toLedgerOrderRows(
  rows: readonly InMemoryPriceLedgerRow[],
): Parameters<typeof buildItemPurchasePriceEntries>[0] {
  const byOrder = new Map<
    string,
    {
      id: string;
      supplierRef: string | null;
      supplierName: string | null;
      state: string;
      createdAt: string;
      lines: { lineNo: number; itemId: string; quantity: number; unitPriceMinor: number | null }[];
    }
  >();
  for (const row of rows) {
    let order = byOrder.get(row.purchaseOrderId);
    if (order === undefined) {
      order = {
        id: row.purchaseOrderId,
        supplierRef: row.supplierRef,
        supplierName: row.supplierName,
        state: row.orderState,
        createdAt: row.orderedAt,
        lines: [],
      };
      byOrder.set(row.purchaseOrderId, order);
    }
    order.lines.push({
      lineNo: row.lineNo,
      itemId: row.itemId,
      quantity: row.quantity,
      unitPriceMinor: row.unitPriceMinor,
    });
  }
  return [...byOrder.values()];
}

/** 内存台账行 → 每单审核时间 Map（物化纯函数入参形状）。 */
function approvedAtByRows(rows: readonly InMemoryPriceLedgerRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.approvedAt !== null) map.set(row.purchaseOrderId, row.approvedAt);
  }
  return map;
}
