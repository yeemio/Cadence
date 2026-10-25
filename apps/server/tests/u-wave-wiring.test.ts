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
  InMemoryInventoryDomainEventStore,
  InMemoryInventoryOperationStore,
  InMemoryIssueDomainEventStore,
  InMemoryIssueExpressStore,
  InMemoryIssueOperationStore,
  InMemoryIssueRecordStore,
  InMemoryIssueTaskLineStore,
  InMemoryIssueTaskStore,
  InMemoryReleaseFactStore,
  InMemoryShippingOrderStore,
  InMemoryStockAccountStore,
  InMemoryStockLocationBalanceStore,
  InMemoryStockMovementStore,
  InMemoryStockReservationStore,
  InMemoryStocktakeStore,
  InMemoryWarehouseStore,
  InventoryService,
  IssueService,
  NOOP_ISSUE_MATERIAL_PORT,
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
});
