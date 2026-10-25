/**
 * U7 接线波组合根适配焦点测试（#31 projectIssueSource / #32 projectEquipmentSource
 * / #33 projectAftercareSource——cross-module-wiring.ts 约第 800~1025 行取数逻辑）。
 *
 * 与 packages/application/tests/costing/project-cost.test.ts（729527 锚点，全走
 * fake 端口）的分工：本文件用**真实 cross-module-wiring 工厂构造**（经
 * createCrossModuleWiring 装配面取 register.costing 三句柄——不 fake 端口），
 * store 层用 @smes/application 内存实现（与 app-registry 零 DB 裁决同一实现）
 * 种子最小事实，数值断言全部手算可复算：
 *  1. PO 加权价：多行 qty×单价加权（Σ金额/Σ数量四舍五入）、未定价行不计
 *     分母、drawingNo 键优先于 itemId 键、drawingNo miss 回落 itemId。
 *  2. ②非标两段拆分：reserved 段=reservedConsumedQty（金额 null——归 costing
 *     录入价格表）、采购段=max(0,thisQty−reserved)×加权价；std 两段=Σ
 *     allocations reserved/available 回执。
 *  3. ②原材料三形态换算：length=长/1000(m)、长宽厚=(L/1000)(W/1000)(H/1000)
 *     (m³)、area=面积原值(m²)；×件数×录入单价×净发料；无价行不计。
 *  4. 撤销清零行：revoked 记录按 quantity=0/amountMinor=0 投影（回冲面——
 *     costing 侧经 delta 冲销对齐净额，文档 §1.2.1）。
 *  5. ⑥设备采购：PO 行 × equipment 清单行 itemId/drawingNo 匹配；金额 =
 *     receivedQty × unitPriceMinor；未收货/未价 = 0。
 *  6. ⑤售后报销：aftermarket 派工单 × 报销单四费合计；无工作令归属单不入。
 *  7. 装配链回归（U7 验收发现 2 / U4 漏项修复）：buildAppModule 注入
 *     processMaterialLinkStore 后——listing 模块注册拿到**同一实例**（不再回落
 *     自建内存 store——PG 形态读写分家已闭合），且 wiring 面 #31 原材料段经
 *     options.processMaterialLinkStore → wiringStores.processMaterialLinks 全链取到数。
 */
import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
  LISTING_PROCESS_MATERIAL_STORE,
  ListingService,
  InMemoryAftercareClaimStore,
  InMemoryDispatchOrderStore,
  InMemoryIssueRecordStore,
  InMemoryListingLineStore,
  InMemoryProcessMaterialLinkStore,
  InMemoryPurchaseOrderStore,
  type AppendListingLineInput,
  type CreatePurchaseOrderInput,
  type CreateIssueRecordInput,
  type IssueRecordLineSnapshot,
  type ProcessMaterialRowInput,
  type PurchaseOrderLine,
} from '@smes/application';
import { TenantId, UserId } from '@smes/business-core';
import { buildAppModule } from '../src/app-registry.js';
import {
  CROSS_MODULE_WIRING,
  bindCrossModuleWiring,
  createCrossModuleWiring,
} from '../src/cross-module-wiring.js';

const tenant = TenantId.create('t-u7');
const operator = UserId.create('u-op-u7');
const WO = 'wo-u7-w1';

// ---- 直构 harness：真实 wiring 工厂 + 内存 store（每 it 独立实例） ----

interface Harness {
  readonly issueRecords: InMemoryIssueRecordStore;
  readonly purchaseOrders: InMemoryPurchaseOrderStore;
  readonly processMaterialLinks: InMemoryProcessMaterialLinkStore;
  readonly listingLines: InMemoryListingLineStore;
  readonly dispatchOrders: InMemoryDispatchOrderStore;
  readonly aftercareClaims: InMemoryAftercareClaimStore;
  readonly issueSource: NonNullable<ReturnType<typeof createCrossModuleWiring>['register']['costing']>['projectIssueSource'];
  readonly equipmentSource: NonNullable<ReturnType<typeof createCrossModuleWiring>['register']['costing']>['projectEquipmentSource'];
  readonly aftercareSource: NonNullable<ReturnType<typeof createCrossModuleWiring>['register']['costing']>['projectAftercareSource'];
}

function makeHarness(): Harness {
  const issueRecords = new InMemoryIssueRecordStore();
  const purchaseOrders = new InMemoryPurchaseOrderStore();
  const processMaterialLinks = new InMemoryProcessMaterialLinkStore();
  const listingLines = new InMemoryListingLineStore();
  const dispatchOrders = new InMemoryDispatchOrderStore();
  const aftercareClaims = new InMemoryAftercareClaimStore();
  const wiring = createCrossModuleWiring({
    enabled: ['costing', 'issue', 'listing', 'dispatch', 'aftercare-claim'],
    stores: {
      issueRecords,
      purchaseOrders,
      processMaterialLinks,
      listingLines,
      dispatchOrders,
      aftercareClaims,
    },
  });
  // 三句柄在 costing+对侧模块 + 对应 store 全装形态下必须接线（否则下面断言即失败）
  return {
    issueRecords,
    purchaseOrders,
    processMaterialLinks,
    listingLines,
    dispatchOrders,
    aftercareClaims,
    issueSource: wiring.register.costing!.projectIssueSource!,
    equipmentSource: wiring.register.costing!.projectEquipmentSource!,
    aftercareSource: wiring.register.costing!.projectAftercareSource!,
  };
}

// ---- 种子 helper（形状全填，快照字段语义见 issue-stores.ts 注释） ----

function po(id: string, lines: readonly PurchaseOrderLine[], workOrderId: string | null = WO): CreatePurchaseOrderInput {
  return {
    tenant,
    id,
    workOrderId,
    flowConfigId: 'fc-u7',
    state: 'issued',
    objectVersion: 2,
    supplierRef: `sup-${id}`,
    supplierName: null,
    promisedAt: '2026-10-30T00:00:00.000Z',
    lines,
    requestIds: [],
    buyer: null,
    remark: null,
  };
}

function poLine(lineNo: number, itemId: string, drawingNo: string | null, quantity: number, unitPriceMinor: number | null, receivedQty: number): PurchaseOrderLine {
  return { lineNo, itemId, drawingNo, quantity, unitPriceMinor, receivedQty };
}

/** 发料记录种子（明细行快照——只写 #31 适配器消费的字段有意义值，余量字段填守恒值）。 */
async function seedIssueRecord(
  store: InMemoryIssueRecordStore,
  input: {
    readonly id: string;
    readonly issuedAt: string;
    readonly lineKind: 'part' | 'standard';
    readonly equipmentRef: string | null;
    readonly lines: readonly IssueRecordLineSnapshot[];
  },
): Promise<void> {
  const payload: CreateIssueRecordInput = {
    tenant,
    id: input.id,
    recordNo: `ISS-REC-${input.id}`,
    taskId: `itk-${input.id}`,
    taskNo: `TASK-${input.id}`,
    workOrderId: WO,
    workOrderLabel: null,
    dispatchKind: 'assembly',
    rollup: false,
    equipmentRef: input.equipmentRef,
    lineKind: input.lineKind,
    issuedAt: input.issuedAt,
    issuedBy: operator,
    totalQty: input.lines.reduce((sum, line) => sum + line.thisQty, 0),
    expressId: null,
    lines: input.lines,
  };
  await store.create(payload);
}

/** part 行快照（requiredQty=15 守恒：thisQty 12 = issuedAfter；快照余量字段填守恒值）。 */
function partLine(input: {
  readonly taskLineId: string;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly thisQty: number;
  readonly reservedConsumedQty: number;
}): IssueRecordLineSnapshot {
  const issuedAfter = input.thisQty;
  return {
    taskLineId: input.taskLineId,
    kind: 'part',
    sourceLineId: input.sourceLineId,
    itemId: input.itemId,
    moduleName: null,
    name: null,
    drawingNo: input.drawingNo,
    requiredQty: issuedAfter + 3,
    reservedBeforeQty: input.reservedConsumedQty,
    issuedBeforeQty: 0,
    thisQty: input.thisQty,
    issuedAfterQty: issuedAfter,
    pendingAfterQty: 3,
    availableBeforeQty: input.thisQty,
    reservedConsumedQty: input.reservedConsumedQty,
    useInventoryConsumedQty: 0,
    issueKey: null,
    allocations: [],
  };
}

/** standard 行快照（两段数量来自 allocations 回执 Σ——#31 口径）。 */
function standardLine(input: {
  readonly taskLineId: string;
  readonly sourceLineId: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly allocations: readonly { readonly locationId: string; readonly quantity: number; readonly reservedConsumedQty: number; readonly availableConsumedQty: number }[];
}): IssueRecordLineSnapshot {
  const thisQty = input.allocations.reduce((sum, alloc) => sum + alloc.quantity, 0);
  return {
    taskLineId: input.taskLineId,
    kind: 'standard',
    sourceLineId: input.sourceLineId,
    itemId: input.itemId,
    moduleName: null,
    name: null,
    drawingNo: input.drawingNo,
    requiredQty: thisQty,
    reservedBeforeQty: 0,
    issuedBeforeQty: 0,
    thisQty,
    issuedAfterQty: thisQty,
    pendingAfterQty: 0,
    availableBeforeQty: thisQty,
    reservedConsumedQty: input.allocations.reduce((sum, alloc) => sum + alloc.reservedConsumedQty, 0),
    useInventoryConsumedQty: 0,
    issueKey: `issue-${input.taskLineId}`,
    allocations: input.allocations.map((alloc) => ({ ...alloc, recommended: true })),
  };
}

async function seedEquipmentListingLine(store: InMemoryListingLineStore, line: {
  readonly id: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
}): Promise<void> {
  const input: AppendListingLineInput = {
    tenant,
    id: line.id,
    sheetId: 'sht-u7',
    workOrderId: WO,
    kind: 'equipment',
    lineNo: await store.nextLineNo(tenant, 'sht-u7'),
    drawingNo: line.drawingNo,
    code: null,
    name: null,
    spec: null,
    itemId: line.itemId,
    requiredQty: 10,
    neededBy: null,
    validationStatus: 'matched',
    candidateItemId: null,
    candidateItemCode: null,
    similarity: 1,
    basis: null,
    source: 'manual',
  };
  await store.appendLines([input]);
}

async function seedLinks(store: InMemoryProcessMaterialLinkStore, listingLineId: string, processId: string, rows: readonly ProcessMaterialRowInput[]): Promise<void> {
  await store.replaceSet({ tenant, listingLineId, processId, rows });
}

async function seedDispatchOrder(store: InMemoryDispatchOrderStore, input: {
  readonly id: string;
  readonly kind: 'aftermarket' | 'assembly';
  readonly workOrderId: string | null;
}): Promise<void> {
  await store.create({
    tenant,
    id: input.id,
    workOrderId: input.workOrderId,
    kind: input.kind,
    flowConfigId: 'fc-u7',
    state: 'done',
    objectVersion: 1,
    title: `派工单 ${input.id}`,
    drawingNo: null,
    operationCode: null,
    material: null,
    sizeSpec: null,
    quantity: 1,
    assignee: null,
    dueAt: null,
    remark: null,
  });
}

// ---- 场景①+⑤：PO 加权价 + 设备采购（#32） ----

describe('U7 #32：设备采购行（PO 行 × equipment 清单行匹配）', () => {
  it('金额=receivedQty×单价、未收货/未价=0、itemId/drawingNo 匹配回链清单行', async () => {
    const harness = makeHarness();
    await seedEquipmentListingLine(harness.listingLines, { id: 'll-eq-1', itemId: 'itm-eq', drawingNo: 'DW-EQ' });
    await seedEquipmentListingLine(harness.listingLines, { id: 'll-eq-2', itemId: 'itm-eq2', drawingNo: null });
    await harness.purchaseOrders.create(
      po('po-eq', [
        // ①已收已价：10 × 50000 = 500000；drawingNo 命中 ll-eq-1
        poLine(1, 'itm-eq', 'DW-EQ', 10, 50000, 10),
        // ②仅 itemId 匹配面：4 × 30000 = 120000；命中 ll-eq-2
        poLine(2, 'itm-eq2', null, 4, 30000, 4),
        // ③未收货：amount 0（匹配面 ll-eq-1 仍回链）
        poLine(3, 'itm-eq', null, 8, 60000, 0),
        // ④未价：amount 0
        poLine(4, 'itm-eq', null, 6, null, 6),
      ]),
    );
    const lines = await harness.equipmentSource!.equipmentPurchases(tenant, WO);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => [line.lineNo, line.amountMinor, line.equipmentListingLineId])).toEqual([
      [1, 500000, 'll-eq-1'], // 10×50000
      [2, 120000, 'll-eq-2'], // 4×30000
      [3, 0, 'll-eq-1'], // receivedQty=0
      [4, 0, 'll-eq-1'], // unitPriceMinor=null
    ]);
    expect(lines.map((line) => line.quantity)).toEqual([10, 4, 8, 6]); // 订购量原样透传
  });
});

// ---- 场景①+②+③+④：#31 issue 发料段（加权价/两段拆分/原材料三形态/撤销清零） ----

describe('U7 #31：issue 发料段（加权价 × 两段拆分 × 原材料三形态 × 撤销清零）', () => {
  it('PO 加权价：多行加权、未定价行不计分母、drawingNo 键优先、miss 回落 itemId', async () => {
    const harness = makeHarness();
    // itm-x/DW-X：10×50000 + 10×70000 = 1200000 / 20 = 60000（未定价 5 件不计分母——
    // 若误计则 1200000/25 = 48000，purchase 断言即失败）
    await harness.purchaseOrders.create(
      po('po-a', [
        poLine(1, 'itm-x', 'DW-X', 10, 50000, 10),
        poLine(2, 'itm-x', 'DW-X', 10, 70000, 0),
        poLine(3, 'itm-x', 'DW-X', 5, null, 0),
      ]),
    );
    // DW-Y 单行：加权 = 原价 90000
    await harness.purchaseOrders.create(po('po-b', [poLine(1, 'itm-z', 'DW-Y', 4, 90000, 0)]));

    await seedIssueRecord(harness.issueRecords, {
      id: 'irc-w',
      issuedAt: '2026-10-24T08:00:00.000Z',
      lineKind: 'part',
      equipmentRef: 'eq-1',
      lines: [
        // p1：12 = 利库 5 + 采购 7；双键同值——DW-X 键 60000
        partLine({ taskLineId: 'itl-p1', sourceLineId: 'll-p1', itemId: 'itm-x', drawingNo: 'DW-X', thisQty: 12, reservedConsumedQty: 5 }),
        // p2：itemId 无任何 PO，但 drawingNo='DW-Y' 命中 → 90000（itemId 键优先则 null——可区分）
        partLine({ taskLineId: 'itl-p2', sourceLineId: 'll-p2', itemId: 'itm-else', drawingNo: 'DW-Y', thisQty: 2, reservedConsumedQty: 0 }),
        // p3：drawingNo='DW-NOPE' 无 PO → 回落 itemId 键 60000
        partLine({ taskLineId: 'itl-p3', sourceLineId: 'll-p3', itemId: 'itm-x', drawingNo: 'DW-NOPE', thisQty: 1, reservedConsumedQty: 0 }),
        // std：Σ allocations reserved=30 / available=20，itemId 键 60000
        standardLine({
          taskLineId: 'itl-s1',
          sourceLineId: 'll-s1',
          itemId: 'itm-x',
          drawingNo: null,
          allocations: [
            { locationId: 'loc-1', quantity: 40, reservedConsumedQty: 30, availableConsumedQty: 10 },
            { locationId: 'loc-2', quantity: 10, reservedConsumedQty: 0, availableConsumedQty: 10 },
          ],
        }),
      ],
    });

    const lines = await harness.issueSource!.issueSegments(tenant, WO);
    expect(lines).toHaveLength(6); // p1 两段 + p2/p3 采购段 + std 两段（无 links → 无 raw 段）
    const of = (taskLineId: string, segment: string) =>
      lines.filter((line) => line.taskLineId === taskLineId && line.segment === segment);
    // p1：reserved 5（金额 null——归录入价格表）+ purchase 7×60000=420000
    expect(of('itl-p1', 'reserved')).toEqual([
      expect.objectContaining({ kind: 'part', quantity: 5, amountMinor: null }),
    ]);
    expect(of('itl-p1', 'purchase')).toEqual([
      expect.objectContaining({ kind: 'part', quantity: 7, amountMinor: 420000 }),
    ]);
    // p2：drawingNo 优先 → 2×90000=180000
    expect(of('itl-p2', 'purchase')).toEqual([
      expect.objectContaining({ kind: 'part', quantity: 2, amountMinor: 180000 }),
    ]);
    // p3：drawingNo miss → itemId 回落 → 1×60000=60000
    expect(of('itl-p3', 'purchase')).toEqual([
      expect.objectContaining({ kind: 'part', quantity: 1, amountMinor: 60000 }),
    ]);
    // std：reserved 30×60000=1800000 + purchase 20×60000=1200000
    expect(of('itl-s1', 'reserved')).toEqual([
      expect.objectContaining({ kind: 'standard', quantity: 30, amountMinor: 1800000 }),
    ]);
    expect(of('itl-s1', 'purchase')).toEqual([
      expect.objectContaining({ kind: 'standard', quantity: 20, amountMinor: 1200000 }),
    ]);
  });

  it('原材料三形态换算：length(m)/长宽厚(m³)/面积(m²)×件数×单价×净发料；无价行不计', async () => {
    const harness = makeHarness();
    // 净发料 7 件（无 PO → purchase 段金额 null，原材料段独立计价）
    await seedIssueRecord(harness.issueRecords, {
      id: 'irc-raw',
      issuedAt: '2026-10-24T09:00:00.000Z',
      lineKind: 'part',
      equipmentRef: 'eq-1',
      lines: [
        partLine({ taskLineId: 'itl-r1', sourceLineId: 'll-raw', itemId: 'itm-raw', drawingNo: null, thisQty: 7, reservedConsumedQty: 0 }),
      ],
    });
    await seedLinks(harness.processMaterialLinks, 'll-raw', 'op-10', [
      // length：2500mm→2.5m × 2件 × 3000分/m × 7 = 105000
      { id: 'ppm-1', rawMaterialId: 'mat-1', quantity: 2, unitPriceMinor: 3000, measureType: 'length', partLength: 2500, partWidth: null, partHeight: null, cutSizeForm: 'length', cutSizeUnit: 'mm' },
      // 长宽厚：2m×1m×0.5m=1m³ × 3件 × 80000 × 7 = 1680000
      { id: 'ppm-2', rawMaterialId: 'mat-2', quantity: 3, unitPriceMinor: 80000, measureType: 'volume', partLength: 2000, partWidth: 1000, partHeight: 500, cutSizeForm: 'length-width-height', cutSizeUnit: 'mm' },
      // area：4.5m² × 1件 × 12000 × 7 = 378000
      { id: 'ppm-3', rawMaterialId: 'mat-3', quantity: 1, unitPriceMinor: 12000, measureType: 'area', partLength: 4.5, partWidth: null, partHeight: null, cutSizeForm: 'area', cutSizeUnit: 'm2' },
      // 无价行不计（有尺寸有件数、单价 null）
      { id: 'ppm-4', rawMaterialId: 'mat-4', quantity: 1, unitPriceMinor: null, measureType: 'length', partLength: 1000, partWidth: null, partHeight: null, cutSizeForm: 'length', cutSizeUnit: 'mm' },
    ]);

    const lines = await harness.issueSource!.issueSegments(tenant, WO);
    // purchase 段：无价（itm-raw 无 PO）——金额 null 仍出数量行
    expect(lines).toEqual([
      expect.objectContaining({ taskLineId: 'itl-r1', segment: 'purchase', quantity: 7, amountMinor: null }),
      expect.objectContaining({ taskLineId: 'itl-r1', segment: 'raw', quantity: 7, amountMinor: 2163000 }),
    ]);
  });

  it('撤销记录按清零行投影（quantity=0/amountMinor=0——delta 冲销对齐面），active 记录不受影响', async () => {
    const harness = makeHarness();
    await harness.purchaseOrders.create(po('po-a', [poLine(1, 'itm-x', 'DW-X', 10, 50000, 10)]));
    // active：p0 两段（3×50000=150000 + raw 15000）
    await seedIssueRecord(harness.issueRecords, {
      id: 'irc-keep',
      issuedAt: '2026-10-24T10:00:00.000Z',
      lineKind: 'part',
      equipmentRef: 'eq-1',
      lines: [
        partLine({ taskLineId: 'itl-keep', sourceLineId: 'll-keep', itemId: 'itm-x', drawingNo: null, thisQty: 3, reservedConsumedQty: 0 }),
      ],
    });
    await seedLinks(harness.processMaterialLinks, 'll-keep', 'op-20', [
      { id: 'ppm-keep', rawMaterialId: 'mat-1', quantity: 1, unitPriceMinor: 5000, measureType: 'length', partLength: 1000, partWidth: null, partHeight: null, cutSizeForm: 'length', cutSizeUnit: 'mm' },
    ]);
    // revoked：active 时本应贡献 purchase 3×50000 + raw 15000；撤销后净贡献 0
    await seedIssueRecord(harness.issueRecords, {
      id: 'irc-revoked',
      issuedAt: '2026-10-24T11:00:00.000Z',
      lineKind: 'part',
      equipmentRef: 'eq-1',
      lines: [
        partLine({ taskLineId: 'itl-rev', sourceLineId: 'll-keep', itemId: 'itm-x', drawingNo: null, thisQty: 3, reservedConsumedQty: 0 }),
      ],
    });
    const revoked = await harness.issueRecords.revoke(tenant, 'irc-revoked', 1, '2026-10-25T09:00:00.000Z', operator);
    expect(revoked?.state).toBe('revoked');

    const lines = await harness.issueSource!.issueSegments(tenant, WO);
    const byRecord = (recordId: string) => lines.filter((line) => line.recordId === recordId);
    // active 记录照常出段（清零不外溢）
    expect(byRecord('irc-keep')).toEqual([
      expect.objectContaining({ segment: 'purchase', quantity: 3, amountMinor: 150000 }),
      expect.objectContaining({ segment: 'raw', quantity: 3, amountMinor: 15000 }),
    ]);
    // revoked 记录：清零行（purchase/raw 两段 quantity=0、amountMinor=0；
    // reservedConsumedQty=0 → reserved 段本就不出）
    expect(byRecord('irc-revoked')).toEqual([
      expect.objectContaining({ segment: 'purchase', quantity: 0, amountMinor: 0 }),
      expect.objectContaining({ segment: 'raw', quantity: 0, amountMinor: 0 }),
    ]);
  });
});

// ---- 场景⑥：#33 售后报销 ----

describe('U7 #33：售后报销段（aftermarket 派工 × 报销单四费合计）', () => {
  it('四费合计行、无工作令归属单不入、未填报报销不计', async () => {
    const harness = makeHarness();
    await seedDispatchOrder(harness.dispatchOrders, { id: 'dsp-am-1', kind: 'aftermarket', workOrderId: WO });
    await seedDispatchOrder(harness.dispatchOrders, { id: 'dsp-am-2', kind: 'aftermarket', workOrderId: null }); // 无归属——不入
    await seedDispatchOrder(harness.dispatchOrders, { id: 'dsp-am-3', kind: 'aftermarket', workOrderId: WO }); // 未填报——不计
    await seedDispatchOrder(harness.dispatchOrders, { id: 'dsp-asm', kind: 'assembly', workOrderId: WO }); // 非售后——不查
    // acl-1：两行四费（12000+5000+8000+3000=28000；0+2500+0+500=3000）→ 31000
    await harness.aftercareClaims.create({
      tenant,
      id: 'acl-1',
      dispatchId: 'dsp-am-1',
      lines: [
        { id: 'acll-1', reportId: 'wr-1', reportDate: '2026-10-22', worker: operator, approvedBy: null, approvedMinutes: 180, lodgingMinor: 12000, trafficMinor: 5000, overtimeMinor: 8000, otherMinor: 3000, remark: null },
        { id: 'acll-2', reportId: 'wr-2', reportDate: '2026-10-23', worker: operator, approvedBy: null, approvedMinutes: 90, lodgingMinor: 0, trafficMinor: 2500, overtimeMinor: 0, otherMinor: 500, remark: null },
      ],
    });
    // acl-2：挂无归属售后单——不应出现
    await harness.aftercareClaims.create({
      tenant,
      id: 'acl-2',
      dispatchId: 'dsp-am-2',
      lines: [
        { id: 'acll-3', reportId: 'wr-3', reportDate: '2026-10-23', worker: operator, approvedBy: null, approvedMinutes: 60, lodgingMinor: 9900, trafficMinor: 0, overtimeMinor: 0, otherMinor: 99, remark: null },
      ],
    });

    const lines = await harness.aftercareSource!.aftercareClaims(tenant, WO);
    expect(lines).toEqual([
      expect.objectContaining({ claimId: 'acl-1', dispatchId: 'dsp-am-1', workOrderId: WO, reimburseMinor: 31000 }),
    ]);
  });
});

// ---- 装配链回归：listing 注册传 processMaterialStore（U7 验收发现 2 / U4 漏项修复） ----

const contexts: INestApplicationContext[] = [];

afterAll(async () => {
  for (const context of contexts) await context.close();
});

describe('U7 装配链回归：buildAppModule 注入 processMaterialLinkStore 同源到 listing 模块与 wiring', () => {
  it('listing 模块拿到同一实例（不回落自建内存 store）且 #31 原材料段全链取数', async () => {
    const WO2 = 'wo-u7-w2';
    const processMaterialLinks = new InMemoryProcessMaterialLinkStore();
    const issueRecords = new InMemoryIssueRecordStore();
    // 种子：part 净发料 2（无 PO → 采购段金额 null）；原材料 1m×1件×2500分×2 = 5000
    await issueRecords.create({
      tenant,
      id: 'irc-reg',
      recordNo: 'ISS-REC-irc-reg',
      taskId: 'itk-reg',
      taskNo: 'TASK-reg',
      workOrderId: WO2,
      workOrderLabel: null,
      dispatchKind: 'assembly',
      rollup: false,
      equipmentRef: null,
      lineKind: 'part',
      issuedAt: '2026-10-24T12:00:00.000Z',
      issuedBy: operator,
      totalQty: 2,
      expressId: null,
      lines: [
        partLine({ taskLineId: 'itl-reg', sourceLineId: 'll-reg', itemId: 'itm-reg', drawingNo: null, thisQty: 2, reservedConsumedQty: 0 }),
      ],
    });
    await processMaterialLinks.replaceSet({
      tenant,
      listingLineId: 'll-reg',
      processId: 'op-reg',
      rows: [
        { id: 'ppm-reg', rawMaterialId: 'mat-reg', quantity: 1, unitPriceMinor: 2500, measureType: 'length', partLength: 1000, partWidth: null, partHeight: null, cutSizeForm: 'length', cutSizeUnit: 'mm' },
      ],
    });

    const context = await NestFactory.create(
      buildAppModule(['core', 'listing', 'costing', 'issue', 'dispatch', 'aftercare-claim'], {
        issueRecordStore: issueRecords,
        processMaterialLinkStore: processMaterialLinks,
      }),
      { logger: ['error', 'warn'] },
    );
    contexts.push(context);
    bindCrossModuleWiring(context);

    // ① U4 漏项修复回归：listing 模块注册收到同一实例（此前不传 → 模块回落自建
    // 内存 store，PG 形态读写分家）。
    const listingStore = context.get(LISTING_PROCESS_MATERIAL_STORE, { strict: false });
    expect(listingStore).toBe(processMaterialLinks);

    // ② listing 模块装配态可用（回落态语义的传入形态——服务可解析、正常响应）。
    expect(context.get(ListingService, { strict: false })).toBeInstanceOf(ListingService);

    // ③ wiring 面：options.processMaterialLinkStore → wiringStores.processMaterialLinks
    // → #31 适配器全链——原材料段取到数（若 app-registry 漏传 wiringStores，
    // processMaterialLinks=undefined → raw 段不出现，断言即失败）。
    const wiring = context.get(CROSS_MODULE_WIRING, { strict: false });
    const issueSource = wiring.register.costing?.projectIssueSource;
    expect(issueSource).toBeDefined();
    const segments = await issueSource!.issueSegments(tenant, WO2);
    expect(segments).toEqual([
      expect.objectContaining({ segment: 'purchase', quantity: 2, amountMinor: null }),
      expect.objectContaining({ segment: 'raw', quantity: 2, amountMinor: 5000 }),
    ]);
  });
});
