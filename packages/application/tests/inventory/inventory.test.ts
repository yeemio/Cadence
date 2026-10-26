/**
 * inventory 模块测试（M2-W5，07-inventory.md v1.0）：两份状态机配置合法集、
 * 仓库/库位主数据、三类入库（质检放行咬合 + 采购 receiptKey 幂等 + 完工直入）、
 * 可用量恒等式（可用量=总量−预占：reserve/release/核销/直扣/负库存策略）、
 * 调拨与仓内移库、盘点实盘-审核-调账全链（调账留痕 + 账面=实盘对账）、发货
 * 执行-确认链（出库核销 + ShippingConfirmed 联动载荷）、兄弟端口适配器
 * （availability/receipt/partsIssue/stockReleaseRecorder）、幂等与乐观锁、
 * 查询视图、模块装配与权限码。全部零框架直连（内存实现 + engine-flow 内存
 * 账本；真实端口由组合根合流接线）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  DEFAULT_SHIPPING_FLOW_CONFIG,
  DEFAULT_STOCKTAKE_FLOW_CONFIG,
  RECEIPT_SOURCE_KINDS,
  SHIPPING_STATE_IDS,
  STOCKTAKE_STATE_IDS,
  movementDirection,
  movementKindLabel,
  shippingStateLabel,
  stocktakeStateLabel,
} from '../../src/inventory/inventory-config.js';
import {
  INVENTORY_EVENT_TYPES,
  SHIPPING_ORDER_AGGREGATE_TYPE,
  STOCKTAKE_AGGREGATE_TYPE,
} from '../../src/inventory/inventory-events.js';
import {
  InventoryConflictError,
  InventoryInputError,
  InventoryNotFoundError,
} from '../../src/inventory/inventory-errors.js';
import {
  parseCommandBodyForKind,
  parseCommandEnvelopeBody,
  parseStockReceivePayload,
  parseStockTransferPayload,
  parseStateFilter,
  parseWarehouseDefinePayload,
} from '../../src/inventory/inventory-input.js';
import {
  createInventoryAvailabilityAdapter,
  createInventoryReceiptAdapter,
  createPartsIssueAdapter,
  createStockReleaseRecorder,
} from '../../src/inventory/inventory-ports.js';
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
} from '../../src/inventory/in-memory-inventory-stores.js';
import { InventoryModule } from '../../src/inventory/inventory.module.js';
import {
  GoodsShelvesController,
  InventoryQueriesController,
  ShelfLocationsController,
  ShippingOrdersController,
  StockMovementCommandsController,
  StocktakingController,
  WarehousesController,
} from '../../src/inventory/inventory.controllers.js';
import { InventoryService } from '../../src/inventory/inventory.service.js';
import type { InventoryCommandResult } from '../../src/inventory/inventory.service.js';
import type { InventoryCommand } from '../../src/inventory/inventory-input.js';
import type { NegativeStockPolicy } from '../../src/inventory/inventory-config.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const keeper = UserId.create('u-keeper-01');
const counter = UserId.create('u-counter-01');
const auditor = UserId.create('u-auditor-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 测试 harness（内存实现 + 固定时钟） ----

interface Harness {
  readonly service: InventoryService;
  readonly warehouses: InMemoryWarehouseStore;
  readonly accounts: InMemoryStockAccountStore;
  readonly balances: InMemoryStockLocationBalanceStore;
  readonly movements: InMemoryStockMovementStore;
  readonly reservations: InMemoryStockReservationStore;
  readonly stocktakes: InMemoryStocktakeStore;
  readonly shippings: InMemoryShippingOrderStore;
  readonly releaseFacts: InMemoryReleaseFactStore;
  readonly domainEvents: InMemoryInventoryDomainEventStore;
  /** 同一组 stores 上重建 service（改服务选项——默认仓/负库存策略切换用；D-16 起默认仓按 code 配置）。 */
  rebuild(options: { negativeStockPolicy?: NegativeStockPolicy; defaultWarehouseCode?: string }): InventoryService;
}

function makeHarness(options: { negativeStockPolicy?: NegativeStockPolicy; defaultWarehouseCode?: string } = {}): Harness {
  const warehouses = new InMemoryWarehouseStore();
  const accounts = new InMemoryStockAccountStore();
  const balances = new InMemoryStockLocationBalanceStore();
  const movements = new InMemoryStockMovementStore();
  const reservations = new InMemoryStockReservationStore();
  const stocktakes = new InMemoryStocktakeStore();
  const shippings = new InMemoryShippingOrderStore();
  const releaseFacts = new InMemoryReleaseFactStore();
  const domainEvents = new InMemoryInventoryDomainEventStore();
  const build = (opts: { negativeStockPolicy?: NegativeStockPolicy; defaultWarehouseCode?: string }): InventoryService =>
    new InventoryService(
      warehouses,
      accounts,
      balances,
      movements,
      reservations,
      stocktakes,
      shippings,
      releaseFacts,
      new InMemoryInventoryOperationStore(),
      domainEvents,
      createInMemoryApprovalEventStore(),
      {
        now: () => FIXED_NOW,
        ...(opts.negativeStockPolicy === undefined ? {} : { negativeStockPolicy: opts.negativeStockPolicy }),
        ...(opts.defaultWarehouseCode === undefined ? {} : { defaultWarehouseCode: opts.defaultWarehouseCode }),
      },
    );
  const service = build(options);
  return {
    service,
    warehouses,
    accounts,
    balances,
    movements,
    reservations,
    stocktakes,
    shippings,
    releaseFacts,
    domainEvents,
    rebuild: build,
  };
}

interface EnvelopeOptions {
  readonly expectedRevision?: 'initial' | number;
  readonly actor?: UserId;
  readonly tenant?: TenantId;
  readonly operationId?: string;
}

let operationSeq = 0;

function envelope(
  kind: InventoryCommand['kind'],
  payload: unknown,
  options: EnvelopeOptions = {},
): CommandEnvelope<InventoryCommand> {
  operationSeq += 1;
  return makeCommandEnvelope<InventoryCommand>({
    tenantId: options.tenant ?? t1,
    issuedBy: options.actor ?? keeper,
    operationId: OperationId.create(options.operationId ?? `op-inv-${operationSeq}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload },
  });
}

function mustCommit(result: InventoryCommandResult): Extract<InventoryCommandResult, { status: 'committed' }> {
  expect(result.status, `命令应 committed（拒绝原因：${result.status === 'rejected' ? result.reason : ''}）`).toBe('committed');
  return result as Extract<InventoryCommandResult, { status: 'committed' }>;
}

function mustReject(result: InventoryCommandResult): string {
  expect(result.status).toBe('rejected');
  return (result as { readonly reason: string }).reason;
}

/** 建两仓三库位的常用前置（WH1: RAW/FG；WH2: EXT）。返回 [wh1, wh2]。 */
async function seedWarehouses(h: Harness): Promise<{ readonly wh1: string; readonly wh2: string; readonly raw: string; readonly fg: string; readonly ext: string }> {
  const wh1 = mustCommit(
    await h.service.execute(
      envelope('warehouse.define.v1', {
        code: 'WH1',
        name: '主仓',
        locations: [
          { code: 'RAW', name: '原料区' },
          { code: 'FG', name: '成品区' },
        ],
      }),
    ),
  ).warehouse as { readonly id: string; readonly defaultLocationId: string; readonly locations: readonly { readonly id: string; readonly code: string }[] };
  const wh2 = mustCommit(
    await h.service.execute(
      envelope('warehouse.define.v1', {
        code: 'WH2',
        name: '外购件仓',
        locations: [{ code: 'EXT', name: '外购区' }],
      }),
    ),
  ).warehouse as { readonly id: string; readonly locations: readonly { readonly id: string; readonly code: string }[] };
  return {
    wh1: wh1.id,
    wh2: wh2.id,
    raw: wh1.locations.find((location) => location.code === 'RAW')?.id as string,
    fg: wh1.locations.find((location) => location.code === 'FG')?.id as string,
    ext: wh2.locations.find((location) => location.code === 'EXT')?.id as string,
  };
}

/** 完工入库（最短路径入账）。 */
async function receiveProduction(
  h: Harness,
  itemId: string,
  warehouseId: string,
  quantity: number,
  locationId?: string,
): Promise<void> {
  mustCommit(
    await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'production',
        itemId,
        warehouseId,
        ...(locationId === undefined ? {} : { locationId }),
        quantity,
      }),
    ),
  );
}

// ---- 状态机配置 ----

describe('状态机配置（engine-flow 配置形态，ADR-0010 条 2）', () => {
  it('盘点四态：draft→counting→reconciled→adjusted，3 条迁移，adjusted 终态', () => {
    expect(STOCKTAKE_STATE_IDS).toEqual(['draft', 'counting', 'reconciled', 'adjusted']);
    expect(DEFAULT_STOCKTAKE_FLOW_CONFIG.transitions).toHaveLength(3);
    expect(DEFAULT_STOCKTAKE_FLOW_CONFIG.initial).toBe('draft');
    expect(stocktakeStateLabel('reconciled')).toBe('待审核调账');
    expect(stocktakeStateLabel('unknown-x')).toBe('unknown-x');
  });

  it('发货三态：draft→executing→shipped，2 条迁移，shipped 终态', () => {
    expect(SHIPPING_STATE_IDS).toEqual(['draft', 'executing', 'shipped']);
    expect(DEFAULT_SHIPPING_FLOW_CONFIG.transitions).toHaveLength(2);
    expect(shippingStateLabel('executing')).toBe('执行中');
  });

  it('流水 kind → 方向推导（in/out）与三类入库来源词汇', () => {
    expect(RECEIPT_SOURCE_KINDS).toEqual(['inspection', 'purchase', 'production']);
    expect(movementDirection('purchase-in')).toBe('in');
    expect(movementDirection('stocktake-loss')).toBe('out');
    expect(movementDirection('transfer-in')).toBe('in');
    expect(movementKindLabel('stocktake-gain')).toBe('盘盈');
  });

  it('事件类型名常量（合同 §6 最小集 5 个）', () => {
    expect(INVENTORY_EVENT_TYPES.stockReceived).toBe('smes.inventory.v1.stock-received');
    expect(INVENTORY_EVENT_TYPES.stockIssued).toBe('smes.inventory.v1.stock-issued');
    expect(INVENTORY_EVENT_TYPES.stockTransferred).toBe('smes.inventory.v1.stock-transferred');
    expect(INVENTORY_EVENT_TYPES.stocktakeAdjusted).toBe('smes.inventory.v1.stocktake-adjusted');
    expect(INVENTORY_EVENT_TYPES.shippingConfirmed).toBe('smes.inventory.v1.shipping-confirmed');
  });
});

// ---- 仓库与库位主数据 ----

describe('warehouse.define（R4：主数据归本模块）', () => {
  it('建仓库：第一个库位为默认库位；库位 code 升序读回', async () => {
    const h = makeHarness();
    const created = mustCommit(
      await h.service.execute(
        envelope('warehouse.define.v1', {
          code: 'WH1',
          name: '主仓',
          locations: [
            { code: 'FG', name: '成品区' },
            { code: 'RAW', name: '原料区' },
          ],
        }),
      ),
    );
    const warehouse = created.warehouse as { readonly id: string; readonly defaultLocationId: string; readonly locations: readonly { readonly id: string; readonly code: string }[] };
    expect(warehouse.locations.map((location) => location.code)).toEqual(['FG', 'RAW']);
    expect(warehouse.defaultLocationId).toBe(warehouse.locations[0]?.id);
    expect(created.newRevision).toBe(1);
    expect(created.events).toEqual([]); // 主数据无域事件（合同事件面最小集）

    const list = await h.service.listWarehouses(t1);
    expect(list).toHaveLength(1);
    const detail = await h.service.warehouseDetail(t1, warehouse.id);
    expect(detail.code).toBe('WH1');
  });

  it('重复仓库编码拒绝（不落账）；库位编码重复/空数组为输入错误', async () => {
    const h = makeHarness();
    await seedWarehouses(h);
    const rejected = await h.service.execute(
      envelope('warehouse.define.v1', { code: 'WH1', name: '重复仓', locations: [{ code: 'A' }] }),
    );
    expect(mustReject(rejected)).toContain("仓库编码 'WH1' 已存在");
    expect((await h.service.listWarehouses(t1)).length).toBe(2);

    expect(() =>
      parseWarehouseDefinePayload({ code: 'WH9', name: 'x', locations: [{ code: 'A' }, { code: 'A' }] }),
    ).toThrow(InventoryInputError);
    expect(() =>
      parseWarehouseDefinePayload({ code: 'WH9', name: 'x', locations: [] }),
    ).toThrow(InventoryInputError);
  });
});

// ---- 三类入库 ----

describe('stock.receive（三类入库：质检放行/采购收货/完工入库）', () => {
  it('production 直入：账面/库位/流水/事件四账齐动', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    const committed = mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', {
          kind: 'production',
          itemId: 'item-001',
          warehouseId: ids.wh1,
          locationId: ids.fg,
          quantity: 10,
          workOrderId: 'wo-1',
        }),
      ),
    );
    expect(committed.movement?.kind).toBe('production-in');
    expect(committed.stockLevel).toMatchObject({
      itemId: 'item-001',
      warehouseId: ids.wh1,
      qtyOnHand: 10,
      qtyReserved: 0,
      availableQty: 10,
    });
    const balances = await h.service.locationBalances(t1, ids.wh1, 'item-001');
    expect(balances).toHaveLength(1);
    expect(balances[0]?.locationId).toBe(ids.fg);
    expect(balances[0]?.qty).toBe(10);
    const movements = await h.service.listMovements(t1, 'item-001', ids.wh1);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.sourceRefType).toBe('work-order'); // 完工入库锚定工作令
    expect(movements[0]?.sourceRefId).toBe('wo-1');
    expect(committed.events[0]?.eventType).toBe(INVENTORY_EVENT_TYPES.stockReceived);
    expect((committed.events[0]?.payload as { source: string }).source).toBe('production');
  });

  it('未指定库位落默认库位；仓库/库位不存在拒绝', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-002', ids.wh1, 5);
    const balances = await h.service.locationBalances(t1, ids.wh1, 'item-002');
    expect(balances[0]?.locationId).toBe(ids.raw); // 第一个库位 = 默认

    const badWarehouse = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'item-002', warehouseId: 'wh-none', quantity: 1 }),
    );
    expect(mustReject(badWarehouse)).toContain("不存在仓库 'wh-none'");
    const badLocation = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'item-002', warehouseId: ids.wh1, locationId: ids.ext, quantity: 1 }),
    );
    // B3 后落位解析器扩展：文案含"可落位的库位"（直属库位或已启用货架库位）。
    expect(mustReject(badLocation)).toContain("可落位的库位");
  });

  it('被拒不占用 operationId（口径统一：先解析校验后记账）：仓库不存在被拒后建仓，同 id 重发 → committed', async () => {
    const h = makeHarness();
    // 深校验拒（仓库不存在）：不 record operationId
    const refused = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'item-101', warehouseId: 'wh-late', quantity: 5, workOrderId: 'wo-9' }, { operationId: 'op-inv-same-retry' }),
    );
    expect(mustReject(refused)).toContain("不存在仓库 'wh-late'");

    // 补建仓库后同 operationId 重发 → committed（旧口径 record 先行：此处会撞"已落账"）
    const created = mustCommit(
      await h.service.execute(envelope('warehouse.define.v1', { code: 'WHL', name: '补建仓', locations: [{ code: 'MAIN', name: '主位' }] })),
    ).warehouse as { readonly id: string };
    const retried = mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', { kind: 'production', itemId: 'item-101', warehouseId: created.id, quantity: 5, workOrderId: 'wo-9' }, { operationId: 'op-inv-same-retry' }),
      ),
    );
    expect(retried.movement?.quantity).toBe(5);

    // committed 后同 id 再发 → 仍被拒（"已落账"终态）
    const dup = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'item-101', warehouseId: created.id, quantity: 5, workOrderId: 'wo-9' }, { operationId: 'op-inv-same-retry' }),
    );
    expect(mustReject(dup)).toContain('已落账');
  });

  it('出库同口径：可用量不足被拒不占用 operationId，补库存后同 id 重发 → committed', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    // 直扣可用量 0 < 5：深校验拒，不 record
    const refused = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-202', warehouseId: ids.wh1, quantity: 5, purpose: 'manual' }, { operationId: 'op-issue-same-retry' }),
    );
    expect(mustReject(refused)).toContain('可用量不足');

    // 补库存（完工入库 5）后同 operationId 重发 → committed（旧口径 record 先行：此处会撞"已落账"）
    await receiveProduction(h, 'item-202', ids.wh1, 5);
    const retried = mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-202', warehouseId: ids.wh1, quantity: 5, purpose: 'manual' }, { operationId: 'op-issue-same-retry' }),
      ),
    );
    expect(retried.movement?.quantity).toBe(5);

    // committed 后同 id 再发：统一口径下同 id 重新评估——库存已被本轮出完，
    // 按状态拒（可用量不足，零新副作用；无 sourceKey 的重发不再走"已落账"门）
    const dup = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-202', warehouseId: ids.wh1, quantity: 5, purpose: 'manual' }, { operationId: 'op-issue-same-retry' }),
    );
    expect(mustReject(dup)).toContain('可用量不足');
    expect((await h.service.listMovements(t1, 'item-202', ids.wh1)).length).toBe(2); // 入 1 + 出 1，零重复扣减
  });

  it('inspection 咬合：无放行事实拒绝；登记后放行内可入；超放行量拒绝', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    // 无放行事实：拒绝（Done-when：三类入库需质检放行才可执行）。
    const refused = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'inspection',
        itemId: 'item-010',
        warehouseId: ids.wh1,
        quantity: 8,
        inspectionId: 'insp-1',
      }),
    );
    expect(mustReject(refused)).toContain("质检单 'insp-1' 无放行事实");

    // 放行事实登记（StockReleasePort 直连通道——inventory 是实现方）。
    await h.service.recordInspectionRelease(t1, {
      inspectionId: 'insp-1',
      kind: 'nonstandard_purchase',
      itemId: 'item-010',
      drawingNo: null,
      quantity: 10,
      sourceType: 'receipt',
      sourceRefId: 'po-1',
      releasedAt: FIXED_NOW,
    });
    // 同轮重试幂等（同 releasedAt → 同 phase 返回既有行，放行量不虚增）。
    await h.service.recordInspectionRelease(t1, {
      inspectionId: 'insp-1',
      kind: 'nonstandard_purchase',
      itemId: 'item-010',
      drawingNo: null,
      quantity: 10,
      sourceType: 'receipt',
      sourceRefId: 'po-1',
      releasedAt: FIXED_NOW,
    });
    const facts = await h.releaseFacts.listByInspection(t1, 'insp-1');
    expect(facts).toHaveLength(1);

    mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', {
          kind: 'inspection',
          itemId: 'item-010',
          warehouseId: ids.wh1,
          quantity: 8,
          inspectionId: 'insp-1',
        }),
      ),
    );
    // 放行 10 − 已入 8 = 2：再入 3 拒（超放行余量）。
    const over = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'inspection',
        itemId: 'item-010',
        warehouseId: ids.wh1,
        quantity: 3,
        inspectionId: 'insp-1',
      }),
    );
    expect(mustReject(over)).toContain('放行余量不足');
    // 余量内再入 2 成功。
    mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', {
          kind: 'inspection',
          itemId: 'item-010',
          warehouseId: ids.wh1,
          quantity: 2,
          inspectionId: 'insp-1',
        }),
      ),
    );
    const level = (await h.service.stockLevels(t1, ids.wh1, 'item-010'))[0];
    expect(level?.qtyOnHand).toBe(10);
  });

  it('inspection 来源缺 inspectionId 为输入错误', () => {
    expect(() =>
      parseStockReceivePayload({ kind: 'inspection', itemId: 'i', warehouseId: 'w', quantity: 1 }),
    ).toThrow(InventoryInputError);
  });

  it('purchase receiptKey 幂等去重（Wave-2 验收低危 #4 兑现点）', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    const first = mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', {
          kind: 'purchase',
          itemId: 'item-020',
          warehouseId: ids.wh2,
          quantity: 6,
          purchaseOrderId: 'po-9',
          receiptKey: 'po-9#1',
        }),
      ),
    );
    expect(first.movement?.sourceKey).toBe('po-9#1');
    expect(first.duplicate).toBeUndefined();

    // 重复指令（新 operationId、同 receiptKey）：幂等返回首次结果，不重复入账。
    const retried = mustCommit(
      await h.service.execute(
        envelope(
          'stock.receive.v1',
          {
            kind: 'purchase',
            itemId: 'item-020',
            warehouseId: ids.wh2,
            quantity: 6,
            purchaseOrderId: 'po-9',
            receiptKey: 'po-9#1',
          },
          { operationId: 'op-retry-receipt' },
        ),
      ),
    );
    expect(retried.duplicate).toBe(true);
    expect(retried.events).toEqual([]); // 不重复发事件
    expect(retried.movement?.id).toBe(first.movement?.id);

    const level = (await h.service.stockLevels(t1, ids.wh2, 'item-020'))[0];
    expect(level?.qtyOnHand).toBe(6); // 只入账一次
    const movements = await h.service.listMovements(t1, 'item-020', ids.wh2);
    expect(movements).toHaveLength(1);
  });

  it('purchase 来源缺 receiptKey 为输入错误（listing 端口合同驱动）', () => {
    expect(() =>
      parseStockReceivePayload({ kind: 'purchase', itemId: 'i', warehouseId: 'w', quantity: 1, purchaseOrderId: 'po-1' }),
    ).toThrow(InventoryInputError);
  });
});

// ---- 可用量恒等式与预占 ----

describe('可用量恒等式（可用量=总量−预占，全程机器校验）', () => {
  it('预占扣可用量不扣总量；核销出库可用量不变；释放退回', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-100', ids.wh1, 20);

    // reserve：reserved=5 → available 20→15，onHand 不变。
    const reserved = await h.service.reserveStock(t1, {
      reservationKey: 'rsv-dispatch-1',
      itemId: 'item-100',
      warehouseId: ids.wh1,
      quantity: 5,
      refType: 'dispatch',
      refId: 'dp-1',
    });
    expect(reserved.reserved).toBe(true);
    let level = (await h.service.stockLevels(t1, ids.wh1, 'item-100'))[0];
    expect(level).toMatchObject({ qtyOnHand: 20, qtyReserved: 5, availableQty: 15 });

    // 重复 reserve 幂等（不重复预占）。
    const again = await h.service.reserveStock(t1, {
      reservationKey: 'rsv-dispatch-1',
      itemId: 'item-100',
      warehouseId: ids.wh1,
      quantity: 5,
      refType: 'dispatch',
      refId: 'dp-1',
    });
    expect(again).toMatchObject({ reserved: true, duplicate: true });
    level = (await h.service.stockLevels(t1, ids.wh1, 'item-100'))[0];
    expect(level?.qtyReserved).toBe(5);

    // 核销出库：onHand 20→15、reserved 5→0，available 15 不变（恒等式）。
    const issued = mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', {
          itemId: 'item-100',
          warehouseId: ids.wh1,
          quantity: 5,
          purpose: 'production',
          reservationKey: 'rsv-dispatch-1',
          workOrderId: 'wo-9',
        }),
      ),
    );
    expect(issued.movement?.kind).toBe('issue-out');
    expect(issued.stockLevel).toMatchObject({ qtyOnHand: 15, qtyReserved: 0, availableQty: 15 });
    const reservation = await h.reservations.findByKey(t1, 'rsv-dispatch-1');
    expect(reservation?.status).toBe('consumed');

    // 释放路径：再预占 3 后释放 2 → available +2。
    await h.service.reserveStock(t1, {
      reservationKey: 'rsv-dispatch-2',
      itemId: 'item-100',
      warehouseId: ids.wh1,
      quantity: 3,
      refType: 'dispatch',
      refId: 'dp-2',
    });
    const released = await h.service.releaseReservation(t1, 'rsv-dispatch-2', 2);
    expect(released.released).toBe(true);
    level = (await h.service.stockLevels(t1, ids.wh1, 'item-100'))[0];
    expect(level).toMatchObject({ qtyOnHand: 15, qtyReserved: 1, availableQty: 14 });
  });

  it('直扣出库守卫：可用量不足硬拒绝（负库存默认策略）且不落任何账', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-101', ids.wh1, 4);
    await h.service.reserveStock(t1, {
      reservationKey: 'rsv-101',
      itemId: 'item-101',
      warehouseId: ids.wh1,
      quantity: 3,
      refType: 'dispatch',
      refId: 'dp-1',
    });
    // available = 4−3 = 1 < 2：拒绝。
    const refused = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-101', warehouseId: ids.wh1, quantity: 2, purpose: 'manual' }),
    );
    expect(mustReject(refused)).toContain('可用量不足');
    expect((await h.service.listMovements(t1, 'item-101', ids.wh1)).length).toBe(1); // 只有入库流水
    // issueKey 幂等：首发出库 1 成功，重发 duplicate。
    const first = mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-101', warehouseId: ids.wh1, quantity: 1, purpose: 'manual', issueKey: 'issue-1' }),
      ),
    );
    const retried = mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-101', warehouseId: ids.wh1, quantity: 1, purpose: 'manual', issueKey: 'issue-1' }, { operationId: 'op-retry-issue' }),
      ),
    );
    expect(retried.duplicate).toBe(true);
    expect(retried.movement?.id).toBe(first.movement?.id);
    expect((await h.service.listMovements(t1, 'item-101', ids.wh1)).length).toBe(2); // 入 1 + 出 1
  });

  it('核销路径校验：预占不存在/已核销/锚点不符/余量不足均拒', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-102', ids.wh1, 10);
    const missing = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-102', warehouseId: ids.wh1, quantity: 1, purpose: 'production', reservationKey: 'rsv-none' }),
    );
    expect(mustReject(missing)).toContain("预占 'rsv-none' 不存在");
    await h.service.reserveStock(t1, { reservationKey: 'rsv-102', itemId: 'item-102', warehouseId: ids.wh1, quantity: 2, refType: 'dispatch', refId: 'dp' });
    const wrongItem = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-999', warehouseId: ids.wh1, quantity: 1, purpose: 'production', reservationKey: 'rsv-102' }),
    );
    expect(mustReject(wrongItem)).toContain('锚定');
    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-102', warehouseId: ids.wh1, quantity: 2, purpose: 'production', reservationKey: 'rsv-102' }),
      ),
    );
    const consumedAgain = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-102', warehouseId: ids.wh1, quantity: 1, purpose: 'production', reservationKey: 'rsv-102' }),
    );
    expect(mustReject(consumedAgain)).toContain('已 consumed');
  });

  it('负库存 allow 策略：超卖放行（账面负数暂存——合同 §8 配置化）', async () => {
    const h = makeHarness({ negativeStockPolicy: 'allow' });
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-103', ids.wh1, 3);
    const issued = mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-103', warehouseId: ids.wh1, quantity: 5, purpose: 'manual' }),
      ),
    );
    expect(issued.stockLevel).toMatchObject({ qtyOnHand: -2, qtyReserved: 0, availableQty: -2 });
    // 库位分布同步为负（差额挂默认库位）。
    const balances = await h.service.locationBalances(t1, ids.wh1, 'item-103');
    expect(balances.reduce((sum, row) => sum + row.qty, 0)).toBe(-2);
  });

  it('库位 FIFO 扣减：未指定库位按 createdAt 升序逐位扣；指定库位不足拒', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-104', ids.wh1, 6, ids.raw);
    await receiveProduction(h, 'item-104', ids.wh1, 4, ids.fg);
    // FIFO：先扣 RAW（6），再扣 FG（2/4）。
    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-104', warehouseId: ids.wh1, quantity: 8, purpose: 'production' }),
      ),
    );
    const balances = await h.service.locationBalances(t1, ids.wh1, 'item-104');
    expect(balances.find((row) => row.locationId === ids.raw)?.qty).toBe(0);
    expect(balances.find((row) => row.locationId === ids.fg)?.qty).toBe(2);
    // 指定 RAW（余 0）出库 1：库位不足拒。
    const refused = await h.service.execute(
      envelope('stock.issue.v1', { itemId: 'item-104', warehouseId: ids.wh1, locationId: ids.raw, quantity: 1, purpose: 'production' }),
    );
    expect(mustReject(refused)).toContain('库位余额不足');
  });
});

// ---- 调拨与移库 ----

describe('stock.transfer（跨仓调拨 + 仓内移库）', () => {
  it('跨仓调拨：双流水共用 transferId、两仓账面与库位分布联动、事件发布', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-200', ids.wh1, 10, ids.raw);

    const committed = mustCommit(
      await h.service.execute(
        envelope('stock.transfer.v1', {
          itemId: 'item-200',
          fromWarehouseId: ids.wh1,
          toWarehouseId: ids.wh2,
          quantity: 4,
        }),
      ),
    );
    expect((committed.movements as readonly { kind: string }[]).map((row) => row.kind)).toEqual(['transfer-out', 'transfer-in']);
    const transferId = (committed.movements as readonly { transferId: string | null }[])[0]?.transferId;
    expect(transferId).toMatch(/^trf-/);
    expect((committed.movements as readonly { transferId: string | null }[])[1]?.transferId).toBe(transferId);
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-200'))[0]).toMatchObject({ qtyOnHand: 6 });
    expect((await h.service.stockLevels(t1, ids.wh2, 'item-200'))[0]).toMatchObject({ qtyOnHand: 4 });
    const payload = committed.events[0]?.payload as { intraWarehouse: boolean; fromWarehouseId: string; toWarehouseId: string };
    expect(payload.intraWarehouse).toBe(false);
    expect(payload.fromWarehouseId).toBe(ids.wh1);
  });

  it('仓内移库：仓库账面不变、库位分布换位', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-201', ids.wh1, 7, ids.raw);
    const committed = mustCommit(
      await h.service.execute(
        envelope('stock.transfer.v1', {
          itemId: 'item-201',
          fromWarehouseId: ids.wh1,
          toWarehouseId: ids.wh1,
          fromLocationId: ids.raw,
          toLocationId: ids.fg,
          quantity: 7,
        }),
      ),
    );
    expect((committed.events[0]?.payload as { intraWarehouse: boolean }).intraWarehouse).toBe(true);
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-201'))[0]?.qtyOnHand).toBe(7);
    const balances = await h.service.locationBalances(t1, ids.wh1, 'item-201');
    expect(balances.find((row) => row.locationId === ids.raw)?.qty ?? 0).toBe(0);
    expect(balances.find((row) => row.locationId === ids.fg)?.qty).toBe(7);
  });

  it('调拨可用量不足拒绝；源库位余额不足拒绝；同位移库输入错误', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-202', ids.wh1, 3);
    const refused = await h.service.execute(
      envelope('stock.transfer.v1', { itemId: 'item-202', fromWarehouseId: ids.wh1, toWarehouseId: ids.wh2, quantity: 5 }),
    );
    expect(mustReject(refused)).toContain('调拨可用量不足');
    expect(() =>
      parseStockTransferPayload({ itemId: 'i', fromWarehouseId: 'w', toWarehouseId: 'w', fromLocationId: 'a', toLocationId: 'a', quantity: 1 }),
    ).toThrow(InventoryInputError);
  });
});

// ---- 盘点全链 ----

describe('stocktake（实盘-审核-调账；调账留痕且账面=实盘）', () => {
  async function seedForStocktake(h: Harness): Promise<{ readonly wh1: string; readonly raw: string; readonly fg: string }> {
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-A', ids.wh1, 10, ids.raw);
    await receiveProduction(h, 'item-B', ids.wh1, 4, ids.fg);
    await receiveProduction(h, 'item-C', ids.wh2, 9, ids.ext);
    return ids;
  }

  it('开单：scope 快照 systemQty，draft→counting；盘点中多轮录入不推版本', async () => {
    const h = makeHarness();
    const ids = await seedForStocktake(h);
    const opened = mustCommit(
      await h.service.execute(
        envelope('stocktake.open.v1', { warehouseId: ids.wh1 }, { actor: counter }),
      ),
    );
    const stocktake = opened.stocktake as { readonly id: string; readonly state: string; readonly lines: readonly { itemId: string; systemQty: number }[] };
    expect(stocktake.state).toBe('counting');
    expect(opened.newRevision).toBe(2);
    expect(stocktake.lines.map((line) => [line.itemId, line.systemQty])).toEqual([
      ['item-A', 10],
      ['item-B', 4],
    ]); // WH2 不在 scope

    const recorded = mustCommit(
      await h.service.execute(
        envelope('stocktake.record.v1', { lines: [{ itemId: 'item-A', countedQty: 9 }], complete: false }, { expectedRevision: 2, actor: counter }),
        stocktake.id,
      ),
    );
    expect(recorded.newRevision).toBe(2); // 录行不推版本
    expect((recorded.stocktake as { lines: readonly { countedQty: number | null }[] }).lines[0]?.countedQty).toBe(9);

    // scope 外物料拒绝。
    const outOfScope = await h.service.execute(
      envelope('stocktake.record.v1', { lines: [{ itemId: 'item-C', countedQty: 1 }], complete: false }, { expectedRevision: 2, actor: counter }),
      stocktake.id,
    );
    expect(mustReject(outOfScope)).toContain("不在盘点单 scope 内");
  });

  it('complete 提交：未盘完拒绝；盘完进 reconciled', async () => {
    const h = makeHarness();
    const ids = await seedForStocktake(h);
    const opened = mustCommit(
      await h.service.execute(envelope('stocktake.open.v1', { warehouseId: ids.wh1 }, { actor: counter })),
    );
    const stocktakeId = (opened.stocktake as { readonly id: string }).id;
    const early = await h.service.execute(
      envelope('stocktake.record.v1', { lines: [{ itemId: 'item-A', countedQty: 9 }], complete: true }, { expectedRevision: 2, actor: counter }),
      stocktakeId,
    );
    expect(mustReject(early)).toContain('仍有 1 行未录实盘');
    const done = mustCommit(
      await h.service.execute(
        envelope(
          'stocktake.record.v1',
          { lines: [{ itemId: 'item-A', countedQty: 9 }, { itemId: 'item-B', countedQty: 4 }], complete: true },
          { expectedRevision: 2, actor: counter },
        ),
        stocktakeId,
      ),
    );
    expect(done.newRevision).toBe(3);
    expect((done.stocktake as { readonly state: string }).state).toBe('reconciled');
  });

  it('审核调账：盘盈/盘亏流水 + StocktakeAdjusted 留痕 + 账面=实盘（台账对账要点）', async () => {
    const h = makeHarness();
    const ids = await seedForStocktake(h);
    // 先开单（快照 item-A=10），开单后账面变动（又入 5 → 当前 15）：
    // 调账以当前账面为基（movement=实盘−当前账面），审计差异=实盘−开单快照。
    const opened = mustCommit(
      await h.service.execute(envelope('stocktake.open.v1', { warehouseId: ids.wh1 }, { actor: counter })),
    );
    const stocktake = opened.stocktake as {
      readonly id: string;
      readonly lines: readonly { itemId: string; systemQty: number }[];
    };
    expect(stocktake.lines.find((line) => line.itemId === 'item-A')?.systemQty).toBe(10); // 快照锁定
    await receiveProduction(h, 'item-A', ids.wh1, 5, ids.raw); // 开单后账面变动（快照不变）
    mustCommit(
      await h.service.execute(
        envelope(
          'stocktake.record.v1',
          { lines: [{ itemId: 'item-A', countedQty: 12 }, { itemId: 'item-B', countedQty: 3 }], complete: true },
          { expectedRevision: 2, actor: counter },
        ),
        stocktake.id,
      ),
    );
    const adjusted = mustCommit(
      await h.service.execute(
        envelope('stocktake.approve-adjust.v1', { remark: '月度盘点核销' }, { expectedRevision: 3, actor: auditor }),
        stocktake.id,
      ),
    );
    expect(adjusted.newRevision).toBe(4);
    expect((adjusted.stocktake as { readonly state: string; readonly approvedBy: string }).state).toBe('adjusted');
    // 账面=实盘（对账要点）。
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-A'))[0]?.qtyOnHand).toBe(12);
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-B'))[0]?.qtyOnHand).toBe(3);
    // 调账流水（movement = 实盘 − 当前账面）：item-A 12−15=−3 盘亏 3、item-B 3−4=−1 盘亏 1。
    const kinds = (adjusted.movements as readonly { itemId: string; kind: string; quantity: number }[])
      .map((row) => [row.itemId, row.kind, row.quantity]);
    expect(kinds).toEqual([
      ['item-A', 'stocktake-loss', 3],
      ['item-B', 'stocktake-loss', 1],
    ]);
    // StocktakeAdjusted 审计载荷：差异行=实盘−开单快照（item-A 12−10=+2 盘盈口径）。
    const payload = adjusted.events[0]?.payload as {
      readonly stocktakeId: string;
      readonly adjustments: readonly { itemId: string; diffQty: number }[];
      readonly totalBefore: number;
      readonly totalAfter: number;
    };
    expect(payload.adjustments).toEqual([
      { itemId: 'item-A', systemQty: 10, countedQty: 12, diffQty: 2 },
      { itemId: 'item-B', systemQty: 4, countedQty: 3, diffQty: -1 },
    ]);
    expect(payload.totalBefore).toBe(14); // 开单快照合计 10+4
    expect(payload.totalAfter).toBe(15); // 实盘合计 12+3
    expect(adjusted.events[0]?.eventType).toBe(INVENTORY_EVENT_TYPES.stocktakeAdjusted);
    expect((adjusted.events[0]?.aggregate as { type: string }).type).toBe(STOCKTAKE_AGGREGATE_TYPE);

    // 终态再调账拒绝。
    const again = await h.service.execute(
      envelope('stocktake.approve-adjust.v1', { remark: '再次调账' }, { expectedRevision: 4, actor: auditor }),
      stocktake.id,
    );
    expect(mustReject(again)).toContain("不支持审核调账");
  });

  it('乐观锁：expectedRevision 不符拒绝；重复 operationId 拒绝', async () => {
    const h = makeHarness();
    const ids = await seedForStocktake(h);
    const opened = mustCommit(
      await h.service.execute(envelope('stocktake.open.v1', { warehouseId: ids.wh1 }, { actor: counter })),
    );
    const stocktakeId = (opened.stocktake as { readonly id: string }).id;
    const stale = await h.service.execute(
      envelope('stocktake.record.v1', { lines: [{ itemId: 'item-A', countedQty: 1 }], complete: false }, { expectedRevision: 99, actor: counter }),
      stocktakeId,
    );
    expect(mustReject(stale)).toContain('乐观锁冲突');
    const first = await h.service.execute(
      envelope('stocktake.record.v1', { lines: [{ itemId: 'item-A', countedQty: 1 }], complete: false }, { expectedRevision: 2, actor: counter, operationId: 'op-dup-1' }),
      stocktakeId,
    );
    expect(first.status).toBe('committed');
    const duplicate = await h.service.execute(
      envelope('stocktake.record.v1', { lines: [{ itemId: 'item-A', countedQty: 1 }], complete: false }, { expectedRevision: 2, actor: counter, operationId: 'op-dup-1' }),
      stocktakeId,
    );
    expect(mustReject(duplicate)).toContain('操作幂等冲突');
  });

  it('指定 scope itemIds：只盘给定的物料（无账物料 systemQty=0 可盘盈）', async () => {
    const h = makeHarness();
    const ids = await seedForStocktake(h);
    const opened = mustCommit(
      await h.service.execute(
        envelope('stocktake.open.v1', { warehouseId: ids.wh1, itemIds: ['item-B', 'item-Z'] }, { actor: counter }),
      ),
    );
    const stocktake = opened.stocktake as { readonly lines: readonly { itemId: string; systemQty: number }[] };
    expect(stocktake.lines.map((line) => [line.itemId, line.systemQty])).toEqual([
      ['item-B', 4],
      ['item-Z', 0],
    ]);
  });
});

// ---- 发货链 ----

describe('shipping.execute / confirm（执行出库 + 确认联动）', () => {
  it('执行即出库（直扣），确认发 ShippingConfirmed（workOrderId 联动锚点）', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-300', ids.wh1, 10, ids.raw);

    const executed = mustCommit(
      await h.service.execute(
        envelope('shipping.execute.v1', {
          workOrderId: 'wo-ship-1',
          lines: [{ itemId: 'item-300', quantity: 6, warehouseId: ids.wh1 }],
          remark: '生产发料',
        }),
      ),
    );
    const shipping = executed.shippingOrder as { readonly id: string; readonly state: string; readonly lines: readonly { itemId: string; quantity: number }[] };
    expect(shipping.state).toBe('executing');
    expect(executed.newRevision).toBe(2);
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-300'))[0]).toMatchObject({ qtyOnHand: 4 });
    expect(executed.events.map((event) => event.eventType)).toEqual([INVENTORY_EVENT_TYPES.stockIssued]);
    expect((executed.events[0]?.payload as { movementKind: string }).movementKind).toBe('shipping-out');

    const confirmed = mustCommit(
      await h.service.execute(
        envelope('shipping.confirm.v1', { carrier: '顺丰', trackingNo: 'SF-001', remark: '已发运' }, { expectedRevision: 2 }),
        shipping.id,
      ),
    );
    expect(confirmed.newRevision).toBe(3);
    const advanced = confirmed.shippingOrder as { readonly state: string; readonly carrier: string | null; readonly trackingNo: string | null; readonly confirmedAt: string | null };
    expect(advanced.state).toBe('shipped');
    expect(advanced.carrier).toBe('顺丰');
    expect(advanced.confirmedAt).toBe(FIXED_NOW);
    const payload = confirmed.events[0]?.payload as {
      readonly shippingOrderId: string;
      readonly workOrderId: string | null;
      readonly carrier: string | null;
      readonly lines: readonly { itemId: string }[];
    };
    expect(confirmed.events[0]?.eventType).toBe(INVENTORY_EVENT_TYPES.shippingConfirmed);
    expect(payload.workOrderId).toBe('wo-ship-1');
    expect(payload.carrier).toBe('顺丰');
    expect(payload.lines).toHaveLength(1);
    expect((confirmed.events[0]?.aggregate as { type: string }).type).toBe(SHIPPING_ORDER_AGGREGATE_TYPE);

    // 终态再确认拒绝。
    const again = await h.service.execute(
      envelope('shipping.confirm.v1', { remark: '再次确认' }, { expectedRevision: 3 }),
      shipping.id,
    );
    expect(mustReject(again)).toContain('不支持确认发货');
  });

  it('行级预占核销：发料任务创建即预占 → 发货执行核销（可用量不变）', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-301', ids.wh1, 10);
    await h.service.reserveStock(t1, {
      reservationKey: 'rsv-ship-1',
      itemId: 'item-301',
      warehouseId: ids.wh1,
      quantity: 8,
      refType: 'issue-task',
      refId: 'task-1',
    });
    const executed = mustCommit(
      await h.service.execute(
        envelope('shipping.execute.v1', {
          workOrderId: 'wo-ship-2',
          lines: [{ itemId: 'item-301', quantity: 8, warehouseId: ids.wh1, reservationKey: 'rsv-ship-1' }],
        }),
      ),
    );
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-301'))[0]).toMatchObject({
      qtyOnHand: 2,
      qtyReserved: 0,
      availableQty: 2,
    });
    expect(await h.reservations.findByKey(t1, 'rsv-ship-1')).toMatchObject({ status: 'consumed' });
    expect((executed.events[0]?.payload as { consumedReservationQty: number }).consumedReservationQty).toBe(8);
  });

  it('两阶段预校验：任一行不可出库整单拒绝不落账', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-302', ids.wh1, 3);
    const refused = await h.service.execute(
      envelope('shipping.execute.v1', {
        workOrderId: 'wo-ship-3',
        lines: [
          { itemId: 'item-302', quantity: 2, warehouseId: ids.wh1 },
          { itemId: 'item-302', quantity: 5, warehouseId: ids.wh1 }, // 超可用量
        ],
      }),
    );
    expect(mustReject(refused)).toContain('可用量不足'); // 合计口径：2+5=7 > 3
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-302'))[0]?.qtyOnHand).toBe(3); // 未动账
    expect(await h.service.listShippingOrders(t1)).toHaveLength(0); // 未建任务
  });

  it('未配置默认仓且行未带仓拒绝；发货记录查询（state/workOrderId 过滤）', async () => {
    const h = makeHarness(); // 未配置 defaultWarehouseCode
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-303', ids.wh1, 5);
    const refused = await h.service.execute(
      envelope('shipping.execute.v1', { lines: [{ itemId: 'item-303', quantity: 1 }] }),
    );
    expect(mustReject(refused)).toContain('未指定仓库且未配置默认仓');

    const defaultedService = h.rebuild({ defaultWarehouseCode: 'WH1' });
    mustCommit(
      await defaultedService.execute(
        envelope('shipping.execute.v1', { workOrderId: 'wo-1', lines: [{ itemId: 'item-303', quantity: 2 }] }),
      ),
    );
    const rows = await defaultedService.listShippingOrders(t1);
    expect(rows).toHaveLength(1);
    expect((await defaultedService.listShippingOrders(t1, 'shipped'))).toHaveLength(0);
    expect((await defaultedService.listShippingOrders(t1, undefined, 'wo-1'))).toHaveLength(1);
    const detail = await defaultedService.shippingDetail(t1, (rows[0] as { readonly id: string }).id);
    expect(detail.milestones.map((row) => row.event)).toEqual(['EXECUTE']);
  });

  it('发货出库缺预占（预占已释放）整单拒绝', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-304', ids.wh1, 10);
    await h.service.reserveStock(t1, { reservationKey: 'rsv-304', itemId: 'item-304', warehouseId: ids.wh1, quantity: 5, refType: 'issue-task', refId: 'task' });
    await h.service.releaseReservation(t1, 'rsv-304', null);
    const refused = await h.service.execute(
      envelope('shipping.execute.v1', {
        lines: [{ itemId: 'item-304', quantity: 5, warehouseId: ids.wh1, reservationKey: 'rsv-304' }],
      }),
    );
    expect(mustReject(refused)).toContain("预占 'rsv-304' 已 released");
  });
});

// ---- 兄弟端口适配器（inventory 是实现方） ----

describe('跨模块端口适配器（组合根合流注入）', () => {
  it('可用量供给：跨仓 Σ max(0, 总量−预占)（workorder 齐套/listing 缺口共用口径）', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-400', ids.wh1, 10);
    await receiveProduction(h, 'item-400', ids.wh2, 5);
    await receiveProduction(h, 'item-401', ids.wh1, 2);
    await h.service.reserveStock(t1, { reservationKey: 'rsv-400', itemId: 'item-400', warehouseId: ids.wh1, quantity: 4, refType: 'dispatch', refId: 'dp' });
    const availability = createInventoryAvailabilityAdapter(h.service);
    const result = await availability.availableQty(t1, ['item-400', 'item-401', 'item-402']);
    expect(result.get('item-400')).toBe(11); // (10−4) + 5
    expect(result.get('item-401')).toBe(2);
    expect(result.get('item-402')).toBe(0); // 缺项 = 0
  });

  it('listing InventoryReceiptPort 适配器：拒绝传播 + receiptKey 幂等 + 默认仓', async () => {
    const h = makeHarness(); // 未配置默认仓：端口面拒绝
    const refused = await h.service.receivePurchaseStock(t1, {
      receiptKey: 'po-1#1',
      purchaseOrderId: 'po-1',
      itemId: 'item-410',
      quantity: 3,
    });
    expect(refused.received).toBe(false);

    const ids = await seedWarehouses(h);
    const receipt = createInventoryReceiptAdapter(h.rebuild({ defaultWarehouseCode: 'WH2' }));
    const first = await receipt.receivePurchase(t1, {
      receiptKey: 'po-2#1',
      purchaseOrderId: 'po-2',
      itemId: 'item-410',
      quantity: 3,
    });
    expect(first.received).toBe(true);
    const retried = await receipt.receivePurchase(t1, {
      receiptKey: 'po-2#1',
      purchaseOrderId: 'po-2',
      itemId: 'item-410',
      quantity: 3,
    });
    expect(retried).toMatchObject({ received: true, duplicate: true });
    expect((await h.service.stockLevels(t1, ids.wh2, 'item-410'))[0]?.qtyOnHand).toBe(3);
  });

  it('workorder PartsIssuePort 适配器：requestId 幂等（重试不重复扣减）', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-420', ids.wh1, 8);
    const partsIssue = createPartsIssueAdapter(h.rebuild({ defaultWarehouseCode: 'WH1' }));
    const first = await partsIssue.issueParts(t1, {
      requestId: 'pr-1',
      workOrderId: 'wo-1',
      itemId: 'item-420',
      quantity: 3,
    });
    expect(first.issued).toBe(true);
    const retried = await partsIssue.issueParts(t1, {
      requestId: 'pr-1',
      workOrderId: 'wo-1',
      itemId: 'item-420',
      quantity: 3,
    });
    expect(retried).toMatchObject({ issued: true, duplicate: true });
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-420'))[0]?.qtyOnHand).toBe(5);
    const movements = await h.service.listMovements(t1, 'item-420', ids.wh1);
    expect(movements).toHaveLength(2); // 入 1 + 出 1
    expect(movements[1]?.sourceRefType).toBe('parts-request');
    // 可用量不足拒绝传播（listing/workorder 整单 rejected 的联动合同）。
    const refused = await partsIssue.issueParts(t1, {
      requestId: 'pr-2',
      workOrderId: 'wo-1',
      itemId: 'item-420',
      quantity: 99,
    });
    expect(refused.issued).toBe(false);
    expect(refused.refusedReason).toContain('可用量不足');
  });

  it('inspection StockReleasePort 适配器：recordRelease 幂等（同 releasedAt）+ 放行可入', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    const recorder = createStockReleaseRecorder(h.service);
    await recorder.recordRelease(t1, {
      inspectionId: 'insp-9',
      kind: 'self_outsourced',
      itemId: 'item-430',
      drawingNo: 'DW-1',
      quantity: 7,
      sourceType: 'report',
      sourceRefId: 'rep-1',
      releasedAt: FIXED_NOW,
    });
    await recorder.recordRelease(t1, {
      inspectionId: 'insp-9',
      kind: 'self_outsourced',
      itemId: 'item-430',
      drawingNo: 'DW-1',
      quantity: 7,
      sourceType: 'report',
      sourceRefId: 'rep-1',
      releasedAt: FIXED_NOW, // 同轮重试
    });
    expect(await h.releaseFacts.listByInspection(t1, 'insp-9')).toHaveLength(1);
    const receipt = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'inspection',
        itemId: 'item-430',
        warehouseId: ids.wh1,
        quantity: 7,
        inspectionId: 'insp-9',
      }),
    );
    expect(receipt.status).toBe('committed');
  });

  it('预占端口（StockReservationPort 语义面）：reserve 幂等/键不复用拒绝、release 全量', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-440', ids.wh1, 10);
    expect(
      await h.service.reserveStock(t1, { reservationKey: 'k1', itemId: 'item-440', warehouseId: ids.wh1, quantity: 4, refType: 'dispatch', refId: 'dp-1' }),
    ).toMatchObject({ reserved: true });
    expect(
      await h.service.reserveStock(t1, { reservationKey: 'k1', itemId: 'item-440', warehouseId: ids.wh1, quantity: 4, refType: 'dispatch', refId: 'dp-1' }),
    ).toMatchObject({ reserved: true, duplicate: true });
    expect(await h.service.releaseReservation(t1, 'k1', null)).toMatchObject({ released: true });
    const reuse = await h.service.reserveStock(t1, { reservationKey: 'k1', itemId: 'item-440', warehouseId: ids.wh1, quantity: 1, refType: 'dispatch', refId: 'dp-1' });
    expect(reuse.reserved).toBe(false);
    expect(reuse.refusedReason).toContain('不得复用');
    expect((await h.service.stockLevels(t1, ids.wh1, 'item-440'))[0]).toMatchObject({ qtyReserved: 0, availableQty: 10 });
  });
});

// ---- D-16 默认仓按租户 code 解析（retest-8abac21：全局单值 id 只对一个租户有效） ----

describe('D-16 默认仓按租户解析（服务选项 defaultWarehouseCode；各租户同 code 仓 id 不同）', () => {
  const t3 = TenantId.create('t3');

  /** 租户内建 code=MAIN 仓，返回仓 id。 */
  async function defineMain(h: Harness, tenant: TenantId): Promise<string> {
    const committed = mustCommit(
      await h.service.execute(
        envelope('warehouse.define.v1', { code: 'MAIN', name: '主仓', locations: [{ code: 'M1', name: null }] }, { tenant }),
      ),
    );
    return (committed.warehouse as { readonly id: string }).id;
  }

  it('收货三态：同 code 回落各租户自己的 MAIN（t1/t2）；租户内无此编码仓拒绝；未配置拒绝', async () => {
    // 态一：配置 code=MAIN + 各租户 MAIN 存在 → 同一服务实例按租户各自解析落位。
    const h = makeHarness();
    const mainT1 = await defineMain(h, t1);
    const mainT2 = await defineMain(h, t2);
    expect(mainT1).not.toBe(mainT2); // 各租户 MAIN 仓 id 不同（D-16 症状根因）

    const defaulted = h.rebuild({ defaultWarehouseCode: 'MAIN' });
    const receiptT1 = await defaulted.receivePurchaseStock(t1, {
      receiptKey: 'po-d16-t1#1',
      purchaseOrderId: 'po-d16-t1',
      itemId: 'item-d16',
      quantity: 2,
    });
    expect(receiptT1.received).toBe(true);
    expect((await defaulted.stockLevels(t1, mainT1, 'item-d16'))[0]?.qtyOnHand).toBe(2);

    const receiptT2 = await defaulted.receivePurchaseStock(t2, {
      receiptKey: 'po-d16-t2#1',
      purchaseOrderId: 'po-d16-t2',
      itemId: 'item-d16',
      quantity: 3,
    });
    expect(receiptT2.received).toBe(true);
    expect((await defaulted.stockLevels(t2, mainT2, 'item-d16'))[0]?.qtyOnHand).toBe(3);
    // 不串租户：t2 收货不落 t1 的 MAIN（id 不同即不存在于 t2）。
    expect((await defaulted.stockLevels(t2, mainT1, 'item-d16')).length).toBe(0);

    // 态二：配置了 code 但该租户内无此编码仓（t3 未建 MAIN）→ 明确拒绝（fail-visible）。
    const refusedT3 = await defaulted.receivePurchaseStock(t3, {
      receiptKey: 'po-d16-t3#1',
      purchaseOrderId: 'po-d16-t3',
      itemId: 'item-d16',
      quantity: 1,
    });
    expect(refusedT3.received).toBe(false);
    expect(refusedT3.refusedReason).toContain("租户 't3' 内不存在默认仓编码 'MAIN'");

    // 态三：未配置默认仓（原 harness 服务）→ D-15 行为保持：必须显式传仓。
    const refusedUnconfigured = await h.service.receivePurchaseStock(t1, {
      receiptKey: 'po-d16-t1#2',
      purchaseOrderId: 'po-d16-t1',
      itemId: 'item-d16',
      quantity: 1,
    });
    expect(refusedUnconfigured.received).toBe(false);
    expect(refusedUnconfigured.refusedReason).toContain('未指定收货仓且未配置默认仓');
  });

  it('发料/预占同语义：code 回落租户内 MAIN；显式仓优先于默认仓', async () => {
    const h = makeHarness();
    const mainT1 = await defineMain(h, t1);
    const otherCommitted = mustCommit(
      await h.service.execute(
        envelope('warehouse.define.v1', { code: 'WH-OTHER', name: '非默认仓', locations: [{ code: 'O1', name: null }] }),
      ),
    );
    const otherId = (otherCommitted.warehouse as { readonly id: string }).id;
    // 各仓先显式入账（未配默认仓的 h.service：显式仓收货 D-15 语义保持）。
    for (const [warehouseId, quantity] of [
      [mainT1, 6],
      [otherId, 5],
    ] as const) {
      const received = await h.service.receivePurchaseStock(t1, {
        receiptKey: `po-d16-x#${warehouseId}`,
        purchaseOrderId: 'po-d16-x',
        itemId: 'item-d16b',
        quantity,
        warehouseId,
      });
      expect(received.received).toBe(true);
    }
    const defaulted = h.rebuild({ defaultWarehouseCode: 'MAIN' });

    // 预占回落：未带仓 → 解析到 t1 的 MAIN（预占量挂 mainT1）。
    const reserved = await defaulted.reserveStock(t1, {
      reservationKey: 'rsv-d16',
      itemId: 'item-d16b',
      quantity: 4,
      refType: 'dispatch',
      refId: 'dp-d16',
    });
    expect(reserved.reserved).toBe(true);
    expect((await defaulted.stockLevels(t1, mainT1, 'item-d16b'))[0]).toMatchObject({ qtyOnHand: 6, qtyReserved: 4 });
    await defaulted.releaseReservation(t1, 'rsv-d16', null);

    // 发料显式仓优先：显式 otherId 落 other 仓，默认仓 MAIN 不动。
    const issued = await defaulted.issuePartsStock(t1, {
      requestId: 'pr-d16',
      workOrderId: 'wo-d16',
      itemId: 'item-d16b',
      quantity: 3,
      warehouseId: otherId,
    });
    expect(issued.issued).toBe(true);
    expect((await defaulted.stockLevels(t1, otherId, 'item-d16b'))[0]?.qtyOnHand).toBe(2);
    expect((await defaulted.stockLevels(t1, mainT1, 'item-d16b'))[0]?.qtyOnHand).toBe(6);
  });
});

// ---- 幂等、信封纪律与租户隔离 ----

describe('命令纪律与租户隔离', () => {
  it('创建命令 expectedRevision 须 initial；既有对象命令须数字', async () => {
    const h = makeHarness();
    const bad = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'i', warehouseId: 'w', quantity: 1 }, { expectedRevision: 5 }),
    );
    expect(mustReject(bad)).toContain("expectedRevision 须为 'initial'");
    const bad2 = await h.service.execute(
      envelope('shipping.confirm.v1', { remark: null }),
    );
    expect(mustReject(bad2)).toContain('expectedRevision 须为当前 objectVersion 数字');
  });

  it('查询 404：仓库/盘点单/发货任务不存在抛 InventoryNotFoundError', async () => {
    const h = makeHarness();
    await expect(h.service.warehouseDetail(t1, 'wh-none')).rejects.toThrow(InventoryNotFoundError);
    await expect(h.service.stocktakeDetail(t1, 'st-none')).rejects.toThrow(InventoryNotFoundError);
    await expect(h.service.shippingDetail(t1, 'ship-none')).rejects.toThrow(InventoryNotFoundError);
  });

  it('租户隔离：t2 看不到 t1 的仓库/库存/流水', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    await receiveProduction(h, 'item-500', ids.wh1, 6);
    expect(await h.service.listWarehouses(t2)).toHaveLength(0);
    expect(await h.service.stockLevels(t2)).toHaveLength(0);
    expect(await h.service.listMovements(t2)).toHaveLength(0);
    const cross = await h.service.execute(
      envelope('stock.receive.v1', { kind: 'production', itemId: 'item-500', warehouseId: ids.wh1, quantity: 1 }, { tenant: t2 }),
    );
    expect(mustReject(cross)).toContain("不存在仓库"); // t2 名下无 WH1
  });

  it('信封体解析：kind 非法/载荷非对象拒绝；状态过滤参数形状', () => {
    expect(() => parseCommandEnvelopeBody({ operationId: 'op', expectedRevision: 'initial', command: { kind: 'stock.unknown.v1', payload: {} } })).toThrow(InventoryInputError);
    expect(() => parseCommandEnvelopeBody({ operationId: 'op', expectedRevision: 'initial', command: { kind: 'stock.issue.v1', payload: null } })).toThrow(InventoryInputError);
    expect(parseStateFilter('counting')).toBe('counting');
    expect(parseStateFilter(undefined)).toBeUndefined();
    expect(() => parseStateFilter('Counting!')).toThrow(InventoryInputError);
  });

  it('事件账本 + Outbox：域事件可按聚合读回、Outbox pending 与投递记账', async () => {
    const h = makeHarness();
    const ids = await seedWarehouses(h);
    const committed = mustCommit(
      await h.service.execute(
        envelope('stock.receive.v1', { kind: 'production', itemId: 'item-600', warehouseId: ids.wh1, quantity: 2 }),
      ),
    );
    const movementId = (committed.movement as { readonly id: string }).id;
    const stored = await h.domainEvents.byAggregate({ id: movementId, type: 'stock-movement' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.eventType).toBe(INVENTORY_EVENT_TYPES.stockReceived);
    const pending = await h.domainEvents.pendingOutbox();
    expect(pending).toHaveLength(1);
    await h.domainEvents.markDelivered(stored[0]?.eventId as import('@smes/business-core').EventId, FIXED_NOW);
    expect(await h.domainEvents.pendingOutbox()).toHaveLength(0);
  });
});

// ---- 模块装配与权限码 ----

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = InventoryModule.register();
    expect(module.controllers).toEqual([
      WarehousesController,
      GoodsShelvesController,
      ShelfLocationsController,
      StockMovementCommandsController,
      StocktakingController,
      ShippingOrdersController,
      InventoryQueriesController,
    ]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, InventoryModule)).toBeUndefined();
  });

  it('权限码：28 路由逐点声明（07-inventory.md §5 最小集 + B3 货架面沿用仓库权限码）', () => {
    const expected: readonly [object, string, string][] = [
      [WarehousesController.prototype, 'define', 'warehouse:write'],
      [WarehousesController.prototype, 'list', 'warehouse:read'],
      [WarehousesController.prototype, 'get', 'warehouse:read'],
      [GoodsShelvesController.prototype, 'define', 'warehouse:write'],
      [GoodsShelvesController.prototype, 'list', 'warehouse:read'],
      [GoodsShelvesController.prototype, 'get', 'warehouse:read'],
      [GoodsShelvesController.prototype, 'update', 'warehouse:write'],
      [GoodsShelvesController.prototype, 'setStatus', 'warehouse:write'],
      [GoodsShelvesController.prototype, 'remove', 'warehouse:write'],
      [GoodsShelvesController.prototype, 'defineLocation', 'warehouse:write'],
      [ShelfLocationsController.prototype, 'update', 'warehouse:write'],
      [ShelfLocationsController.prototype, 'setStatus', 'warehouse:write'],
      [ShelfLocationsController.prototype, 'remove', 'warehouse:write'],
      [StockMovementCommandsController.prototype, 'receive', 'stock:receive'],
      [StockMovementCommandsController.prototype, 'issue', 'stock:issue'],
      [StockMovementCommandsController.prototype, 'transfer', 'stock:transfer'],
      [StocktakingController.prototype, 'open', 'stocktake:record'],
      [StocktakingController.prototype, 'record', 'stocktake:record'],
      [StocktakingController.prototype, 'approveAdjust', 'stocktake:approve'],
      [ShippingOrdersController.prototype, 'execute', 'shipping:execute'],
      [ShippingOrdersController.prototype, 'confirm', 'shipping:execute'],
      [ShippingOrdersController.prototype, 'list', 'shipping:read'],
      [ShippingOrdersController.prototype, 'get', 'shipping:read'],
      [InventoryQueriesController.prototype, 'stock', 'stock:read'],
      [InventoryQueriesController.prototype, 'locationBalances', 'stock:read'],
      [InventoryQueriesController.prototype, 'movements', 'stock:read'],
      [InventoryQueriesController.prototype, 'stocktakes', 'stocktake:read'],
      [InventoryQueriesController.prototype, 'stocktake', 'stocktake:read'],
    ];
    expect(expected).toHaveLength(28);
    for (const [target, method, code] of expected) {
      const actual = Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (target as unknown as Record<string, object>)[method] as object,
      );
      expect(actual, `${String(method)} 权限码`).toBe(code);
    }
  });
});
