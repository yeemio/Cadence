/**
 * inventory 十端口的 PG 实现 + 组合根装配工厂（M2-W5，经本包 `./inventory`
 * 子路径导出——与 `./listing` / `./workorder` 同模式：主入口保持零
 * @prisma/client 依赖）。启动零 DB 依赖：connectInventoryStore 只构造
 * PrismaClient（惰性连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 十一个实现（表 ↔ 端口分工见 prisma/schema.prisma inventory 节与迁移头注）：
 *  - PgWarehouseStore               → warehouses / warehouse_locations 主数据
 *                                      （(tenant, code) 与 (tenant, 仓, code)
 *                                      唯一，P2002 → InventoryConflictError）
 *  - PgStockAccountStore            → stock_accounts 投影（adjust = 原子守卫
 *                                      upsert：INSERT … ON CONFLICT DO UPDATE
 *                                      … WHERE 负库存守卫，零行命中 → 冲突拒）
 *  - PgStockLocationBalanceStore    → stock_location_balances 投影（同守卫语义）
 *  - PgStockMovementStore           → stock_movements 事实（(tenant, source_key)
 *                                      唯一 = receiptKey/issueKey 幂等锚点，
 *                                      P2002 → 回查返回 duplicate）
 *  - PgStockReservationStore        → stock_reservations 投影（consume/release
 *                                      条件推进：remaining 足额才写）
 *  - PgStocktakeStore               → stocktakes 投影（advance 乐观；
 *                                      updateLines 条件写不推版本）
 *  - PgShippingOrderStore           → shipping_orders 投影（advance 可回填
 *                                      物流/确认列）
 *  - PgReleaseFactStore             → release_facts 事实（(tenant, inspection,
 *                                      phase) 幂等：P2002 → 回查返回既有行）
 *  - PgInventoryOperationStore      → inventory_operations 幂等记账（PK=租户|
 *                                      operationId，P2002 = 已落账 → null）
 *  - PgInventoryDomainEventStore    → 域事件 + Outbox 同事务落账（**复用既有
 *                                      event_records / outbox_records**，不建新表）
 *  - PgInventoryMachineEventStore   → engine-flow ApprovalEventStore
 *                                      （inventory_events 账本；stocktake /
 *                                      shipping-order 两类聚合共用，
 *                                      (aggregate_id, aggregate_revision) 唯一 =
 *                                      DB 级乐观锁）
 *
 * 租户解析取舍（同 workorder/listing）：engine 机器事件端口不带租户参数——
 * 聚合锚定合同 = 投影行（stocktakes / shipping_orders），租户经投影行解析
 * （孤儿聚合 fail-fast 拒写）。域事件自带 tenantId，直落 event_records。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  EventId,
  TenantId,
  UserId,
  type BusinessEvent,
  type OutboxRecord,
} from '@smes/business-core';
import {
  makeApprovalEvent,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
} from '@smes/engine-flow';
import {
  RELEASE_FACT_AUDIT_STATUS,
  SHIPPING_ORDER_AGGREGATE_TYPE,
  STOCKTAKE_AGGREGATE_TYPE,
  STOCK_MOVEMENT_AUDIT_STATUS,
  InventoryConflictError,
  type AppendReleaseFactInput,
  type AppendStockMovementInput,
  type CreateShippingOrderInput,
  type CreateStockReservationInput,
  type CreateStocktakeInput,
  type DefineWarehouseInput,
  type InventoryDomainEventStore,
  type InventoryOperationRecord,
  type InventoryOperationStore,
  type ListLocationBalancesFilter,
  type ListStockAccountsFilter,
  type ListStockMovementsFilter,
  type ReleaseFact,
  type ReleaseFactStore,
  type ShippingLine,
  type ShippingOrder,
  type ShippingOrderStore,
  type StockAccount,
  type StockAccountStore,
  type StockAdjustGuard,
  type StockLocationBalance,
  type StockLocationBalanceStore,
  type StockMovement,
  type StockMovementAppendReceipt,
  type StockMovementStore,
  type StockReservation,
  type StockReservationCreateReceipt,
  type StockReservationStore,
  type Stocktake,
  type StocktakeLine,
  type StocktakeStore,
  type Warehouse,
  type WarehouseLocation,
  type WarehouseStore,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';

// ---- 小工具（同 listing 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ---- 行 <-> 领域形状映射 ----

interface LocationDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string | null;
  readonly createdAt: Date;
}

function rowToLocation(row: LocationDbRow): WarehouseLocation {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    warehouseId: row.warehouseId,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

/** warehouses 行 + 库位集 → 领域 Warehouse（库位按 code 升序）。 */
function rowsToWarehouse(
  row: { readonly id: string; readonly tenantId: string; readonly code: string; readonly name: string; readonly defaultLocationId: string; readonly createdAt: Date; readonly updatedAt: Date },
  locations: readonly LocationDbRow[],
): Warehouse {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    code: row.code,
    name: row.name,
    defaultLocationId: row.defaultLocationId,
    locations: [...locations].sort((a, b) => a.code.localeCompare(b.code)).map(rowToLocation),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface AccountDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToAccount(row: AccountDbRow): StockAccount {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    qtyOnHand: row.qtyOnHand,
    qtyReserved: row.qtyReserved,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface BalanceDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToBalance(row: BalanceDbRow): StockLocationBalance {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    itemId: row.itemId,
    qty: row.qty,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface MovementDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly seq: bigint;
  readonly kind: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly sourceRefType: string | null;
  readonly sourceRefId: string | null;
  readonly sourceKey: string | null;
  readonly transferId: string | null;
  readonly workOrderId: string | null;
  readonly remark: string | null;
  readonly occurredAt: Date;
  readonly recordedBy: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
}

export function rowToStockMovement(row: MovementDbRow): StockMovement {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    seq: Number(row.seq),
    kind: row.kind as StockMovement['kind'],
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    quantity: row.quantity,
    sourceRefType: row.sourceRefType,
    sourceRefId: row.sourceRefId,
    sourceKey: row.sourceKey,
    transferId: row.transferId,
    workOrderId: row.workOrderId,
    remark: row.remark,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: UserId.create(row.recordedBy),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

interface ReservationDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly reservationKey: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: number;
  readonly remaining: number;
  readonly status: string;
  readonly refType: string;
  readonly refId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToReservation(row: ReservationDbRow): StockReservation {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    reservationKey: row.reservationKey,
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    quantity: row.quantity,
    remaining: row.remaining,
    status: row.status as StockReservation['status'],
    refType: row.refType,
    refId: row.refId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface StocktakeDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: unknown;
  readonly openedBy: string;
  readonly approvedBy: string | null;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToStocktake(row: StocktakeDbRow): Stocktake {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    warehouseId: row.warehouseId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines as readonly StocktakeLine[],
    openedBy: UserId.create(row.openedBy),
    approvedBy: row.approvedBy === null ? null : UserId.create(row.approvedBy),
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface ShippingDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: unknown;
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly executedBy: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToShippingOrder(row: ShippingDbRow): ShippingOrder {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines as readonly ShippingLine[],
    carrier: row.carrier,
    trackingNo: row.trackingNo,
    executedBy: UserId.create(row.executedBy),
    confirmedBy: row.confirmedBy === null ? null : UserId.create(row.confirmedBy),
    confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface ReleaseFactDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly inspectionId: string;
  readonly phase: string;
  readonly kind: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: Date;
  readonly recordedAt: Date;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
}

export function rowToReleaseFact(row: ReleaseFactDbRow): ReleaseFact {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    inspectionId: row.inspectionId,
    phase: row.phase,
    kind: row.kind,
    itemId: row.itemId,
    drawingNo: row.drawingNo,
    quantity: row.quantity,
    sourceType: row.sourceType,
    sourceRefId: row.sourceRefId,
    releasedAt: row.releasedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

interface InventoryEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToInventoryEvent(row: InventoryEventDbRow): ApprovalEvent {
  return makeApprovalEvent({
    eventId: EventId.create(row.eventId),
    eventType: row.eventType,
    aggregate: {
      id: row.aggregateId,
      type: row.aggregateType,
      revision: row.aggregateRevision,
    },
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload as ApprovalEventPayload,
  });
}

// ---- 仓库与库位（application WarehouseStore） ----

export class PgWarehouseStore implements WarehouseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: DefineWarehouseInput): Promise<Warehouse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.warehouseRecord.create({
          data: {
            id: input.id,
            tenantId: input.tenant,
            code: input.code,
            name: input.name,
            defaultLocationId: input.defaultLocationId,
          },
        });
        const locations: LocationDbRow[] = [];
        for (const location of input.locations) {
          locations.push(
            await tx.warehouseLocationRecord.create({
              data: {
                id: location.id,
                tenantId: input.tenant,
                warehouseId: input.id,
                code: location.code,
                name: location.name,
              },
            }),
          );
        }
        return rowsToWarehouse(row, locations);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const target = Array.isArray((error as Prisma.PrismaClientKnownRequestError).meta?.target)
          ? ((error as Prisma.PrismaClientKnownRequestError).meta?.target as string[])
          : [];
        throw new InventoryConflictError(
          target.includes('code')
            ? `仓库编码 '${input.code}' 已存在（(tenant, code) 唯一）`
            : `库位编码冲突（(tenant, warehouse, code) 唯一）`,
        );
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<Warehouse | null> {
    const row = await this.prisma.warehouseRecord.findFirst({ where: { tenantId: tenant, id } });
    if (row === null) return null;
    const locations = await this.prisma.warehouseLocationRecord.findMany({
      where: { tenantId: tenant, warehouseId: id },
      orderBy: { code: 'asc' },
    });
    return rowsToWarehouse(row, locations);
  }

  async findByCode(tenant: TenantId, code: string): Promise<Warehouse | null> {
    const row = await this.prisma.warehouseRecord.findFirst({ where: { tenantId: tenant, code } });
    if (row === null) return null;
    const locations = await this.prisma.warehouseLocationRecord.findMany({
      where: { tenantId: tenant, warehouseId: row.id },
      orderBy: { code: 'asc' },
    });
    return rowsToWarehouse(row, locations);
  }

  async list(tenant: TenantId): Promise<readonly Warehouse[]> {
    const rows = await this.prisma.warehouseRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    const locations = await this.prisma.warehouseLocationRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) =>
      rowsToWarehouse(
        row,
        locations.filter((location) => location.warehouseId === row.id),
      ),
    );
  }

  async findLocation(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
  ): Promise<WarehouseLocation | null> {
    const row = await this.prisma.warehouseLocationRecord.findFirst({
      where: { tenantId: tenant, warehouseId, id: locationId },
    });
    return row === null ? null : rowToLocation(row);
  }
}

// ---- 库存账（守卫 upsert：负库存策略的 DB 级防线） ----

export class PgStockAccountStore implements StockAccountStore {
  constructor(private readonly prisma: PrismaClient) {}

  async find(tenant: TenantId, itemId: string, warehouseId: string): Promise<StockAccount | null> {
    const row = await this.prisma.stockAccountRecord.findUnique({
      where: { tenantId_itemId_warehouseId: { tenantId: tenant, itemId, warehouseId } },
    });
    return row === null ? null : rowToAccount(row);
  }

  async adjust(
    tenant: TenantId,
    itemId: string,
    warehouseId: string,
    onHandDelta: number,
    reservedDelta: number,
    guard?: StockAdjustGuard,
  ): Promise<StockAccount> {
    // 原子守卫 upsert：不存在 → INSERT（delta 即初值，守卫下可为负仅当放开）；
    // 已存在 → ON CONFLICT DO UPDATE 增量推进 WHERE 负库存守卫；零行 = 守卫拒。
    const allowNegative = guard?.allowNegativeHand === true;
    const changed = await this.prisma.$executeRaw`
      INSERT INTO "stock_accounts" ("id", "tenant_id", "item_id", "warehouse_id", "qty_on_hand", "qty_reserved", "created_at", "updated_at")
      VALUES (gen_random_uuid()::text, ${tenant}::text, ${itemId}::text, ${warehouseId}::text, ${onHandDelta}::double precision, ${reservedDelta}::double precision, now(), now())
      ON CONFLICT ("tenant_id", "item_id", "warehouse_id")
      DO UPDATE SET
        "qty_on_hand" = "stock_accounts"."qty_on_hand" + ${onHandDelta}::double precision,
        "qty_reserved" = "stock_accounts"."qty_reserved" + ${reservedDelta}::double precision,
        "updated_at" = now()
      WHERE ${allowNegative}::boolean OR "stock_accounts"."qty_on_hand" + ${onHandDelta}::double precision >= 0`;
    if (changed === 0) {
      throw new InventoryConflictError(
        `库存账守卫拒绝：物料 '${itemId}' @仓库 '${warehouseId}' 推进后将现存量 < 0（负库存策略硬拒绝）`,
      );
    }
    const row = await this.prisma.stockAccountRecord.findUniqueOrThrow({
      where: { tenantId_itemId_warehouseId: { tenantId: tenant, itemId, warehouseId } },
    });
    return rowToAccount(row);
  }

  async list(tenant: TenantId, filter?: ListStockAccountsFilter): Promise<readonly StockAccount[]> {
    const rows = await this.prisma.stockAccountRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.warehouseId === undefined ? {} : { warehouseId: filter.warehouseId }),
        ...(filter?.itemId === undefined ? {} : { itemId: filter.itemId }),
      },
      orderBy: [{ itemId: 'asc' }, { warehouseId: 'asc' }],
    });
    return rows.map(rowToAccount);
  }
}

// ---- 库位余额（同守卫语义） ----

export class PgStockLocationBalanceStore implements StockLocationBalanceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async find(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
  ): Promise<StockLocationBalance | null> {
    const row = await this.prisma.stockLocationBalanceRecord.findUnique({
      where: {
        tenantId_warehouseId_locationId_itemId: { tenantId: tenant, warehouseId, locationId, itemId },
      },
    });
    return row === null ? null : rowToBalance(row);
  }

  async adjust(
    tenant: TenantId,
    warehouseId: string,
    locationId: string,
    itemId: string,
    delta: number,
    guard?: StockAdjustGuard,
  ): Promise<StockLocationBalance> {
    const allowNegative = guard?.allowNegativeHand === true;
    const changed = await this.prisma.$executeRaw`
      INSERT INTO "stock_location_balances" ("id", "tenant_id", "warehouse_id", "location_id", "item_id", "qty", "created_at", "updated_at")
      VALUES (gen_random_uuid()::text, ${tenant}::text, ${warehouseId}::text, ${locationId}::text, ${itemId}::text, ${delta}::double precision, now(), now())
      ON CONFLICT ("tenant_id", "warehouse_id", "location_id", "item_id")
      DO UPDATE SET
        "qty" = "stock_location_balances"."qty" + ${delta}::double precision,
        "updated_at" = now()
      WHERE ${allowNegative}::boolean OR "stock_location_balances"."qty" + ${delta}::double precision >= 0`;
    if (changed === 0) {
      throw new InventoryConflictError(
        `库位余额守卫拒绝：物料 '${itemId}' @库位 '${locationId}' 推进后将为负（负库存策略硬拒绝）`,
      );
    }
    const row = await this.prisma.stockLocationBalanceRecord.findUniqueOrThrow({
      where: { tenantId_warehouseId_locationId_itemId: { tenantId: tenant, warehouseId, locationId, itemId } },
    });
    return rowToBalance(row);
  }

  async list(tenant: TenantId, filter?: ListLocationBalancesFilter): Promise<readonly StockLocationBalance[]> {
    const rows = await this.prisma.stockLocationBalanceRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.warehouseId === undefined ? {} : { warehouseId: filter.warehouseId }),
        ...(filter?.itemId === undefined ? {} : { itemId: filter.itemId }),
      },
      orderBy: [{ createdAt: 'asc' }, { itemId: 'asc' }],
    });
    return rows.map(rowToBalance);
  }
}

// ---- 出入库流水（append-only + sourceKey 幂等） ----

export class PgStockMovementStore implements StockMovementStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendStockMovementInput): Promise<StockMovementAppendReceipt> {
    if (input.sourceKey !== null) {
      const existing = await this.findBySourceKey(input.tenant, input.sourceKey);
      if (existing !== null) return { movement: existing, duplicate: true };
    }
    try {
      const row = await this.prisma.stockMovementRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
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
          occurredAt: new Date(input.occurredAt),
          recordedBy: input.recordedBy,
          auditStatus: STOCK_MOVEMENT_AUDIT_STATUS,
          ...(input.provenance === undefined ? {} : { provenance: json(input.provenance) }),
        },
      });
      return { movement: rowToStockMovement(row), duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // sourceKey 竞态窗口（并发同键指令）：回查返回既有行（幂等合同）。
        const existing = await this.findBySourceKey(input.tenant, input.sourceKey as string);
        if (existing !== null) return { movement: existing, duplicate: true };
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<StockMovement | null> {
    const row = await this.prisma.stockMovementRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToStockMovement(row);
  }

  async findBySourceKey(tenant: TenantId, sourceKey: string): Promise<StockMovement | null> {
    const row = await this.prisma.stockMovementRecord.findUnique({
      where: { tenantId_sourceKey: { tenantId: tenant, sourceKey } },
    });
    return row === null ? null : rowToStockMovement(row);
  }

  async list(tenant: TenantId, filter?: ListStockMovementsFilter): Promise<readonly StockMovement[]> {
    const rows = await this.prisma.stockMovementRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.itemId === undefined ? {} : { itemId: filter.itemId }),
        ...(filter?.warehouseId === undefined ? {} : { warehouseId: filter.warehouseId }),
        ...(filter?.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
        ...(filter?.sourceRefId === undefined ? {} : { sourceRefId: filter.sourceRefId }),
      },
      orderBy: { seq: 'asc' },
    });
    return rows.map(rowToStockMovement);
  }
}

// ---- 预占（条件推进） ----

export class PgStockReservationStore implements StockReservationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateStockReservationInput): Promise<StockReservationCreateReceipt> {
    try {
      const row = await this.prisma.stockReservationRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          reservationKey: input.reservationKey,
          itemId: input.itemId,
          warehouseId: input.warehouseId,
          quantity: input.quantity,
          remaining: input.quantity,
          status: 'active',
          refType: input.refType,
          refId: input.refId,
        },
      });
      return { reservation: rowToReservation(row), duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findByKey(input.tenant, input.reservationKey);
        if (existing !== null && existing.status === 'active') {
          return { reservation: existing, duplicate: true };
        }
        throw new InventoryConflictError(
          `预占键 '${input.reservationKey}' 已 ${existing?.status ?? '占用'}（consumed/released 的键不得复用）`,
        );
      }
      throw error;
    }
  }

  async findByKey(tenant: TenantId, reservationKey: string): Promise<StockReservation | null> {
    const row = await this.prisma.stockReservationRecord.findUnique({
      where: { tenantId_reservationKey: { tenantId: tenant, reservationKey } },
    });
    return row === null ? null : rowToReservation(row);
  }

  async list(
    tenant: TenantId,
    filter?: { readonly status?: StockReservation['status'] },
  ): Promise<readonly StockReservation[]> {
    const rows = await this.prisma.stockReservationRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.status === undefined ? {} : { status: filter.status }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(rowToReservation);
  }

  async consume(tenant: TenantId, reservationKey: string, quantity: number): Promise<StockReservation | null> {
    // 条件推进：active 且余量足额才写；remaining 减到 0 推 consumed。
    const updated = await this.prisma.$executeRaw`
      UPDATE "stock_reservations"
      SET "remaining" = "remaining" - ${quantity}::double precision,
          "status" = CASE WHEN "remaining" - ${quantity}::double precision = 0 THEN 'consumed' ELSE "status" END,
          "updated_at" = now()
      WHERE "tenant_id" = ${tenant}::text
        AND "reservation_key" = ${reservationKey}::text
        AND "status" = 'active'
        AND "remaining" >= ${quantity}::double precision`;
    if (updated === 0) return null;
    return this.findByKey(tenant, reservationKey);
  }

  async releaseBy(
    tenant: TenantId,
    reservationKey: string,
    quantity: number | null,
  ): Promise<StockReservation | null> {
    const current = await this.findByKey(tenant, reservationKey);
    if (current === null || current.status !== 'active') return null;
    const releaseQty = quantity === null ? current.remaining : quantity;
    if (releaseQty > current.remaining) return null;
    const nextRemaining = current.remaining - releaseQty;
    const updated = await this.prisma.stockReservationRecord.updateMany({
      where: {
        tenantId: tenant,
        reservationKey,
        status: 'active',
        remaining: current.remaining, // 乐观条件（并发释放窗口）
      },
      data: {
        remaining: nextRemaining,
        status: nextRemaining === 0 ? 'released' : 'active',
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    return this.findByKey(tenant, reservationKey);
  }
}

// ---- 盘点（投影 + 行载荷条件写） ----

export class PgStocktakeStore implements StocktakeStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateStocktakeInput): Promise<Stocktake> {
    try {
      const row = await this.prisma.stocktakeRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          warehouseId: input.warehouseId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          lines: json(input.lines as unknown as readonly unknown[]),
          openedBy: input.openedBy,
          remark: input.remark,
        },
      });
      return rowToStocktake(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InventoryConflictError(`盘点单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<Stocktake | null> {
    const row = await this.prisma.stocktakeRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToStocktake(row);
  }

  async list(tenant: TenantId, filter?: { readonly state?: string }): Promise<readonly Stocktake[]> {
    const rows = await this.prisma.stocktakeRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToStocktake);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly approvedBy?: UserId; readonly remark?: string | null },
  ): Promise<Stocktake> {
    const updated = await this.prisma.stocktakeRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.approvedBy === undefined ? {} : { approvedBy: extra.approvedBy }),
        ...(extra?.remark === undefined ? {} : { remark: extra.remark }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.stocktakeRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new InventoryConflictError(
        `盘点单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.stocktakeRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToStocktake(row);
  }

  async updateLines(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    lines: readonly StocktakeLine[],
  ): Promise<Stocktake | null> {
    const updated = await this.prisma.stocktakeRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: { lines: json(lines as unknown as readonly unknown[]), updatedAt: new Date() },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.stocktakeRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToStocktake(row);
  }
}

// ---- 发货任务（投影，乐观 advance） ----

export class PgShippingOrderStore implements ShippingOrderStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateShippingOrderInput): Promise<ShippingOrder> {
    try {
      const row = await this.prisma.shippingOrderRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          lines: json(input.lines as unknown as readonly unknown[]),
          executedBy: input.executedBy,
          carrier: input.carrier,
          trackingNo: input.trackingNo,
          remark: input.remark,
        },
      });
      return rowToShippingOrder(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InventoryConflictError(`发货任务 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<ShippingOrder | null> {
    const row = await this.prisma.shippingOrderRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToShippingOrder(row);
  }

  async list(
    tenant: TenantId,
    filter?: { readonly state?: string; readonly workOrderId?: string },
  ): Promise<readonly ShippingOrder[]> {
    const rows = await this.prisma.shippingOrderRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToShippingOrder);
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
    const updated = await this.prisma.shippingOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.carrier === undefined ? {} : { carrier: extra.carrier }),
        ...(extra?.trackingNo === undefined ? {} : { trackingNo: extra.trackingNo }),
        ...(extra?.confirmedBy === undefined ? {} : { confirmedBy: extra.confirmedBy }),
        ...(extra?.confirmedAt === undefined ? {} : { confirmedAt: new Date(extra.confirmedAt) }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.shippingOrderRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new InventoryConflictError(
        `发货任务 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.shippingOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToShippingOrder(row);
  }
}

// ---- 放行事实（append-only + (inspection, phase) 幂等） ----

export class PgReleaseFactStore implements ReleaseFactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendReleaseFactInput): Promise<ReleaseFact> {
    try {
      const row = await this.prisma.releaseFactRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          inspectionId: input.inspectionId,
          phase: input.phase,
          kind: input.kind,
          itemId: input.itemId,
          drawingNo: input.drawingNo,
          quantity: input.quantity,
          sourceType: input.sourceType,
          sourceRefId: input.sourceRefId,
          releasedAt: new Date(input.releasedAt),
          auditStatus: RELEASE_FACT_AUDIT_STATUS,
        },
      });
      return rowToReleaseFact(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // 幂等合同：重复通知返回既有行（(tenant, inspection, phase) 锚点）。
        const existing = await this.prisma.releaseFactRecord.findUnique({
          where: {
            tenantId_inspectionId_phase: {
              tenantId: input.tenant,
              inspectionId: input.inspectionId,
              phase: input.phase,
            },
          },
        });
        if (existing !== null) return rowToReleaseFact(existing);
      }
      throw error;
    }
  }

  async listByInspection(tenant: TenantId, inspectionId: string): Promise<readonly ReleaseFact[]> {
    const rows = await this.prisma.releaseFactRecord.findMany({
      where: { tenantId: tenant, inspectionId },
      orderBy: { releasedAt: 'asc' },
    });
    return rows.map(rowToReleaseFact);
  }
}

// ---- 命令幂等记账 ----

export class PgInventoryOperationStore implements InventoryOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: InventoryOperationRecord): Promise<InventoryOperationRecord | null> {
    try {
      await this.prisma.inventoryOperationRecord.create({
        data: {
          operationKey: `${entry.tenant}|${entry.operationId}`, // PK = 租户+operationId（应用侧拼键）
          tenantId: entry.tenant,
          operationId: entry.operationId,
          command: entry.command,
          aggregateType: entry.aggregateType,
          aggregateId: entry.aggregateId,
          occurredAt: new Date(entry.occurredAt),
        },
      });
      return entry;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // 已落账 → 幂等拒绝（端口合同）
      throw error;
    }
  }
}

// ---- 域事件（BusinessEvent + Outbox，复用既有 event_records / outbox_records） ----

export class PgInventoryDomainEventStore implements InventoryDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      await this.prisma.$transaction([
        this.prisma.businessEventRecord.create({
          data: {
            eventId: row.eventId,
            tenantId: row.tenantId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            aggregateType: row.aggregateType,
            aggregateRevision: row.aggregateRevision,
            occurredAt: row.occurredAt,
            ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
            ...(row.availableTime === undefined ? {} : { availableTime: row.availableTime }),
            ...(row.provenance === undefined ? {} : { provenance: json(row.provenance) }),
            payload: json(row.payload as Readonly<Record<string, unknown>>),
          },
        }),
        this.prisma.outboxRecord.create({
          data: {
            eventId: outbox.eventId,
            tenantId: outbox.tenantId,
            createdAt: outbox.createdAt,
          },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InventoryConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
    return toOutboxRecord(outbox);
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    // 聚合 id 带模块前缀 uuidv7，全局唯一——端口不带租户参数（发布账本按聚合收口）。
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { aggregateId: aggregate.id, aggregateType: aggregate.type },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }], // eventId=evt-uuidv7 时间序，同毫秒稳定
    });
    return rows.map((row) =>
      fromBusinessEventRow({
        eventId: row.eventId,
        eventType: row.eventType,
        tenantId: TenantId.create(row.tenantId),
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        aggregateRevision: row.aggregateRevision,
        occurredAt: row.occurredAt,
        ...(row.businessTime === null ? {} : { businessTime: row.businessTime }),
        ...(row.availableTime === null ? {} : { availableTime: row.availableTime }),
        ...(row.provenance === null ? {} : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
        payload: row.payload,
      }),
    );
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    const rows = await this.prisma.outboxRecord.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      toOutboxRecord({
        eventId: row.eventId,
        tenantId: TenantId.create(row.tenantId),
        createdAt: row.createdAt,
        attempts: row.attempts,
        ...(row.lastAttemptAt === null ? {} : { lastAttemptAt: row.lastAttemptAt }),
        ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
        deliveredAt: row.deliveredAt,
      }),
    );
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    // Outbox 例外：投递记账可 UPDATE（append-only 触发器对 outbox_records 豁免）。
    await this.prisma.outboxRecord.updateMany({
      where: { eventId },
      data: { deliveredAt: new Date(deliveredAt) },
    });
  }
}

// ---- 机器事件账本（engine-flow ApprovalEventStore → inventory_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（同 listing 取舍）。stocktake → stocktakes、
 * shipping-order → shipping_orders；其余类型 / 不存在的聚合 = 孤儿账目
 * fail-fast 拒写（这就是"先落初始投影再驱动迁移"落账顺序的 DB 侧依据）。
 */
async function tenantOfInventoryAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === STOCKTAKE_AGGREGATE_TYPE) {
    const row = await prisma.stocktakeRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  } else if (aggregate.type === SHIPPING_ORDER_AGGREGATE_TYPE) {
    const row = await prisma.shippingOrderRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `inventory aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = stocktakes / shipping_orders）`,
  );
}

export class PgInventoryMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfInventoryAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.inventoryEventRecord.create({
        data: {
          eventId: event.eventId,
          tenantId,
          eventType: event.eventType,
          aggregateId: event.aggregate.id,
          aggregateType: event.aggregate.type,
          aggregateRevision: event.aggregate.revision,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload as object,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? (error.meta.target as string[]) : [];
        if (target.includes('aggregate_id')) {
          // 版本乐观锁：另一迁移已占该 (aggregate, revision)——并发推进必拒其一。
          throw new InventoryConflictError(
            `聚合 '${event.aggregate.id}' 版本 ${event.aggregate.revision} 已被另一迁移占用（并发推进冲突）`,
          );
        }
        // eventId 主键冲突 = 幂等去重纪律（与引擎内存实现同一合同）。
        throw new Error(`append-only violation: eventId "${event.eventId}" is already stored`);
      }
      throw error;
    }
  }

  async readByAggregate(
    aggregate: { readonly id: string; readonly type: string },
    options?: { readonly afterCursor?: ApprovalEventCursor },
  ): Promise<ApprovalEventPage> {
    const tenantId = await tenantOfInventoryAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.inventoryEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToInventoryEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./listing） ----

export interface InventoryStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：十端口实现（可直接喂 InventoryModule.register）+ 优雅断连。 */
export interface InventoryStoreHandle {
  readonly warehouseStore: WarehouseStore;
  readonly accountStore: StockAccountStore;
  readonly locationBalanceStore: StockLocationBalanceStore;
  readonly movementStore: StockMovementStore;
  readonly reservationStore: StockReservationStore;
  readonly stocktakeStore: StocktakeStore;
  readonly shippingStore: ShippingOrderStore;
  readonly releaseFactStore: ReleaseFactStore;
  readonly operationStore: InventoryOperationStore;
  readonly domainEventStore: InventoryDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造 inventory PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectInventoryStore(options: InventoryStoreOptions = {}): InventoryStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  return {
    warehouseStore: new PgWarehouseStore(prisma),
    accountStore: new PgStockAccountStore(prisma),
    locationBalanceStore: new PgStockLocationBalanceStore(prisma),
    movementStore: new PgStockMovementStore(prisma),
    reservationStore: new PgStockReservationStore(prisma),
    stocktakeStore: new PgStocktakeStore(prisma),
    shippingStore: new PgShippingOrderStore(prisma),
    releaseFactStore: new PgReleaseFactStore(prisma),
    operationStore: new PgInventoryOperationStore(prisma),
    domainEventStore: new PgInventoryDomainEventStore(prisma),
    machineEventStore: new PgInventoryMachineEventStore(prisma),
    async disconnect(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
