/**
 * inventory 存储端口的内存先行实现（M2-W5）。
 *
 * 重启即失；PG 实现在 business-store（`./inventory` 子路径，总控合流接线）。
 * 与 in-memory-listing-stores 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读操作按租户收口；adjust/advance/
 * record 带守卫或乐观版本检查（与 PG 实现同一合同）。机器事件账本不复刻——
 * 直接用 engine-flow 的 createInMemoryApprovalEventStore（见 inventory.module.ts）。
 */
import {
  TenantId,
  UserId,
  type BusinessEvent,
  type EventId,
  type OutboxRecord,
} from '@smes/business-core';
import type { ReservationStatus } from './inventory-config.js';
import { InventoryConflictError } from './inventory-errors.js';
import type {
  AppendReleaseFactInput,
  AppendStockMovementInput,
  CreateShippingOrderInput,
  CreateStockReservationInput,
  CreateStocktakeInput,
  DefineWarehouseInput,
  InventoryDomainEventStore,
  InventoryOperationRecord,
  InventoryOperationStore,
  ListLocationBalancesFilter,
  ListStockAccountsFilter,
  ListStockMovementsFilter,
  ReleaseFact,
  ReleaseFactStore,
  ShippingLine,
  ShippingOrder,
  ShippingOrderStore,
  StockAccount,
  StockAccountStore,
  StockLocationBalance,
  StockLocationBalanceStore,
  StockMovement,
  StockMovementAppendReceipt,
  StockMovementStore,
  StockReservation,
  StockReservationCreateReceipt,
  StockReservationStore,
  Stocktake,
  StocktakeLine,
  StocktakeStore,
  Warehouse,
  WarehouseLocation,
  WarehouseStore,
} from './inventory-stores.js';
import {
  RELEASE_FACT_AUDIT_STATUS,
  STOCK_MOVEMENT_AUDIT_STATUS,
} from './inventory-stores.js';

// ---- 仓库与库位（主数据） ----

interface WarehouseRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  readonly defaultLocationId: string;
  readonly locations: { readonly id: string; readonly code: string; readonly name: string | null; readonly createdAt: string }[];
  readonly createdAt: string;
  updatedAt: string;
}

function toWarehouse(row: WarehouseRow): Warehouse {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    defaultLocationId: row.defaultLocationId,
    locations: [...row.locations]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((location) => ({
        id: location.id,
        tenant: TenantId.create(row.tenant),
        warehouseId: row.id,
        code: location.code,
        name: location.name,
        createdAt: location.createdAt,
      })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryWarehouseStore implements WarehouseStore {
  private readonly rows = new Map<string, WarehouseRow>(); // key: `${tenant}|${id}`

  async create(input: DefineWarehouseInput): Promise<Warehouse> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new InventoryConflictError(`仓库 '${input.id}' 已存在`);
    }
    const duplicate = [...this.rows.values()].some(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (duplicate) {
      throw new InventoryConflictError(`仓库编码 '${input.code}' 已存在（(tenant, code) 唯一）`);
    }
    const now = new Date().toISOString();
    const row: WarehouseRow = {
      tenant: input.tenant,
      id: input.id,
      code: input.code,
      name: input.name,
      defaultLocationId: input.defaultLocationId,
      locations: input.locations.map((location) => ({
        id: location.id,
        code: location.code,
        name: location.name,
        createdAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toWarehouse(row);
  }

  async find(tenant: TenantId, id: string): Promise<Warehouse | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toWarehouse(row);
  }

  async findByCode(tenant: TenantId, code: string): Promise<Warehouse | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.tenant === tenant && candidate.code === code,
    );
    return row === undefined ? null : toWarehouse(row);
  }

  async list(tenant: TenantId): Promise<readonly Warehouse[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toWarehouse);
  }

  async findLocation(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
  ): Promise<WarehouseLocation | null> {
    const warehouse = await this.find(tenant, warehouseId);
    return warehouse?.locations.find((location) => location.id === locationId) ?? null;
  }
}

// ---- 库存账（恒等式两输入：现存量 + 预占） ----

interface StockAccountRow {
  readonly tenant: string;
  readonly itemId: string;
  readonly warehouseId: string;
  qtyOnHand: number;
  qtyReserved: number;
  readonly createdAt: string;
  updatedAt: string;
}

function toAccount(row: StockAccountRow, id: string): StockAccount {
  return {
    id,
    tenant: TenantId.create(row.tenant),
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    qtyOnHand: row.qtyOnHand,
    qtyReserved: row.qtyReserved,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 内存实现的账户 id：按 (tenant, item, warehouse) 复合键索引（id 不进词汇面）。 */
function accountKey(tenant: string, itemId: string, warehouseId: string): string {
  return `${tenant}|${itemId}|${warehouseId}`;
}

export class InMemoryStockAccountStore implements StockAccountStore {
  /** 复合键 → 行；ids 平行表产 sa-id（对账读面用）。 */
  private readonly rows = new Map<string, StockAccountRow>();
  private readonly ids = new Map<string, string>(); // 复合键 → sa-<uuidv7>

  async find(tenant: TenantId, itemId: string, warehouseId: string): Promise<StockAccount | null> {
    const key = accountKey(tenant, itemId, warehouseId);
    const row = this.rows.get(key);
    return row === undefined ? null : toAccount(row, this.ids.get(key) ?? '');
  }

  async adjust(
    tenant: TenantId,
    itemId: string,
    warehouseId: string,
    onHandDelta: number,
    reservedDelta: number,
    guard?: { readonly allowNegativeHand?: boolean },
  ): Promise<StockAccount> {
    const key = accountKey(tenant, itemId, warehouseId);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      const next = onHandDelta;
      if (next < 0 && guard?.allowNegativeHand !== true) {
        throw new InventoryConflictError(
          `库存账新建守卫拒绝：物料 '${itemId}' @仓库 '${warehouseId}' 账面将为 ${next}（负库存策略硬拒绝）`,
        );
      }
      const now = new Date().toISOString();
      const id = `sa-${crypto.randomUUID()}`;
      this.ids.set(key, id);
      const row: StockAccountRow = {
        tenant,
        itemId,
        warehouseId,
        qtyOnHand: next,
        qtyReserved: reservedDelta,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(key, row);
      return toAccount(row, id);
    }
    const nextHand = existing.qtyOnHand + onHandDelta;
    if (nextHand < 0 && guard?.allowNegativeHand !== true) {
      throw new InventoryConflictError(
        `库存账守卫拒绝：物料 '${itemId}' @仓库 '${warehouseId}' 账面将为 ${nextHand}（负库存策略硬拒绝）`,
      );
    }
    existing.qtyOnHand = nextHand;
    existing.qtyReserved += reservedDelta;
    existing.updatedAt = new Date().toISOString();
    return toAccount(existing, this.ids.get(key) ?? '');
  }

  async list(tenant: TenantId, filter?: ListStockAccountsFilter): Promise<readonly StockAccount[]> {
    return [...this.rows.entries()]
      .filter(([key, row]) => {
        if (row.tenant !== tenant) return false;
        if (filter?.warehouseId !== undefined && row.warehouseId !== filter.warehouseId) return false;
        if (filter?.itemId !== undefined && row.itemId !== filter.itemId) return false;
        return key.length >= 0;
      })
      .map(([key, row]) => toAccount(row, this.ids.get(key) ?? ''))
      .sort((a, b) => a.itemId.localeCompare(b.itemId) || a.warehouseId.localeCompare(b.warehouseId));
  }
}

// ---- 库位余额（库位分布投影） ----

interface LocationBalanceRow {
  readonly tenant: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly itemId: string;
  qty: number;
  readonly createdAt: string;
  updatedAt: string;
}

function toBalance(row: LocationBalanceRow, id: string): StockLocationBalance {
  return {
    id,
    tenant: TenantId.create(row.tenant),
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    itemId: row.itemId,
    qty: row.qty,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function balanceKey(tenant: string, warehouseId: string, locationId: string, itemId: string): string {
  return `${tenant}|${warehouseId}|${locationId}|${itemId}`;
}

export class InMemoryStockLocationBalanceStore implements StockLocationBalanceStore {
  private readonly rows = new Map<string, LocationBalanceRow>();
  private readonly ids = new Map<string, string>();

  async find(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
  ): Promise<StockLocationBalance | null> {
    const key = balanceKey(tenant, warehouseId, locationId, itemId);
    const row = this.rows.get(key);
    return row === undefined ? null : toBalance(row, this.ids.get(key) ?? '');
  }

  async adjust(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
    delta: number,
    guard?: { readonly allowNegativeHand?: boolean },
  ): Promise<StockLocationBalance> {
    const key = balanceKey(tenant, warehouseId, locationId, itemId);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      if (delta < 0 && guard?.allowNegativeHand !== true) {
        throw new InventoryConflictError(
          `库位余额新建守卫拒绝：物料 '${itemId}' @库位 '${locationId}' 将为 ${delta}`,
        );
      }
      const now = new Date().toISOString();
      const id = `lb-${crypto.randomUUID()}`;
      this.ids.set(key, id);
      const row: LocationBalanceRow = {
        tenant,
        warehouseId,
        locationId,
        itemId,
        qty: delta,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(key, row);
      return toBalance(row, id);
    }
    const next = existing.qty + delta;
    if (next < 0 && guard?.allowNegativeHand !== true) {
      throw new InventoryConflictError(
        `库位余额守卫拒绝：物料 '${itemId}' @库位 '${locationId}' 将为 ${next}`,
      );
    }
    existing.qty = next;
    existing.updatedAt = new Date().toISOString();
    return toBalance(existing, this.ids.get(key) ?? '');
  }

  async list(tenant: TenantId, filter?: ListLocationBalancesFilter): Promise<readonly StockLocationBalance[]> {
    return [...this.rows.entries()]
      .filter(
        ([, row]) =>
          row.tenant === tenant &&
          (filter?.warehouseId === undefined || row.warehouseId === filter.warehouseId) &&
          (filter?.itemId === undefined || row.itemId === filter.itemId),
      )
      .map(([key, row]) => toBalance(row, this.ids.get(key) ?? ''))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
  }
}

// ---- 出入库流水（append-only 事实 + sourceKey 幂等） ----

export class InMemoryStockMovementStore implements StockMovementStore {
  private readonly rows = new Map<string, StockMovement>(); // key: `${tenant}|${id}`
  private readonly sourceKeys = new Map<string, string>(); // `${tenant}|${sourceKey}` -> movement id

  async append(input: AppendStockMovementInput): Promise<StockMovementAppendReceipt> {
    if (input.sourceKey !== null) {
      const existingId = this.sourceKeys.get(`${input.tenant}|${input.sourceKey}`);
      if (existingId !== undefined) {
        const existing = this.rows.get(`${input.tenant}|${existingId}`);
        if (existing !== undefined) return { movement: existing, duplicate: true };
      }
    }
    const seq = this.rows.size + 1;
    const movement: StockMovement = {
      id: input.id,
      tenant: input.tenant,
      seq,
      kind: input.kind,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      quantity: input.quantity,
      sourceRefType: input.sourceRefType,
      sourceRefId: input.sourceRefId,
      sourceKey: input.sourceKey,
      transferId: input.transferId,
      workOrderId: input.workOrderId,
      remark: input.remark,
      occurredAt: input.occurredAt,
      recordedBy: input.recordedBy,
      objectVersion: 1,
      auditStatus: STOCK_MOVEMENT_AUDIT_STATUS,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    };
    this.rows.set(`${input.tenant}|${input.id}`, movement);
    if (input.sourceKey !== null) {
      this.sourceKeys.set(`${input.tenant}|${input.sourceKey}`, input.id);
    }
    return { movement, duplicate: false };
  }

  async find(tenant: TenantId, id: string): Promise<StockMovement | null> {
    return this.rows.get(`${tenant}|${id}`) ?? null;
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<StockMovement | null> {
    const id = this.sourceKeys.get(`${tenant}|${sourceKey}`);
    return id === undefined ? null : (this.rows.get(`${tenant}|${id}`) ?? null);
  }

  async list(tenant: TenantId, filter?: ListStockMovementsFilter): Promise<readonly StockMovement[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.itemId === undefined || row.itemId === filter.itemId) &&
          (filter?.warehouseId === undefined || row.warehouseId === filter.warehouseId) &&
          (filter?.kind === undefined || row.kind === filter.kind) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId) &&
          (filter?.sourceRefId === undefined || row.sourceRefId === filter.sourceRefId),
      )
      .sort((a, b) => a.seq - b.seq);
  }
}

// ---- 预占（reserve/release 投影账） ----

/** 可变行（映射到只读 StockReservation；演进只经 store 方法）。 */
interface ReservationRow {
  readonly tenant: string;
  readonly id: string;
  readonly reservationKey: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: number;
  remaining: number;
  status: ReservationStatus;
  readonly refType: string;
  readonly refId: string;
  readonly createdAt: string;
  updatedAt: string;
}

function toReservation(row: ReservationRow): StockReservation {
  return { ...row, tenant: TenantId.create(row.tenant) };
}

export class InMemoryStockReservationStore implements StockReservationStore {
  private readonly rows = new Map<string, ReservationRow>(); // key: `${tenant}|${reservationKey}`

  async create(input: CreateStockReservationInput): Promise<StockReservationCreateReceipt> {
    const key = `${input.tenant}|${input.reservationKey}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      if (existing.status === 'active') {
        return { reservation: toReservation(existing), duplicate: true };
      }
      throw new InventoryConflictError(
        `预占键 '${input.reservationKey}' 已 ${existing.status}（consumed/released 的键不得复用）`,
      );
    }
    const now = new Date().toISOString();
    const row: ReservationRow = {
      tenant: input.tenant,
      id: input.id,
      reservationKey: input.reservationKey,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      remaining: input.quantity,
      status: 'active',
      refType: input.refType,
      refId: input.refId,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return { reservation: toReservation(row), duplicate: false };
  }

  async findByKey(tenant: TenantId, reservationKey: string): Promise<StockReservation | null> {
    const row = this.rows.get(`${tenant}|${reservationKey}`);
    return row === undefined ? null : toReservation(row);
  }

  async list(
    tenant: TenantId,
    filter?: { readonly status?: ReservationStatus },
  ): Promise<readonly StockReservation[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.status === undefined || row.status === filter.status),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toReservation);
  }

  async consume(tenant: TenantId, reservationKey: string, quantity: number): Promise<StockReservation | null> {
    const row = this.rows.get(`${tenant}|${reservationKey}`);
    if (row === undefined || row.status !== 'active' || row.remaining < quantity) return null;
    row.remaining -= quantity;
    if (row.remaining === 0) row.status = 'consumed';
    row.updatedAt = new Date().toISOString();
    return toReservation(row);
  }

  async releaseBy(
    tenant: TenantId,
    reservationKey: string,
    quantity: number | null,
  ): Promise<StockReservation | null> {
    const row = this.rows.get(`${tenant}|${reservationKey}`);
    if (row === undefined || row.status !== 'active') return null;
    const releaseQty = quantity === null ? row.remaining : quantity;
    if (releaseQty > row.remaining) return null;
    row.remaining -= releaseQty;
    if (row.remaining === 0) row.status = 'released';
    row.updatedAt = new Date().toISOString();
    return toReservation(row);
  }
}

// ---- 盘点（投影 + 行载荷；乐观 advance + updateLines 条件写） ----

interface StocktakeRow {
  readonly tenant: string;
  readonly id: string;
  readonly warehouseId: string;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  lines: readonly StocktakeLine[];
  readonly openedBy: string;
  approvedBy: string | null;
  remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toStocktake(row: StocktakeRow): Stocktake {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    warehouseId: row.warehouseId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines,
    openedBy: UserId.create(row.openedBy),
    approvedBy: row.approvedBy === null ? null : UserId.create(row.approvedBy),
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryStocktakeStore implements StocktakeStore {
  private readonly rows = new Map<string, StocktakeRow>(); // key: `${tenant}|${id}`

  async create(input: CreateStocktakeInput): Promise<Stocktake> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new InventoryConflictError(`盘点单 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: StocktakeRow = {
      tenant: input.tenant,
      id: input.id,
      warehouseId: input.warehouseId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      lines: input.lines,
      openedBy: input.openedBy,
      approvedBy: null,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toStocktake(row);
  }

  async find(tenant: TenantId, id: string): Promise<Stocktake | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toStocktake(row);
  }

  async list(tenant: TenantId, filter?: { readonly state?: string }): Promise<readonly Stocktake[]> {
    return [...this.rows.values()]
      .filter(
        (row) => row.tenant === tenant && (filter?.state === undefined || row.state === filter.state),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toStocktake);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly approvedBy?: UserId; readonly remark?: string | null },
  ): Promise<Stocktake> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new InventoryConflictError(
        `盘点单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.approvedBy !== undefined) row.approvedBy = extra.approvedBy;
    if (extra?.remark !== undefined) row.remark = extra.remark;
    row.updatedAt = new Date().toISOString();
    return toStocktake(row);
  }

  async updateLines(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    lines: readonly StocktakeLine[],
  ): Promise<Stocktake | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) return null;
    row.lines = lines;
    row.updatedAt = new Date().toISOString();
    return toStocktake(row);
  }
}

// ---- 发货任务（投影，乐观 advance） ----

interface ShippingRow {
  readonly tenant: string;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  state: string;
  objectVersion: number;
  lines: readonly ShippingLine[];
  carrier: string | null;
  trackingNo: string | null;
  readonly executedBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  remark: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

function toShipping(row: ShippingRow): ShippingOrder {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    workOrderId: row.workOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines,
    carrier: row.carrier,
    trackingNo: row.trackingNo,
    executedBy: UserId.create(row.executedBy),
    confirmedBy: row.confirmedBy === null ? null : UserId.create(row.confirmedBy),
    confirmedAt: row.confirmedAt,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InMemoryShippingOrderStore implements ShippingOrderStore {
  private readonly rows = new Map<string, ShippingRow>(); // key: `${tenant}|${id}`

  async create(input: CreateShippingOrderInput): Promise<ShippingOrder> {
    const key = `${input.tenant}|${input.id}`;
    if (this.rows.has(key)) {
      throw new InventoryConflictError(`发货任务 '${input.id}' 已存在`);
    }
    const now = new Date().toISOString();
    const row: ShippingRow = {
      tenant: input.tenant,
      id: input.id,
      workOrderId: input.workOrderId,
      flowConfigId: input.flowConfigId,
      state: input.state,
      objectVersion: input.objectVersion,
      lines: input.lines,
      carrier: input.carrier,
      trackingNo: input.trackingNo,
      executedBy: input.executedBy,
      confirmedBy: null,
      confirmedAt: null,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return toShipping(row);
  }

  async find(tenant: TenantId, id: string): Promise<ShippingOrder | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toShipping(row);
  }

  async list(
    tenant: TenantId,
    filter?: { readonly state?: string; readonly workOrderId?: string },
  ): Promise<readonly ShippingOrder[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.tenant === tenant &&
          (filter?.state === undefined || row.state === filter.state) &&
          (filter?.workOrderId === undefined || row.workOrderId === filter.workOrderId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toShipping);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly carrier?: string | null;
      readonly trackingNo?: string | null;
      readonly confirmedBy?: UserId;
      readonly confirmedAt?: string;
    },
  ): Promise<ShippingOrder> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined || row.objectVersion !== expectedObjectVersion) {
      throw new InventoryConflictError(
        `发货任务 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${row?.objectVersion ?? '不存在'}`,
      );
    }
    row.state = nextState;
    row.objectVersion = nextObjectVersion;
    if (extra?.carrier !== undefined) row.carrier = extra.carrier;
    if (extra?.trackingNo !== undefined) row.trackingNo = extra.trackingNo;
    if (extra?.confirmedBy !== undefined) row.confirmedBy = extra.confirmedBy;
    if (extra?.confirmedAt !== undefined) row.confirmedAt = extra.confirmedAt;
    row.updatedAt = new Date().toISOString();
    return toShipping(row);
  }
}

// ---- 放行事实（append-only；(inspection, phase) 幂等） ----

export class InMemoryReleaseFactStore implements ReleaseFactStore {
  private readonly rows = new Map<string, ReleaseFact>(); // key: `${tenant}|${inspectionId}|${phase}`

  async append(input: AppendReleaseFactInput): Promise<ReleaseFact> {
    const key = `${input.tenant}|${input.inspectionId}|${input.phase}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing; // 幂等：重复通知返回既有行
    const fact: ReleaseFact = {
      id: input.id,
      tenant: input.tenant,
      inspectionId: input.inspectionId,
      phase: input.phase,
      kind: input.kind,
      itemId: input.itemId,
      drawingNo: input.drawingNo,
      quantity: input.quantity,
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId,
      releasedAt: input.releasedAt,
      recordedAt: new Date().toISOString(),
      objectVersion: 1,
      auditStatus: RELEASE_FACT_AUDIT_STATUS,
    };
    this.rows.set(key, fact);
    return fact;
  }

  async listByInspection(tenant: TenantId, inspectionId: string): Promise<readonly ReleaseFact[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.inspectionId === inspectionId)
      .sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
  }
}

// ---- 命令幂等记账 ----

export class InMemoryInventoryOperationStore implements InventoryOperationStore {
  private readonly recorded = new Map<string, InventoryOperationRecord>(); // key: `${tenant}|${operationId}`

  async record(entry: InventoryOperationRecord): Promise<InventoryOperationRecord | null> {
    const key = `${entry.tenant}|${entry.operationId}`;
    if (this.recorded.has(key)) return null;
    this.recorded.set(key, entry);
    return entry;
  }
}

// ---- 域事件（BusinessEvent + Outbox） ----

interface StoredDomainEvent {
  readonly seq: number;
  readonly event: BusinessEvent;
}

export class InMemoryInventoryDomainEventStore implements InventoryDomainEventStore {
  private readonly events: StoredDomainEvent[] = [];
  private readonly outbox = new Map<string, OutboxRecord>(); // eventId -> 行

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    if (this.outbox.has(event.eventId)) {
      throw new InventoryConflictError(`append-only violation: eventId '${event.eventId}' is already stored`);
    }
    this.events.push({ seq: this.events.length + 1, event });
    const record: OutboxRecord = {
      eventId: event.eventId,
      createdAt: event.occurredAt,
      attempts: 0,
      deliveredAt: null,
    };
    this.outbox.set(event.eventId, record);
    return record;
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    return this.events
      .filter(({ event }) => event.aggregate.id === aggregate.id && event.aggregate.type === aggregate.type)
      .sort((a, b) => a.seq - b.seq)
      .map(({ event }) => event);
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((row) => row.deliveredAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    const row = this.outbox.get(eventId);
    if (row === undefined) return;
    this.outbox.set(eventId, { ...row, deliveredAt });
  }
}
