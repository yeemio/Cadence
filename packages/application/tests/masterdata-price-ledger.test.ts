/**
 * 物品价格台账 + 初始价格测试（fix-wave-6 6b-1 S9：RREQ-MD-019/020，
 * PRD 11 册 §4.7；U9 中止版按 PRD 定义重做）：
 *  - RREQ-MD-020：initialPriceMinor 输入解析边界（≥0 整数分/null 清空/未提供不动）
 *    与 create/update 透传（内存实现）；
 *  - RREQ-MD-019：台账物化纯函数（审核时间优先回落下单时间排序/决胜序/
 *    itemId 过滤/空价行仍展示/坏行跳过）、内存台账端口（租户收口+分页）、
 *    service 404 与分页解析、控制器权限码（item:read）。
 * import 直接模块路径（不经桶导出）——并行波次的工作树含其它域进行中改动，
 * 本文件只锁 masterdata 面。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../src/core/auth/require-permission.decorator.js';
import {
  MasterdataInputError,
  MasterdataNotFoundError,
} from '../src/masterdata/masterdata-errors.js';
import {
  parseCreateItemInput,
  parsePriceLedgerPageQuery,
  parseUpdateItemInput,
} from '../src/masterdata/masterdata-input.js';
import {
  buildItemPurchasePriceEntries,
  type PriceLedgerOrderRow,
} from '../src/masterdata/masterdata-stores.js';
import {
  InMemoryItemPriceLedgerStore,
  InMemoryItemStore,
  type InMemoryPriceLedgerRow,
} from '../src/masterdata/in-memory-masterdata-stores.js';
import { MasterdataService } from '../src/masterdata/masterdata.service.js';
import { MasterdataItemsController } from '../src/masterdata/masterdata.controllers.js';
import { MasterdataModule } from '../src/masterdata/masterdata.module.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

// ---- RREQ-MD-020：初始价格输入解析 ----

describe('初始价格输入解析（RREQ-MD-020）', () => {
  it('create：合法整数分收下；缺省不落键（缺省 null = 未维护）', () => {
    const payload = parseCreateItemInput({
      code: 'P-1001',
      name: '轴承',
      initialPriceMinor: 12550,
    });
    expect(payload.initialPriceMinor).toBe(12550);
    const withoutPrice = parseCreateItemInput({ code: 'P-1002', name: '垫片' });
    expect('initialPriceMinor' in withoutPrice).toBe(false);
  });

  it('create：负数/小数/超界/非数字拒绝（≥0 整数分）', () => {
    for (const bad of [-1, 1.5, '100', 2_000_000_001, Number.NaN]) {
      expect(() =>
        parseCreateItemInput({ code: 'P-1001', name: '轴承', initialPriceMinor: bad }),
      ).toThrow(MasterdataInputError);
    }
  });

  it('update：0 是合法值；null = 清空保存（取消）；未提供 = 不动', () => {
    const payload = parseUpdateItemInput({ initialPriceMinor: 0 });
    expect(payload.initialPriceMinor).toBe(0);
    const cleared = parseUpdateItemInput({ initialPriceMinor: null });
    expect(cleared.initialPriceMinor).toBeNull();
    const untouched = parseUpdateItemInput({ name: '新名' });
    expect('initialPriceMinor' in untouched).toBe(false);
  });
});

// ---- RREQ-MD-020：service / 内存实现透传 ----

describe('初始价格 service 行为（RREQ-MD-020）', () => {
  it('create 落初始价格；update null 取消；未提供不变', async () => {
    const service = new MasterdataService(new InMemoryItemStore(), {} as never);
    const created = await service.createItem(t1, {
      code: 'P-1001',
      name: '轴承',
      initialPriceMinor: 9900,
    });
    expect(created.initialPriceMinor).toBe(9900);
    const cancelled = await service.updateItem(t1, created.id, { initialPriceMinor: null });
    expect(cancelled.initialPriceMinor).toBeNull();
    const kept = await service.updateItem(t1, created.id, { name: '轴承 6204' });
    expect(kept.initialPriceMinor).toBeNull(); // 上轮已取消；本轮未提供 → 不变
    expect(kept.name).toBe('轴承 6204');
  });

  it('内存实现缺省 null（存量物品无初始价格语义）', async () => {
    const items = new InMemoryItemStore();
    const created = await items.create({ tenant: t1, code: 'P-1001', name: '轴承' });
    expect(created.initialPriceMinor).toBeNull();
    const updated = await items.update(t1, created.id, { initialPriceMinor: 500 });
    expect(updated?.initialPriceMinor).toBe(500);
  });
});

// ---- RREQ-MD-019：台账物化纯函数（内存 / PG 共享合同单点） ----

describe('台账物化纯函数（RREQ-MD-019 排序合同）', () => {
  const orders: readonly PriceLedgerOrderRow[] = [
    {
      id: 'po-1',
      supplierRef: 'sup-a',
      supplierName: '供应商甲',
      state: 'received',
      createdAt: '2026-10-01T08:00:00.000Z',
      lines: [
        { lineNo: 1, itemId: 'item-x', quantity: 10, unitPriceMinor: 12000 },
        { lineNo: 2, itemId: 'item-x', quantity: 5, unitPriceMinor: null }, // 未定价仍展示
        { lineNo: 3, itemId: 'item-y', quantity: 1, unitPriceMinor: 100 }, // 他物品行
      ],
    },
    {
      id: 'po-2',
      supplierRef: null,
      supplierName: null,
      state: 'submitted',
      createdAt: '2026-10-20T08:00:00.000Z', // 未审核：回落下单时间
      lines: [{ lineNo: 1, itemId: 'item-x', quantity: 3, unitPriceMinor: 15000 }],
    },
    {
      id: 'po-3',
      supplierRef: 'sup-b',
      supplierName: '供应商乙',
      state: 'approved',
      createdAt: '2026-10-10T08:00:00.000Z',
      lines: [{ lineNo: 1, itemId: 'item-x', quantity: 7, unitPriceMinor: 13000 }],
    },
  ];

  it('按 occurredAt=COALESCE(approvedAt, orderedAt) 降序；单号降序、行号升序决胜；他物品行过滤', () => {
    const approvedAt = new Map([['po-3', '2026-10-18T09:30:00.000Z']]);
    const entries = buildItemPurchasePriceEntries(orders, approvedAt, 'item-x');
    // 各行 occurred：po-2=下单 10-20（无审核回落）> po-3=审 10-18 > po-1=下单 10-01；
    // po-1 两行（item-y 行过滤），共 4 行
    expect(entries.map((e) => `${e.purchaseOrderId}#${e.lineNo}`)).toEqual([
      'po-2#1',
      'po-3#1',
      'po-1#1',
      'po-1#2',
    ]);
    expect(entries.find((e) => e.purchaseOrderId === 'po-3')?.approvedAt).toBe(
      '2026-10-18T09:30:00.000Z',
    );
    // 同单（po-1）行号升序：line1(12000) → line2(null)
    const po1 = entries.filter((e) => e.purchaseOrderId === 'po-1');
    expect(po1.map((e) => e.lineNo)).toEqual([1, 2]);
    // 空价行仍展示（unitPriceMinor null）
    expect(po1[1]?.unitPriceMinor).toBeNull();
    expect(po1[1]?.quantity).toBe(5);
  });

  it('审核时间缺失回落下单时间排序（未审核单仍在台账面，状态列可辨）', () => {
    const entries = buildItemPurchasePriceEntries(orders, new Map(), 'item-x');
    expect(entries.map((e) => `${e.purchaseOrderId}#${e.lineNo}`)).toEqual([
      'po-2#1',
      'po-3#1',
      'po-1#1',
      'po-1#2',
    ]);
    expect(entries.every((e) => e.approvedAt === null)).toBe(true);
    expect(entries.find((e) => e.purchaseOrderId === 'po-2')?.orderState).toBe('submitted');
  });

  it('同 occurred 单号降序决胜；行形状不符静默跳过（坏数据不阻塞台账）', () => {
    const rows: readonly PriceLedgerOrderRow[] = [
      {
        id: 'po-b',
        supplierRef: null,
        supplierName: 'B',
        state: 'draft',
        createdAt: '2026-10-05T00:00:00.000Z',
        lines: [{ lineNo: 1, itemId: 'item-x', quantity: 1, unitPriceMinor: 1 }],
      },
      {
        id: 'po-a',
        supplierRef: null,
        supplierName: 'A',
        state: 'draft',
        createdAt: '2026-10-05T00:00:00.000Z',
        lines: [
          { lineNo: 2, itemId: 'item-x', quantity: 2, unitPriceMinor: 2 },
          { lineNo: 1, itemId: 'item-x', quantity: 1, unitPriceMinor: 1 },
          'not-an-object',
          { itemId: 'item-x', quantity: 1 }, // 缺 lineNo
        ],
      },
      { id: 'po-c', supplierRef: null, supplierName: null, state: 'x', createdAt: '', lines: null },
    ];
    const entries = buildItemPurchasePriceEntries(rows, new Map(), 'item-x');
    expect(entries.map((e) => `${e.purchaseOrderId}#${e.lineNo}`)).toEqual([
      'po-b#1',
      'po-a#1',
      'po-a#2',
    ]);
  });
});

// ---- RREQ-MD-019：内存台账端口 + service ----

function ledgerRow(
  tenant: TenantId,
  itemId: string,
  entry: Omit<InMemoryPriceLedgerRow, 'tenant' | 'itemId'>,
): InMemoryPriceLedgerRow {
  return { tenant, itemId, ...entry };
}

describe('价格台账读面（RREQ-MD-019）', () => {
  const rows: readonly InMemoryPriceLedgerRow[] = [
    ledgerRow(t1, 'item-x', {
      purchaseOrderId: 'po-1',
      lineNo: 1,
      supplierRef: 'sup-a',
      supplierName: '供应商甲',
      unitPriceMinor: 12000,
      quantity: 10,
      orderState: 'approved',
      orderedAt: '2026-10-01T08:00:00.000Z',
      approvedAt: '2026-10-02T08:00:00.000Z',
    }),
    ledgerRow(t1, 'item-x', {
      purchaseOrderId: 'po-2',
      lineNo: 1,
      supplierRef: null,
      supplierName: null,
      unitPriceMinor: null,
      quantity: 4,
      orderState: 'submitted',
      orderedAt: '2026-10-15T08:00:00.000Z',
      approvedAt: null,
    }),
    ledgerRow(t2, 'item-x', {
      purchaseOrderId: 'po-other-tenant',
      lineNo: 1,
      supplierRef: null,
      supplierName: null,
      unitPriceMinor: 1,
      quantity: 1,
      orderState: 'approved',
      orderedAt: '2026-10-16T08:00:00.000Z',
      approvedAt: '2026-10-16T09:00:00.000Z',
    }),
  ];

  it('内存端口：租户收口 + 审核时间优先排序 + 分页 total 与页切片', async () => {
    const ledger = new InMemoryItemPriceLedgerStore(rows);
    const page = await ledger.listByItem(t1, 'item-x', { limit: 1, offset: 0 });
    expect(page.total).toBe(2); // 他租户行不计
    expect(page.entries.map((e) => e.purchaseOrderId)).toEqual(['po-2']); // 10-15 近于 10-02
    const secondPage = await ledger.listByItem(t1, 'item-x', { limit: 1, offset: 1 });
    expect(secondPage.entries.map((e) => e.purchaseOrderId)).toEqual(['po-1']);
    expect(secondPage.entries[0]?.unitPriceMinor).toBe(12000);
  });

  it('service：404 语义 + 响应面（itemCode/unit/initialPriceMinor/分页）+ 空台账恒空页', async () => {
    const items = new InMemoryItemStore();
    const item = await items.create({
      tenant: t1,
      code: 'P-1001',
      name: '轴承',
      unit: '个',
      initialPriceMinor: 8000,
    });
    // 台账行按生成物品 id 对齐（po-2 未审核 10-15 > po-1 已审核 10-02）
    const itemRows = rows
      .filter((row) => row.tenant === t1)
      .map((row) => ({ ...row, itemId: item.id }));
    const service = new MasterdataService(
      items,
      {} as never,
      undefined,
      undefined,
      undefined,
      new InMemoryItemPriceLedgerStore(itemRows),
    );
    const view = await service.listItemPurchasePrices(t1, item.id, '1', '1');
    expect(view).toMatchObject({
      itemId: item.id,
      itemCode: 'P-1001',
      unit: '个',
      initialPriceMinor: 8000,
      page: 1,
      pageSize: 1,
      total: 2,
    });
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]?.purchaseOrderId).toBe('po-2'); // 审核时间优先回落下单时间
    // 缺省参数：page=1、pageSize=10（源 §2.4 默认 10）
    const defaulted = await service.listItemPurchasePrices(t1, item.id, undefined, undefined);
    expect(defaulted.page).toBe(1);
    expect(defaulted.pageSize).toBe(10);
    expect(defaulted.entries).toHaveLength(2);
    // 物品不存在 → 404 语义
    await expect(service.listItemPurchasePrices(t1, 'ghost', '1', '10')).rejects.toThrow(
      MasterdataNotFoundError,
    );
    // 无台账数据（缺省内存 ledger）→ 恒空页（零 DB boot 语义完整）
    const emptyService = new MasterdataService(new InMemoryItemStore(), {} as never);
    const otherItem = await emptyService.createItem(t1, { code: 'P-2', name: '垫片' });
    const emptyView = await emptyService.listItemPurchasePrices(t1, otherItem.id, null, null);
    expect(emptyView.total).toBe(0);
    expect(emptyView.entries).toEqual([]);
  });

  it('分页查询解析：非法 page/pageSize 拒绝；上限 100', () => {
    expect(parsePriceLedgerPageQuery(null, null)).toEqual({ page: 1, pageSize: 10 });
    expect(parsePriceLedgerPageQuery('2', '50')).toEqual({ page: 2, pageSize: 50 });
    expect(parsePriceLedgerPageQuery('', '')).toEqual({ page: 1, pageSize: 10 });
    expect(() => parsePriceLedgerPageQuery('0', '10')).toThrow(MasterdataInputError);
    expect(() => parsePriceLedgerPageQuery('abc', '10')).toThrow(MasterdataInputError);
    expect(() => parsePriceLedgerPageQuery('1', '101')).toThrow(MasterdataInputError);
    expect(() => parsePriceLedgerPageQuery('1', '1.5')).toThrow(MasterdataInputError);
  });
});

// ---- 控制器权限元数据（体例同 masterdata.test.ts） ----

describe('价格台账控制器权限（RREQ-MD-019 挂 masterdata item:read）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('GET :id/purchase-prices 权限码 = item:read（只读台账，不新设权限）', () => {
    expect(routePermissions(MasterdataItemsController, 'purchasePrices')).toBe('item:read');
  });

  it('MasterdataModule.register 装配含价格台账注入点（缺省回落内存恒空页）', () => {
    const dynamic = MasterdataModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      MasterdataModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(MasterdataModule);
    expect(controllers).toContain(MasterdataItemsController);
  });
});
