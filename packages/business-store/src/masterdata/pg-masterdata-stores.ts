/**
 * ItemStore / ResourceStore 的 PG 实现 + 组合根装配工厂
 * （M1 增量 4-I，经本包 `./masterdata` 子路径导出——与 `./org` 同模式：
 * 主入口保持零 @prisma/client 依赖，纯数据面测试不触碰 Prisma）。
 *
 * 启动零 DB 依赖：connectMasterdataStore 只构造 PrismaClient（惰性连接——
 * 构造不握手、bootstrap 阶段零查询），首条查询才真正连库；无 DATABASE_URL
 * 时组合根不调用本工厂（回落 application 内存实现）。
 *
 * 主数据表取舍：配置数据非业务事实——普通 CRUD（不套证据公共列、
 * 不套 append-only 触发器，见 prisma/schema.prisma 分节注释）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId } from '@smes/business-core';
import {
  MasterdataConflictError,
  buildItemPurchasePriceEntries,
  type CreateCustomerInput,
  type CreateItemInput,
  type CreateResourceInput,
  type CreateSupplierInput,
  type CreateUnitInput,
  type CustomerMaster,
  type CustomerStore,
  type ItemMaster,
  type ItemPriceLedgerStore,
  type ItemPurchasePricePage,
  type ItemPurchasePriceQuery,
  type ItemStore,
  type PriceLedgerOrderRow,
  type ResourceMaster,
  type ResourceStore,
  type SupplierMaster,
  type SupplierStore,
  type UnitMaster,
  type UnitStore,
  type UpdateCustomerInput,
  type UpdateItemInput,
  type UpdateResourceInput,
  type UpdateSupplierInput,
  type UpdateUnitInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

/** 唯一键冲突（P2002）-> 域冲突错误；其余原样上抛（不吞连接错误）。 */
function toConflict(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new MasterdataConflictError(message);
  }
  return error;
}

interface ItemDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unit: string | null;
  readonly category: string | null;
  readonly active: boolean;
  readonly initialPriceMinor: number | null;
}

function toItemMaster(row: ItemDbRow): ItemMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    category: row.category,
    active: row.active,
    initialPriceMinor: row.initialPriceMinor,
  };
}

export class PgItemStore implements ItemStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateItemInput): Promise<ItemMaster> {
    try {
      const row = await this.prisma.itemRecord.create({
        data: {
          id: uuidv7(), // 应用侧权威生成（本包 id 策略）
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          spec: input.spec ?? null,
          unit: input.unit ?? null,
          category: input.category ?? null,
          active: input.active ?? true,
          initialPriceMinor: input.initialPriceMinor ?? null,
        },
      });
      return toItemMaster(row);
    } catch (error) {
      throw toConflict(
        error,
        `物品 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly ItemMaster[]> {
    const rows = await this.prisma.itemRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toItemMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ItemMaster | null> {
    const row = await this.prisma.itemRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toItemMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateItemInput): Promise<ItemMaster | null> {
    try {
      const row = await this.prisma.itemRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.spec !== undefined ? { spec: input.spec } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.initialPriceMinor !== undefined
            ? { initialPriceMinor: input.initialPriceMinor }
            : {}),
        },
      });
      return toItemMaster(row);
    } catch (error) {
      // update 按 (id, tenantId) 复合 where（@@unique 无此键时 P2025 = 行不存在）→ null
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

interface ResourceDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: string | null;
  readonly active: boolean;
}

function toResourceMaster(row: ResourceDbRow): ResourceMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    type: row.type,
    active: row.active,
  };
}

export class PgResourceStore implements ResourceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateResourceInput): Promise<ResourceMaster> {
    try {
      const row = await this.prisma.resourceRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          type: input.type ?? null,
          active: input.active ?? true,
        },
      });
      return toResourceMaster(row);
    } catch (error) {
      throw toConflict(
        error,
        `资源 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
  }

  async list(tenant: TenantId): Promise<readonly ResourceMaster[]> {
    const rows = await this.prisma.resourceRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toResourceMaster);
  }

  async find(tenant: TenantId, id: string): Promise<ResourceMaster | null> {
    const row = await this.prisma.resourceRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toResourceMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateResourceInput,
  ): Promise<ResourceMaster | null> {
    try {
      const row = await this.prisma.resourceRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toResourceMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

export interface MasterdataStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：五端口实现（物品/资源 + S1 客户/供应商/计量单位）+ 价格台账只读读面 + 优雅断连。 */
export interface MasterdataStoreHandle {
  readonly itemStore: ItemStore;
  readonly resourceStore: ResourceStore;
  /** 客户主数据存储（S1 backfill：0920 #8）。 */
  readonly customerStore: CustomerStore;
  /** 供应商主数据存储（S1 backfill：0920 #9）。 */
  readonly supplierStore: SupplierStore;
  /** 计量单位字典存储（S1 backfill：0920 #100）。 */
  readonly unitStore: UnitStore;
  /** 物品价格台账读面（fix-wave-6 6b-1 S9，RREQ-MD-019；只读消费 listing 采购表）。 */
  readonly itemPriceLedgerStore: ItemPriceLedgerStore;
  disconnect(): Promise<void>;
}

/** 构造基础数据 PG 存储装配（惰性连接：见文件头）。 */
export function connectMasterdataStore(
  options: MasterdataStoreOptions = {},
): MasterdataStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    itemStore: new PgItemStore(client),
    resourceStore: new PgResourceStore(client),
    customerStore: new PgCustomerStore(client),
    supplierStore: new PgSupplierStore(client),
    unitStore: new PgUnitStore(client),
    itemPriceLedgerStore: new PgItemPriceLedgerStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// 客户/供应商/计量单位 PG 实现（S1 backfill：0920 #8/#9/#100）——与
// PgItemStore 同形态（P2002 → 冲突；update 扩展唯一 where + P2025 → null）。
// ---------------------------------------------------------------------------

interface CustomerDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly contact: string | null;
  readonly active: boolean;
}

function toCustomerMaster(row: CustomerDbRow): CustomerMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    contact: row.contact,
    active: row.active,
  };
}

export class PgCustomerStore implements CustomerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateCustomerInput): Promise<CustomerMaster> {
    try {
      const row = await this.prisma.customerRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          contact: input.contact ?? null,
          active: input.active ?? true,
        },
      });
      return toCustomerMaster(row);
    } catch (error) {
      throw toConflict(error, `客户 code '${input.code}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly CustomerMaster[]> {
    const rows = await this.prisma.customerRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toCustomerMaster);
  }

  async find(tenant: TenantId, id: string): Promise<CustomerMaster | null> {
    const row = await this.prisma.customerRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toCustomerMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerMaster | null> {
    try {
      const row = await this.prisma.customerRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.contact !== undefined ? { contact: input.contact } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toCustomerMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

interface SupplierDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
}

function toSupplierMaster(row: SupplierDbRow): SupplierMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    active: row.active,
  };
}

export class PgSupplierStore implements SupplierStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSupplierInput): Promise<SupplierMaster> {
    try {
      const row = await this.prisma.supplierRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          active: input.active ?? true,
        },
      });
      return toSupplierMaster(row);
    } catch (error) {
      throw toConflict(error, `供应商 code '${input.code}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly SupplierMaster[]> {
    const rows = await this.prisma.supplierRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toSupplierMaster);
  }

  async find(tenant: TenantId, id: string): Promise<SupplierMaster | null> {
    const row = await this.prisma.supplierRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toSupplierMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateSupplierInput,
  ): Promise<SupplierMaster | null> {
    try {
      const row = await this.prisma.supplierRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      return toSupplierMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

interface UnitDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly symbol: string | null;
}

function toUnitMaster(row: UnitDbRow): UnitMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    symbol: row.symbol,
  };
}

export class PgUnitStore implements UnitStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateUnitInput): Promise<UnitMaster> {
    try {
      const row = await this.prisma.unitRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          code: input.code,
          name: input.name,
          symbol: input.symbol ?? null,
        },
      });
      return toUnitMaster(row);
    } catch (error) {
      throw toConflict(error, `计量单位 code '${input.code}' 在租户 '${input.tenant}' 内已存在`);
    }
  }

  async list(tenant: TenantId): Promise<readonly UnitMaster[]> {
    const rows = await this.prisma.unitRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map(toUnitMaster);
  }

  async find(tenant: TenantId, id: string): Promise<UnitMaster | null> {
    const row = await this.prisma.unitRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : toUnitMaster(row);
  }

  async update(tenant: TenantId, id: string, input: UpdateUnitInput): Promise<UnitMaster | null> {
    try {
      const row = await this.prisma.unitRecord.update({
        where: { id, tenantId: tenant },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
        },
      });
      return toUnitMaster(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// 物品价格台账 PG 只读实现（RREQ-MD-019，fix-wave-6 6b-1 S9）。
//
// 数据源 = 采购域两张表**只读消费**（listing 域代码禁碰——本实现不改 listing
// 任何端口/表/迁移，只 SELECT；跨域只读先例 = standardreports r8 事实源直读
// purchase_orders 行级）：
//   - purchase_orders（租户内全量订单，lines JSONB 行级展开过滤 itemId）；
//   - listing_events（订单状态机 transitioned 事件，payload.to='approved' 的
//     occurredAt = 审核时间；path 过滤谓词下推，Prisma Json filter）。
// 取行取舍（同 metric-pack v1 / r8）：谓词/排序/分页在应用侧物化——不大规模
// 下推 SQL（中小单租户订单量口径；对账阶段校准）。排序/回落/行形状复用
// @smes/application 的 buildItemPurchasePriceEntries 共享纯函数（内存实现
// 同一合同单点）。RLS：模型操作经 withRlsTenantSession 钩子自动 SET——
// 零 raw SQL，租户谓词兜底（tenantId where）双保险。
// ---------------------------------------------------------------------------

/** 机器事件 payload.to='approved' 的 Prisma Json path 过滤（谓词下推形态）。 */
const APPROVED_EVENT_PAYLOAD_FILTER = { path: ['to'], equals: 'approved' } as const;

export class PgItemPriceLedgerStore implements ItemPriceLedgerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listByItem(
    tenant: TenantId,
    itemId: string,
    query: ItemPurchasePriceQuery,
  ): Promise<ItemPurchasePricePage> {
    const orders = await this.prisma.purchaseOrderRecord.findMany({
      where: { tenantId: tenant },
      select: {
        id: true,
        supplierRef: true,
        supplierName: true,
        state: true,
        lines: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const events = await this.prisma.listingEventRecord.findMany({
      where: {
        tenantId: tenant,
        aggregateType: 'purchase-order',
        payload: APPROVED_EVENT_PAYLOAD_FILTER,
      },
      select: { aggregateId: true, occurredAt: true },
      orderBy: { seq: 'asc' },
    });
    // 每单审核时间 = 其 to='approved' 迁移的 occurredAt（seq 升序遍历，
    // 同单多条时取最后一条——状态机不可逆下理论仅一条，防御性取末值）。
    const approvedAtByOrder = new Map<string, string>();
    for (const event of events) {
      approvedAtByOrder.set(event.aggregateId, event.occurredAt.toISOString());
    }
    const rows: PriceLedgerOrderRow[] = orders.map((order) => ({
      id: order.id,
      supplierRef: order.supplierRef,
      supplierName: order.supplierName,
      state: order.state,
      createdAt: order.createdAt.toISOString(),
      lines: order.lines,
    }));
    const entries = buildItemPurchasePriceEntries(rows, approvedAtByOrder, itemId);
    return {
      total: entries.length,
      entries: entries.slice(query.offset, query.offset + query.limit),
    };
  }
}
