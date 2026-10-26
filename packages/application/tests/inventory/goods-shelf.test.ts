/**
 * B3 货架与货架库位测试（fix-wave-6 6b-1，PRD 15 册 RREQ-IV-002；源《仓库
 * 基础信息模块》§2.3-2.4/§3.3-3.4）：主数据 CRUD 与保护（仓内编码唯一/
 * 前缀+表内唯一/有下属锁码/正结存不得停删/流水引用不得删改码）+ 既有库位面
 * 兼容（两级变三级可选形态——落位引用扩展到已启用货架库位，收发存/调拨/
 * 发货/库位分布全径）+ 租户隔离。全部零框架直连（内存实现）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InventoryInputError, InventoryNotFoundError } from '../../src/inventory/inventory-errors.js';
import {
  parseGoodsShelfDefinePayload,
  parseGoodsShelfUpdatePayload,
} from '../../src/inventory/inventory-input.js';
import {
  InMemoryGoodsShelfStore,
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
import { InventoryService } from '../../src/inventory/inventory.service.js';
import type { InventoryCommand, InventoryCommandKind } from '../../src/inventory/inventory-input.js';
import type { InventoryCommandResult } from '../../src/inventory/inventory.service.js';
import type { GoodsShelf, ShelfLocation } from '../../src/inventory/inventory-stores.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const keeper = UserId.create('u-keeper-01');
const FIXED_NOW = '2026-10-26T10:00:00.000Z';

interface Harness {
  readonly service: InventoryService;
  readonly goodsShelves: InMemoryGoodsShelfStore;
}

function makeHarness(): Harness {
  const goodsShelves = new InMemoryGoodsShelfStore();
  const service = new InventoryService(
    new InMemoryWarehouseStore(),
    new InMemoryStockAccountStore(),
    new InMemoryStockLocationBalanceStore(),
    new InMemoryStockMovementStore(),
    new InMemoryStockReservationStore(),
    new InMemoryStocktakeStore(),
    new InMemoryShippingOrderStore(),
    new InMemoryReleaseFactStore(),
    new InMemoryInventoryOperationStore(),
    new InMemoryInventoryDomainEventStore(),
    createInMemoryApprovalEventStore(),
    { now: () => FIXED_NOW },
    goodsShelves, // 尾参（服务构造口径：options 之后；模块面 register 恒显式注入）
  );
  return { service, goodsShelves };
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
    operationId: OperationId.create(options.operationId ?? `op-b3-${operationSeq}`),
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

/** 建一仓（WH1 直属库位 RAW）+ 一架（A1 含 A101，随建）。 */
async function seedWarehouseAndShelf(h: Harness): Promise<{
  readonly warehouseId: string;
  readonly shelf: GoodsShelf;
  readonly shelfLocation: ShelfLocation;
}> {
  const warehouse = mustCommit(
    await h.service.execute(
      envelope('warehouse.define.v1', { code: 'WH1', name: '主仓', locations: [{ code: 'RAW', name: '原料区' }] }),
    ),
  ).warehouse as { readonly id: string };
  const shelf = mustCommit(
    await h.service.execute(
      envelope('goods-shelf.define.v1', {
        warehouseId: warehouse.id,
        code: 'A1',
        name: 'A 排一架',
        locations: [{ code: 'A101', name: '一层一位' }],
      }),
    ),
  ).goodsShelf as GoodsShelf;
  const locations = (await h.service.goodsShelfDetail(t1, shelf.id)).locations;
  expect(locations).toHaveLength(1);
  return { warehouseId: warehouse.id, shelf, shelfLocation: locations[0] as ShelfLocation };
}

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

// ---- goods-shelf.define（建架 + 随建库位） ----

describe('goods-shelf.define（货架属仓/仓内编码唯一；库位前缀+表内唯一）', () => {
  it('建架随建库位：默认启用、objectVersion=1、详情 code 升序；主数据无事件', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    expect(seeded.shelf.code).toBe('A1');
    expect(seeded.shelf.status).toBe('active');
    expect(seeded.shelf.warehouseId).toBe(seeded.warehouseId);
    expect(seeded.shelfLocation.code).toBe('A101');
    expect(seeded.shelfLocation.goodsShelfId).toBe(seeded.shelf.id);
    expect(seeded.shelfLocation.objectVersion).toBe(1);

    const list = await h.service.listGoodsShelves(t1, seeded.warehouseId);
    expect(list).toHaveLength(1);
    const detail = await h.service.goodsShelfDetail(t1, seeded.shelf.id);
    expect(detail.locations.map((location) => location.code)).toEqual(['A101']);
  });

  it('仓内编码唯一（PRD 口径）：同仓重复拒绝；异仓同码可建', async () => {
    const h = makeHarness();
    const wh1 = mustCommit(
      await h.service.execute(envelope('warehouse.define.v1', { code: 'WH1', name: '一仓', locations: [{ code: 'L' }] })),
    ).warehouse as { readonly id: string };
    const wh2 = mustCommit(
      await h.service.execute(envelope('warehouse.define.v1', { code: 'WH2', name: '二仓', locations: [{ code: 'L' }] })),
    ).warehouse as { readonly id: string };

    mustCommit(await h.service.execute(envelope('goods-shelf.define.v1', { warehouseId: wh1.id, code: 'A1', name: '一仓 A1' })));
    const rejected = await h.service.execute(
      envelope('goods-shelf.define.v1', { warehouseId: wh1.id, code: 'A1', name: '重复架', locations: [] }),
    );
    expect(mustReject(rejected)).toContain("货架编码 'A1' 在仓库");
    // 异仓同码可建（仓内唯一语义，非全局）。
    mustCommit(await h.service.execute(envelope('goods-shelf.define.v1', { warehouseId: wh2.id, code: 'A1', name: '二仓 A1' })));
    expect((await h.service.listGoodsShelves(t1)).length).toBe(2);
  });

  it('仓库不存在拒绝；货架库位编码表内唯一（跨仓跨架占码拒绝）', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    const noWarehouse = await h.service.execute(
      envelope('goods-shelf.define.v1', { warehouseId: 'wh-none', code: 'B1', name: 'x' }),
    );
    expect(mustReject(noWarehouse)).toContain("不存在仓库 'wh-none'");

    // 表内唯一：架 'A' 的库位码 'A101' 同时满足 'A' 前缀，与架 'A1' 的既有
    // 'A101' 撞码（跨架占码）。
    const duplicateLocation = await h.service.execute(
      envelope('goods-shelf.define.v1', { warehouseId: seeded.warehouseId, code: 'A', name: '短码架', locations: [{ code: 'A101' }] }),
    );
    expect(mustReject(duplicateLocation)).toContain("货架库位编码 'A101' 已存在（表内唯一");
  });

  it('载荷解析：库位编码须以货架编码开头且长于货架编码；重复编码拒绝', () => {
    expect(() =>
      parseGoodsShelfDefinePayload({ warehouseId: 'wh-1', code: 'A1', name: 'x', locations: [{ code: 'B201' }] }),
    ).toThrow(InventoryInputError);
    expect(() =>
      parseGoodsShelfDefinePayload({ warehouseId: 'wh-1', code: 'A1', name: 'x', locations: [{ code: 'A1' }] }),
    ).toThrow(InventoryInputError);
    expect(() =>
      parseGoodsShelfDefinePayload({ warehouseId: 'wh-1', code: 'A1', name: 'x', locations: [{ code: 'A101' }, { code: 'A101' }] }),
    ).toThrow(InventoryInputError);
    expect(() => parseGoodsShelfUpdatePayload({})).toThrow(InventoryInputError); // 空载荷拒绝
  });
});

// ---- goods-shelf.update / set-status / remove（保护） ----

describe('goods-shelf 保护（有下属锁码；正结存不得停删）', () => {
  it('update：改名/备注推版本；有下属库位时锁码，清空下属后可改码', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);

    const renamed = mustCommit(
      await h.service.execute(
        envelope('goods-shelf.update.v1', { name: 'A 排一架（改名）' }, { expectedRevision: 1 }),
        seeded.shelf.id,
      ),
    );
    expect(renamed.newRevision).toBe(2);

    const locked = await h.service.execute(
      envelope('goods-shelf.update.v1', { code: 'A2' }, { expectedRevision: 2 }),
      seeded.shelf.id,
    );
    expect(mustReject(locked)).toContain('货架编码不可修改');

    const staleVersion = await h.service.execute(
      envelope('goods-shelf.update.v1', { name: '旧版本写入' }, { expectedRevision: 1 }),
      seeded.shelf.id,
    );
    expect(mustReject(staleVersion)).toContain('版本不符');

    // 删下属库位（无结存无流水，可删）→ 改码放行。
    mustCommit(
      await h.service.execute(
        envelope('shelf-location.remove.v1', {}, { expectedRevision: 1 }),
        seeded.shelfLocation.id,
      ),
    );
    const recoded = mustCommit(
      await h.service.execute(
        envelope('goods-shelf.update.v1', { code: 'A2' }, { expectedRevision: 2 }),
        seeded.shelf.id,
      ),
    );
    expect((recoded.goodsShelf as GoodsShelf).code).toBe('A2');
  });

  it('set-status：下属库位有正结存不得停用；清仓后停用成功且落位拒绝', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    await receiveProduction(h, 'item-900', seeded.warehouseId, 5, seeded.shelfLocation.id);

    const refused = await h.service.execute(
      envelope('goods-shelf.set-status.v1', { status: 'disabled' }, { expectedRevision: 1 }),
      seeded.shelf.id,
    );
    expect(mustReject(refused)).toContain('下属库位存在库存');

    // 出清（指定货架库位出库）后停用放行。
    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', {
          itemId: 'item-900',
          warehouseId: seeded.warehouseId,
          locationId: seeded.shelfLocation.id,
          quantity: 5,
          purpose: 'manual',
        }),
      ),
    );
    const disabled = mustCommit(
      await h.service.execute(
        envelope('goods-shelf.set-status.v1', { status: 'disabled' }, { expectedRevision: 1 }),
        seeded.shelf.id,
      ),
    );
    expect((disabled.goodsShelf as GoodsShelf).status).toBe('disabled');

    // 停用货架后其库位不可再作落位锚点（双层启用校验）。
    const placement = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'production',
        itemId: 'item-900',
        warehouseId: seeded.warehouseId,
        locationId: seeded.shelfLocation.id,
        quantity: 1,
      }),
    );
    expect(mustReject(placement)).toContain('可落位的库位');
  });

  it('remove：有下属库位拒绝；空架可删；重复删按不存在拒绝', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);

    const refused = await h.service.execute(
      envelope('goods-shelf.remove.v1', {}, { expectedRevision: 1 }),
      seeded.shelf.id,
    );
    expect(mustReject(refused)).toContain('已配置库位');

    mustCommit(
      await h.service.execute(envelope('shelf-location.remove.v1', {}, { expectedRevision: 1 }), seeded.shelfLocation.id),
    );
    mustCommit(await h.service.execute(envelope('goods-shelf.remove.v1', {}, { expectedRevision: 1 }), seeded.shelf.id));
    await expect(h.service.goodsShelfDetail(t1, seeded.shelf.id)).rejects.toThrow(InventoryNotFoundError);

    const again = await h.service.execute(
      envelope('goods-shelf.remove.v1', {}, { expectedRevision: 1 }),
      seeded.shelf.id,
    );
    expect(mustReject(again)).toContain('不存在货架');
  });
});

// ---- shelf-location 命令族 ----

describe('shelf-location（挂货架：前缀+表内唯一；结存与流水引用保护）', () => {
  it('define：前缀校验与表内唯一；warehouseId 以货架主数据为准反写', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);

    const badPrefix = await h.service.execute(
      envelope('shelf-location.define.v1', { code: 'B202' }),
      seeded.shelf.id,
    );
    expect(mustReject(badPrefix)).toContain("须以货架编码 'A1' 开头");

    const created = mustCommit(
      await h.service.execute(envelope('shelf-location.define.v1', { code: 'A102', name: '一层二位' }), seeded.shelf.id),
    );
    const location = created.shelfLocation as ShelfLocation;
    expect(location.code).toBe('A102');
    expect(location.warehouseId).toBe(seeded.warehouseId);

    const duplicate = await h.service.execute(
      envelope('shelf-location.define.v1', { code: 'A102' }),
      seeded.shelf.id,
    );
    expect(mustReject(duplicate)).toContain('表内唯一');
  });

  it('update：无引用可改码（重校前缀）；被流水引用锁码，改名不受限', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);

    const recoded = mustCommit(
      await h.service.execute(
        envelope('shelf-location.update.v1', { code: 'A109' }, { expectedRevision: 1 }),
        seeded.shelfLocation.id,
      ),
    );
    expect((recoded.shelfLocation as ShelfLocation).code).toBe('A109');

    // 落一笔流水（入到改回的编码位）→ 改码被拒，改名放行。
    mustCommit(
      await h.service.execute(
        envelope('shelf-location.update.v1', { code: 'A101' }, { expectedRevision: 2 }),
        seeded.shelfLocation.id,
      ),
    );
    await receiveProduction(h, 'item-901', seeded.warehouseId, 3, seeded.shelfLocation.id);
    const locked = await h.service.execute(
      envelope('shelf-location.update.v1', { code: 'A110' }, { expectedRevision: 3 }),
      seeded.shelfLocation.id,
    );
    expect(mustReject(locked)).toContain('已被出入库流水引用，编码不可修改');
    mustCommit(
      await h.service.execute(
        envelope('shelf-location.update.v1', { name: '改名不受限' }, { expectedRevision: 3 }),
        seeded.shelfLocation.id,
      ),
    );
  });

  it('set-status：有正结存不得停用；出清后停用成功；停用位不可落位', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    await receiveProduction(h, 'item-902', seeded.warehouseId, 4, seeded.shelfLocation.id);

    const refused = await h.service.execute(
      envelope('shelf-location.set-status.v1', { status: 'disabled' }, { expectedRevision: 1 }),
      seeded.shelfLocation.id,
    );
    expect(mustReject(refused)).toContain('存在库存（正结存），无法停用');

    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', {
          itemId: 'item-902',
          warehouseId: seeded.warehouseId,
          locationId: seeded.shelfLocation.id,
          quantity: 4,
          purpose: 'manual',
        }),
      ),
    );
    const disabled = mustCommit(
      await h.service.execute(
        envelope('shelf-location.set-status.v1', { status: 'disabled' }, { expectedRevision: 1 }),
        seeded.shelfLocation.id,
      ),
    );
    expect((disabled.shelfLocation as ShelfLocation).status).toBe('disabled');

    const placement = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'production',
        itemId: 'item-902',
        warehouseId: seeded.warehouseId,
        locationId: seeded.shelfLocation.id,
        quantity: 1,
      }),
    );
    expect(mustReject(placement)).toContain('可落位的库位');
    // 复启后可再落位。
    mustCommit(
      await h.service.execute(
        envelope('shelf-location.set-status.v1', { status: 'active' }, { expectedRevision: 2 }),
        seeded.shelfLocation.id,
      ),
    );
    receiveProduction(h, 'item-902', seeded.warehouseId, 1, seeded.shelfLocation.id);
  });

  it('remove：正结存拒绝；流水引用（结存已清）仍拒绝；干净位可删', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    await receiveProduction(h, 'item-903', seeded.warehouseId, 2, seeded.shelfLocation.id);

    const withBalance = await h.service.execute(
      envelope('shelf-location.remove.v1', {}, { expectedRevision: 1 }),
      seeded.shelfLocation.id,
    );
    expect(mustReject(withBalance)).toContain('存在库存（正结存），无法删除');

    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', {
          itemId: 'item-903',
          warehouseId: seeded.warehouseId,
          locationId: seeded.shelfLocation.id,
          quantity: 2,
          purpose: 'manual',
        }),
      ),
    );
    const withHistory = await h.service.execute(
      envelope('shelf-location.remove.v1', {}, { expectedRevision: 1 }),
      seeded.shelfLocation.id,
    );
    expect(mustReject(withHistory)).toContain('存在入库或出库记录，无法删除');

    // 干净位（从未落账）可删。
    const fresh = mustCommit(
      await h.service.execute(envelope('shelf-location.define.v1', { code: 'A103' }), seeded.shelf.id),
    ).shelfLocation as ShelfLocation;
    mustCommit(await h.service.execute(envelope('shelf-location.remove.v1', {}, { expectedRevision: 1 }), fresh.id));
  });
});

// ---- 落位引用扩展（三级可选形态；既有两级面兼容） ----

describe('收发存落位引用扩展到货架库位（RREQ-IV-002"被落位与分布引用"）', () => {
  it('入库落货架库位：库位分布可见、仓库直属库位并行可用（两级兼容）', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    const directLocation = (await h.service.warehouseDetail(t1, seeded.warehouseId)).locations[0] as { readonly id: string };

    await receiveProduction(h, 'item-910', seeded.warehouseId, 6, seeded.shelfLocation.id);
    await receiveProduction(h, 'item-910', seeded.warehouseId, 4, directLocation.id);

    const balances = await h.service.locationBalances(t1, seeded.warehouseId);
    const byLocation = new Map(balances.map((row) => [row.locationId, row.qty]));
    expect(byLocation.get(seeded.shelfLocation.id)).toBe(6);
    expect(byLocation.get(directLocation.id)).toBe(4);
    // 台账恒等：Σ库位余额 = 仓库现存量。
    const level = (await h.service.stockLevels(t1, seeded.warehouseId, 'item-910'))[0];
    expect(level?.qtyOnHand).toBe(10);
  });

  it('调拨/移库与发货均可挂货架库位；FIFO 未指定位含货架位扣减', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    await receiveProduction(h, 'item-911', seeded.warehouseId, 8, seeded.shelfLocation.id);

    // 仓内移库：货架位 → 直属默认位（仓库总量不动，位间 5/3）。
    const directLocation = (await h.service.warehouseDetail(t1, seeded.warehouseId)).locations[0] as { readonly id: string };
    mustCommit(
      await h.service.execute(
        envelope('stock.transfer.v1', {
          itemId: 'item-911',
          fromWarehouseId: seeded.warehouseId,
          toWarehouseId: seeded.warehouseId,
          fromLocationId: seeded.shelfLocation.id,
          toLocationId: directLocation.id,
          quantity: 3,
        }),
      ),
    );
    // FIFO 直扣（未指定位）：货架位余额先建（createdAt 序）→ 4 件全从货架位扣，
    // 位间 1/3，仓库总量 4。
    mustCommit(
      await h.service.execute(
        envelope('stock.issue.v1', { itemId: 'item-911', warehouseId: seeded.warehouseId, quantity: 4, purpose: 'manual' }),
      ),
    );
    // 发货行挂货架位：从直属位移回 2 件（位间 3/1）再发货 2 → 位间 1/1、总量 2。
    mustCommit(
      await h.service.execute(
        envelope('stock.transfer.v1', {
          itemId: 'item-911',
          fromWarehouseId: seeded.warehouseId,
          toWarehouseId: seeded.warehouseId,
          fromLocationId: directLocation.id,
          toLocationId: seeded.shelfLocation.id,
          quantity: 2,
        }),
      ),
    );
    mustCommit(
      await h.service.execute(
        envelope('shipping.execute.v1', {
          lines: [{ itemId: 'item-911', quantity: 2, warehouseId: seeded.warehouseId, locationId: seeded.shelfLocation.id }],
        }),
      ),
    );
    const level = (await h.service.stockLevels(t1, seeded.warehouseId, 'item-911'))[0];
    expect(level?.qtyOnHand).toBe(2);
    const balances = await h.service.locationBalances(t1, seeded.warehouseId, 'item-911');
    expect(balances.map((row) => row.qty).reduce((sum, qty) => sum + qty, 0)).toBe(2);
  });

  it('跨仓货架位不可作本仓落位（warehouseId 锚定校验）', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    const wh2 = mustCommit(
      await h.service.execute(envelope('warehouse.define.v1', { code: 'WH2', name: '二仓', locations: [{ code: 'L' }] })),
    ).warehouse as { readonly id: string };
    const cross = await h.service.execute(
      envelope('stock.receive.v1', {
        kind: 'production',
        itemId: 'item-912',
        warehouseId: wh2.id,
        locationId: seeded.shelfLocation.id, // WH1 的货架位
        quantity: 1,
      }),
    );
    expect(mustReject(cross)).toContain('可落位的库位');
  });
});

// ---- 租户隔离与命令纪律 ----

describe('租户隔离与命令纪律（B3 面）', () => {
  it('t2 看不到 t1 的货架；跨租户命令按不存在拒绝', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    expect(await h.service.listGoodsShelves(t2)).toHaveLength(0);
    await expect(h.service.goodsShelfDetail(t2, seeded.shelf.id)).rejects.toThrow(InventoryNotFoundError);

    const cross = await h.service.execute(
      envelope('goods-shelf.update.v1', { name: '跨租户改名' }, { tenant: t2, expectedRevision: 1 }),
      seeded.shelf.id,
    );
    expect(mustReject(cross)).toContain('不存在货架');
  });

  it('创建命令 expectedRevision 须 initial；既有对象命令须数字版本', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    const bad1 = await h.service.execute(
      envelope('goods-shelf.define.v1', { warehouseId: seeded.warehouseId, code: 'Z9', name: 'x' }, { expectedRevision: 3 }),
    );
    expect(mustReject(bad1)).toContain("expectedRevision 须为 'initial'");
    const bad2 = await h.service.execute(
      envelope('goods-shelf.set-status.v1', { status: 'disabled' }),
      seeded.shelf.id,
    );
    expect(mustReject(bad2)).toContain('expectedRevision 须为当前 objectVersion 数字');
  });

  it('operationId 幂等：同 operationId 重发拒绝（不落新账）', async () => {
    const h = makeHarness();
    const seeded = await seedWarehouseAndShelf(h);
    const first = await h.service.execute(
      envelope('shelf-location.define.v1', { code: 'A104' }, { operationId: 'op-b3-dup-1' }),
      seeded.shelf.id,
    );
    mustCommit(first);
    const replay = await h.service.execute(
      envelope('shelf-location.define.v1', { code: 'A105' }, { operationId: 'op-b3-dup-1' }),
      seeded.shelf.id,
    );
    expect(mustReject(replay)).toContain('op-b3-dup-1');
    const detail = await h.service.goodsShelfDetail(t1, seeded.shelf.id);
    expect(detail.locations.map((location) => location.code)).toEqual(['A101', 'A104']);
  });
});
