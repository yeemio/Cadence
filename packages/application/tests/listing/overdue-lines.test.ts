/**
 * U8 逾期未交**明细行**事实面测试（逾期交货采购件报表-开发文档：订单明细行级）：
 * 一行一采购订单明细行（orderLineId=订单#行号），与订单头粒度 overdueList 并存。
 * 覆盖：交期已过且未收齐行纳入（含已收货态部分收货行）、已收齐行退出、
 * 未到期剔除、无工作令（手工采购行）纳入且 workOrderId/drawingNo 为 null、
 * 未入库数量=quantity−receivedQty、交期升序+orderLineId 稳定序、工作令过滤、
 * 租户隔离、控制器路由/权限码/空串归一。固化留存（②③）依赖跑批历史，
 * 实时面不出——归快照波，此处不测。
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
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { TenantContext } from '../../src/core/tenant-context.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import {
  InMemoryGapCheckStore,
  InMemoryListingDomainEventStore,
  InMemoryListingLineStore,
  InMemoryListingOperationStore,
  InMemoryListingSheetStore,
  InMemoryPurchaseOrderStore,
  InMemoryPurchaseRequestStore,
  InMemoryPurchaseReturnStore,
} from '../../src/listing/in-memory-listing-stores.js';
import { PurchaseQueriesController } from '../../src/listing/listing.controllers.js';
import { ListingService } from '../../src/listing/listing.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const planner = UserId.create('u-planner-01');
const approver = UserId.create('u-approver-01');
const buyer = UserId.create('u-buyer-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

function newHarness() {
  const orders = new InMemoryPurchaseOrderStore();
  const service = new ListingService(
    new InMemoryListingSheetStore(),
    new InMemoryListingLineStore(),
    new InMemoryGapCheckStore(),
    new InMemoryPurchaseRequestStore(),
    orders,
    new InMemoryPurchaseReturnStore(),
    new InMemoryListingOperationStore(),
    new InMemoryListingDomainEventStore(),
    createInMemoryApprovalEventStore(),
    new InMemoryTodoStore(),
    {},
    { orderApprover: approver, now: () => FIXED_NOW },
  );
  return { orders, service };
}

let opCounter = 0;
function envelope(
  kind: string,
  payload: unknown,
  options: {
    readonly tenant?: typeof t1;
    readonly actor?: typeof planner;
    readonly expectedRevision?: number | 'initial';
  } = {},
): CommandEnvelope<{ kind: never; payload: unknown }> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: options.actor ?? planner,
    operationId: OperationId.create(`op-overdue-lines-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as never,
  }) as CommandEnvelope<{ kind: never; payload: unknown }>;
}

function mustCommit(result: { readonly status: string; readonly reason?: string }): unknown {
  if (result.status !== 'committed') {
    throw new Error(`期望 committed，得到 ${result.status}：${'reason' in result ? String(result.reason) : ''}`);
  }
  return result;
}

/** 建单+推进到目标态（体例同 listing.test.ts orderAt；approve 需配置审核人；租户贯穿全链）。 */
async function orderTo(
  service: ListingService,
  overrides: {
    readonly workOrderId?: string | null;
    readonly promisedAt: string;
    readonly lines: readonly { itemId: string; quantity: number; drawingNo?: string }[];
    readonly toState?: 'submitted' | 'approved' | 'issued' | 'received';
    readonly receiveLines?: readonly { lineNo: number; receivedQty: number }[];
    readonly tenant?: typeof t1;
  },
): Promise<string> {
  const tenant = overrides.tenant;
  const submitted = mustCommit(
    await service.execute(
      envelope(
        'purchase.order.submit.v1',
        {
          workOrderId: overrides.workOrderId === undefined ? 'wo-1' : overrides.workOrderId,
          supplierRef: 'SUP-001',
          supplierName: '供应商甲',
          promisedAt: overrides.promisedAt,
          lines: overrides.lines,
          requestIds: [],
          buyer,
          remark: 'r',
        },
        { ...(tenant === undefined ? {} : { tenant }) },
      ),
    ),
  ) as { purchaseOrder?: { id: string } };
  const orderId = submitted.purchaseOrder?.id as string;
  const target = overrides.toState ?? 'issued';
  if (target === 'submitted') return orderId;
  mustCommit(
    await service.execute(
      envelope(
        'purchase.order.approve.v1',
        { remark: 'r' },
        { expectedRevision: 2, actor: approver, ...(tenant === undefined ? {} : { tenant }) },
      ),
      orderId,
    ),
  );
  if (target === 'approved') return orderId;
  mustCommit(
    await service.execute(
      envelope('purchase.order.issue.v1', {}, { expectedRevision: 3, ...(tenant === undefined ? {} : { tenant }) }),
      orderId,
    ),
  );
  if (target === 'issued') return orderId;
  mustCommit(
    await service.execute(
      envelope(
        'purchase.order.receive.v1',
        { lines: overrides.receiveLines ?? [] },
        { expectedRevision: 4, ...(tenant === undefined ? {} : { tenant }) },
      ),
      orderId,
    ),
  );
  return orderId;
}

describe('U8 逾期未交明细行 · service', () => {
  it('一行一明细行：未收齐行纳入（含已收货态部分收货）、已收齐行退出、未到期剔除、手工行 null 组、交期升序稳定序', async () => {
    const { orders, service } = newHarness();
    // A：wo-1 两行均未收（issued）——同单两行各自成行
    const orderA = await orderTo(service, {
      promisedAt: '2026-10-20T00:00:00.000Z',
      lines: [
        { itemId: 'item-a', quantity: 10, drawingNo: 'DWG-A' },
        { itemId: 'item-b', quantity: 4 },
      ],
    });
    // B：未到期（issued）剔除
    await orderTo(service, {
      workOrderId: 'wo-2',
      promisedAt: '2026-12-30T00:00:00.000Z',
      lines: [{ itemId: 'item-x', quantity: 7 }],
    });
    // C：无工作令（手工采购行）+ submitted 态——同等纳入
    await orderTo(service, {
      workOrderId: null,
      promisedAt: '2026-10-10T00:00:00.000Z',
      lines: [{ itemId: 'item-m', quantity: 5 }],
      toState: 'submitted',
    });
    // D：部分收货后整单 received——未收齐行保留、已收齐行退出
    await orderTo(service, {
      workOrderId: 'wo-3',
      promisedAt: '2026-10-18T00:00:00.000Z',
      lines: [
        { itemId: 'item-c', quantity: 8 },
        { itemId: 'item-d', quantity: 2 },
      ],
      toState: 'received',
      receiveLines: [
        { lineNo: 1, receivedQty: 6 },
        { lineNo: 2, receivedQty: 2 },
      ],
    });

    // E：draft 态（未下发）——剔除（U8 验收发现 2 补例：此前 state!=='draft' 分支
    // 无用例可证伪，误改恒真测试仍绿；直接落 store 种子以覆盖命令面到不了的态）。
    await orders.create({
      tenant: t1,
      id: 'po-draft-u8',
      workOrderId: 'wo-4',
      flowConfigId: 'fc-po',
      state: 'draft',
      objectVersion: 1,
      supplierRef: 'SUP-001',
      supplierName: '供应商甲',
      promisedAt: '2026-10-01T00:00:00.000Z',
      lines: [{ lineNo: 1, itemId: 'item-draft', drawingNo: null, quantity: 3, unitPriceMinor: null, receivedQty: 0 }],
      requestIds: [],
      buyer,
      remark: 'r',
    });

    const rows = await service.overdueLines(t1);
    expect(rows.length).toBe(4); // C、D#c1、A#1、A#2（B 未到期、D#2 已收齐、E draft 剔除）
    expect(rows.map((row) => row.itemId)).toEqual(['item-m', 'item-c', 'item-a', 'item-b']); // 交期 10-10 < 10-18 < 10-20（同单 #1 < #2 稳定）；item-draft 不在

    const manual = rows[0]!;
    expect(manual.workOrderId).toBeNull(); // 手工采购行：null（呈现层显示「—」）
    expect(manual.drawingNo).toBeNull();
    expect(manual.orderLineId.endsWith('#1')).toBe(true);
    expect(manual.unInboundQty).toBe(5);
    expect(manual.daysOverdue).toBe(15);
    const partial = rows[1]!;
    expect(partial.state).toBe('received'); // 已完成态部分收货行保留（未入库数量>0）
    expect(partial.stateLabel).toBe('已收货');
    expect(partial.receivedQty).toBe(6);
    expect(partial.unInboundQty).toBe(2);
    expect(partial.purchaseOrderId).not.toBe(orderA); // 订单级字段随行携带
    const [a1, a2] = [rows[2]!, rows[3]!];
    expect(a1.orderLineId).toBe(`${orderA}#1`);
    expect(a2.orderLineId).toBe(`${orderA}#2`);
    expect(a1.unInboundQty).toBe(10);
    expect(a2.drawingNo).toBeNull();
    expect(a1.daysOverdue).toBe(5); // FIXED_NOW 2026-10-25 − 计划到货 10-20
    // 订单头粒度面并存：overdueList 仍是订单级且不含 received 态 D 单（两面口径差异如实呈现）
    const headerRows = await service.overdueList(t1);
    expect(headerRows.map((row) => row.state)).toEqual(['submitted', 'issued']); // C、A
  });

  it('工作令过滤与租户隔离', async () => {
    const { service } = newHarness();
    await orderTo(service, {
      workOrderId: 'wo-1',
      promisedAt: '2026-10-20T00:00:00.000Z',
      lines: [{ itemId: 'item-a', quantity: 10 }],
    });
    await orderTo(service, {
      workOrderId: 'wo-2',
      promisedAt: '2026-10-21T00:00:00.000Z',
      lines: [{ itemId: 'item-b', quantity: 3 }],
    });
    // 他租户同交期订单不计入
    await orderTo(service, {
      workOrderId: 'wo-9',
      promisedAt: '2026-10-20T00:00:00.000Z',
      lines: [{ itemId: 'item-z', quantity: 9 }],
      tenant: t2,
    });

    const byWorkOrder = await service.overdueLines(t1, 'wo-2');
    expect(byWorkOrder.map((row) => row.itemId)).toEqual(['item-b']);
    expect((await service.overdueLines(t1)).length).toBe(2);
    expect(await service.overdueLines(t1, 'wo-9')).toEqual([]); // 他租户工作令在 t1 不可见
    expect((await service.overdueLines(t2)).map((row) => row.itemId)).toEqual(['item-z']);
    expect((await service.overdueLines(t2, 'wo-9')).length).toBe(1); // t2 内按本租户工作令可命中
  });
});

describe('U8 逾期未交明细行 · controller', () => {
  it('权限码 purchase:read；租户取 TenantContext（ALS）；workOrderId 空串归一为未传', async () => {
    const { service } = newHarness();
    await orderTo(service, {
      workOrderId: 'wo-1',
      promisedAt: '2026-10-20T00:00:00.000Z',
      lines: [{ itemId: 'item-a', quantity: 10 }],
    });
    const tenantContext = new TenantContext(); // 控制器与 run 共用同一实例（ALS 同源）
    const controller = new PurchaseQueriesController(tenantContext, service);
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.overdueLines)).toBe('purchase:read');
    const all = await tenantContext.run(t1, () => controller.overdueLines(''));
    expect(all.overdueLines.length).toBe(1);
    expect(all.overdueLines[0]?.orderLineId.endsWith('#1')).toBe(true);
    const filtered = await tenantContext.run(t1, () => controller.overdueLines('wo-1'));
    expect(filtered.overdueLines.length).toBe(1);
    const none = await tenantContext.run(t1, () => controller.overdueLines('wo-none'));
    expect(none.overdueLines).toEqual([]);
  });
});
