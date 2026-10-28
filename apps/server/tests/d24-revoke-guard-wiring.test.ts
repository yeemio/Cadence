/**
 * D-24 第二层焦点测试：inspection.revokeGuardPort 组合根接线（#39）。
 *
 * 修复对象：撤销质检在部署/组合形态被模块缺省 FAIL_CLOSED_INSPECTION_REVOKE_GUARD
 * 恒拒（"撤销闸门端口未接线"）——6a-2 交付的域面撤销功能在组合根无读面接线。
 * 本文件三段：
 *  1. 适配器行为合同（真实内存 store + baseline 桩，不起 HTTP）：
 *     闸门①入库完成拒/部分入库放行；闸门②下一道已报工拒/已质检拒/末道与
 *     无链放行；未启用域 per-gate permissive（零模块形态撤销可用）。
 *  2. wiring 装配面：createCrossModuleWiring 在 inspection 装配时产出
 *     register.inspection.revokeGuardPort（单模块与全模块形态皆非空）。
 *  3. 全链回归（buildAppModule 组合形态 inspection+inventory，共享注入
 *     releaseFacts/movements 句柄）：判定 PASS → 放行事实落共享 store →
 *     撤销 committed（D-24 症状回归锚）；补齐已入量后撤销 rejected
 *     （闸门①经组合根真实生效）。
 *
 * 闸门③（HC 工时已审）裁量：我方 hours 条目只从 verified 报工联动产生、恒
 * verified（hours-config 明示无人工审核环节），无"已审核"状态面可读——恒
 * 放行，登记开放问题（19 册 HC 增审核面后补接线）。本文件不为其造伪状态。
 */
import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
  BaselineService,
  InMemoryDispatchOrderStore,
  InMemoryItemStore,
  InMemoryInspectionOrderStore,
  InMemoryReleaseFactStore,
  InMemoryStockMovementStore,
  InMemoryWorkReportStore,
  InspectionService,
  type InspectionCommand,
  type RevokeGuardTarget,
} from '@smes/application';
import {
  InspectionId,
  OperationId,
  TenantId,
  UserId,
  makeCommandEnvelope,
} from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import {
  CROSS_MODULE_WIRING,
  bindCrossModuleWiring,
  createCrossModuleWiring,
  createInspectionRevokeGuard,
} from '../src/cross-module-wiring.js';

const tenant = TenantId.create('t-d24');
const FIXED_NOW = '2026-10-26T10:00:00.000Z';
const contexts: INestApplicationContext[] = [];

afterAll(async () => {
  for (const context of contexts) await context.close();
});

/** 适配器行为段共用造数束（各用例按需覆写/追加）。 */
function freshStores() {
  return {
    releaseFacts: new InMemoryReleaseFactStore(),
    movements: new InMemoryStockMovementStore(),
    workReports: new InMemoryWorkReportStore(),
    dispatchOrders: new InMemoryDispatchOrderStore(),
    inspections: new InMemoryInspectionOrderStore(),
  };
}

/** baseline 桩：仅 getRouting 消费面（路线按图号注入；缺图 = BaselineNotFoundError 语义由用例给 null steps 旁路）。 */
function baselineStub(
  routings: Record<string, readonly { seq: number; processCode: string }[]>,
): () => BaselineService {
  const service = {
    getRouting: async (_tenant: TenantId, drawingNo: string) => ({
      current: { steps: routings[drawingNo] ?? [] },
    }),
  } as unknown as BaselineService;
  return () => service;
}

async function appendRelease(
  store: InMemoryReleaseFactStore,
  inspectionId: string,
  quantity: number,
): Promise<void> {
  await store.append({
    tenant,
    id: `rel-${inspectionId}-${quantity}`,
    inspectionId,
    phase: 'judge@t1',
    kind: 'self_outsourced',
    itemId: 'item-d24',
    drawingNo: 'DWG-001',
    quantity,
    sourceType: 'report',
    sourceRefId: 'rpt-src',
    releasedAt: FIXED_NOW,
  });
}

let movementCounter = 0;

async function appendInspectionIn(
  store: InMemoryStockMovementStore,
  inspectionId: string,
  quantity: number,
): Promise<void> {
  movementCounter += 1;
  await store.append({
    tenant,
    id: `mv-d24-${String(movementCounter).padStart(4, '0')}`,
    kind: 'inspection-in',
    itemId: 'item-d24',
    warehouseId: 'wh-1',
    locationId: null,
    quantity,
    sourceRefType: 'inspection',
    sourceRefId: inspectionId,
    sourceKey: null,
    transferId: null,
    workOrderId: null,
    remark: null,
    occurredAt: FIXED_NOW,
    recordedBy: UserId.create('u-d24'),
  });
}

async function createReport(
  store: InMemoryWorkReportStore,
  id: string,
  overrides: {
    state?: string;
    operationCode?: string;
    drawingNo?: string | null;
    workOrderId?: string | null;
  } = {},
): Promise<void> {
  await store.create({
    tenant,
    id,
    dispatchId: 'dsp-any',
    kind: 'part',
    flowConfigId: 'flow-report',
    state: overrides.state ?? 'verified',
    objectVersion: 1,
    doneQty: 1,
    laborMinutes: 60,
    reporter: UserId.create('u-reporter'),
    workOrderId: overrides.workOrderId === undefined ? 'wo-1' : overrides.workOrderId,
    drawingNo: overrides.drawingNo === undefined ? 'DWG-001' : overrides.drawingNo,
    operationCode: overrides.operationCode ?? 'OP-A',
    supersedes: null,
    businessTime: FIXED_NOW,
    remark: null,
  });
}

async function createDispatch(
  store: InMemoryDispatchOrderStore,
  id: string,
  overrides: { operationCode?: string; workOrderId?: string | null } = {},
): Promise<void> {
  await store.create({
    tenant,
    id,
    workOrderId: overrides.workOrderId === undefined ? 'wo-1' : overrides.workOrderId,
    kind: 'part',
    flowConfigId: 'flow-dispatch',
    state: 'done',
    objectVersion: 1,
    title: 'd24 造数派工单',
    drawingNo: 'DWG-001',
    operationCode: overrides.operationCode ?? 'OP-A',
    material: null,
    sizeSpec: null,
    quantity: 10,
    assignee: null,
    dueAt: null,
    remark: null,
  });
}

async function createJudgedInspection(
  store: InMemoryInspectionOrderStore,
  id: string,
  overrides: {
    state?: string;
    sourceType?: string | null;
    sourceRefId?: string | null;
  } = {},
): Promise<void> {
  await store.create({
    tenant,
    id: InspectionId.create(id),
    flowConfigId: 'flow-inspection',
    state: overrides.state ?? 'passed',
    objectVersion: 2,
    kind: 'self_outsourced',
    sourceType: (overrides.sourceType === undefined ? 'dispatch' : overrides.sourceType) as never,
    sourceRefId: overrides.sourceRefId === undefined ? 'dsp-next-op' : overrides.sourceRefId,
    itemId: 'item-d24',
    drawingNo: 'DWG-001',
    quantity: 10,
  });
}

/** 工序链 DWG-001：OP-A(seq1) → OP-B(seq2) → OP-C(seq3)。 */
const ROUTING = [{ seq: 1, processCode: 'OP-A' }, { seq: 2, processCode: 'OP-B' }, { seq: 3, processCode: 'OP-C' }];

function reportTarget(overrides: Partial<RevokeGuardTarget> = {}): RevokeGuardTarget {
  return {
    inspectionId: 'insp-under-revoke',
    kind: 'self_outsourced',
    sourceType: 'report',
    sourceRefId: 'rpt-src',
    ...overrides,
  };
}

describe('D-24 #39 闸门①：关联入库未入库完成方可撤（IV 读面）', () => {
  it('入库完成（已入 ≥ 放行）拒撤；部分入库/无放行事实放行', async () => {
    const stores = freshStores();
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({}) });
    await appendRelease(stores.releaseFacts, 'insp-under-revoke', 10);
    await appendInspectionIn(stores.movements, 'insp-under-revoke', 4);
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull(); // 未完成可撤（撤时删待入库行归消费侧）
    await appendInspectionIn(stores.movements, 'insp-under-revoke', 6); // 已入 10 = 放行 10
    const fault = await guard.assertRevokable(tenant, reportTarget());
    expect(fault).toContain('关联入库已完成');
    expect(fault).toContain('放行 10');
    expect(fault).toContain('已入 10');
  });

  it('已入量跨物料按 inspectionId 汇总（多行 inspection-in 累计口径）', async () => {
    const stores = freshStores();
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({}) });
    await appendRelease(stores.releaseFacts, 'insp-under-revoke', 6);
    await appendInspectionIn(stores.movements, 'insp-under-revoke', 3);
    await appendInspectionIn(stores.movements, 'insp-under-revoke', 3);
    expect(await guard.assertRevokable(tenant, reportTarget())).toContain('关联入库已完成');
  });

  it('无放行事实（failed 判定/未放行）= 闸门①无约束', async () => {
    const stores = freshStores();
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({}) });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });
});

describe('D-24 #39 闸门②：紧邻下一道已报工/已质检禁撤（reporting+baseline）', () => {
  it('来源在 OP-A、下一道 OP-B 已有 verified 报工 → 拒撤；报工已 revoked 不算事实', async () => {
    const stores = freshStores();
    await createReport(stores.workReports, 'rpt-src'); // OP-A 来源报工
    await createReport(stores.workReports, 'rpt-next', { operationCode: 'OP-B' });
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    const fault = await guard.assertRevokable(tenant, reportTarget());
    expect(fault).toContain("紧邻下一道工序 'OP-B' 已有报工");
    expect(fault).toContain("报工单 'rpt-next'");
  });

  it('下一道 OP-B 的报工已 revoked → 放行（冲销不算事实）', async () => {
    const stores = freshStores();
    await createReport(stores.workReports, 'rpt-src');
    await createReport(stores.workReports, 'rpt-next', { operationCode: 'OP-B', state: 'revoked' });
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('下一道报工挂别的工作令（双方工作令齐备且不等）→ 放行', async () => {
    const stores = freshStores();
    await createReport(stores.workReports, 'rpt-src'); // wo-1 / OP-A
    await createReport(stores.workReports, 'rpt-other-wo', { operationCode: 'OP-B', workOrderId: 'wo-2' });
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('dispatch 来源（OP-A 外协）+ 下一道 OP-B 已有质检判定（dispatch 来源 passed 单）→ 拒撤', async () => {
    const stores = freshStores();
    await createDispatch(stores.dispatchOrders, 'dsp-src'); // 被撤单来源：OP-A 外协
    await createDispatch(stores.dispatchOrders, 'dsp-next-op', { operationCode: 'OP-B' });
    await createJudgedInspection(stores.inspections, 'insp-next', {
      state: 'passed',
      sourceType: 'dispatch',
      sourceRefId: 'dsp-next-op',
    });
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    const fault = await guard.assertRevokable(
      tenant,
      reportTarget({ sourceType: 'dispatch', sourceRefId: 'dsp-src' }),
    );
    expect(fault).toContain("紧邻下一道工序 'OP-B' 已有质检判定");
    expect(fault).toContain("质检单 'insp-next'");
  });

  it('下一道质检单仍在待检（pending）→ 放行（未判定不拦）', async () => {
    const stores = freshStores();
    await createReport(stores.workReports, 'rpt-src');
    await createDispatch(stores.dispatchOrders, 'dsp-next-op', { operationCode: 'OP-B' });
    await createJudgedInspection(stores.inspections, 'insp-next', {
      state: 'pending',
      sourceType: 'dispatch',
      sourceRefId: 'dsp-next-op',
    });
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('来源已是末道（OP-C）/不在链上 / receipt 采购质检 / 无工艺路线 → 放行', async () => {
    const stores = freshStores();
    await createReport(stores.workReports, 'rpt-src');
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({ 'DWG-001': ROUTING }) });
    // 末道：下一道不存在
    expect(
      await guard.assertRevokable(tenant, reportTarget({ sourceRefId: 'rpt-src-c' })),
    ).toBeNull();
    // 不在链上（OP-A 是链首——另用不在链上的工序码造一张来源报工）
    await createReport(stores.workReports, 'rpt-off-chain', { operationCode: 'OP-X' });
    expect(
      await guard.assertRevokable(tenant, reportTarget({ sourceRefId: 'rpt-off-chain' })),
    ).toBeNull();
    // receipt 采购质检无工序位
    expect(
      await guard.assertRevokable(
        tenant,
        reportTarget({ sourceType: 'receipt', sourceRefId: 'rcpt-1' }),
      ),
    ).toBeNull();
    // 空路线（图号无步序）→ 无下一道可护
    const emptyRouting = createInspectionRevokeGuard({
      ...stores,
      baseline: baselineStub({ 'DWG-001': [] }),
    });
    expect(await emptyRouting.assertRevokable(tenant, reportTarget())).toBeNull();
  });
});

describe('D-24 #39 未启用域与闸门③裁量（per-gate permissive）', () => {
  it('零读面形态（inspection 单模块装配）恒可撤——撤销闸门不再恒拒', async () => {
    const guard = createInspectionRevokeGuard({});
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('IV 读面缺位时即便构造上存在放行数据也不读（域未启用 = 无该闸门约束）', async () => {
    const stores = freshStores();
    await appendRelease(stores.releaseFacts, 'insp-under-revoke', 10);
    const guard = createInspectionRevokeGuard({
      releaseFacts: undefined, // inventory 未装配：两读面一体缺位
      movements: undefined,
      workReports: stores.workReports,
      baseline: baselineStub({ 'DWG-001': ROUTING }),
    });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('来源不可解析（reporting 未装配/来源行不存在）→ 闸门②放行', async () => {
    const guard = createInspectionRevokeGuard({
      baseline: baselineStub({ 'DWG-001': ROUTING }),
    });
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });

  it('闸门③（HC 工时已审）：我方 hours 恒 verified 无审核态——恒放行（登记开放问题）', async () => {
    const stores = freshStores();
    const guard = createInspectionRevokeGuard({ ...stores, baseline: baselineStub({}) });
    // 即使按工时口径也无法构造"已审"状态：hours 条目出生即 verified（hours-config）
    expect(await guard.assertRevokable(tenant, reportTarget())).toBeNull();
  });
});

describe('D-24 #39 wiring 装配面', () => {
  it('inspection 装配（含单模块形态）即产出 register.inspection.revokeGuardPort', () => {
    const wiring = createCrossModuleWiring({
      enabled: ['inspection'],
      stores: { inspectionOrders: new InMemoryInspectionOrderStore() },
    });
    expect(wiring.register.inspection?.revokeGuardPort).toBeDefined();
  });

  it('全模块形态三读面束齐备（IV/reporting/dispatch/baseline/inspection 投影）', () => {
    const wiring = createCrossModuleWiring({
      enabled: ['inspection', 'inventory', 'reporting', 'dispatch', 'baseline'],
      stores: {
        inventoryMovements: new InMemoryStockMovementStore(),
        inventoryReleaseFacts: new InMemoryReleaseFactStore(),
        workReports: new InMemoryWorkReportStore(),
        dispatchOrders: new InMemoryDispatchOrderStore(),
        inspectionOrders: new InMemoryInspectionOrderStore(),
      },
    });
    expect(wiring.register.inspection?.revokeGuardPort).toBeDefined();
    expect(wiring.register.inspection?.stockReleasePort).toBeDefined();
  });
});

describe('D-24 全链回归：组合形态撤销真实可用（inspection+inventory）', () => {
  it('判定→放行落共享 store→撤销 committed；补齐已入量后撤销被闸门①拦截', async () => {
    const itemStore = new InMemoryItemStore();
    const item = await itemStore.create({ tenant, code: 'ITEM-D24', name: '撤销守恒物料' });
    const releaseFacts = new InMemoryReleaseFactStore();
    const movements = new InMemoryStockMovementStore();
    const enabled = parseModulesEnabled('core,inspection,inventory');
    const app = await NestFactory.create(
      buildAppModule(enabled, {
        itemStore,
        inventoryReleaseFactStore: releaseFacts,
        inventoryMovementStore: movements,
      }),
      { logger: false },
    );
    contexts.push(app);
    bindCrossModuleWiring(app);
    const wiring = app.get(CROSS_MODULE_WIRING, { strict: false });
    expect(wiring.register.inspection?.revokeGuardPort).toBeDefined(); // 模块注册面带上真实闸门

    const inspection = app.get(InspectionService, { strict: false });
    const receipt = await inspection.receiveSourceFact(tenant, {
      sourceType: 'report',
      sourceRefId: 'rpt-d24-boot',
      itemId: item.id,
      drawingNo: 'DWG-D24',
      quantity: 7,
      workOrderId: 'wo-d24',
      occurredAt: FIXED_NOW,
      triggeredBy: 'test-d24',
    });
    expect(receipt.created).toBe(true);
    const id = receipt.inspectionId as string;
    let opCounter = 0;
    const envelope = (kind: string, payload: unknown, expectedRevision: number | 'initial') =>
      makeCommandEnvelope<InspectionCommand>({
        tenantId: tenant,
        issuedBy: UserId.create('u-d24'),
        operationId: OperationId.create(`d24-op-${String((opCounter += 1))}`),
        expectedRevision,
        issuedAt: FIXED_NOW,
        command: { kind: kind as never, payload } as never,
      });

    const judged = await inspection.execute(
      envelope('inspection.judge.v1', { passedQty: 7, failedQty: 0 }, 1),
      id,
    );
    expect(judged.status).toBe('committed'); // 判定 PASS → 放行事实经 #17 落共享 store
    const facts = await releaseFacts.listByInspection(tenant, id);
    expect(facts.reduce((sum, fact) => sum + fact.quantity, 0)).toBe(7); // 同源裁决证明：模块写的即测试持有的实例

    // D-24 症状回归锚：组合形态撤销不再被"撤销闸门端口未接线"恒拒（入库未完成 → 可撤）。
    const revoked = await inspection.execute(
      envelope('inspection.revoke.v1', { remark: '判定录错重判' }, 2),
      id,
    );
    expect(revoked.status).toBe('committed');

    // 重判 PASS 后把已入量补齐到放行账（append-only：首轮撤销不冲账，两轮
    // 放行 Σ=14——与 inventory receive 放行咬合面同口径）→ 闸门①经组合根真实生效。
    const rejudged = await inspection.execute(
      envelope('inspection.judge.v1', { passedQty: 7, failedQty: 0 }, 3),
      id,
    );
    expect(rejudged.status).toBe('committed');
    await appendInspectionIn(movements, id, 7);
    await appendInspectionIn(movements, id, 7); // 两轮放行各 7
    const blocked = await inspection.execute(
      envelope('inspection.revoke.v1', { remark: '入库后再撤应被拦' }, 4),
      id,
    );
    expect(blocked.status).toBe('rejected');
    if (blocked.status !== 'rejected') throw new Error('unreachable: 上一行已断言 rejected');
    expect(blocked.reason).toContain('撤销质检闸门拦截');
    expect(blocked.reason).toContain('关联入库已完成');
  });
});
