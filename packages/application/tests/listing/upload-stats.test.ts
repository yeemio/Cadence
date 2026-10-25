/**
 * A9 下图统计测试（U 波，工作令-下图统计-开发文档）：零件清单（kind='part'）
 * 明细行按创建日闭区间 COUNT——不去重图号、不按工作令拆分、恒一行结果；
 * 端口未接线显式拒绝；控制器路由/权限码/空串归一。内存行 createdAt 取真实
 * 时钟，窗口断言用相对今日/昨日/明日构造（闭区间边界可测：今日=今日含界）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { TenantContext } from '../../src/core/tenant-context.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { ListingInputError, ListingStateError } from '../../src/listing/listing-errors.js';
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
import type { ListingLineStore } from '../../src/listing/listing-stores.js';
import { ListingSheetsController } from '../../src/listing/listing.controllers.js';
import { ListingService } from '../../src/listing/listing.service.js';
import type { AppendListingLineInput } from '../../src/listing/listing-stores.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newHarness() {
  const lines = new InMemoryListingLineStore();
  const service = new ListingService(
    new InMemoryListingSheetStore(),
    lines,
    new InMemoryGapCheckStore(),
    new InMemoryPurchaseRequestStore(),
    new InMemoryPurchaseOrderStore(),
    new InMemoryPurchaseReturnStore(),
    new InMemoryListingOperationStore(),
    new InMemoryListingDomainEventStore(),
    createInMemoryApprovalEventStore(),
    new InMemoryTodoStore(),
  );
  return { lines, service };
}

let lineCounter = 0;
function lineInput(
  tenant: typeof t1,
  kind: AppendListingLineInput['kind'],
  overrides: Partial<AppendListingLineInput> = {},
): AppendListingLineInput {
  lineCounter += 1;
  return {
    tenant,
    id: `ll-${String(lineCounter).padStart(4, '0')}`,
    sheetId: `sheet-${tenant}`,
    workOrderId: 'wo-1',
    kind,
    lineNo: lineCounter,
    drawingNo: `DWG-${lineCounter}`,
    code: null,
    name: null,
    spec: null,
    itemId: null,
    requiredQty: 1,
    neededBy: null,
    validationStatus: 'pending',
    candidateItemId: null,
    candidateItemCode: null,
    similarity: 0,
    basis: null,
    source: 'manual',
    ...overrides,
  };
}

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function seededHarness() {
  const harness = newHarness();
  // t1：3 行零件清单（同图号两行不去重）+ 1 行标准件清单（不在统计面）
  await harness.lines.appendLines([
    lineInput(t1, 'part'),
    lineInput(t1, 'part', { drawingNo: 'DWG-1' }), // 同图号重复上传：按行计
    lineInput(t1, 'part'),
    lineInput(t1, 'standard'),
  ]);
  // t2：租户外零件行不计入
  await harness.lines.appendLines([lineInput(t2, 'part')]);
  return harness;
}

describe('A9 下图统计 · service', () => {
  it('无范围=全部有效零件行（同图号不去重、标准件/他租户不计入）', async () => {
    const { service } = await seededHarness();
    const stat = await service.partUploadStats(t1);
    expect(stat).toEqual({ timeRange: '全部', drawingCount: 3 });
  });

  it('闭区间：今日~今日含界计数；空窗仍恒一行返回 0', async () => {
    const { service } = await seededHarness();
    expect(await service.partUploadStats(t1, today, today)).toEqual({
      timeRange: `${today} ~ ${today}`,
      drawingCount: 3,
    });
    const empty = await service.partUploadStats(t1, tomorrow, tomorrow);
    expect(empty).toEqual({ timeRange: `${tomorrow} ~ ${tomorrow}`, drawingCount: 0 });
  });

  it('仅传一侧=半开区间（昨日截止=0；今起=全部）', async () => {
    const { service } = await seededHarness();
    expect((await service.partUploadStats(t1, undefined, yesterday)).drawingCount).toBe(0);
    expect((await service.partUploadStats(t1, today, undefined)).drawingCount).toBe(3);
  });

  it('非法日期格式 / 起大于止 → ListingInputError', async () => {
    const { service } = await seededHarness();
    await expect(service.partUploadStats(t1, '2026/10/01', today)).rejects.toThrow(ListingInputError);
    await expect(service.partUploadStats(t1, tomorrow, yesterday)).rejects.toThrow(/日期范围不正确/);
  });

  it('端口未接线（lineStore 无可选计数成员）→ 显式拒绝不静默回 0', async () => {
    const unwired: ListingLineStore = {
      appendLines: async () => [],
      nextLineNo: async () => 1,
      find: async () => null,
      listBySheet: async () => [],
      listByWorkOrder: async () => [],
      update: async () => null,
    };
    const service = new ListingService(
      new InMemoryListingSheetStore(),
      unwired,
      new InMemoryGapCheckStore(),
      new InMemoryPurchaseRequestStore(),
      new InMemoryPurchaseOrderStore(),
      new InMemoryPurchaseReturnStore(),
      new InMemoryListingOperationStore(),
      new InMemoryListingDomainEventStore(),
      createInMemoryApprovalEventStore(),
      new InMemoryTodoStore(),
    );
    await expect(service.partUploadStats(t1)).rejects.toThrow(ListingStateError);
  });
});

describe('A9 下图统计 · controller', () => {
  it('权限码 listing:read；租户取 TenantContext（ALS）；空串参数归一为未传', async () => {
    const { service } = await seededHarness();
    const tenantContext = new TenantContext(); // 控制器与 run 共用同一实例（ALS 同源）
    const controller = new ListingSheetsController(tenantContext, service);
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.uploadStats)).toBe('listing:read');
    const stat = await tenantContext.run(t1, () => controller.uploadStats('', ''));
    expect(stat).toEqual({ uploadStat: { timeRange: '全部', drawingCount: 3 } });
    const ranged = await tenantContext.run(
      t1,
      () => controller.uploadStats(today, today),
    );
    expect(ranged.uploadStat.timeRange).toBe(`${today} ~ ${today}`);
  });
});
