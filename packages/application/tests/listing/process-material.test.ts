/**
 * U4 工序×原材料关联表数据面测试（S10：生产购置清单 §1.3.4/1.2 重述）：
 * 整表替换语义（删旧插新/空集清空）、尺寸/单价快照录入值校验（体积形式宽厚
 * 必填、其余形式须空、≤2 位小数、同工序原材料不重复）、零件清单行归属门禁、
 * 工序引用归属唯一、operationId 幂等、租户收口；控制器路由/权限码/空串归一。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import { TenantContext } from '../../src/core/tenant-context.js';
import { REQUEST_USER_KEY } from '../../src/core/auth/request-user.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { ListingInputError } from '../../src/listing/listing-errors.js';
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
import { InMemoryProcessMaterialLinkStore } from '../../src/listing/in-memory-process-material-stores.js';
import type { AppendListingLineInput } from '../../src/listing/listing-stores.js';
import type { ProcessMaterialCommand } from '../../src/listing/process-material-input.js';
import { ProcessMaterialsController } from '../../src/listing/process-material.controllers.js';
import { ProcessMaterialService } from '../../src/listing/process-material.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const actor = UserId.create('u1');

function newHarness() {
  const lines = new InMemoryListingLineStore();
  const materials = new InMemoryProcessMaterialLinkStore();
  const operations = new InMemoryListingOperationStore();
  const domainEvents = new InMemoryListingDomainEventStore();
  const service = new ProcessMaterialService(materials, lines, operations, domainEvents);
  const controller = new ProcessMaterialsController(new TenantContext(), service);
  return { lines, materials, operations, domainEvents, service, controller };
}

let lineCounter = 0;
async function seedPartLine(
  lines: InMemoryListingLineStore,
  kind: AppendListingLineInput['kind'] = 'part',
): Promise<string> {
  lineCounter += 1;
  const id = `ll-${String(lineCounter).padStart(4, '0')}`;
  const input: AppendListingLineInput = {
    tenant: t1,
    id,
    sheetId: 'sheet-1',
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
  };
  await lines.appendLines([input]);
  return id;
}

let opCounter = 0;
function replaceEnvelope(
  payload: unknown,
  overrides: { operationId?: OperationId; expectedRevision?: 'initial' | number } = {},
) {
  opCounter += 1;
  const command: ProcessMaterialCommand = { kind: 'listing.process-material.replace.v1', payload };
  return makeCommandEnvelope({
    tenantId: t1,
    issuedBy: actor,
    operationId: OperationId.create(`op-pm-${opCounter}`),
    expectedRevision: 'initial',
    issuedAt: new Date().toISOString(),
    command,
    ...overrides,
  });
}

const lengthRow = { rawMaterialId: 'item-steel-1', quantity: 2, unitPriceMinor: 12500, cutSizeForm: 'length', partLength: 120.5 };
const volumeRow = {
  rawMaterialId: 'item-steel-2',
  quantity: 1,
  unitPriceMinor: null,
  cutSizeForm: 'length-width-height',
  partLength: 100,
  partWidth: 50.25,
  partHeight: 3.5,
};
const areaRow = { rawMaterialId: 'item-plate-1', quantity: 4, unitPriceMinor: 0, cutSizeForm: 'area', partLength: 2.5 };

describe('U4 工序×原材料关联 · service 整表替换', () => {
  it('一工序挂多原材料：按数组序落 N 行（sortOrder 0 起）、measureType/cutSizeUnit 由尺寸形式派生', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    const outcome = await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-blank-1', materials: [lengthRow, volumeRow, areaRow] }),
    );
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') return;
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
    expect(outcome.rows.every((row) => row.id.startsWith('ppm-'))).toBe(true);
    expect(outcome.rows[0]).toMatchObject({
      listingLineId: lineId,
      processId: 'proc-blank-1',
      rawMaterialId: 'item-steel-1',
      quantity: 2,
      unitPriceMinor: 12500,
      measureType: 'length',
      cutSizeUnit: 'mm',
      partLength: 120.5,
      partWidth: null,
      partHeight: null,
    });
    expect(outcome.rows[1]).toMatchObject({ measureType: 'volume', partWidth: 50.25, partHeight: 3.5, unitPriceMinor: null });
    expect(outcome.rows[2]).toMatchObject({ measureType: 'area', cutSizeUnit: 'm2', partWidth: null });
    // 事件：聚合 = 工序引用；首写 previousCount=0 → revision 1（替换序）。
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]!.aggregate).toEqual({ id: 'proc-blank-1', type: 'process-material', revision: 1 });
    expect((await h.domainEvents.byAggregate({ id: 'proc-blank-1', type: 'process-material' })).length).toBe(1);
  });

  it('再替换整表覆盖：旧行消失、行数与事件 previousCount 对得上；空集 = 显式清空', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-laser-1', materials: [lengthRow, volumeRow] }),
    );
    const second = await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-laser-1', materials: [areaRow] }),
    );
    expect(second.status).toBe('committed');
    const rows = await h.service.listByProcess(t1, lineId, 'proc-laser-1');
    expect(rows.map((row) => row.rawMaterialId)).toEqual(['item-plate-1']);
    expect(rows[0]!.sortOrder).toBe(0); // 重新从 0 编序
    const cleared = await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-laser-1', materials: [] }),
    );
    expect(cleared.status).toBe('committed');
    expect(await h.service.listByProcess(t1, lineId, 'proc-laser-1')).toEqual([]);
    const events = await h.domainEvents.byAggregate({ id: 'proc-laser-1', type: 'process-material' });
    expect(events.map((event) => (event.payload as { replacedCount: number }).replacedCount)).toEqual([2, 1, 0]);
  });

  it('清单行全工序读（listByLine）按 processId→sortOrder 稳定序；租户收口', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-b', materials: [lengthRow] }),
    );
    await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-a', materials: [areaRow, volumeRow] }),
    );
    const rows = await h.service.listByLine(t1, lineId);
    expect(rows.map((row) => `${row.processId}#${row.sortOrder}`)).toEqual([
      'proc-a#0',
      'proc-a#1',
      'proc-b#0',
    ]);
    // 他租户同 id 读为零行（租户收口）。
    expect(await h.service.listByLine(t2, lineId)).toEqual([]);
    expect(await h.service.listByProcess(t2, lineId, 'proc-a')).toEqual([]);
  });

  it('归属门禁：清单行不存在 / 非零件类目 / 工序引用已挂他行 → rejected', async () => {
    const h = newHarness();
    const missing = await h.service.execute(
      replaceEnvelope({ listingLineId: 'll-nope', processId: 'proc-1', materials: [lengthRow] }),
    );
    expect(missing).toMatchObject({ status: 'rejected', reason: expect.stringContaining('不存在') });

    const stdLineId = await seedPartLine(h.lines, 'standard');
    const wrongKind = await h.service.execute(
      replaceEnvelope({ listingLineId: stdLineId, processId: 'proc-1', materials: [lengthRow] }),
    );
    expect(wrongKind).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining("kind='part'"),
    });

    const lineA = await seedPartLine(h.lines);
    const lineB = await seedPartLine(h.lines);
    await h.service.execute(
      replaceEnvelope({ listingLineId: lineA, processId: 'proc-x', materials: [lengthRow] }),
    );
    const stray = await h.service.execute(
      replaceEnvelope({ listingLineId: lineB, processId: 'proc-x', materials: [areaRow] }),
    );
    expect(stray).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('只允许挂一个清单行'),
    });
  });

  it('幂等：同一 operationId 二次执行 rejected；expectedRevision 非 initial rejected', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    const envelope = replaceEnvelope({ listingLineId: lineId, processId: 'proc-idem', materials: [lengthRow] });
    expect((await h.service.execute(envelope)).status).toBe('committed');
    const replay = await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-idem', materials: [lengthRow] }, { operationId: envelope.operationId }),
    );
    expect(replay).toMatchObject({ status: 'rejected', reason: expect.stringContaining('幂等冲突') });
    // 幂等拒绝不落任何新账。
    expect(await h.service.listByProcess(t1, lineId, 'proc-idem')).toHaveLength(1);

    const badRevision = await h.service.execute(
      replaceEnvelope({ listingLineId: lineId, processId: 'proc-idem2', materials: [lengthRow] }, { expectedRevision: 1 }),
    );
    expect(badRevision).toMatchObject({ status: 'rejected', reason: expect.stringContaining("须为 'initial'") });
  });
});

describe('U4 工序×原材料关联 · 输入校验（ListingInputError → 400）', () => {
  it('同工序原材料不可重复', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    await expect(
      h.service.execute(
        replaceEnvelope({
          listingLineId: lineId,
          processId: 'proc-dup',
          materials: [lengthRow, { ...lengthRow, quantity: 3 }],
        }),
      ),
    ).rejects.toThrow(/不可重复选择/);
  });

  it('尺寸校验：非正数 / 3 位小数 / 体积缺宽厚 / 长度形式带宽厚 全拒', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    const run = (materials: unknown[]) =>
      h.service.execute(replaceEnvelope({ listingLineId: lineId, processId: 'proc-dim', materials }));
    await expect(run([{ ...lengthRow, partLength: 0 }])).rejects.toThrow(/partLength/);
    await expect(run([{ ...lengthRow, partLength: 120.555 }])).rejects.toThrow(/2 位小数/);
    await expect(
      run([{ rawMaterialId: 'i', quantity: 1, cutSizeForm: 'length-width-height', partLength: 10 }]),
    ).rejects.toThrow(/宽\/厚必填/);
    await expect(
      run([{ ...lengthRow, partWidth: 5 }]),
    ).rejects.toThrow(/partWidth 仅体积形式/);
    await expect(run([{ ...areaRow, cutSizeForm: 'bogus' }])).rejects.toThrow(/cutSizeForm 非法/);
  });

  it('数量/单价校验：quantity 正整数；unitPriceMinor 非负整数（分）或空', async () => {
    const h = newHarness();
    const lineId = await seedPartLine(h.lines);
    const run = (materials: unknown[]) =>
      h.service.execute(replaceEnvelope({ listingLineId: lineId, processId: 'proc-qty', materials }));
    await expect(run([{ ...lengthRow, quantity: 0 }])).rejects.toThrow(/quantity/);
    await expect(run([{ ...lengthRow, quantity: 1.5 }])).rejects.toThrow(/quantity/);
    await expect(run([{ ...lengthRow, unitPriceMinor: -1 }])).rejects.toThrow(/unitPriceMinor/);
    await expect(run([{ ...lengthRow, unitPriceMinor: 1.5 }])).rejects.toThrow(/unitPriceMinor/);
    // 未定价（null/缺省）合法。
    expect(
      (await run([{ rawMaterialId: 'i-ok', quantity: 1, cutSizeForm: 'length', partLength: 5, unitPriceMinor: null }]))
        .status,
    ).toBe('committed');
  });
});

describe('U4 工序×原材料关联 · controller', () => {
  it('权限码：replace=listing:write、list=listing:read；租户取 TenantContext；空串参数归一', async () => {
    const h = newHarness();
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, h.controller.replace)).toBe('listing:write');
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, h.controller.list)).toBe('listing:read');

    const lineId = await seedPartLine(h.lines);
    const tenantContext = new TenantContext();
    const controller = new ProcessMaterialsController(tenantContext, h.service);
    const body = {
      operationId: 'op-ctrl-1',
      expectedRevision: 'initial',
      command: {
        kind: 'listing.process-material.replace.v1',
        payload: { listingLineId: lineId, processId: 'proc-ctrl', materials: [lengthRow] },
      },
    };
    const outcome = await tenantContext.run(
      t1,
      () => controller.replace({ [REQUEST_USER_KEY]: actor } as never, body),
    );
    expect(outcome.status).toBe('committed');

    // processId 空串 → 未传 → 全工序列表；缺 listingLineId → 400。
    const all = await tenantContext.run(t1, () => controller.list(lineId, ''));
    expect(all.materials.map((row) => row.processId)).toEqual(['proc-ctrl']);
    await expect(tenantContext.run(t1, () => controller.list('', ''))).rejects.toThrow(ListingInputError);
    const one = await tenantContext.run(t1, () => controller.list(lineId, 'proc-ctrl'));
    expect(one.materials).toHaveLength(1);
  });
});
