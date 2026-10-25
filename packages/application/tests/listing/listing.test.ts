/**
 * listing 模块测试（M2-W3）：三份状态机配置合法集、清单骨架生成（WorkOrderCreated
 * 订阅端口）、Excel 导入 × 物料校验端口、清单行修订、缺口核查 × 库存可用量、
 * 一键采购申请、订单五态全链（提交-审核-下发-收货 + 退货回退 + 重收）、入库
 * 指令联动、逾期事实扫描与催货待办、账本↔投影对账、查询视图（全流程/明细/
 * 金额汇总/导出）、模块装配与权限码。全部零框架直连（内存实现 + engine-flow
 * 内存账本 + 可注入假端口——联动验证用夹具，真实端口由兄弟模块合流提供）。
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
  type CommandOutcome,
} from '@smes/business-core';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import type { BaselineCommandEnvelope } from '../../src/baseline/baseline-input.js';
import {
  DEFAULT_PURCHASE_ORDER_FLOW_CONFIG,
  DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG,
  DEFAULT_PURCHASE_RETURN_FLOW_CONFIG,
  LISTING_KINDS,
  PURCHASE_ORDER_STATE_IDS,
  purchaseOrderStateLabel,
  purchaseRequestStateLabel,
  purchaseReturnStateLabel,
} from '../../src/listing/listing-config.js';
import { LISTING_EVENT_TYPES, PURCHASE_ORDER_AGGREGATE_TYPE, PURCHASE_REQUEST_AGGREGATE_TYPE, PURCHASE_RETURN_AGGREGATE_TYPE } from '../../src/listing/listing-events.js';
import {
  ListingConflictError,
  ListingInputError,
  ListingNotFoundError,
  ListingStateError,
} from '../../src/listing/listing-errors.js';
import {
  parseCommandBodyForKind,
  parseCommandEnvelopeBody,
  parsePurchaseOrderReceivePayload,
  parsePurchaseRequestCreatePayload,
  parseStateFilter,
} from '../../src/listing/listing-input.js';
import type {
  InventoryAvailabilityPort,
  InventoryReceiptCommand,
  InventoryReceiptPort,
  WorkOrderCreatedEventMessage,
  WorkOrderCreatedFeedPort,
} from '../../src/listing/listing-ports.js';
import { JsonTablesExcelPort } from '../../src/listing/excel-port.js';
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
import { ListingModule } from '../../src/listing/listing.module.js';
import {
  ListingSheetsController,
  PurchaseOrdersController,
  PurchaseQueriesController,
  PurchaseRequestsController,
  PurchaseReturnsController,
} from '../../src/listing/listing.controllers.js';
import { ListingService } from '../../src/listing/listing.service.js';
import type { ListingCommitted, ListingCommandResult } from '../../src/listing/listing.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const planner = UserId.create('u-planner-01');
const approver = UserId.create('u-approver-01');
const buyer = UserId.create('u-buyer-01');
const FIXED_NOW = '2026-10-25T10:00:00.000Z';

// ---- 可注入假端口（联动验证夹具；testkit 另有完整版供跨模块使用） ----

class FakeWorkOrderFeed implements WorkOrderCreatedFeedPort {
  readonly messages: WorkOrderCreatedEventMessage[] = [];
  readonly acknowledged: string[] = [];

  seed(workOrderId: string, listingKinds: readonly string[] = LISTING_KINDS): string {
    const eventId = `evt-wo-${this.messages.length + 1}`;
    this.messages.push({
      eventId,
      tenantId: 't1',
      occurredAt: FIXED_NOW,
      payload: {
        workOrderId,
        projectName: `项目-${workOrderId}`,
        customerRef: null,
        salesRep: null,
        manager: null,
        plannedDeliveryAt: null,
        packagingArrivalAt: null,
        listingKinds,
        actor: 'u-planner-01',
      },
    });
    return eventId;
  }

  async pendingCreatedEvents(tenant: TenantId): Promise<readonly WorkOrderCreatedEventMessage[]> {
    const pending = this.messages.filter((m) => m.tenantId === tenant && !this.acknowledged.includes(m.eventId));
    return [...pending].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

class FakeInventory implements InventoryAvailabilityPort {
  readonly stock = new Map<string, number>();
  async availableQty(_tenant: unknown, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(itemIds.map((id) => [id, this.stock.get(id) ?? 0]));
  }
}

class FakeReceipt implements InventoryReceiptPort {
  readonly calls: InventoryReceiptCommand[] = [];
  refuseReason: string | null = null;
  async receivePurchase(_tenant: unknown, command: InventoryReceiptCommand) {
    this.calls.push(command);
    return this.refuseReason === null
      ? { received: true }
      : { received: false, refusedReason: this.refuseReason };
  }
}

/** 物料校验假端口：编码命中种子库 → matched（candidate 回填）；否则 unmatched。 */
class FakeMaterialValidation {
  readonly calls: BaselineCommandEnvelope[] = [];
  readonly library = new Map<string, string>(); // code -> itemId
  refuseReason: string | null = null;
  indeterminateReason: string | null = null;

  async execute(_tenant: TenantId, envelope: BaselineCommandEnvelope): Promise<CommandOutcome> {
    this.calls.push(envelope);
    if (this.refuseReason !== null) return { status: 'rejected', reason: this.refuseReason };
    if (this.indeterminateReason !== null) {
      return { status: 'indeterminate', reason: this.indeterminateReason, retrySafe: false };
    }
    const lines = (envelope.command.payload as { lines: readonly { code: string | null }[] }).lines;
    const judgments = lines.map((line, index) => {
      const itemId = line.code === null ? undefined : this.library.get(line.code);
      return {
        lineNo: index + 1,
        code: line.code,
        name: null,
        spec: null,
        judgment: itemId === undefined ? 'unmatched' : 'matched',
        candidateItemId: itemId ?? null,
        candidateItemCode: itemId === undefined ? null : line.code,
        similarity: itemId === undefined ? 0 : 1,
        basis: itemId === undefined ? 'none' : 'code-exact',
      };
    });
    const runId = `mv-${this.calls.length}`;
    const event = {
      eventId: `evt-${runId}`,
      eventType: LISTING_EVENT_TYPES.listingImported.replace('listing-imported', 'material-validated-x'),
      tenantId: envelope.tenantId,
      aggregate: { id: runId, type: 'baseline-material-validation', revision: 1 },
      occurredAt: FIXED_NOW,
      payload: { runId, summary: { total: judgments.length }, lines: judgments },
    };
    return { status: 'committed', newRevision: 1, events: [event] as never };
  }
}

function newHarness() {
  const sheets = new InMemoryListingSheetStore();
  const lines = new InMemoryListingLineStore();
  const gapChecks = new InMemoryGapCheckStore();
  const requests = new InMemoryPurchaseRequestStore();
  const orders = new InMemoryPurchaseOrderStore();
  const returns = new InMemoryPurchaseReturnStore();
  const operations = new InMemoryListingOperationStore();
  const domainEvents = new InMemoryListingDomainEventStore();
  const machineEvents = createInMemoryApprovalEventStore();
  const todos = new InMemoryTodoStore();
  const feed = new FakeWorkOrderFeed();
  const inventory = new FakeInventory();
  const receipt = new FakeReceipt();
  const materialValidation = new FakeMaterialValidation();
  const service = new ListingService(
    sheets, lines, gapChecks, requests, orders, returns, operations, domainEvents,
    machineEvents, todos,
    { workOrderFeed: feed, inventory, receipt, excel: new JsonTablesExcelPort(), materialValidation },
    { orderApprover: approver, now: () => FIXED_NOW },
  );
  return {
    sheets, lines, gapChecks, requests, orders, returns, operations, domainEvents,
    machineEvents, todos, feed, inventory, receipt, materialValidation, service,
  };
}

let opCounter = 0;
function envelope(
  kind: string,
  payload: unknown,
  options: {
    readonly tenant?: typeof t1;
    readonly actor?: typeof planner;
    readonly operationId?: string;
    readonly expectedRevision?: number | 'initial';
  } = {},
): CommandEnvelope<{ kind: never; payload: unknown }> {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: options.tenant ?? t1,
    issuedBy: options.actor ?? planner,
    operationId: OperationId.create(options.operationId ?? `op-listing-${String(opCounter).padStart(4, '0')}`),
    expectedRevision: options.expectedRevision ?? 'initial',
    issuedAt: FIXED_NOW,
    command: { kind, payload } as never,
  }) as CommandEnvelope<{ kind: never; payload: unknown }>;
}

function mustCommit(result: ListingCommandResult): ListingCommitted {
  if (result.status !== 'committed') {
    throw new Error(`期望 committed，得到 ${result.status}：${'reason' in result ? result.reason : ''}`);
  }
  return result;
}

function excelSource(header: readonly string[], rows: readonly (readonly string[])[]) {
  return { kind: 'json-tables' as const, sheets: [{ name: '清单', header, rows }] };
}

const CN_HEADER = ['图号', '物料编码', '物料名称', '规格型号', '数量', '需求日期'];

async function importExcel(
  service: ListingService,
  workOrderId: string,
  kind: string,
  rows: readonly (readonly string[])[],
  header: readonly string[] = CN_HEADER,
  options: { readonly operationId?: string; readonly actor?: typeof planner } = {},
) {
  return service.execute(
    envelope(
      'listing.import.v1',
      { source: 'excel', workOrderId, kind, excel: excelSource(header, rows) },
      options,
    ),
  );
}

async function submitOrder(
  service: ListingService,
  overrides: {
    readonly workOrderId?: string | null;
    readonly promisedAt?: string;
    readonly requestIds?: readonly string[];
    readonly buyer?: string | null;
    readonly lines?: readonly { itemId: string; quantity: number; unitPriceMinor?: number; drawingNo?: string }[];
  } = {},
) {
  const result = mustCommit(
    await service.execute(
      envelope('purchase.order.submit.v1', {
        workOrderId: overrides.workOrderId === undefined ? 'wo-1' : overrides.workOrderId,
        supplierRef: 'SUP-001',
        supplierName: '标准件供应商',
        promisedAt: overrides.promisedAt ?? '2026-11-20T00:00:00.000Z',
        lines: overrides.lines ?? [{ itemId: 'item-1', quantity: 10, unitPriceMinor: 1500 }],
        requestIds: overrides.requestIds ?? [],
        buyer: overrides.buyer === undefined ? buyer : overrides.buyer,
        remark: '首次下单',
      }),
    ),
  );
  return result.purchaseOrder as NonNullable<typeof result.purchaseOrder>;
}

describe('三份状态机配置（初版合法集）', () => {
  it('订单五态 + 主干 5 条 + 退货回退 1 条 = 6 条；无 final 态（received 可回退）', () => {
    expect(DEFAULT_PURCHASE_ORDER_FLOW_CONFIG.states.map((s) => s.id)).toEqual([...PURCHASE_ORDER_STATE_IDS]);
    expect(DEFAULT_PURCHASE_ORDER_FLOW_CONFIG.transitions).toEqual([
      { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
      { from: 'submitted', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
      { from: 'approved', event: 'ISSUE', to: 'issued', eventAction: 'issued' },
      { from: 'issued', event: 'RECEIVE', to: 'received', eventAction: 'received' },
      { from: 'received', event: 'RETURN', to: 'issued', eventAction: 'return-rolled-back' },
    ]);
    expect(DEFAULT_PURCHASE_ORDER_FLOW_CONFIG.states.every((s) => s.final !== true)).toBe(true);
    expect(purchaseOrderStateLabel('submitted')).toBe('已提交待审');
    expect(purchaseOrderStateLabel('unknown')).toBe('unknown');
  });

  it('申请三态 draft→approved→converted（converted 终态）；退货单两态 open→revoked', () => {
    expect(DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG.initial).toBe('draft');
    expect(
      DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG.states.filter((s) => s.final).map((s) => s.id),
    ).toEqual(['converted']);
    expect(DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG.transitions.length).toBe(2);
    expect(DEFAULT_PURCHASE_RETURN_FLOW_CONFIG.initial).toBe('open');
    expect(DEFAULT_PURCHASE_RETURN_FLOW_CONFIG.transitions).toEqual([
      { from: 'open', event: 'REVOKE', to: 'revoked', eventAction: 'revoked' },
    ]);
    expect(purchaseRequestStateLabel('converted')).toBe('已转单');
    expect(purchaseReturnStateLabel('revoked')).toBe('已撤销');
  });
});

describe('listing.import（workorder 骨架：订阅端口消费）', () => {
  it('消费 WorkOrderCreated：四类清单骨架 + 四条 ListingImported + 事件确认', async () => {
    const h = newHarness();
    h.feed.seed('wo-100', LISTING_KINDS);
    const result = mustCommit(
      await h.service.execute(envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-100' })),
    );
    expect(result.sheets?.map((sheet) => sheet.kind)).toEqual([...LISTING_KINDS]);
    expect(result.sheets?.map((sheet) => sheet.name)).toEqual([
      '零件清单（wo-100）', '标准件清单（wo-100）', '电气件清单（wo-100）', '设备采购清单（wo-100）',
    ]);
    expect(result.events.length).toBe(4);
    expect((await h.domainEvents.pendingOutbox()).length).toBe(4); // Outbox 已记账
    expect(result.events.every((event) => event.eventType === LISTING_EVENT_TYPES.listingImported)).toBe(true);
    const firstPayload = result.events[0]?.payload as { source: string; sourceEventId: string | null; kind: string };
    expect(firstPayload.source).toBe('workorder');
    expect(firstPayload.sourceEventId).toBe('evt-wo-1');
    expect(h.feed.acknowledged).toEqual(['evt-wo-1']); // 消费确认
    expect((await h.feed.pendingCreatedEvents(t1)).length).toBe(0);
  });

  it('事件 listingKinds 子集只建对应类目；再导入收敛到四类全集，全齐后 rejected', async () => {
    const h = newHarness();
    h.feed.seed('wo-101', ['part', 'equipment']);
    const result = mustCommit(
      await h.service.execute(envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-101' })),
    );
    expect(result.sheets?.map((sheet) => sheet.kind)).toEqual(['part', 'equipment']);
    expect(h.feed.acknowledged).toEqual(['evt-wo-1']); // 事件已消费：再导入走四类缺省集
    const again = mustCommit(
      await h.service.execute(envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-101' })),
    );
    expect(again.sheets?.map((sheet) => sheet.kind)).toEqual(['standard', 'electrical']); // 补齐缺类
    const third = await h.service.execute(
      envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-101' }),
    );
    expect(third.status).toBe('rejected');
    if (third.status === 'rejected') expect(third.reason).toContain('已齐');
    expect((await h.sheets.listByWorkOrder(t1, 'wo-101')).map((sheet) => sheet.kind)).toEqual([...LISTING_KINDS]);
  });

  it('零接线（EMPTY feed）：按四类缺省骨架生成，sourceEventId=null', async () => {
    const h = newHarness(); // feed 无事件
    const result = mustCommit(
      await h.service.execute(envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-102' })),
    );
    expect(result.sheets?.length).toBe(4);
    expect((result.events[0]?.payload as { sourceEventId: string | null }).sourceEventId).toBeNull();
  });

  it('跨租户隔离：t2 导入看不到 t1 的清单', async () => {
    const h = newHarness();
    mustCommit(
      await h.service.execute(envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-103' })),
    );
    expect(await h.sheets.listByWorkOrder(t2, 'wo-103')).toEqual([]);
  });
});

describe('listing.import（excel 行导入 × 物料校验端口）', () => {
  function seedLibrary(h: ReturnType<typeof newHarness>) {
    h.materialValidation.library.set('M-001', 'item-001');
    h.materialValidation.library.set('M-002', 'item-002');
  }

  it('表头别名解析 → 物料校验 → 行落库（matched 行回填 itemId；事件含判定汇总）', async () => {
    const h = newHarness();
    seedLibrary(h);
    const result = mustCommit(
      await importExcel(h.service, 'wo-200', 'part', [
        ['DWG-1', 'M-001', '螺栓', 'M8x40', '10', '2026-11-01'],
        ['DWG-2', 'M-002', '垫片', 'D8', '4', ''],
        ['DWG-3', 'M-999', '未知件', 'X', '2', ''],
      ]),
    );
    expect(result.lines?.length).toBe(3);
    const lines = result.lines as NonNullable<typeof result.lines>;
    expect([lines[0]!.validationStatus, lines[0]!.itemId, lines[0]!.candidateItemId]).toEqual(['matched', 'item-001', 'item-001']);
    expect([lines[1]!.validationStatus, lines[1]!.neededBy]).toEqual(['matched', null]);
    expect([lines[2]!.validationStatus, lines[2]!.itemId, lines[2]!.candidateItemId]).toEqual(['unmatched', null, null]);
    expect(result.rowIssues).toEqual([]);
    // 骨架不存在时自动补建对应类目清单
    expect(result.sheets?.[0]?.kind).toBe('part');
    expect(await h.lines.listBySheet(t1, result.sheets?.[0]?.id as string)).toHaveLength(3);
    // 事件：ListingImported + ListingLineValidated（同一命令产出）
    expect(result.events.map((event) => event.eventType)).toEqual([
      LISTING_EVENT_TYPES.listingImported,
      LISTING_EVENT_TYPES.listingLineValidated,
    ]);
    const validated = result.events[1]?.payload as { summary: { total: number; matched: number; unmatched: number }; lines: { judgment: string }[] };
    expect(validated.summary).toEqual({ total: 3, matched: 2, suspected: 0, unmatched: 1 });
    expect(validated.lines.map((line) => line.judgment)).toEqual(['matched', 'matched', 'unmatched']);
    // 物料校验子信封：确定性 operationId 派生 + baseline 命令动词
    expect(h.materialValidation.calls.length).toBe(1);
    const subEnvelope = h.materialValidation.calls[0] as unknown as { operationId: string; command: { kind: string } };
    expect(subEnvelope.command.kind).toBe('baseline.material.validate.v1');
    expect(String(subEnvelope.operationId)).toContain('#material');
  });

  it('错误行提示：坏行跳过进 rowIssues（载荷可回放），好行照常导入', async () => {
    const h = newHarness();
    seedLibrary(h);
    const result = mustCommit(
      await importExcel(h.service, 'wo-201', 'standard', [
        ['DWG-1', 'M-001', '螺栓', 'M8', '10', ''],
        ['DWG-2', 'M-002', '垫片', 'D8', 'abc', ''],
        ['', 'M-002', '垫片', 'D8', '3', ''], // 无图号但编码齐全：合法行（标准件常态）
      ]),
    );
    expect(result.lines?.length).toBe(2); // 第 1、3 行导入；第 2 行坏数量跳过
    expect(result.rowIssues?.map((issue) => issue.lineNo)).toEqual([2]);
    const payload = result.events[0]?.payload as { rowIssues: { lineNo: number }[] };
    expect(payload.rowIssues.length).toBe(1);
  });

  it('文件级问题整单拒绝；无有效行拒绝；缺 quantity 列拒绝', async () => {
    const h = newHarness();
    const missingColumn = await importExcel(h.service, 'wo-202', 'part', [['M-001', '10']], ['物料编码', '备注']);
    expect(missingColumn.status).toBe('rejected');
    if (missingColumn.status === 'rejected') expect(missingColumn.reason).toContain('Excel 导入被拒绝');
    const noRows = await importExcel(h.service, 'wo-202', 'part', []);
    expect(noRows.status).toBe('rejected');
  });

  it('校验端口拒绝 → 命令 rejected 不落账；indeterminate → 透传 retrySafe=false', async () => {
    const h = newHarness();
    h.materialValidation.refuseReason = '物料库不可用';
    const refused = await importExcel(h.service, 'wo-203', 'part', [['DWG-1', 'M-001', 'a', 'b', '1', '']]);
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason).toContain('物料校验拒绝');
    expect(await h.lines.listByWorkOrder(t1, 'wo-203')).toEqual([]); // 未落账

    h.materialValidation.refuseReason = null;
    h.materialValidation.indeterminateReason = '事件追加失败';
    const indeterminate = await importExcel(h.service, 'wo-203', 'part', [['DWG-1', 'M-001', 'a', 'b', '1', '']]);
    expect(indeterminate.status).toBe('indeterminate');
    if (indeterminate.status === 'indeterminate') expect(indeterminate.retrySafe).toBe(false);
  });

  it('同命令重复 operationId → rejected（幂等）；同清单续行 lineNo 递增', async () => {
    const h = newHarness();
    seedLibrary(h);
    const first = mustCommit(
      await importExcel(h.service, 'wo-204', 'part', [['DWG-1', 'M-001', 'a', 'b', '1', '']], CN_HEADER, {
        operationId: 'op-import-once',
      }),
    );
    const duplicate = await importExcel(h.service, 'wo-204', 'part', [['DWG-2', 'M-001', 'a', 'b', '2', '']], CN_HEADER, {
      operationId: 'op-import-once',
    });
    expect(duplicate.status).toBe('rejected');
    if (duplicate.status === 'rejected') expect(duplicate.reason).toContain('幂等');

    const second = mustCommit(
      await importExcel(h.service, 'wo-204', 'part', [['DWG-2', 'M-001', 'a', 'b', '2', '']]),
    );
    const sheetId = (first.sheets?.[0]?.id ?? second.sheets?.[0]?.id) as string;
    const all = await h.lines.listBySheet(t1, sheetId);
    expect(all.map((line) => [line.lineNo, line.requiredQty])).toEqual([[1, 1], [2, 2]]);
  });
});

describe('listing.line.update（行修订）', () => {
  async function seededLine(h: ReturnType<typeof newHarness>) {
    h.materialValidation.library.set('M-001', 'item-001');
    const result = mustCommit(
      await importExcel(h.service, 'wo-300', 'part', [['DWG-1', 'M-001', '螺栓', 'M8x40', '10', '']]),
    );
    return (result.lines as NonNullable<typeof result.lines>)[0]!;
  }

  it('改数量/日期：版本 +1，校验态保留，ListingLineUpdated(validationReset=false)', async () => {
    const h = newHarness();
    const line = await seededLine(h);
    const result = mustCommit(
      await h.service.execute(
        envelope('listing.line.update.v1', { requiredQty: 12 }, { expectedRevision: 1 }),
        line.id,
      ),
    );
    expect(result.newRevision).toBe(2);
    const updated = (result.lines as NonNullable<typeof result.lines>)[0]!;
    expect([updated.requiredQty, updated.validationStatus, updated.itemId]).toEqual([12, 'matched', 'item-001']);
    const payload = result.events[0]?.payload as { validationReset: boolean; changes: Record<string, unknown> };
    expect(payload.validationReset).toBe(false);
    expect(payload.changes['requiredQty']).toBe(12);
  });

  it('改物料三要素：校验态重置 pending、itemId/候选清空', async () => {
    const h = newHarness();
    const line = await seededLine(h);
    const result = mustCommit(
      await h.service.execute(
        envelope('listing.line.update.v1', { spec: 'M10x50' }, { expectedRevision: 1 }),
        line.id,
      ),
    );
    const updated = (result.lines as NonNullable<typeof result.lines>)[0]!;
    expect([updated.validationStatus, updated.itemId, updated.candidateItemId, updated.similarity]).toEqual([
      'pending', null, null, 0,
    ]);
    const payload = result.events[0]?.payload as { validationReset: boolean };
    expect(payload.validationReset).toBe(true);
  });

  it('人工确认 itemId（suspected 候选裁定）：校验态保留；乐观锁/缺失行 rejected', async () => {
    const h = newHarness();
    const line = await seededLine(h);
    const confirmed = mustCommit(
      await h.service.execute(
        envelope('listing.line.update.v1', { itemId: 'item-manual' }, { expectedRevision: 1 }),
        line.id,
      ),
    );
    const updated = (confirmed.lines as NonNullable<typeof confirmed.lines>)[0]!;
    expect([updated.itemId, updated.validationStatus]).toEqual(['item-manual', 'matched']);

    const stale = await h.service.execute(
      envelope('listing.line.update.v1', { requiredQty: 1 }, { expectedRevision: 1 }),
      updated.id,
    );
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') expect(stale.reason).toContain('乐观锁');
    const missing = await h.service.execute(
      envelope('listing.line.update.v1', { requiredQty: 1 }, { expectedRevision: 1 }),
      'll-missing',
    );
    expect(missing.status).toBe('rejected');
    await expect(
      h.service.execute(envelope('listing.line.update.v1', {}, { expectedRevision: 1 }), line.id),
    ).rejects.toBeInstanceOf(ListingInputError);
  });
});

describe('gap.check（清单 × 库存可用量 → 缺口行）', () => {
  async function seedGapSheet(h: ReturnType<typeof newHarness>) {
    h.materialValidation.library.set('M-001', 'item-1');
    h.materialValidation.library.set('M-002', 'item-2');
    mustCommit(
      await importExcel(h.service, 'wo-400', 'part', [
        ['DWG-1', 'M-001', 'a', 's', '10', ''],
        ['DWG-2', 'M-002', 'b', 's', '4', '2026-11-10'],
      ]),
    );
    // 未校验类目：手工造一行 pending（不进差集，但计入 lineCount）
    await h.lines.appendLines([
      {
        tenant: t1, id: 'll-manual-1', sheetId: 'ls-ghost', workOrderId: 'wo-400', kind: 'standard',
        lineNo: 1, drawingNo: null, code: 'M-X', name: 'x', spec: null, itemId: null,
        requiredQty: 5, neededBy: null, validationStatus: 'pending',
        candidateItemId: null, candidateItemCode: null, similarity: 0, basis: null, source: 'manual',
      },
    ]);
  }

  it('缺口 = Σ(itemId 已解析行) 与可用量差集；未解析行只计数不入差集；快照不可变', async () => {
    const h = newHarness();
    await seedGapSheet(h);
    h.inventory.stock.set('item-1', 7); // 缺 3
    // item-2 缺省 0 → 缺 4
    const result = mustCommit(
      await h.service.execute(envelope('gap.check.v1', {}, { actor: buyer }), 'wo-400'),
    );
    const snapshot = result.gapCheck as NonNullable<typeof result.gapCheck>;
    expect(snapshot.complete).toBe(false);
    expect(snapshot.gapLines).toEqual([
      { kind: 'part', listingLineId: expect.any(String), itemId: 'item-1', drawingNo: 'DWG-1', requiredQty: 10, availableQty: 7, gapQty: 3, neededBy: null },
      { kind: 'part', listingLineId: expect.any(String), itemId: 'item-2', drawingNo: 'DWG-2', requiredQty: 4, availableQty: 0, gapQty: 4, neededBy: '2026-11-10' },
    ]);
    expect(snapshot.kinds.map((k) => [k.kind, k.lineCount, k.checkedLineCount, k.gapLineCount, k.complete])).toEqual([
      ['part', 2, 2, 2, false],
      ['standard', 1, 0, 0, true], // pending 行：计数但不入差集 → 类目"无缺口"（可解析口径）
      ['electrical', 0, 0, 0, true],
      ['equipment', 0, 0, 0, true],
    ]);
    expect(result.events[0]?.eventType).toBe(LISTING_EVENT_TYPES.gapChecked);
    expect(snapshot.auditStatus).toBe('recorded'); // 证据公共列口径

    // 补齐后再核查：新快照 complete=true；旧快照仍在（append-only）
    h.inventory.stock.set('item-1', 10);
    h.inventory.stock.set('item-2', 4);
    const second = mustCommit(await h.service.execute(envelope('gap.check.v1', {}), 'wo-400'));
    expect((second.gapCheck as NonNullable<typeof second.gapCheck>).complete).toBe(true);
    expect((await h.gapChecks.latestByWorkOrder(t1, 'wo-400'))?.complete).toBe(true);
    expect((await h.gapChecks.latestByWorkOrder(t2, 'wo-400'))).toBeNull(); // 跨租户不可见
  });
});

describe('purchase.request.create（含缺口一键发起）', () => {
  it('缺口一键：source 锚点校验 + draft@v1 + PurchaseRequested', async () => {
    const h = newHarness();
    h.materialValidation.library.set('M-001', 'item-1');
    mustCommit(await importExcel(h.service, 'wo-500', 'part', [['DWG-1', 'M-001', 'a', 's', '10', '']]));
    const gap = mustCommit(await h.service.execute(envelope('gap.check.v1', {}), 'wo-500'));
    const gapLine = (gap.gapCheck as NonNullable<typeof gap.gapCheck>).gapLines[0]!;
    const result = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', {
          kind: 'nonstandard',
          itemId: gapLine.itemId,
          quantity: gapLine.gapQty,
          source: { type: 'gap', gapCheckId: (gap.gapCheck as NonNullable<typeof gap.gapCheck>).id, listingLineId: gapLine.listingLineId },
          remark: '缺口一键',
        }),
      ),
    );
    const request = result.purchaseRequest as NonNullable<typeof result.purchaseRequest>;
    expect([request.state, request.objectVersion, request.kind, request.workOrderId]).toEqual([
      'draft', 1, 'nonstandard', 'wo-500', // workOrderId 从缺口快照回填
    ]);
    expect(result.events[0]?.eventType).toBe(LISTING_EVENT_TYPES.purchaseRequested);
  });

  it('手工发起（无工作令）；非法 kind / 伪缺口锚点 rejected', async () => {
    const h = newHarness();
    const manual = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', { kind: 'equipment', itemId: 'item-e', quantity: 1 }),
      ),
    );
    expect((manual.purchaseRequest as NonNullable<typeof manual.purchaseRequest>).workOrderId).toBeNull();

    await expect(
      h.service.execute(envelope('purchase.request.create.v1', { kind: 'mystery', itemId: 'x', quantity: 1 })),
    ).rejects.toBeInstanceOf(ListingInputError); // 载荷形状非法 → 400（同 workorder 口径）
    await expect(
      h.service.execute(envelope('purchase.request.create.v1', { kind: 'standard', itemId: 'x', quantity: 1 })),
    ).resolves.toMatchObject({ status: 'committed' });
    const bogusAnchor = await h.service.execute(
      envelope('purchase.request.create.v1', {
        kind: 'standard', itemId: 'x', quantity: 1,
        source: { type: 'gap', gapCheckId: 'gap-none', listingLineId: 'll-none' },
      }),
    );
    expect(bogusAnchor.status).toBe('rejected');
    if (bogusAnchor.status === 'rejected') expect(bogusAnchor.reason).toContain('不存在');
  });
});

describe('采购订单五态全链（提交-审核-下发-收货）', () => {
  it('submit：建单+SUBMIT 落 submitted@v2，行号编排，申请承接回填，审批待办', async () => {
    const h = newHarness();
    const request = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', { workOrderId: 'wo-1', kind: 'standard', itemId: 'item-1', quantity: 6 }),
      ),
    );
    const order = await submitOrder(h.service, { requestIds: [(request.purchaseRequest as NonNullable<typeof request.purchaseRequest>).id] });
    expect([order.state, order.objectVersion]).toEqual(['submitted', 2]);
    expect(order.lines).toEqual([
      { lineNo: 1, itemId: 'item-1', drawingNo: null, quantity: 10, unitPriceMinor: 1500, receivedQty: 0 },
    ]);
    expect(order.requestIds.length).toBe(1);
    const linked = await h.requests.list(t1, { purchaseOrderId: order.id });
    expect(linked.length).toBe(1);
    expect(linked[0]?.purchaseOrderId).toBe(order.id); // 承接回填
    // 审批待办（orderApprover 注入）
    const own = await h.todos.listOwn(t1, approver);
    const approvalTodo = own.find((todo) => todo.refId === order.id && todo.status === 'open');
    expect(approvalTodo?.title).toContain('采购订单待审批');
    const events = await h.domainEvents.byAggregate({ id: order.id, type: 'purchase-order' });
    expect(events.map((event) => event.eventType)).toEqual([LISTING_EVENT_TYPES.purchaseOrderSubmitted]);
  });

  it('submit 守门：伪申请 / 已承接申请 rejected', async () => {
    const h = newHarness();
    const ghost = await h.service.execute(
      envelope('purchase.order.submit.v1', {
        promisedAt: '2026-11-20T00:00:00.000Z',
        lines: [{ itemId: 'item-1', quantity: 1 }],
        requestIds: ['preq-ghost'],
      }),
    );
    expect(ghost.status).toBe('rejected');

    const request = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', { workOrderId: 'wo-1', kind: 'standard', itemId: 'item-1', quantity: 1 }),
      ),
    );
    const requestId = (request.purchaseRequest as NonNullable<typeof request.purchaseRequest>).id;
    await submitOrder(h.service, { requestIds: [requestId] });
    const second = await h.service.execute(
      envelope('purchase.order.submit.v1', {
        promisedAt: '2026-11-20T00:00:00.000Z',
        lines: [{ itemId: 'item-1', quantity: 1 }],
        requestIds: [requestId],
      }),
    );
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.reason).toContain('已被订单');
  });

  it('全链 submit→approve→issue→receive：版本 2→5，申请 draft→approved→converted，里程碑', async () => {
    const h = newHarness();
    const request = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', { workOrderId: 'wo-1', kind: 'standard', itemId: 'item-1', quantity: 10 }),
      ),
    );
    const requestId = (request.purchaseRequest as NonNullable<typeof request.purchaseRequest>).id;
    const order = await submitOrder(h.service, {
      requestIds: [requestId],
      lines: [{ itemId: 'item-1', quantity: 10, unitPriceMinor: 1500 }, { itemId: 'item-2', quantity: 4 }],
    });
    expect((await h.requests.find(t1, requestId))?.state).toBe('draft'); // 提交不推进申请

    const approved = mustCommit(
      await h.service.execute(
        envelope('purchase.order.approve.v1', { remark: '价格合理' }, { expectedRevision: 2, actor: approver }),
        order.id,
      ),
    );
    expect(approved.purchaseOrder?.state).toBe('approved');
    expect(approved.newRevision).toBe(3);
    expect((approved.events[0]?.payload as { requestsApproved: string[] }).requestsApproved).toEqual([requestId]);
    expect((await h.requests.find(t1, requestId))?.state).toBe('approved'); // 决策迁移推进
    expect(approved.todosCompleted.length).toBe(1); // 提交待办自动完成
    const own = await h.todos.listOwn(t1, approver);
    expect(own.every((todo) => todo.status === 'done')).toBe(true);

    const issued = mustCommit(
      await h.service.execute(
        envelope('purchase.order.issue.v1', { remark: '下发供应商' }, { expectedRevision: 3 }),
        order.id,
      ),
    );
    expect([issued.purchaseOrder?.state, issued.newRevision]).toEqual(['issued', 4]);
    expect((issued.events[0]?.payload as { requestsConverted: string[] }).requestsConverted).toEqual([requestId]);
    expect((await h.requests.find(t1, requestId))?.state).toBe('converted'); // 转单完成

    const received = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', {
          lines: [{ lineNo: 1, receivedQty: 10 }, { lineNo: 2, receivedQty: 3 }],
          receiptRef: 'RCPT-001',
        }, { expectedRevision: 4, actor: buyer }),
        order.id,
      ),
    );
    expect(received.purchaseOrder?.state).toBe('received');
    expect(received.newRevision).toBe(5);
    expect(received.purchaseOrder?.lines.map((line) => [line.lineNo, line.receivedQty])).toEqual([[1, 10], [2, 3]]);
    expect(received.purchaseOrder?.receiptRef).toBe('RCPT-001');
    // 入库指令端口：receiptKey = orderId#lineNo
    expect(h.receipt.calls).toEqual([
      { receiptKey: `${order.id}#1`, purchaseOrderId: order.id, itemId: 'item-1', quantity: 10 },
      { receiptKey: `${order.id}#2`, purchaseOrderId: order.id, itemId: 'item-2', quantity: 3 },
    ]);
    // 事件序列（发布账本）
    const events = await h.domainEvents.byAggregate({ id: order.id, type: 'purchase-order' });
    expect(events.map((event) => event.eventType)).toEqual([
      LISTING_EVENT_TYPES.purchaseOrderSubmitted,
      LISTING_EVENT_TYPES.purchaseOrderApproved,
      LISTING_EVENT_TYPES.purchaseOrderIssued,
      LISTING_EVENT_TYPES.purchaseOrderReceived,
    ]);
    // 全流程视图里程碑（机器账本）
    const detail = await h.service.orderDetail(t1, order.id);
    expect(detail.milestones.map((milestone) => [milestone.from, milestone.to, milestone.event])).toEqual([
      ['draft', 'submitted', 'SUBMIT'],
      ['submitted', 'approved', 'APPROVE'],
      ['approved', 'issued', 'ISSUE'],
      ['issued', 'received', 'RECEIVE'],
    ]);
    expect(detail.requests.map((r) => r.state)).toEqual(['converted']);
    // 金额汇总：10×1500 + 3×0（未定价行计 0）
    const details = await h.service.purchaseDetails(t1);
    expect(details.totalAmountMinor).toBe(15000);
    expect(details.rows.length).toBe(2);
  });

  it('receive 守门：入库拒绝 → rejected 不落账；超收 / 伪行号 / 重复行号 rejected', async () => {
    const h = newHarness();
    const order = await submitOrder(h.service);
    mustCommit(await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 2, actor: approver }), order.id));
    mustCommit(await h.service.execute(envelope('purchase.order.issue.v1', {}, { expectedRevision: 3 }), order.id));

    h.receipt.refuseReason = '库位已满';
    const refused = await h.service.execute(
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 5 }] }, { expectedRevision: 4 }),
      order.id,
    );
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason).toContain('库位已满');
    expect((await h.orders.find(t1, order.id))?.state).toBe('issued'); // 未落账
    expect(h.receipt.calls.length).toBe(1);

    h.receipt.refuseReason = null;
    const over = await h.service.execute(
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 11 }] }, { expectedRevision: 4 }),
      order.id,
    );
    expect(over.status).toBe('rejected');
    if (over.status === 'rejected') expect(over.reason).toContain('超订');
    const ghostLine = await h.service.execute(
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 9, receivedQty: 1 }] }, { expectedRevision: 4 }),
      order.id,
    );
    expect(ghostLine.status).toBe('rejected');
    const committed = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 10 }] }, { expectedRevision: 4 }),
        order.id,
      ),
    );
    expect(committed.purchaseOrder?.state).toBe('received');
    // 已收货再收 → rejected（须先退货回退）
    const again = await h.service.execute(
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 10 }] }, { expectedRevision: 5 }),
      order.id,
    );
    expect(again.status).toBe('rejected');
  });

  it('状态守门：未审核不可下发；未下发不可收货；乐观锁过期 rejected；账本不一致抛 StateError', async () => {
    const h = newHarness();
    const order = await submitOrder(h.service);
    const earlyIssue = await h.service.execute(envelope('purchase.order.issue.v1', {}, { expectedRevision: 2 }), order.id);
    expect(earlyIssue.status).toBe('rejected');
    const earlyReceive = await h.service.execute(
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 1 }] }, { expectedRevision: 2 }),
      order.id,
    );
    expect(earlyReceive.status).toBe('rejected');
    const stale = await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 9, actor: approver }), order.id);
    expect(stale.status).toBe('rejected');

    // 写入中断模拟：直接推进投影（账本未落）→ 后续迁移抛 ListingStateError
    mustCommit(await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 2, actor: approver }), order.id));
    await h.orders.advance(t1, order.id, 3, 'issued', 4); // 账本未记 ISSUE
    await expect(
      h.service.execute(envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 1 }] }, { expectedRevision: 4 }), order.id),
    ).rejects.toBeInstanceOf(ListingStateError);
  });
});

describe('purchase.return（退货单 + 订单退货回退）', () => {
  async function receivedOrder(h: ReturnType<typeof newHarness>) {
    const order = await submitOrder(h.service, { lines: [{ itemId: 'item-1', quantity: 10, unitPriceMinor: 200 }] });
    mustCommit(await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 2, actor: approver }), order.id));
    mustCommit(await h.service.execute(envelope('purchase.order.issue.v1', {}, { expectedRevision: 3 }), order.id));
    mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 8 }] }, { expectedRevision: 4 }),
        order.id,
      ),
    );
    return order;
  }

  it('建退货单：open@v1 + 订单回退 received→issued@v6 + PurchaseReturned；可重收', async () => {
    const h = newHarness();
    const order = await receivedOrder(h);
    const result = mustCommit(
      await h.service.execute(
        envelope('purchase.return.create.v1', {
          purchaseOrderId: order.id,
          lines: [{ lineNo: 1, returnedQty: 3, reason: '外观划伤' }],
          remark: '部分退回',
        }, { actor: buyer }),
      ),
    );
    const purchaseReturn = result.purchaseReturn as NonNullable<typeof result.purchaseReturn>;
    expect([purchaseReturn.state, purchaseReturn.objectVersion]).toEqual(['open', 1]);
    expect(purchaseReturn.lines).toEqual([{ lineNo: 1, itemId: 'item-1', returnedQty: 3, reason: '外观划伤' }]);
    expect([result.purchaseOrder?.state, result.purchaseOrder?.objectVersion]).toEqual(['issued', 6]);
    const payload = result.events[0]?.payload as { orderRolledBackTo: string };
    expect(payload.orderRolledBackTo).toBe('issued');
    const events = await h.domainEvents.byAggregate({ id: purchaseReturn.id, type: 'purchase-return' });
    expect(events.map((event) => event.eventType)).toEqual([LISTING_EVENT_TYPES.purchaseReturned]);

    // 重收（修正后 10 全收）
    const reReceived = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 10 }] }, { expectedRevision: 6 }),
        order.id,
      ),
    );
    expect(reReceived.purchaseOrder?.lines[0]?.receivedQty).toBe(10);
  });

  it('守门：非 received 态退货 rejected；超收货数量 rejected；撤销 → revoked@v2', async () => {
    const h = newHarness();
    const issued = await submitOrder(h.service);
    mustCommit(await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 2, actor: approver }), issued.id));
    mustCommit(await h.service.execute(envelope('purchase.order.issue.v1', {}, { expectedRevision: 3 }), issued.id));
    const notReceived = await h.service.execute(
      envelope('purchase.return.create.v1', { purchaseOrderId: issued.id, lines: [{ lineNo: 1, returnedQty: 1 }] }),
    );
    expect(notReceived.status).toBe('rejected');

    const order = await receivedOrder(h);
    const over = await h.service.execute(
      envelope('purchase.return.create.v1', { purchaseOrderId: order.id, lines: [{ lineNo: 1, returnedQty: 9 }] }),
    );
    expect(over.status).toBe('rejected');
    if (over.status === 'rejected') expect(over.reason).toContain('超收货');

    const created = mustCommit(
      await h.service.execute(
        envelope('purchase.return.create.v1', { purchaseOrderId: order.id, lines: [{ lineNo: 1, returnedQty: 2 }] }),
      ),
    );
    const returnId = (created.purchaseReturn as NonNullable<typeof created.purchaseReturn>).id;
    const revoked = mustCommit(
      await h.service.execute(envelope('purchase.return.revoke.v1', { remark: '误登' }, { expectedRevision: 1 }), returnId),
    );
    expect([revoked.purchaseReturn?.state, revoked.newRevision]).toEqual(['revoked', 2]);
    expect(revoked.events).toEqual([]); // 撤销不另发域事件（机器账本承载）
    const reRevoke = await h.service.execute(envelope('purchase.return.revoke.v1', {}, { expectedRevision: 2 }), returnId);
    expect(reRevoke.status).toBe('rejected'); // 已撤销不可再撤
    expect((await h.service.listReturns(t1, order.id)).length).toBe(1);
  });
});

describe('purchase.overdue（逾期事实：交期对比）', () => {
  async function orderAt(
    h: ReturnType<typeof newHarness>,
    promisedAt: string,
    options: { readonly toState?: 'submitted' | 'approved' | 'issued' | 'received'; readonly buyer?: string | null } = {},
  ) {
    const order = await submitOrder(h.service, {
      promisedAt,
      ...(options.buyer === undefined ? {} : { buyer: options.buyer }),
    });
    const target = options.toState ?? 'issued';
    if (target === 'submitted') return order;
    mustCommit(await h.service.execute(envelope('purchase.order.approve.v1', { remark: 'r' }, { expectedRevision: 2, actor: approver }), order.id));
    if (target === 'approved') return order;
    mustCommit(await h.service.execute(envelope('purchase.order.issue.v1', {}, { expectedRevision: 3 }), order.id));
    if (target === 'issued') return order;
    mustCommit(
      await h.service.execute(envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 1 }] }, { expectedRevision: 4 }), order.id),
    );
    return order;
  }

  it('扫描：仅 未收货∧交期已过 的订单出 PurchaseOverdue + 催货待办；重复扫描不重复派待办', async () => {
    const h = newHarness();
    const overdue = await orderAt(h, '2026-10-20T00:00:00.000Z'); // 逾期 5 天
    await orderAt(h, '2026-12-30T00:00:00.000Z'); // 未到期
    await orderAt(h, '2026-10-20T00:00:00.000Z', { toState: 'received' }); // 已收货不计
    const submittedLate = await orderAt(h, '2026-10-24T00:00:00.000Z', { toState: 'submitted' }); // 待审也计

    const scan = mustCommit(await h.service.execute(envelope('purchase.overdue.scan.v1', {}, { actor: planner })));
    expect(scan.overdue?.map((row) => row.purchaseOrderId)).toEqual([overdue.id, submittedLate.id]);
    expect(scan.overdue?.[0]?.daysOverdue).toBe(5);
    expect(scan.events.length).toBe(2);
    expect(scan.events.every((event) => event.eventType === LISTING_EVENT_TYPES.purchaseOverdue)).toBe(true);
    expect(scan.todosCreated.length).toBe(2); // buyer 催货待办
    const buyerTodos = (await h.todos.listOwn(t1, buyer)).filter((todo) => todo.status === 'open');
    expect(buyerTodos.length).toBe(2);
    expect(buyerTodos.every((todo) => todo.title.includes('采购催货'))).toBe(true);

    const again = mustCommit(await h.service.execute(envelope('purchase.overdue.scan.v1', {})));
    expect(again.events.length).toBe(2); // 事实再记（append-only）
    expect(again.todosCreated.length).toBe(0); // 待办去重

    // 查询视图（事实行）
    const list = await h.service.overdueList(t1);
    expect(list.map((row) => row.purchaseOrderId)).toEqual([overdue.id, submittedLate.id]);
    expect(list[0]?.daysOverdue).toBe(5);
  });

  it('收货消催货：receive 完成 buyer 名下该订单催货待办', async () => {
    const h = newHarness();
    const order = await orderAt(h, '2026-10-20T00:00:00.000Z');
    mustCommit(await h.service.execute(envelope('purchase.overdue.scan.v1', {})));
    const received = mustCommit(
      await h.service.execute(
        envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 10 }] }, { expectedRevision: 4, actor: buyer }),
        order.id,
      ),
    );
    expect(received.todosCompleted.length).toBe(1);
    expect((await h.todos.listOwn(t1, buyer)).every((todo) => todo.status === 'done')).toBe(true);
    expect((await h.service.overdueList(t1))).toEqual([]); // 已收货退出逾期集
  });
});

describe('查询视图与需求行投影', () => {
  it('清单详情（404）；采购明细导出（ExcelPort 序列化）；requirementLines 只出已解析行', async () => {
    const h = newHarness();
    h.materialValidation.library.set('M-001', 'item-1');
    const imported = mustCommit(
      await importExcel(h.service, 'wo-600', 'part', [
        ['DWG-1', 'M-001', 'a', 's', '10', ''],
        ['DWG-2', 'M-999', 'b', 's', '2', ''],
      ]),
    );
    const sheetId = (imported.sheets?.[0]?.id) as string;
    const detail = await h.service.sheetDetail(t1, sheetId);
    expect(detail.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    await expect(h.service.sheetDetail(t1, 'ls-missing')).rejects.toBeInstanceOf(ListingNotFoundError);

    await submitOrder(h.service, { workOrderId: 'wo-600' });
    const exported = await h.service.exportPurchaseDetails(t1, 'wo-600');
    expect(exported.kind).toBe('json-tables');
    if (exported.kind === 'json-tables') {
      expect(exported.sheets[0]?.name).toBe('采购明细');
      expect(exported.sheets[0]?.rows.length).toBe(1);
      expect(exported.sheets[0]?.rows[0]?.[5]).toBe('item-1');
    }

    const requirement = await h.service.requirementLines(t1, 'wo-600');
    expect(requirement).toEqual([
      { kind: 'part', itemId: 'item-1', drawingNo: 'DWG-1', requiredQty: 10, neededBy: null },
    ]); // unmatched 行（itemId null）不进需求投影
  });
});

describe('存储端口（内存实现合同）', () => {
  it('清单唯一约束 + 行号唯一 + 乐观更新；订单/申请/退货 advance 乐观检查', async () => {
    const sheets = new InMemoryListingSheetStore();
    await sheets.create({ tenant: t1, id: 'ls-1', workOrderId: 'wo-1', kind: 'part', name: 'n' });
    await expect(
      sheets.create({ tenant: t1, id: 'ls-2', workOrderId: 'wo-1', kind: 'part', name: 'n' }),
    ).rejects.toBeInstanceOf(ListingConflictError);
    expect((await sheets.listByWorkOrder(t1, 'wo-1')).length).toBe(1);

    const lines = new InMemoryListingLineStore();
    await lines.appendLines([
      { tenant: t1, id: 'll-1', sheetId: 'ls-1', workOrderId: 'wo-1', kind: 'part', lineNo: 1, drawingNo: null, code: 'c', name: null, spec: null, itemId: null, requiredQty: 1, neededBy: null, validationStatus: 'pending', candidateItemId: null, candidateItemCode: null, similarity: 0, basis: null, source: 'manual' },
    ]);
    await expect(
      lines.appendLines([
        { tenant: t1, id: 'll-2', sheetId: 'ls-1', workOrderId: 'wo-1', kind: 'part', lineNo: 1, drawingNo: null, code: 'c', name: null, spec: null, itemId: null, requiredQty: 1, neededBy: null, validationStatus: 'pending', candidateItemId: null, candidateItemCode: null, similarity: 0, basis: null, source: 'manual' },
      ]),
    ).rejects.toBeInstanceOf(ListingConflictError);
    expect(await lines.nextLineNo(t1, 'ls-1')).toBe(2);
    expect(await lines.update(t1, 'll-1', 1, { requiredQty: 5 })).not.toBeNull();
    expect(await lines.update(t1, 'll-1', 1, { requiredQty: 5 })).toBeNull(); // 版本不符

    const orders = new InMemoryPurchaseOrderStore();
    await orders.create({
      tenant: t1, id: 'po-1', workOrderId: null, flowConfigId: 'purchase-order', state: 'submitted',
      objectVersion: 2, supplierRef: null, supplierName: null, promisedAt: FIXED_NOW, lines: [], requestIds: [],
      buyer: null, remark: null,
    });
    await expect(orders.advance(t1, 'po-1', 2, 'approved', 3)).resolves.toMatchObject({ state: 'approved' });
    await expect(orders.advance(t1, 'po-1', 2, 'issued', 4)).rejects.toBeInstanceOf(ListingConflictError);
    expect(await orders.find(t2, 'po-1')).toBeNull();

    const returns = new InMemoryPurchaseReturnStore();
    await returns.create({
      tenant: t1, id: 'prt-1', purchaseOrderId: 'po-1', flowConfigId: 'purchase-return', state: 'open',
      objectVersion: 1, lines: [], returnedBy: planner, remark: null,
    });
    await expect(returns.advance(t1, 'prt-1', 1, 'revoked', 2)).resolves.toMatchObject({ state: 'revoked' });
  });

  it('OperationStore 同租户幂等 / 跨租户互不干扰；DomainEventStore eventId 去重 + Outbox', async () => {
    const operations = new InMemoryListingOperationStore();
    const entry = {
      tenant: t1, operationId: 'op-1', command: 'listing.import.v1',
      aggregateType: 'listing-sheet', aggregateId: 'ls-1', occurredAt: FIXED_NOW,
    };
    expect(await operations.record(entry)).not.toBeNull();
    expect(await operations.record(entry)).toBeNull();
    expect(await operations.record({ ...entry, tenant: t2 })).not.toBeNull();

    const domainEvents = new InMemoryListingDomainEventStore();
    const event = {
      eventId: 'evt-1', eventType: LISTING_EVENT_TYPES.listingImported, tenantId: t1,
      aggregate: { id: 'ls-1', type: 'listing-sheet', revision: 1 },
      occurredAt: FIXED_NOW, payload: {},
    };
    expect((await domainEvents.append(event as never)).eventId).toBe('evt-1');
    await expect(domainEvents.append(event as never)).rejects.toBeInstanceOf(ListingConflictError);
    expect((await domainEvents.pendingOutbox()).length).toBe(1);
  });
});

describe('输入解析与信封体', () => {
  it('parseCommandEnvelopeBody：动词白名单 + expectedRevision 形状；端点动词断言', () => {
    const parsed = parseCommandEnvelopeBody({
      operationId: 'op-x', expectedRevision: 'initial',
      command: { kind: 'listing.import.v1', payload: {} },
    });
    expect(parsed.command.kind).toBe('listing.import.v1');
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 0, command: { kind: 'listing.import.v1', payload: {} } }),
    ).toThrow(ListingInputError);
    expect(() =>
      parseCommandEnvelopeBody({ operationId: 'op-x', expectedRevision: 'initial', command: { kind: 'x.y.v1', payload: {} } }),
    ).toThrow(ListingInputError);
    expect(() =>
      parseCommandBodyForKind(
        { operationId: 'op-x', expectedRevision: 1, command: { kind: 'listing.line.update.v1', payload: {} } },
        'gap.check.v1',
      ),
    ).toThrow(ListingInputError);
  });

  it('收货载荷重复行号拒绝；申请载荷 kind 白名单；状态过滤参数', () => {
    expect(() =>
      parsePurchaseOrderReceivePayload({ lines: [{ lineNo: 1, receivedQty: 1 }, { lineNo: 1, receivedQty: 2 }] }),
    ).toThrow(ListingInputError);
    expect(parsePurchaseRequestCreatePayload({ kind: 'standard', itemId: 'x', quantity: 1 }).source).toEqual({ type: 'manual' });
    expect(parseStateFilter('submitted')).toBe('submitted');
    expect(parseStateFilter('')).toBeUndefined();
    expect(() => parseStateFilter('SUBMITTED')).toThrow(ListingInputError);
  });

  it('信封口径：创建命令带数字 revision rejected；既有命令带 initial rejected', async () => {
    const h = newHarness();
    const numeric = await h.service.execute(
      envelope('listing.import.v1', { source: 'workorder', workOrderId: 'wo-1' }, { expectedRevision: 3 }),
    );
    expect(numeric.status).toBe('rejected');
    const initial = await h.service.execute(
      envelope('listing.line.update.v1', { requiredQty: 1 }),
      'll-1',
    );
    expect(initial.status).toBe('rejected');
  });
});

describe('落账顺序锚点（PG 投影租户解析语义：机器事件账本按投影行解析租户）', () => {
  /**
   * 模拟 pg-listing-stores.tenantOfListingAggregate：append / readByAggregate
   * 前按投影行解析租户，聚合不存在于投影行 = 孤儿账目 fail-fast 拒写。投影行
   * 在投影存储 create 落账时登记（anchorProjectionsOnCreate）——若 service
   * 先 append 机器事件后落投影行（M2 Wave-2 验收缺陷形态），此处即抛孤儿错误。
   */
  function createProjectionAnchoredMachineEvents(
    projections: ReadonlyMap<string, TenantId>,
  ): ApprovalEventStore {
    const inner = createInMemoryApprovalEventStore();
    const requireProjected = (aggregate: { readonly id: string; readonly type: string }): void => {
      if (!projections.has(`${aggregate.type}\u0000${aggregate.id}`)) {
        throw new Error(
          `listing aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（Fake 模拟 PG tenantOfListingAggregate）`,
        );
      }
    };
    return {
      append: async (event) => {
        requireProjected(event.aggregate);
        await inner.append(event);
      },
      readByAggregate: async (aggregate, options) => {
        requireProjected(aggregate);
        return inner.readByAggregate(aggregate, options);
      },
    };
  }

  /** 包装投影存储：create 落账即登记投影行（聚合键 → 租户）；advance 不改登记。 */
  function anchorProjectionsOnCreate<
    S extends { create(input: { readonly id: string; readonly tenant: TenantId }): Promise<{ readonly id: string; readonly tenant: TenantId }> },
  >(store: S, aggregateType: string, projections: Map<string, TenantId>): S {
    const originalCreate = store.create.bind(store);
    store.create = async (input) => {
      const created = await originalCreate(input);
      projections.set(`${aggregateType}\u0000${created.id}`, created.tenant);
      return created;
    };
    return store;
  }

  function newAnchoredHarness() {
    const projections = new Map<string, TenantId>();
    const requests = anchorProjectionsOnCreate(
      new InMemoryPurchaseRequestStore(), PURCHASE_REQUEST_AGGREGATE_TYPE, projections,
    );
    const orders = anchorProjectionsOnCreate(
      new InMemoryPurchaseOrderStore(), PURCHASE_ORDER_AGGREGATE_TYPE, projections,
    );
    const returns = anchorProjectionsOnCreate(
      new InMemoryPurchaseReturnStore(), PURCHASE_RETURN_AGGREGATE_TYPE, projections,
    );
    const service = new ListingService(
      new InMemoryListingSheetStore(),
      new InMemoryListingLineStore(),
      new InMemoryGapCheckStore(),
      requests,
      orders,
      returns,
      new InMemoryListingOperationStore(),
      new InMemoryListingDomainEventStore(),
      createProjectionAnchoredMachineEvents(projections),
      new InMemoryTodoStore(),
      {},
      { orderApprover: approver, now: () => FIXED_NOW },
    );
    return { service, orders, requests };
  }

  it('订单提交全程不触发孤儿账目：先落 draft@v1 投影行再 append；重放对账一致', async () => {
    const h = newAnchoredHarness();
    const request = mustCommit(
      await h.service.execute(
        envelope('purchase.request.create.v1', { kind: 'standard', itemId: 'item-1', quantity: 5 }),
      ),
    ).purchaseRequest as NonNullable<ListingCommitted['purchaseRequest']>;
    const order = mustCommit(
      await h.service.execute(
        envelope('purchase.order.submit.v1', {
          workOrderId: 'wo-anchor',
          supplierRef: 'SUP-A',
          supplierName: '锚点供应商',
          promisedAt: '2026-11-20T00:00:00.000Z',
          lines: [{ itemId: 'item-1', quantity: 5 }],
          requestIds: [request.id],
          buyer,
          remark: null,
        }),
      ),
    ).purchaseOrder as NonNullable<ListingCommitted['purchaseOrder']>;

    expect([order.state, order.objectVersion]).toEqual(['submitted', 2]);
    // 后续 approve（订单重放对账 + 申请联动 append）在同一 Fake 账本下全程通过
    const approved = mustCommit(
      await h.service.execute(
        envelope('purchase.order.approve.v1', { remark: '锚点核准' }, { expectedRevision: 2, actor: approver }),
        order.id,
      ),
    );
    expect(approved.purchaseOrder?.state).toBe('approved');
    expect((await h.requests.find(t1, request.id))?.state).toBe('approved');
    expect((await h.orders.find(t1, order.id))?.objectVersion).toBe(3);
  });
});

describe('模块装配与权限码', () => {
  it('register()：内存缺省装配完整（controllers + providers 可解析）', () => {
    const module = ListingModule.register();
    expect(module.controllers).toEqual([
      ListingSheetsController,
      PurchaseRequestsController,
      PurchaseOrdersController,
      PurchaseReturnsController,
      PurchaseQueriesController,
    ]);
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ListingModule)).toBeUndefined();
  });

  it('权限码：22 路由逐点声明（03-listing.md §5 最小集）', () => {
    const expected: readonly [object, string, string][] = [
      [ListingSheetsController.prototype, 'import', 'listing:import'],
      [ListingSheetsController.prototype, 'sheets', 'listing:read'],
      [ListingSheetsController.prototype, 'sheet', 'listing:read'],
      [ListingSheetsController.prototype, 'updateLine', 'listing:write'],
      [ListingSheetsController.prototype, 'checkGap', 'gap:read'],
      [ListingSheetsController.prototype, 'latestGapCheck', 'gap:read'],
      [PurchaseRequestsController.prototype, 'create', 'purchase:request'],
      [PurchaseRequestsController.prototype, 'list', 'purchase:read'],
      [PurchaseRequestsController.prototype, 'get', 'purchase:read'],
      [PurchaseOrdersController.prototype, 'submit', 'purchase:order'],
      [PurchaseOrdersController.prototype, 'list', 'purchase:read'],
      [PurchaseOrdersController.prototype, 'get', 'purchase:read'],
      [PurchaseOrdersController.prototype, 'approve', 'purchase:approve'],
      [PurchaseOrdersController.prototype, 'issue', 'purchase:order'],
      [PurchaseOrdersController.prototype, 'receive', 'purchase:receive'],
      [PurchaseReturnsController.prototype, 'create', 'purchase:return'],
      [PurchaseReturnsController.prototype, 'list', 'purchase:read'],
      [PurchaseReturnsController.prototype, 'revoke', 'purchase:return'],
      [PurchaseQueriesController.prototype, 'scanOverdue', 'purchase:order'],
      [PurchaseQueriesController.prototype, 'overdue', 'purchase:read'],
      [PurchaseQueriesController.prototype, 'exportDetails', 'purchase:read'],
      [PurchaseQueriesController.prototype, 'details', 'purchase:read'],
    ];
    for (const [target, method, code] of expected) {
      const actual = Reflect.getMetadata(
        PERMISSION_METADATA_KEY,
        (target as unknown as Record<string, object>)[method] as object,
      );
      expect(actual, `${String(method)} 权限码`).toBe(code);
    }
  });
});

