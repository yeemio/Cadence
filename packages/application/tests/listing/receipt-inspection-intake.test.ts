/**
 * 收货→三类采购质检来源投递（17 册 RQ-019 / fix-wave-3 W3-1）域层测试：
 * listing receivePurchase 落账后经 inspectionIntake 端口逐行投递来源事实——
 * ①有申请承接：kind 经申请链推导映射 + 全字段断言（sourceRefId 复用 receiptKey
 * 幂等键约定）；②无申请/无匹配/多 kind 歧义：不投递不报错；③端口抛异常：通知式
 * 合同——收货仍 committed 不回滚。组合根接线（迟到绑定）由 apps/server
 * cross-module-wiring 测试覆盖，本文件只锚域层端口合同。
 */
import { describe, expect, it, vi } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
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
import { ListingService } from '../../src/listing/listing.service.js';
import type { ListingCommitted, ListingCommandResult } from '../../src/listing/listing.service.js';
import { LISTING_NOOP_RECEIPT_PORT } from '../../src/listing/listing-ports.js';
import type { ListingCommand } from '../../src/listing/listing-input.js';
import type {
  InspectionIntakePort,
  InspectionIntakeReceipt,
  InspectionSourceFact,
} from '../../src/inspection/inspection-ports.js';

const t1 = TenantId.create('t1');
const planner = UserId.create('u-planner-01');
const approver = UserId.create('u-approver-01');
const buyer = UserId.create('u-buyer-01');
const FIXED_NOW = '2026-10-26T10:00:00.000Z';

class FakeInspectionIntake implements InspectionIntakePort {
  readonly facts: { readonly tenant: unknown; readonly fact: InspectionSourceFact }[] = [];
  failMessage: string | null = null;

  async receiveSourceFact(tenant: unknown, fact: InspectionSourceFact): Promise<InspectionIntakeReceipt> {
    this.facts.push({ tenant, fact });
    if (this.failMessage !== null) throw new Error(this.failMessage);
    return { inspectionId: `insp-${this.facts.length}`, created: true };
  }
}

function newHarness() {
  const requests = new InMemoryPurchaseRequestStore();
  const orders = new InMemoryPurchaseOrderStore();
  const intake = new FakeInspectionIntake();
  const service = new ListingService(
    new InMemoryListingSheetStore(),
    new InMemoryListingLineStore(),
    new InMemoryGapCheckStore(),
    requests,
    orders,
    new InMemoryPurchaseReturnStore(),
    new InMemoryListingOperationStore(),
    new InMemoryListingDomainEventStore(),
    createInMemoryApprovalEventStore(),
    new InMemoryTodoStore(),
    { receipt: LISTING_NOOP_RECEIPT_PORT, inspectionIntake: intake },
    { orderApprover: approver, now: () => FIXED_NOW },
  );
  return { requests, orders, intake, service };
}

let opCounter = 0;
function envelope(
  kind: string,
  payload: unknown,
  options: { readonly actor?: typeof planner; readonly expectedRevision?: number } = {},
): CommandEnvelope<ListingCommand> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: options.actor ?? planner,
    operationId: OperationId.create(`op-w3-intake-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as never,
  }) as CommandEnvelope<ListingCommand>;
}

function mustCommit(result: ListingCommandResult): ListingCommitted {
  if (result.status !== 'committed') {
    throw new Error(`期望 committed，得到 ${result.status}：${'reason' in result ? result.reason : ''}`);
  }
  return result;
}

async function createRequest(
  service: ListingService,
  payload: { readonly kind: string; readonly itemId: string; readonly quantity: number },
): Promise<string> {
  const created = mustCommit(await service.execute(envelope('purchase.request.create.v1', { workOrderId: 'wo-w3', ...payload })));
  return (created.purchaseRequest as NonNullable<typeof created.purchaseRequest>).id;
}

interface OrderOverrides {
  readonly requestIds?: readonly string[];
  readonly lines?: readonly { readonly itemId: string; readonly quantity: number; readonly drawingNo?: string | null }[];
}

/** 建单提交并把订单推进到 issued（receive 前置态），返回订单行事实源。 */
async function issueOrder(service: ListingService, overrides: OrderOverrides = {}) {
  const submitted = mustCommit(
    await service.execute(
      envelope('purchase.order.submit.v1', {
        workOrderId: 'wo-w3',
        supplierRef: 'SUP-W3',
        supplierName: 'W3 供应商',
        promisedAt: '2026-11-30T00:00:00.000Z',
        lines: overrides.lines ?? [{ itemId: 'item-std', quantity: 8, drawingNo: 'DWG-W3-01' }],
        requestIds: overrides.requestIds ?? [],
        buyer,
        remark: null,
      }),
    ),
  );
  const order = submitted.purchaseOrder as NonNullable<typeof submitted.purchaseOrder>;
  mustCommit(await service.execute(envelope('purchase.order.approve.v1', { remark: '价格合理' }, { expectedRevision: 2, actor: approver }), order.id));
  const issued = mustCommit(await service.execute(envelope('purchase.order.issue.v1', { remark: null }, { expectedRevision: 3 }), order.id));
  return issued.purchaseOrder as NonNullable<typeof issued.purchaseOrder>;
}

describe('收货→三类采购质检来源投递（RQ-019 域层端口）', () => {
  it('有申请承接 + 收货：逐行投递事实（kind 申请链映射 + sourceRefId=订单#行号 + 全字段）', async () => {
    const h = newHarness();
    const standardRequestId = await createRequest(h.service, { kind: 'standard', itemId: 'item-std', quantity: 8 });
    const nonstandardRequestId = await createRequest(h.service, { kind: 'nonstandard', itemId: 'item-ns', quantity: 3 });
    const order = await issueOrder(h.service, {
      requestIds: [standardRequestId, nonstandardRequestId],
      lines: [
        { itemId: 'item-std', quantity: 8, drawingNo: 'DWG-W3-01' },
        { itemId: 'item-ns', quantity: 3, drawingNo: null },
      ],
    });

    const received = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 8 }, { lineNo: 2, receivedQty: 3 }] }, { expectedRevision: 4, actor: buyer }),
        order.id,
      ),
    );
    expect(received.purchaseOrder?.state).toBe('received');
    expect(h.intake.facts.map((entry) => entry.fact)).toEqual([
      {
        sourceType: 'receipt',
        sourceRefId: `${order.id}#1`, // 复用 receiptKey 幂等键约定
        kind: 'standard_purchase', // standard → standard_purchase
        itemId: 'item-std',
        drawingNo: 'DWG-W3-01',
        quantity: 8,
        workOrderId: 'wo-w3',
        occurredAt: FIXED_NOW,
        triggeredBy: buyer,
      },
      {
        sourceType: 'receipt',
        sourceRefId: `${order.id}#2`,
        kind: 'nonstandard_purchase', // nonstandard → nonstandard_purchase
        itemId: 'item-ns',
        drawingNo: null,
        quantity: 3,
        workOrderId: 'wo-w3',
        occurredAt: FIXED_NOW,
        triggeredBy: buyer,
      },
    ]);
  });

  it('无申请订单与 kind 歧义：不投递不报错，收货仍 committed', async () => {
    const h = newHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 无申请承接：订单可无申请（requestIds 可空）——收货行无从推导 kind。
    const bareOrder = await issueOrder(h.service);
    const bare = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 8 }] }, { expectedRevision: 4, actor: buyer }),
        bareOrder.id,
      ),
    );
    expect(bare.purchaseOrder?.state).toBe('received');

    // 歧义：同物料被两类申请承接（standard + equipment 同 itemId）——多 kind 不投。
    const requestIdA = await createRequest(h.service, { kind: 'standard', itemId: 'item-amb', quantity: 5 });
    const requestIdB = await createRequest(h.service, { kind: 'equipment', itemId: 'item-amb', quantity: 5 });
    const ambOrder = await issueOrder(h.service, {
      requestIds: [requestIdA, requestIdB],
      lines: [{ itemId: 'item-amb', quantity: 5 }],
    });
    const amb = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 5 }] }, { expectedRevision: 4, actor: buyer }),
        ambOrder.id,
      ),
    );
    expect(amb.purchaseOrder?.state).toBe('received');

    expect(h.intake.facts).toEqual([]); // 两路径均不投递
    expect(warnSpy.mock.calls.length).toBe(2); // 每跳过一行留痕一次
    warnSpy.mockRestore();
  });

  it('intake 抛异常：通知式合同——收货仍 committed 不回滚', async () => {
    const h = newHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requestId = await createRequest(h.service, { kind: 'equipment', itemId: 'item-eqp', quantity: 2 });
    const order = await issueOrder(h.service, {
      requestIds: [requestId],
      lines: [{ itemId: 'item-eqp', quantity: 2 }],
    });

    h.intake.failMessage = 'inspection 服务暂不可用';
    const received = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 2 }] }, { expectedRevision: 4, actor: buyer }),
        order.id,
      ),
    );
    expect(received.purchaseOrder?.state).toBe('received'); // 收货落账不回滚
    expect(received.purchaseOrder?.lines[0]?.receivedQty).toBe(2);
    expect(h.intake.facts.length).toBe(1); // 已尝试投递（失败留痕）
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes(order.id))).toBe(true);
    warnSpy.mockRestore();
  });
});
