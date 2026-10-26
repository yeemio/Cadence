/**
 * U6 接线波组合根适配焦点测试（#28 issue.material / #29 派工生成钩子 /
 * #30 aftercare reportPort / wiring 装配面）。
 *
 * 与 cross-module-wiring.e2e.test.ts（HTTP 全链路）的区别：本文件直击三个
 * 新适配器的行为合同——真实 InventoryService + 共享 store 实例（与 app-registry
 * 零 DB 裁决同一实现），不起 HTTP：
 *  1. IssueMaterialPort ← inventory：可用量/预占锚读面、多库位出库（预占核销 +
 *     直扣拆分）、子键幂等、撤销原路回滚（库位/账面回补 + 预占同锚恢复）。
 *  2. dispatch→issue 生成钩子：advance→assigned 触发（assembly 走归拢）、
 *     electrical 不触发、同步异常不回滚派工（通知式合同）。
 *  3. wiring 装配面：全装形态下 register.issue.material / register
 *     ['aftercare-claim'].reportPort / storeOverrides.dispatchOrders 三句柄非空。
 */
import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import {
  EMPTY_ISSUE_DEMAND_PORT,
  InMemoryDispatchOrderStore,
  InMemoryGapCheckStore,
  InMemoryInventoryDomainEventStore,
  InMemoryInventoryOperationStore,
  InMemoryIssueDomainEventStore,
  InMemoryIssueExpressStore,
  InMemoryIssueOperationStore,
  InMemoryIssueRecordStore,
  InMemoryIssueTaskLineStore,
  InMemoryIssueTaskStore,
  InMemoryListingDomainEventStore,
  InMemoryListingLineStore,
  InMemoryListingOperationStore,
  InMemoryListingSheetStore,
  InMemoryPurchaseOrderStore,
  InMemoryPurchaseRequestStore,
  InMemoryPurchaseReturnStore,
  InMemoryReleaseFactStore,
  InMemoryShippingOrderStore,
  InMemoryStockAccountStore,
  InMemoryStockLocationBalanceStore,
  InMemoryStockMovementStore,
  InMemoryStockReservationStore,
  InMemoryStocktakeStore,
  InMemoryTodoStore,
  InMemoryWarehouseStore,
  InventoryService,
  IssueService,
  ListingService,
  NOOP_ISSUE_MATERIAL_PORT,
  createInventoryAvailabilityAdapter,
  type DispatchOrderStore,
  type InventoryCommand,
  type IssueSyncTrigger,
} from '@smes/application';
import {
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
  type CommandEnvelope,
} from '@smes/business-core';
import { buildAppModule } from '../src/app-registry.js';
import {
  CROSS_MODULE_WIRING,
  bindCrossModuleWiring,
  buildIssueReservationKey,
  createInventoryIssueMaterialPort,
  createInventoryUseReservationPort,
  createIssueSyncDispatchStore,
  parseIssueReservationKey,
} from '../src/cross-module-wiring.js';

const tenant = TenantId.create('t-u6');

/** 测试信封（操作者记系统账号——口径同 wiring 适配器）。 */
function envelope(
  kind: 'warehouse.define.v1' | 'stock.receive.v1',
  operationId: string,
  payload: Record<string, unknown>,
): CommandEnvelope<InventoryCommand> {
  return makeCommandEnvelope<InventoryCommand>({
    tenantId: tenant,
    issuedBy: UserId.create('u-op-u6'),
    operationId: OperationId.create(operationId),
    expectedRevision: 'initial',
    issuedAt: new Date().toISOString(),
    command: { kind, payload },
  });
}

const contexts: INestApplicationContext[] = [];

afterAll(async () => {
  for (const context of contexts) await context.close();
});

describe('U6 #28：IssueMaterialPort ← inventory 适配器', () => {
  it('多库位出库拆预占/直扣、子键幂等、撤销原路回滚并同锚恢复预占', async () => {
    // 直接构造 InventoryService（12 参全内存——与 InventoryModule 缺省同一实现；
    // 不起独立 app context：模块面 TenantContext 由 CoreModule 全局供给）。
    const movements = new InMemoryStockMovementStore();
    const reservations = new InMemoryStockReservationStore();
    const domainEvents = new InMemoryInventoryDomainEventStore();
    const inventory = new InventoryService(
      new InMemoryWarehouseStore(),
      new InMemoryStockAccountStore(),
      new InMemoryStockLocationBalanceStore(),
      movements,
      reservations,
      new InMemoryStocktakeStore(),
      new InMemoryShippingOrderStore(),
      new InMemoryReleaseFactStore(),
      new InMemoryInventoryOperationStore(),
      domainEvents,
      createInMemoryApprovalEventStore(),
      {},
    );
    const material = createInventoryIssueMaterialPort({
      inventory: () => inventory,
      reservations,
      movements,
      domainEvents,
    });

    // 两库位仓库 + 两笔入库（L1=100 / L2=20）。
    const defined = await inventory.execute(
      envelope('warehouse.define.v1', 'u6-wh', {
        code: 'WH-U6',
        name: 'U6 测试仓',
        locations: [
          { code: 'L1', name: '一号位' },
          { code: 'L2', name: '二号位' },
        ],
      }),
    );
    expect(defined.status).toBe('committed');
    const warehouse = (defined as { readonly warehouse?: { readonly id: string; readonly locations: readonly { readonly id: string }[] } }).warehouse!;
    const [loc1, loc2] = warehouse.locations;
    for (const [locationId, quantity, receiptKey] of [
      [loc1!.id, 100, 'u6-rcv-1'],
      [loc2!.id, 20, 'u6-rcv-2'],
    ] as const) {
      const received = await inventory.execute(
        envelope('stock.receive.v1', receiptKey, {
          kind: 'production',
          itemId: 'itm-u6',
          warehouseId: warehouse.id,
          locationId,
          quantity,
          receiptKey,
          workOrderId: 'wo-u6',
        }),
      );
      expect(received.status).toBe('committed');
    }

    // issue 锚预占：订单级 30（可核销）+ 设备级 10（只读锚，不核销）。
    for (const [equipmentRef, quantity] of [
      [null, 30],
      ['eq-u6', 10],
    ] as const) {
      const reserved = await inventory.reserveStock(tenant, {
        reservationKey: buildIssueReservationKey('wo-u6', equipmentRef, 'itm-u6'),
        itemId: 'itm-u6',
        warehouseId: warehouse.id,
        quantity,
        refType: 'issue',
        refId: 'wo-u6',
      });
      expect(reserved.reserved).toBe(true);
    }

    // 读面：可用量 = Σ max(0, 总量−预占) = (120−40)；预占按设备维拆分。
    expect((await material.availableQtyOf(tenant, ['itm-u6'])).get('itm-u6')).toBe(80);
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-u6', equipmentRef: null, itemIds: ['itm-u6'] })).get('itm-u6'),
    ).toBe(30);
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-u6', equipmentRef: 'eq-u6', itemIds: ['itm-u6'] })).get('itm-u6'),
    ).toBe(10);

    // 出库：L1 发 40（预占 30 核销 + 直扣 10）、L2 发 10（全直扣）。
    const receipt = await material.issueStock(tenant, {
      issueKey: 'issue-u6-rec1-l0',
      workOrderId: 'wo-u6',
      itemId: 'itm-u6',
      allocations: [
        { locationId: loc1!.id, quantity: 40 },
        { locationId: loc2!.id, quantity: 10 },
      ],
    });
    expect(receipt.issued).toBe(true);
    expect(receipt.allocations).toEqual([
      { locationId: loc1!.id, quantity: 40, reservedConsumedQty: 30, availableConsumedQty: 10 },
      { locationId: loc2!.id, quantity: 10, reservedConsumedQty: 0, availableConsumedQty: 10 },
    ]);
    // 账面：总量 120−50=70、预占 40−30=10 → 可用量 60；设备锚不动。
    expect((await material.availableQtyOf(tenant, ['itm-u6'])).get('itm-u6')).toBe(60);
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-u6', equipmentRef: 'eq-u6', itemIds: ['itm-u6'] })).get('itm-u6'),
    ).toBe(10);
    const movementCountAfterIssue = (await movements.list(tenant)).length;

    // 子键幂等：同 issueKey 重发不重复扣减（流水数不变、可用量不变）。
    const retried = await material.issueStock(tenant, {
      issueKey: 'issue-u6-rec1-l0',
      workOrderId: 'wo-u6',
      itemId: 'itm-u6',
      allocations: [
        { locationId: loc1!.id, quantity: 40 },
        { locationId: loc2!.id, quantity: 10 },
      ],
    });
    expect(retried.issued).toBe(true);
    expect((await movements.list(tenant)).length).toBe(movementCountAfterIssue);
    expect((await material.availableQtyOf(tenant, ['itm-u6'])).get('itm-u6')).toBe(60);

    // 撤销：原路回补（库位/账面）+ 订单级预占同锚恢复（新键 :rb: 段归并原锚）。
    const rolled = await material.rollbackIssue(tenant, { issueKey: 'issue-u6-rec1-l0' });
    expect(rolled.rolled).toBe(true);
    expect((await material.availableQtyOf(tenant, ['itm-u6'])).get('itm-u6')).toBe(80);
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-u6', equipmentRef: null, itemIds: ['itm-u6'] })).get('itm-u6'),
    ).toBe(30);

    // 撤销幂等：重滚不再回补（可用量/流水数不变）。
    const rolledAgain = await material.rollbackIssue(tenant, { issueKey: 'issue-u6-rec1-l0' });
    expect(rolledAgain.rolled).toBe(true);
    expect((await material.availableQtyOf(tenant, ['itm-u6'])).get('itm-u6')).toBe(80);

    // 未知库位拒绝（fail-closed 携原因）。
    const refused = await material.issueStock(tenant, {
      issueKey: 'issue-u6-rec2-l0',
      workOrderId: 'wo-u6',
      itemId: 'itm-u6',
      allocations: [{ locationId: 'loc-unknown', quantity: 1 }],
    });
    expect(refused.issued).toBe(false);
    expect(refused.refusedReason).toContain('loc-unknown');
  });

  it('预占键约定：段编码可逆、rb 恢复段归并原锚、非约定形状返回 null', () => {
    const key = buildIssueReservationKey('wo:1', 'eq:甲', 'itm/1');
    expect(parseIssueReservationKey(key)).toEqual({
      workOrderId: 'wo:1',
      equipmentRef: 'eq:甲',
      itemId: 'itm/1',
    });
    expect(parseIssueReservationKey(`${key}:rb:issue-x@0r0`)).toEqual({
      workOrderId: 'wo:1',
      equipmentRef: 'eq:甲',
      itemId: 'itm/1',
    });
    expect(parseIssueReservationKey('issue-rsv:v1:wo:itm')).toBeNull(); // 段数不符
    expect(parseIssueReservationKey('issue-rsv:v1:wo%:eq:itm')).toBeNull(); // 非法百分号序列
    expect(parseIssueReservationKey('other:v1:a:b:c')).toBeNull();
  });
});

describe('#38：listing.useReservationPort ← inventory（gap.check 确认→利库预占创建）', () => {
  /** gap.check 信封（expectedRevision='initial'——创建命令口径）。 */
  function gapEnvelope(operationId: string): CommandEnvelope<{ kind: 'gap.check.v1'; payload: Record<string, never> }> {
    return makeCommandEnvelope({
      tenantId: tenant,
      issuedBy: UserId.create('u-op-u6'),
      operationId: OperationId.create(operationId),
      expectedRevision: 'initial',
      issuedAt: new Date().toISOString(),
      command: { kind: 'gap.check.v1', payload: {} },
    });
  }

  /** 直构 ListingService（内存全量；清单行经行存储直写——itemId 已解析）。 */
  function listingService(
    availability: { availableQty(t: typeof tenant, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>> },
    useReservation: ReturnType<typeof createInventoryUseReservationPort>,
    lines: InstanceType<typeof InMemoryListingLineStore>,
    gapChecks: InstanceType<typeof InMemoryGapCheckStore>,
  ) {
    return new ListingService(
      new InMemoryListingSheetStore(),
      lines,
      gapChecks,
      new InMemoryPurchaseRequestStore(),
      new InMemoryPurchaseOrderStore(),
      new InMemoryPurchaseReturnStore(),
      new InMemoryListingOperationStore(),
      new InMemoryListingDomainEventStore(),
      createInMemoryApprovalEventStore(),
      new InMemoryTodoStore(),
      { inventory: availability, useReservation },
      {},
    );
  }

  /** 直构全内存 InventoryService（12 参——与 #28 测试同一构造口径）。 */
  function inventoryService(reservations: InstanceType<typeof InMemoryStockReservationStore>) {
    return new InventoryService(
      new InMemoryWarehouseStore(),
      new InMemoryStockAccountStore(),
      new InMemoryStockLocationBalanceStore(),
      new InMemoryStockMovementStore(),
      reservations,
      new InMemoryStocktakeStore(),
      new InMemoryShippingOrderStore(),
      new InMemoryReleaseFactStore(),
      new InMemoryInventoryOperationStore(),
      new InMemoryInventoryDomainEventStore(),
      createInMemoryApprovalEventStore(),
      {},
    );
  }

  async function defineWarehouse(
    inventory: InventoryService,
    operationId: string,
    code: string,
  ): Promise<{ readonly warehouseId: string; readonly locationId: string }> {
    const defined = await inventory.execute(
      envelope('warehouse.define.v1', operationId, {
        code,
        name: `利库测试仓 ${code}`,
        locations: [{ code: 'L1', name: '一号位' }],
      }),
    );
    expect(defined.status).toBe('committed');
    const warehouse = (defined as { readonly warehouse?: { readonly id: string; readonly locations: readonly { readonly id: string }[] } }).warehouse!;
    return { warehouseId: warehouse.id, locationId: warehouse.locations[0]!.id };
  }

  it('跨仓拆分立锚（g/wh 键段归并订单级锚）、重复核查折差不重复预占、#28 发料核销可消费', async () => {
    const reservations = new InMemoryStockReservationStore();
    const movements = new InMemoryStockMovementStore();
    const domainEvents = new InMemoryInventoryDomainEventStore();
    const inventory = inventoryService(reservations);
    const useReservation = createInventoryUseReservationPort({
      inventory: () => inventory,
      reservations,
    });
    const lines = new InMemoryListingLineStore();
    const gapChecks = new InMemoryGapCheckStore();
    const service = listingService(createInventoryAvailabilityAdapter(inventory), useReservation, lines, gapChecks);

    // 两仓入库：A 仓 30 / B 仓 80（合计 110——与需求等量，拆分行序无关）。
    const whA = await defineWarehouse(inventory, 'g38-wh-a', 'WH-G38-A');
    const whB = await defineWarehouse(inventory, 'g38-wh-b', 'WH-G38-B');
    for (const [target, quantity, receiptKey] of [
      [whA, 30, 'g38-rcv-a'],
      [whB, 80, 'g38-rcv-b'],
    ] as const) {
      const received = await inventory.execute(
        envelope('stock.receive.v1', receiptKey, {
          kind: 'production',
          itemId: 'itm-g38',
          warehouseId: target.warehouseId,
          locationId: target.locationId,
          quantity,
          receiptKey,
          workOrderId: 'wo-g38',
        }),
      );
      expect(received.status).toBe('committed');
    }

    // 零件清单行：item 需求 110（跨仓供给恰好覆盖）。
    await lines.appendLines([
      {
        tenant, id: 'll-g38-1', sheetId: 'ls-g38', workOrderId: 'wo-g38', kind: 'part',
        lineNo: 1, drawingNo: 'DWG-G38', code: null, name: 'g', spec: null, itemId: 'itm-g38',
        requiredQty: 110, neededBy: null, validationStatus: 'matched',
        candidateItemId: 'itm-g38', candidateItemCode: null, similarity: 1, basis: 'code-exact', source: 'manual',
      },
    ]);

    // 第一次核查：利库预占 = min(110, 110) = 110，跨仓拆两行（A 30 + B 80）。
    const first = await service.execute(gapEnvelope('g38-check-1'), 'wo-g38');
    expect(first.status).toBe('committed');
    const firstResult = first as { readonly reservations?: readonly { readonly itemId: string; readonly quantity: number; readonly reservationKeys: readonly string[] }[] };
    expect(firstResult.reservations).toEqual([
      { itemId: 'itm-g38', quantity: 110, reservationKeys: expect.anything() },
    ]);
    expect(firstResult.reservations?.[0]?.reservationKeys.length).toBe(2);
    const rows = await reservations.list(tenant, { status: 'active' });
    expect(rows.length).toBe(2);
    const byWarehouse = new Map(rows.map((row) => [row.warehouseId, row]));
    expect(byWarehouse.get(whA.warehouseId)?.quantity).toBe(30);
    expect(byWarehouse.get(whB.warehouseId)?.quantity).toBe(80);
    // 键形：issue-rsv 约定 + g/wh 段——解析归并订单级锚（设备段空串）。
    for (const row of rows) {
      expect(parseIssueReservationKey(row.reservationKey)).toEqual({
        workOrderId: 'wo-g38',
        equipmentRef: '',
        itemId: 'itm-g38',
      });
      expect(row.reservationKey).toContain(':g:');
      expect(row.reservationKey).toContain(':wh:');
      expect(row.refType).toBe('issue');
      expect(row.refId).toBe('wo-g38');
    }
    // 可用量恒等式：110 全额预占 → 跨仓可用 0。
    expect((await inventory.availableQtyOf(tenant, ['itm-g38'])).get('itm-g38')).toBe(0);

    // 重复核查：供给基数 = 可用 0 + 本令预占 110 → 无缺口（complete）且折差 0
    // ——不新增预占行（幂等收敛，不重复预占）。
    const second = await service.execute(gapEnvelope('g38-check-2'), 'wo-g38');
    expect(second.status).toBe('committed');
    const secondSnapshot = (second as { readonly gapCheck?: { readonly complete: boolean; readonly gapLines: readonly unknown[] } }).gapCheck;
    expect(secondSnapshot?.complete).toBe(true);
    expect(secondSnapshot?.gapLines).toEqual([]);
    expect((await reservations.list(tenant)).length).toBe(2);
    const secondResult = second as { readonly reservations?: readonly { readonly quantity: number }[] };
    expect(secondResult.reservations?.[0]?.quantity).toBe(0);

    // 发料核销（#28 适配器）：预占可核销——A 仓库位发 20 全走预占核销份额。
    const material = createInventoryIssueMaterialPort({
      inventory: () => inventory,
      reservations,
      movements,
      domainEvents,
    });
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-g38', equipmentRef: null, itemIds: ['itm-g38'] })).get('itm-g38'),
    ).toBe(110);
    const issued = await material.issueStock(tenant, {
      issueKey: 'issue-g38-l0',
      workOrderId: 'wo-g38',
      itemId: 'itm-g38',
      allocations: [{ locationId: whA.locationId, quantity: 20 }],
    });
    expect(issued.issued).toBe(true);
    expect(issued.allocations?.[0]).toEqual({
      locationId: whA.locationId, quantity: 20, reservedConsumedQty: 20, availableConsumedQty: 0,
    });
    expect(
      (await material.reservedQtyOf(tenant, { workOrderId: 'wo-g38', equipmentRef: null, itemIds: ['itm-g38'] })).get('itm-g38'),
    ).toBe(90);
  });

  it('供给读取后可用被并发占用 → 分配不足拒绝，gap.check 整单 rejected 不落快照', async () => {
    const reservations = new InMemoryStockReservationStore();
    const inventory = inventoryService(reservations);
    const useReservation = createInventoryUseReservationPort({
      inventory: () => inventory,
      reservations,
    });
    const wh = await defineWarehouse(inventory, 'g38b-wh', 'WH-G38-B1');
    const received = await inventory.execute(
      envelope('stock.receive.v1', 'g38b-rcv', {
        kind: 'production',
        itemId: 'itm-g38b',
        warehouseId: wh.warehouseId,
        locationId: wh.locationId,
        quantity: 10,
        receiptKey: 'g38b-rcv',
        workOrderId: 'wo-g38b',
      }),
    );
    expect(received.status).toBe('committed');

    // 虚报可用量的供给端口（模拟供给读取与预占写入间的竞态/读数虚高）：
    // 目标量 50 > 实际可分配 10 → 适配方折差后分配不足 → 拒绝。
    const inflatedAvailability = {
      availableQty: async (_tenant: typeof tenant, itemIds: readonly string[]) =>
        new Map(itemIds.map((itemId) => [itemId, itemId === 'itm-g38b' ? 100 : 0])),
    };
    const lines = new InMemoryListingLineStore();
    const gapChecks = new InMemoryGapCheckStore();
    const service = listingService(inflatedAvailability, useReservation, lines, gapChecks);
    await lines.appendLines([
      {
        tenant, id: 'll-g38b-1', sheetId: 'ls-g38b', workOrderId: 'wo-g38b', kind: 'standard',
        lineNo: 1, drawingNo: null, code: null, name: 's', spec: null, itemId: 'itm-g38b',
        requiredQty: 50, neededBy: null, validationStatus: 'matched',
        candidateItemId: 'itm-g38b', candidateItemCode: null, similarity: 1, basis: 'code-exact', source: 'manual',
      },
    ]);

    const refused = await service.execute(gapEnvelope('g38b-check-1'), 'wo-g38b');
    expect(refused.status).toBe('rejected');
    const reason = (refused as { readonly reason: string }).reason;
    expect(reason).toContain('利库预占被拒绝');
    expect(reason).toContain('可用量不足');
    expect(await gapChecks.latestByWorkOrder(tenant, 'wo-g38b')).toBeNull();
    // 被拒后竞态窗口内已立的部分预占仍在锚点上（不丢账——下次核查折差收敛）。
    const rows = await reservations.list(tenant, { status: 'active' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.quantity).toBe(10);
  });

  it('预占键追加段约定：g/wh 段（含 rb 叠加）归并原锚，未知段/奇数段拒绝', () => {
    const key = buildIssueReservationKey('wo:1', null, 'itm/1');
    const anchor = { workOrderId: 'wo:1', equipmentRef: '', itemId: 'itm/1' };
    expect(parseIssueReservationKey(`${key}:g:gap-1`)).toEqual(anchor);
    expect(parseIssueReservationKey(`${key}:wh:wh-a`)).toEqual(anchor);
    expect(parseIssueReservationKey(`${key}:g:gap-1:wh:wh-a`)).toEqual(anchor);
    // 撤销恢复叠加在 g/wh 键上（9 段）——仍归并原锚。
    expect(parseIssueReservationKey(`${key}:g:gap-1:wh:wh-a:rb:issue-x@0r0`)).toEqual(anchor);
    expect(parseIssueReservationKey(`${key}:rb:issue-x@0r0`)).toEqual(anchor); // 旧形状不破
    expect(parseIssueReservationKey(`${key}:xx:yy`)).toBeNull(); // 未知段标签
    expect(parseIssueReservationKey(`${key}:g`)).toBeNull(); // 奇数追加段
    expect(parseIssueReservationKey('issue-rsv:v1:wo:itm')).toBeNull(); // 段数不符（既有行为）
  });
});

describe('U6 #29：dispatch→issue 派工生成钩子（store 装饰）', () => {
  /** 记录触发的 IssueService 间谍（真实服务承底，同步命令照常执行）。 */
  class SpyIssueService extends IssueService {
    static readonly triggers: IssueSyncTrigger[] = [];
    override async syncFromDispatch(t: typeof tenant, trigger: IssueSyncTrigger) {
      SpyIssueService.triggers.push(trigger);
      return super.syncFromDispatch(t, trigger);
    }
  }

  function spyIssueService(): SpyIssueService {
    return new SpyIssueService(
      new InMemoryIssueTaskStore(),
      new InMemoryIssueTaskLineStore(),
      new InMemoryIssueRecordStore(),
      new InMemoryIssueExpressStore(),
      new InMemoryIssueOperationStore(),
      new InMemoryIssueDomainEventStore(),
      EMPTY_ISSUE_DEMAND_PORT,
      NOOP_ISSUE_MATERIAL_PORT,
      {},
    );
  }

  it('assembly advance→assigned 触发归拢同步；electrical/非 assigned 不触发；同步异常不回滚派工', async () => {
    const issue = spyIssueService();
    const orders = new InMemoryDispatchOrderStore();
    const wrapped = createIssueSyncDispatchStore(orders, () => issue);
    SpyIssueService.triggers.length = 0;

    const assembly = await orders.create({
      tenant,
      id: 'dsp-u6-1',
      workOrderId: 'wo-u6-1',
      kind: 'assembly',
      flowConfigId: 'fc-1',
      state: 'draft',
      objectVersion: 1,
      title: '装配派工（U6）',
      drawingNo: null,
      operationCode: null,
      material: null,
      sizeSpec: null,
      quantity: 5,
      assignee: null,
      dueAt: null,
      remark: null,
    });
    expect(assembly.state).toBe('draft');

    const advanced = await wrapped.advance(tenant, 'dsp-u6-1', 1, 'assigned', 2, {
      assignee: UserId.create('u-op-u6'),
    });
    expect(advanced.state).toBe('assigned');
    expect(SpyIssueService.triggers.length).toBe(1);
    expect(SpyIssueService.triggers[0]).toMatchObject({
      workOrderId: 'wo-u6-1',
      dispatchKind: 'assembly',
      rollup: true,
    });

    // electrical：无 equipmentRefs 解析源，不触发（取舍见 wiring 文件头 #29）。
    const electrical = await orders.create({
      tenant,
      id: 'dsp-u6-2',
      workOrderId: 'wo-u6-2',
      kind: 'electrical',
      flowConfigId: 'fc-1',
      state: 'draft',
      objectVersion: 1,
      title: '电气派工（U6）',
      drawingNo: null,
      operationCode: null,
      material: null,
      sizeSpec: null,
      quantity: 3,
      assignee: null,
      dueAt: null,
      remark: null,
    });
    void electrical;
    await wrapped.advance(tenant, 'dsp-u6-2', 1, 'executing', 2, undefined);
    expect(SpyIssueService.triggers.length).toBe(1); // 非 assigned 迁移不触发

    // 同步抛错：通知式合同——派工 advance 结果原样返回（不回滚）。
    // 真覆盖要求钩子真的走到：用 assembly 单迁移到 assigned（触发四条件全过），
    // 让 resolveIssue 真抛、catch 路径真执行（验收发现 1 修复：此前用 electrical
    // 单例条件短路，异常从未发生，断言空过）。
    await orders.create({
      tenant,
      id: 'dsp-u6-3',
      workOrderId: 'wo-u6-3',
      kind: 'assembly',
      flowConfigId: 'fc-1',
      state: 'draft',
      objectVersion: 1,
      title: '装配派工（U6 同步异常）',
      drawingNo: null,
      operationCode: null,
      material: null,
      sizeSpec: null,
      quantity: 2,
      assignee: null,
      dueAt: null,
      remark: null,
    });
    const failing = createIssueSyncDispatchStore(orders, () => {
      throw new Error('issue 服务不可用（模拟）');
    });
    const survived = await failing.advance(tenant, 'dsp-u6-3', 1, 'assigned', 2, {
      assignee: UserId.create('u-op-u6'),
    });
    expect(survived.state).toBe('assigned');
    expect(survived.objectVersion).toBe(2);
  });
});

describe('D-23：#29 装饰器透传 transfer（全模块形态转单可用）', () => {
  /** 直构 executing 单（draft→assigned→executing 两跳，v3）。 */
  async function executingOrder(
    orders: InstanceType<typeof InMemoryDispatchOrderStore>,
    id: string,
  ) {
    await orders.create({
      tenant,
      id,
      workOrderId: null,
      kind: 'part',
      flowConfigId: 'fc-1',
      state: 'draft',
      objectVersion: 1,
      title: '转单透传（D-23）',
      drawingNo: null,
      operationCode: 'OP-A',
      material: null,
      sizeSpec: null,
      quantity: 4,
      assignee: null,
      dueAt: null,
      remark: null,
    });
    await orders.advance(tenant, id, 1, 'assigned', 2, { assignee: UserId.create('u-d23-a') });
    await orders.advance(tenant, id, 2, 'executing', 3, undefined);
  }

  it('装饰态 transfer 可用：字段重写落底层、版本不推进、乐观未命中返 null', async () => {
    const orders = new InMemoryDispatchOrderStore();
    await executingOrder(orders, 'dsp-d23-1');
    const wrapped = createIssueSyncDispatchStore(orders, () => undefined);

    // D-23 修复面：可选能力按底层有无透传（此前装饰器丢 transfer →
    // dispatch.transfer.v1 在全模块形态恒拒"不支持转单写入"）。
    expect(wrapped.transfer).toBeDefined();
    const transferred = await wrapped.transfer!(tenant, 'dsp-d23-1', 3, {
      assignee: UserId.create('u-d23-b'),
      operationCode: 'OP-B',
    });
    expect(transferred).not.toBeNull();
    expect(String(transferred!.assignee)).toBe('u-d23-b');
    expect(transferred!.operationCode).toBe('OP-B');
    expect(transferred!.objectVersion).toBe(3); // 转单非状态机迁移：版本不推进
    // 落底层：原 store 读回同一行（透传真转发非旁路副本）。
    const stored = await orders.find(tenant, 'dsp-d23-1');
    expect(String(stored!.assignee)).toBe('u-d23-b');
    // 乐观未命中（旧版本号）→ null（底层合同不回归）。
    expect(await wrapped.transfer!(tenant, 'dsp-d23-1', 2, { assignee: UserId.create('u-d23-c') })).toBeNull();
  });

  it('底层无 transfer 能力 → 装饰态保持缺省（服务侧既有 fail-closed 拒绝不回归）', () => {
    const orders = new InMemoryDispatchOrderStore();
    const bare: Pick<DispatchOrderStore, 'create' | 'find' | 'list' | 'advance'> = {
      create: (input) => orders.create(input),
      find: (t, id) => orders.find(t, id),
      list: (t, filter) => orders.list(t, filter),
      advance: (t, id, eov, next, nov, extra) => orders.advance(t, id, eov, next, nov, extra),
    };
    const wrapped = createIssueSyncDispatchStore(bare, () => undefined);
    expect(wrapped.transfer).toBeUndefined();
  });

  it('组合态装配面：dispatch+issue 同装 → storeOverrides.dispatchOrders.transfer 可用', async () => {
    const context = await NestFactory.create(
      buildAppModule(['core', 'dispatch', 'issue'], {}),
      { logger: ['error', 'warn'] },
    );
    contexts.push(context);
    bindCrossModuleWiring(context);
    const wiring = context.get(CROSS_MODULE_WIRING, { strict: false });
    const wrapped = wiring.storeOverrides.dispatchOrders!;
    expect(wrapped).toBeDefined();
    expect(wrapped.transfer).toBeDefined(); // D-23：装饰态不再丢可选能力
    await wrapped.create({
      tenant,
      id: 'dsp-d23-w',
      workOrderId: null,
      kind: 'part',
      flowConfigId: 'fc-1',
      state: 'draft',
      objectVersion: 1,
      title: '组合态转单（D-23）',
      drawingNo: null,
      operationCode: 'OP-A',
      material: null,
      sizeSpec: null,
      quantity: 2,
      assignee: null,
      dueAt: null,
      remark: null,
    });
    await wrapped.advance(tenant, 'dsp-d23-w', 1, 'assigned', 2, { assignee: UserId.create('u-d23-w') });
    await wrapped.advance(tenant, 'dsp-d23-w', 2, 'executing', 3, undefined);
    const transferred = await wrapped.transfer!(tenant, 'dsp-d23-w', 3, {
      operationCode: 'OP-W2',
    });
    expect(transferred?.operationCode).toBe('OP-W2');
    await context.close();
  });
});

describe('U6 wiring 装配面（全装形态三句柄）', () => {
  it('issue.material / aftercare-claim.reportPort / 装饰态派工单存储均非空', async () => {
    // boot.e2e 同款起服路径（createApplicationContext 无本仓先例且异常面不友好）。
    // attachment 控制器 DI 缺陷已由总控修复（import type→值导入，M2 Wave-1 同型
    // 前科）；其装配面由 boot.e2e U6 全装场景（12 模块+/attachment 探针）覆盖，
    // 此处保持只验 issue/aftercare-claim 接线句柄。
    const context = await NestFactory.create(
      buildAppModule(
        ['core', 'inventory', 'dispatch', 'reporting', 'issue', 'aftercare-claim'],
        {},
      ),
      { logger: ['error', 'warn'] },
    );
    contexts.push(context);
    bindCrossModuleWiring(context);
    const wiring = context.get(CROSS_MODULE_WIRING, { strict: false });
    expect(wiring.register.issue?.material).toBeDefined();
    expect(wiring.register['aftercare-claim']?.reportPort).toBeDefined();
    expect(wiring.storeOverrides.dispatchOrders).toBeDefined();

    // #30 迟到绑定读面：reporting 空账时投影为空数组（绑定路径通、投影归 application 测试）。
    const reportPort = wiring.register['aftercare-claim']?.reportPort;
    expect(reportPort).toBeDefined();
    const lines = await reportPort!.listApproved(tenant, 'dsp-none');
    expect(lines).toEqual([]);
    await context.close();
  });

  it('#38 组合根装配面：listing+inventory 同装 → register.listing.useReservationPort 非空（app-registry 透传）', async () => {
    const context = await NestFactory.create(
      buildAppModule(['core', 'inventory', 'listing'], {}),
      { logger: ['error', 'warn'] },
    );
    contexts.push(context);
    bindCrossModuleWiring(context);
    const wiring = context.get(CROSS_MODULE_WIRING, { strict: false });
    expect(wiring.register.listing?.useReservationPort).toBeDefined();
    // 读面迟到绑定前窗口（bind 前后行为确定性）：未绑定 → 供给基数自有部分 0。
    const port = wiring.register.listing?.useReservationPort;
    expect(port).toBeDefined();
    const own = await port!.reservedForWorkOrder(tenant, 'wo-none', ['itm-none']);
    expect(own.get('itm-none')).toBe(0);
    // ListingService 实际经 app-registry 拿到该端口（模块 register 透传链路通）。
    const { ListingService: RegisteredListingService } = await import('@smes/application');
    const listing = context.get(RegisteredListingService, { strict: false });
    expect(listing).toBeDefined();
    await context.close();
  });
});

describe('D-16 装配面：env SMES_DEFAULT_WAREHOUSE_CODE → inventory 服务选项 defaultWarehouseCode（租户内解析）', () => {
  const ENV_KEY = 'SMES_DEFAULT_WAREHOUSE_CODE';
  const otherTenant = TenantId.create('t-u6-d16');

  /**
   * 预置两租户各自同 code（WH-ENV）仓 + 显式收货仓（组合根 store 注入——
   * 零 DB 形态同源裁决点）。各租户同 code 仓 id 不同 = D-16 症状根因。
   */
  async function preseededWarehouseStore() {
    const warehouses = new InMemoryWarehouseStore();
    for (const [index, seededTenant] of [tenant, otherTenant].entries()) {
      await warehouses.create({
        tenant: seededTenant,
        id: `wh-env-main-${index + 1}`,
        code: 'WH-ENV',
        name: 'env 默认仓',
        defaultLocationId: `loc-env-${index + 1}`,
        locations: [{ id: `loc-env-${index + 1}`, code: 'ENV-1', name: null }],
      });
    }
    await warehouses.create({
      tenant,
      id: 'wh-explicit',
      code: 'WH-EXP',
      name: '显式收货仓',
      defaultLocationId: 'loc-exp-1',
      locations: [{ id: 'loc-exp-1', code: 'EXP-1', name: null }],
    });
    return warehouses;
  }

  it('env 已配 code：两租户省略仓各落自己的 WH-ENV；显式仓优先；env 未配 → 拒收', async () => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'WH-ENV';
    try {
      const context = await NestFactory.create(
        buildAppModule(['core', 'inventory'], { inventoryWarehouseStore: await preseededWarehouseStore() }),
        { logger: ['error', 'warn'] },
      );
      contexts.push(context);
      const inventory = context.get(InventoryService, { strict: false });

      // 默认仓回落（租户内 code 解析）：载荷省略仓 → 各租户自己的 WH-ENV 仓
      //（env → serviceOptions → findByCode(tenant, code) 链路通；D-16 修复面）。
      const receivedA = await inventory.receivePurchaseStock(tenant, {
        receiptKey: 'd16-po-1#1',
        purchaseOrderId: 'd16-po-1',
        itemId: 'itm-d16',
        quantity: 3,
      });
      expect(receivedA.received).toBe(true);
      expect((await inventory.stockLevels(tenant, 'wh-env-main-1', 'itm-d16'))[0]?.qtyOnHand).toBe(3);

      const receivedB = await inventory.receivePurchaseStock(otherTenant, {
        receiptKey: 'd16-po-1#1',
        purchaseOrderId: 'd16-po-1',
        itemId: 'itm-d16',
        quantity: 2,
      });
      expect(receivedB.received).toBe(true);
      expect((await inventory.stockLevels(otherTenant, 'wh-env-main-2', 'itm-d16'))[0]?.qtyOnHand).toBe(2);

      // 显式仓优先：显式 wh-explicit 落显式仓，env 默认仓不动。
      const explicit = await inventory.receivePurchaseStock(tenant, {
        receiptKey: 'd16-po-2#1',
        purchaseOrderId: 'd16-po-2',
        itemId: 'itm-d16',
        quantity: 2,
        warehouseId: 'wh-explicit',
      });
      expect(explicit.received).toBe(true);
      expect((await inventory.stockLevels(tenant, 'wh-explicit', 'itm-d16'))[0]?.qtyOnHand).toBe(2);
      expect((await inventory.stockLevels(tenant, 'wh-env-main-1', 'itm-d16'))[0]?.qtyOnHand).toBe(3);
      await context.close();
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    }

    // env 未配（compose 显式置空同义——`''` 经 `|| null` 归 null）：无默认仓拒收。
    delete process.env[ENV_KEY];
    try {
      const bare = await NestFactory.create(buildAppModule(['core', 'inventory'], {}), {
        logger: ['error', 'warn'],
      });
      contexts.push(bare);
      const inventory = bare.get(InventoryService, { strict: false });
      const refused = await inventory.receivePurchaseStock(tenant, {
        receiptKey: 'd16-po-3#1',
        purchaseOrderId: 'd16-po-3',
        itemId: 'itm-d16',
        quantity: 1,
      });
      expect(refused.received).toBe(false);
      expect(refused.refusedReason).toContain('未指定收货仓且未配置默认仓');
      await bare.close();
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});
