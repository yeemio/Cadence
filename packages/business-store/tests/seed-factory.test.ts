/**
 * seed-factory 幂等与终态形状锚定（体例同 seed.test.ts 纯桩面）。
 *
 * 内存桩 PrismaClient 实现 seedFactoryMain 用到的 24 张 createMany 表 +
 * 4 张 upsert 表的真实去重语义（近似真库唯一约束：createMany(skipDuplicates)
 * 按表唯一键去重；upsert 命中 where 应用 update（空对象=不动既有行））。
 *
 * 锚定四面：
 *  1) 幂等：seedFactoryMain 连跑两次，全部表行数/内容不变（第二次零新增）；
 *  2) 终态形状：六账号+两形态授权 / 主数据量（客户 2/供应商 3/物料 10/
 *     工序 8/路线 3/额定工时 8）/ B3 仓库形态 / 在制链五单（工作令
 *     not_started、清单 4 骨架+5 行挂图号、采购 issued@4、派工 executing@3、
 *     质检 pending@1）+ 命令信封语义（event/outbox 1:1 双写、机器事件
 *     (aggregate, revision) 逐版本、operationId 确定性 seed-factory-<n>、
 *     #material 子信封派生）；
 *  3) 多租户（同 seed.mjs 口径）：SMES_TENANTS=tenant-a 时仓库面每租户
 *     各 2 座（id 后缀区分），账号/策略/在制链仍只种 default；
 *  4) env 显式门：SMES_FACTORY_SEED 缺省时直跑入口拒跑（spawn 子进程验
 *     证 exit 1 + 提示——门在 PrismaClient 实例化之前，无 DB 依赖）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  // seed-factory.mjs 顶层 import 但仅直跑入口实例化（测试 argv[1] = vitest bin 不触发）
  PrismaClient: class MockPrismaClient {},
}));

import { seedFactoryMain } from '../prisma/seed-factory.mjs';

const execFileAsync = promisify(execFile);

// SMES_TENANTS / SMES_FACTORY_SEED 确定性：用例自管，恢复原值。
const originalTenantsEnv = process.env['SMES_TENANTS'];
const originalFactoryEnv = process.env['SMES_FACTORY_SEED'];
afterEach(() => {
  if (originalTenantsEnv === undefined) delete process.env['SMES_TENANTS'];
  else process.env['SMES_TENANTS'] = originalTenantsEnv;
  if (originalFactoryEnv === undefined) delete process.env['SMES_FACTORY_SEED'];
  else process.env['SMES_FACTORY_SEED'] = originalFactoryEnv;
});

// ---- 内存桩表（体例同 seed.test.ts；uniqueKey 近似真库唯一约束） ----

function makeCreateManyTable(uniqueKey: (row: Record<string, unknown>) => string) {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    counts: [] as number[],
    async createMany({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) {
      let count = 0;
      for (const row of data) {
        const key = uniqueKey(row);
        if (skipDuplicates === true && rows.some((existing) => uniqueKey(existing) === key)) continue;
        rows.push(row);
        count += 1;
      }
      this.counts.push(count);
      return { count };
    },
  };
}

function makeUpsertTable(
  compositeKey: (where: Record<string, unknown>) => string,
  rowKey: (row: Record<string, unknown>) => string,
) {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    calls: [] as { readonly where: Record<string, unknown>; readonly create: Record<string, unknown>; readonly update: Record<string, unknown> }[],
    async upsert({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) {
      this.calls.push({ where, create, update });
      const key = compositeKey(where);
      const existing = rows.find((row) => rowKey(row) === key);
      if (existing !== undefined) return { ...existing, ...update };
      const row = { ...create };
      rows.push(row);
      return row;
    },
  };
}

type CreateManyTable = ReturnType<typeof makeCreateManyTable>;
type UpsertTable = ReturnType<typeof makeUpsertTable>;

function makePrismaStub() {
  // createMany 表（键名 = 桩内表名；唯一键函数 = 近似真库唯一约束）
  const users = makeCreateManyTable((row) => `${row['tenantId']}|${row['username']}`);
  const policies = makeCreateManyTable((row) => String(row['ruleKey']));
  const customers = makeCreateManyTable((row) => String(row['id']));
  const suppliers = makeCreateManyTable((row) => String(row['id']));
  const items = makeCreateManyTable((row) => String(row['id']));
  const processDefs = makeCreateManyTable((row) => String(row['id']));
  const routings = makeCreateManyTable((row) => String(row['id']));
  const standardTimes = makeCreateManyTable((row) => String(row['id']));
  const materialRuns = makeCreateManyTable((row) => String(row['id']));
  const baselineOperations = makeCreateManyTable((row) => `${row['tenantId']}|${row['operationId']}`);
  const inventoryOperations = makeCreateManyTable((row) => String(row['operationKey']));
  const workOrders = makeCreateManyTable((row) => String(row['id']));
  const workorderOperations = makeCreateManyTable((row) => String(row['operationKey']));
  const listingSheets = makeCreateManyTable((row) => String(row['id']));
  const listingLines = makeCreateManyTable((row) => String(row['id']));
  const listingEvents = makeCreateManyTable((row) => `${row['aggregateId']}|${row['aggregateRevision']}`);
  const listingOperations = makeCreateManyTable((row) => String(row['operationKey']));
  const purchaseOrders = makeCreateManyTable((row) => String(row['id']));
  const dispatchOrders = makeCreateManyTable((row) => String(row['id']));
  const dispatchEvents = makeCreateManyTable((row) => `${row['aggregateId']}|${row['aggregateRevision']}`);
  const dispatchOperations = makeCreateManyTable((row) => String(row['operationKey']));
  const inspections = makeCreateManyTable((row) => String(row['id']));
  const inspectionOperations = makeCreateManyTable((row) => String(row['operationKey']));
  const events = makeCreateManyTable((row) => String(row['eventId']));
  const outbox = makeCreateManyTable((row) => String(row['eventId']));
  // upsert 表
  const warehouses = makeUpsertTable(
    (where) => {
      const key = where['tenantId_code'] as { tenantId: string; code: string };
      return `${key.tenantId}|${key.code}`;
    },
    (row) => `${row['tenantId']}|${row['code']}`,
  );
  const warehouseLocations = makeUpsertTable(
    (where) => {
      const key = where['tenantId_warehouseId_code'] as { tenantId: string; warehouseId: string; code: string };
      return `${key.tenantId}|${key.warehouseId}|${key.code}`;
    },
    (row) => `${row['tenantId']}|${row['warehouseId']}|${row['code']}`,
  );
  const goodsShelves = makeUpsertTable(
    (where) => {
      const key = where['tenantId_warehouseId_code'] as { tenantId: string; warehouseId: string; code: string };
      return `${key.tenantId}|${key.warehouseId}|${key.code}`;
    },
    (row) => `${row['tenantId']}|${row['warehouseId']}|${row['code']}`,
  );
  const shelfLocations = makeUpsertTable(
    (where) => {
      const key = where['tenantId_code'] as { tenantId: string; code: string };
      return `${key.tenantId}|${key.code}`;
    },
    (row) => `${row['tenantId']}|${row['code']}`,
  );

  const bind = (table: CreateManyTable) => ({ createMany: table.createMany.bind(table) });
  const prisma = {
    userRecord: bind(users),
    policyRecord: bind(policies),
    customerRecord: bind(customers),
    supplierRecord: bind(suppliers),
    itemRecord: bind(items),
    processDefRecord: bind(processDefs),
    routingRecord: bind(routings),
    standardTimeRecord: bind(standardTimes),
    materialValidationRunRecord: bind(materialRuns),
    baselineOperationRecord: bind(baselineOperations),
    inventoryOperationRecord: bind(inventoryOperations),
    workOrderProjectionRecord: bind(workOrders),
    workorderOperationRecord: bind(workorderOperations),
    listingSheetRecord: bind(listingSheets),
    listingLineRecord: bind(listingLines),
    listingEventRecord: bind(listingEvents),
    listingOperationRecord: bind(listingOperations),
    purchaseOrderRecord: bind(purchaseOrders),
    dispatchOrderRecord: bind(dispatchOrders),
    dispatchEventRecord: bind(dispatchEvents),
    dispatchOperationRecord: bind(dispatchOperations),
    inspectionOrderRecord: bind(inspections),
    inspectionOperationRecord: bind(inspectionOperations),
    businessEventRecord: bind(events),
    outboxRecord: bind(outbox),
    warehouseRecord: { upsert: warehouses.upsert.bind(warehouses) },
    warehouseLocationRecord: { upsert: warehouseLocations.upsert.bind(warehouseLocations) },
    goodsShelfRecord: { upsert: goodsShelves.upsert.bind(goodsShelves) },
    shelfLocationRecord: { upsert: shelfLocations.upsert.bind(shelfLocations) },
  };
  const tables: Record<string, CreateManyTable | UpsertTable> = {
    users, policies, customers, suppliers, items, processDefs, routings, standardTimes,
    materialRuns, baselineOperations, inventoryOperations, workOrders, workorderOperations,
    listingSheets, listingLines, listingEvents, listingOperations, purchaseOrders,
    dispatchOrders, dispatchEvents, dispatchOperations, inspections, inspectionOperations,
    events, outbox, warehouses, warehouseLocations, goodsShelves, shelfLocations,
  };
  return { prisma: prisma as Parameters<typeof seedFactoryMain>[0], tables };
}

function silenceLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe('seed-factory.mjs 幂等与终态形状', () => {
  it('连跑两次（无 SMES_TENANTS）：全表零重复；账号/主数据/B3 仓库/在制链五单形状锚定', async () => {
    delete process.env['SMES_TENANTS'];
    const { prisma, tables } = makePrismaStub();
    const logSpy = silenceLog();
    try {
      await seedFactoryMain(prisma);
      await seedFactoryMain(prisma);
    } finally {
      logSpy.mockRestore();
    }

    // ---- 幂等：每张 createMany 表恰两次调用，第二次全跳过 ----
    for (const [name, table] of Object.entries(tables)) {
      if (!('counts' in table)) continue; // upsert 表走 calls 断言
      expect(table.counts, `表 ${name} 调用计数`).toHaveLength(2);
      expect(table.counts[1], `表 ${name} 第二次应零新增`).toBe(0);
    }
    // upsert 表幂等：第二次全命中（calls 数 = 2×首次建行量）
    expect(warehouses(tables).calls.length).toBe(warehouses(tables).rows.length * 2);

    // ---- 账号：六业务岗（viewer 第七岗由主 seed 承担——此处不建不删） ----
    const userRows = table(tables, 'users').rows;
    expect(userRows).toHaveLength(6);
    const usernames = userRows.map((row) => String(row['username'])).sort();
    expect(usernames).toEqual(['appr01', 'plan01', 'prod01', 'purch01', 'qc01', 'wh01']);
    expect(userRows.every((row) => String(row['passwordHash']).startsWith('scrypt$65536$8$1$'))).toBe(true);
    expect(userRows.every((row) => row['tenantId'] === 'default' && row['active'] === true)).toBe(true);

    // ---- casbin 两形态：6 条 grant-role + 66 条 grant-permission = 72
    //（码集 = architecture/ROLE-PACKS.md v1.0 §1：14/9/11/7/17/8——plan-role
    // 相对文档 §1.0 的 13 码多 parts:approve 一码：工厂夹具 WO manager=plan01
    // 兼一级配件审批人（ROLE-PACKS §1.6 L1=项目经理），无码则 UI 可批 API 403
    // （AP-SEED-01），修复依据见 seed-factory.mjs 行内注）----
    const policyRows = table(tables, 'policies').rows;
    const grantRoles = policyRows.filter((row) => row['kind'] === 'grant-role');
    const grantPerms = policyRows.filter((row) => row['kind'] === 'grant-permission');
    expect(grantRoles).toHaveLength(6);
    expect(grantPerms).toHaveLength(66);
    expect(grantRoles.map((row) => String(row['role'])).sort()).toEqual(
      ['appr-role', 'plan-role', 'prod-role', 'purch-role', 'qc-role', 'wh-role'],
    );
    // 绑码参数化锚：qc-role → ROLE-PACKS §1.4 七码（基线 2 + 质检专码 5）
    const qcPerms = grantPerms.filter((row) => row['role'] === 'qc-role');
    expect(qcPerms.map((row) => `${row['resource']}:${row['action']}`).sort()).toEqual([
      'inspection:judge',
      'inspection:read',
      'nonconform:close',
      'nonconform:dispose',
      'nonconform:read',
      'notification:read',
      'workbench:read',
    ]);
    // AP-SEED-01 锚：plan-role 含 parts:approve（一级配件审批人被派时必须可批）
    expect(
      grantPerms
        .filter((row) => row['role'] === 'plan-role')
        .some((row) => row['resource'] === 'parts' && row['action'] === 'approve'),
    ).toBe(true);
    // 共码锚（ROLE-PACKS §3）：purchase:receive 同时授采购与仓管
    const receiveRoles = grantPerms
      .filter((row) => row['resource'] === 'purchase' && row['action'] === 'receive')
      .map((row) => String(row['role']))
      .sort();
    expect(receiveRoles).toEqual(['purch-role', 'wh-role']);

    // ---- 主数据量纲 ----
    expect(table(tables, 'customers').rows).toHaveLength(2);
    expect(table(tables, 'suppliers').rows).toHaveLength(3);
    const itemRows = table(tables, 'items').rows;
    expect(itemRows).toHaveLength(10);
    expect(itemRows.map((row) => String(row['code'])).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `ITM-${String(index + 1).padStart(3, '0')}`),
    );
    expect(itemRows.every((row) => typeof row['unit'] === 'string' && typeof row['spec'] === 'string')).toBe(true);
    const processRows = table(tables, 'processDefs').rows;
    expect(processRows).toHaveLength(8);
    expect(processRows.map((row) => String(row['code'])).sort()).toEqual([
      'OP-001', 'OP-002', 'OP-003', 'OP-004', 'OP-005', 'OP-006', 'OP-007', 'OP-008',
    ]);
    expect(table(tables, 'routings').rows).toHaveLength(3);
    // 标准工时分钟→秒：车削 OP-001 = 30 分钟/件 + 15 分钟预备
    const stTurning = table(tables, 'standardTimes').rows.find((row) => row['code'] === 'ST-OP-001');
    expect(stTurning).toMatchObject({ scope: 'process', targetCode: 'OP-001', standardSeconds: 1800, preparationSeconds: 900 });
    expect(table(tables, 'standardTimes').rows).toHaveLength(8);
    // 路线 3~5 步链：seq 严格递增且工序码在工序库内
    const routingRows = table(tables, 'routings').rows;
    const stepCounts = routingRows
      .map((row) => [String(row['code']), (row['steps'] as { seq: number; processCode: string }[]).length] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(stepCounts).toEqual([['DWG-001', 3], ['DWG-002', 4], ['DWG-003', 5]]);
    const processCodes = new Set(processRows.map((row) => String(row['code'])));
    for (const routing of routingRows) {
      const steps = routing['steps'] as { seq: number; processCode: string }[];
      expect(steps.map((step) => step.seq)).toEqual(steps.map((_, index) => index + 1));
      expect(steps.every((step) => processCodes.has(step.processCode))).toBe(true);
    }

    // ---- B3 仓库形态（default）：2 仓 + 3 直属库位 + 2 货架 + 5 货架库位 ----
    const warehouseRows = warehouses(tables).rows;
    expect(warehouseRows).toHaveLength(2);
    expect(warehouseRows.map((row) => String(row['code'])).sort()).toEqual(['FG', 'RAW']);
    expect(warehouseRows.find((row) => row['code'] === 'RAW')).toMatchObject({
      id: 'wh-seed-raw',
      defaultLocationId: 'loc-seed-raw-a01',
    });
    expect(warehouseLocations(tables).rows).toHaveLength(3);
    const shelfRows = goodsShelves(tables).rows;
    expect(shelfRows).toHaveLength(2);
    expect(shelfRows.find((row) => row['code'] === 'HLF-RAW-01')).toMatchObject({ id: 'gs-seed-raw-01', warehouseId: 'wh-seed-raw' });
    const shelfLocationRows = shelfLocations(tables).rows;
    expect(shelfLocationRows).toHaveLength(5);
    // 货架库位编码以货架编码开头 + 三级锚点一致（货架库位→货架→仓）
    for (const location of shelfLocationRows) {
      expect(String(location['code']).startsWith('HLF-')).toBe(true);
      const shelfRow = shelfRows.find((row) => row['id'] === location['goodsShelfId']);
      expect(shelfRow).toBeDefined();
      expect(location['warehouseId']).toBe(shelfRow?.['warehouseId']);
      expect(warehouseRows.some((row) => row['id'] === location['warehouseId'])).toBe(true);
    }

    // ---- 在制链五单（同一工作令） ----
    // 工作令 not_started@1（flowConfig 与真实配置一致）
    const workOrderRows = table(tables, 'workOrders').rows;
    expect(workOrderRows).toHaveLength(1);
    expect(workOrderRows[0]).toMatchObject({
      id: 'wo-seed-factory-01',
      tenantId: 'default',
      flowConfigId: 'work-order',
      state: 'not_started',
      objectVersion: 1,
      customerRef: 'CUST-001',
    });
    // 清单：4 骨架（含设备采购清单）+ 5 行挂图号（matched）
    const sheetRows = table(tables, 'listingSheets').rows;
    expect(sheetRows).toHaveLength(4);
    expect(sheetRows.map((row) => String(row['kind'])).sort()).toEqual(['electrical', 'equipment', 'part', 'standard']);
    expect(sheetRows.every((row) => row['workOrderId'] === 'wo-seed-factory-01')).toBe(true);
    const lineRows = table(tables, 'listingLines').rows;
    expect(lineRows).toHaveLength(5);
    expect(lineRows.every((row) => String(row['drawingNo']).startsWith('DWG-'))).toBe(true);
    expect(lineRows.every((row) => row['validationStatus'] === 'matched' && row['itemId'] !== null)).toBe(true);
    // 采购订单 issued@4 + 机器事件链（rev 2/3/4；APPROVE 决策带 record）
    const purchaseOrderRows = table(tables, 'purchaseOrders').rows;
    expect(purchaseOrderRows).toHaveLength(1);
    expect(purchaseOrderRows[0]).toMatchObject({
      id: 'po-seed-factory-01',
      state: 'issued',
      objectVersion: 4,
      flowConfigId: 'purchase-order',
      supplierRef: 'SUP-001',
      receiptRef: null,
    });
    const poEvents = [...table(tables, 'listingEvents').rows].sort(
      (a, b) => Number(a['aggregateRevision']) - Number(b['aggregateRevision']),
    );
    expect(poEvents.map((row) => [row['eventType'], row['aggregateRevision']])).toEqual([
      ['smes.purchase-order.v1.submitted', 2],
      ['smes.purchase-order.v1.approved', 3],
      ['smes.purchase-order.v1.issued', 4],
    ]);
    const approvePayload = poEvents[1]?.['payload'] as { record?: { decision: string; reviewer: string } };
    expect(approvePayload.record).toMatchObject({ decision: 'approve', reviewer: 'user-factory-appr' });
    // 派工单 executing@3 + 机器事件链（assigned/started）
    const dispatchRows = table(tables, 'dispatchOrders').rows;
    expect(dispatchRows).toHaveLength(1);
    expect(dispatchRows[0]).toMatchObject({
      id: 'dsp-seed-factory-01',
      state: 'executing',
      objectVersion: 3,
      kind: 'part',
      drawingNo: 'DWG-001',
      operationCode: 'OP-001',
      assignee: 'user-factory-prod',
      doneQty: 0,
    });
    const dspEvents = [...table(tables, 'dispatchEvents').rows].sort(
      (a, b) => Number(a['aggregateRevision']) - Number(b['aggregateRevision']),
    );
    expect(dspEvents.map((row) => row['eventType'])).toEqual(['smes.dispatch-order.v1.assigned', 'smes.dispatch-order.v1.started']);
    // 质检单 pending@1（self_outsourced 手工建单）
    const inspectionRows = table(tables, 'inspections').rows;
    expect(inspectionRows).toHaveLength(1);
    expect(inspectionRows[0]).toMatchObject({
      id: 'insp-seed-factory-01',
      state: 'pending',
      objectVersion: 1,
      kind: 'self_outsourced',
      sourceType: null,
    });

    // ---- 命令信封语义：event/outbox 1:1 双写 + operationId 确定性 ----
    const eventRows = table(tables, 'events').rows;
    const outboxRows = table(tables, 'outbox').rows;
    const eventIds = new Set(eventRows.map((row) => String(row['eventId'])));
    expect(outboxRows.map((row) => String(row['eventId']))).toEqual([...eventIds]);
    expect(eventRows.length).toBe(34); // 19 baseline 主数据 + 15 在制链域事件
    // provenance 两形态：模块面 {operationId, command, actor} / baseline 面 {operationId, issuedBy, commandKind, contract}
    const moduleProv = eventRows.find((row) => row['eventType'] === 'smes.workorder.v1.created')?.['provenance'] as Record<string, unknown>;
    expect(moduleProv).toMatchObject({ operationId: 'seed-factory-1', command: 'workorder.create.v1', actor: 'user-factory-plan' });
    const baselineProv = eventRows.find((row) => row['eventType'] === 'smes.baseline.v1.process-defined')?.['provenance'] as Record<string, unknown>;
    expect(baselineProv).toMatchObject({ commandKind: 'baseline.process.define.v1', contract: 'smes.command.v1' });
    // 命令幂等账本：确定性 operationId + #material 子信封派生
    expect(table(tables, 'workorderOperations').rows[0]).toMatchObject({
      operationId: 'seed-factory-1',
      command: 'workorder.create.v1',
      aggregateId: 'wo-seed-factory-01',
    });
    expect(table(tables, 'listingOperations').rows.map((row) => String(row['operationId'])).sort()).toEqual([
      'seed-factory-2', 'seed-factory-3', 'seed-factory-4', 'seed-factory-5', 'seed-factory-6',
    ]);
    const baselineOpIds = table(tables, 'baselineOperations').rows.map((row) => String(row['operationId']));
    expect(baselineOpIds).toContain('seed-factory-3#material');
    expect(baselineOpIds).toHaveLength(20); // 工序 8 + 路线 3 + 工时 8 + 物料校验 1
    expect(table(tables, 'inventoryOperations').rows.map((row) => String(row['operationKey'])).sort()).toEqual([
      'default|seed-factory-30', 'default|seed-factory-31', 'default|seed-factory-32', 'default|seed-factory-33',
    ]);
    // 物料校验运行：5 行 matched 判定 + 汇总
    expect(table(tables, 'materialRuns').rows).toHaveLength(1);
    expect(table(tables, 'materialRuns').rows[0]).toMatchObject({
      issuedBy: 'user-factory-plan',
      summary: { total: 5, matched: 5, suspected: 0, unmatched: 0 },
    });
  });

  it('SMES_TENANTS=tenant-a：仓库面每租户各 2 座（id 后缀区分）；账号/策略/在制链仍只种 default', async () => {
    process.env['SMES_TENANTS'] = 'tenant-a';
    const { prisma, tables } = makePrismaStub();
    const logSpy = silenceLog();
    try {
      await seedFactoryMain(prisma);
      await seedFactoryMain(prisma);
    } finally {
      logSpy.mockRestore();
    }

    // 仓库面：default + tenant-a 各 2 仓/2 货架；库位/货架库位翻倍
    const warehouseRows = warehouses(tables).rows;
    expect(warehouseRows).toHaveLength(4);
    expect(warehouseRows.filter((row) => row['tenantId'] === 'tenant-a').map((row) => String(row['id']))).toEqual([
      'wh-seed-raw-tenant-a',
      'wh-seed-fg-tenant-a',
    ]);
    expect(warehouseLocations(tables).rows).toHaveLength(6);
    expect(goodsShelves(tables).rows).toHaveLength(4);
    expect(shelfLocations(tables).rows).toHaveLength(10);
    // 租户货架库位挂各自租户的仓
    for (const location of shelfLocations(tables).rows) {
      const warehouse = warehouseRows.find((row) => row['id'] === location['warehouseId']);
      expect(warehouse?.['tenantId']).toBe(location['tenantId']);
    }
    expect(table(tables, 'inventoryOperations').rows).toHaveLength(8); // 每租户 4 条命令
    // 身份/策略/在制链/主数据：仍只种 default（同 seed.mjs 口径）
    const userRows = table(tables, 'users').rows;
    expect(userRows).toHaveLength(6);
    expect(userRows.every((row) => row['tenantId'] === 'default')).toBe(true);
    expect(table(tables, 'workOrders').rows).toHaveLength(1);
    expect(table(tables, 'events').rows.every((row) => row['tenantId'] === 'default')).toBe(true);
  });

  it('env 显式门：SMES_FACTORY_SEED 缺省直跑拒跑（exit 1 + 提示，PrismaClient 不实例化）', async () => {
    delete process.env['SMES_FACTORY_SEED'];
    const script = realpathSync(fileURLToPath(new URL('../prisma/seed-factory.mjs', import.meta.url)));
    const env = { ...process.env };
    delete env['SMES_FACTORY_SEED'];
    delete env['DATABASE_URL']; // 门必须先于任何 DB 触碰——无 DATABASE_URL 也能给出门提示
    let exitError: (Error & { code?: number | string; stderr?: string }) | undefined;
    try {
      await execFileAsync(process.execPath, [script], { env });
    } catch (error) {
      exitError = error as Error & { code?: number | string; stderr?: string };
    }
    // 缺省门：非零退出 + stderr 给出开启方式（未配置 DB 也不该报连接错误）
    expect(exitError).toBeDefined();
    expect(exitError?.code).not.toBe(0);
    expect(exitError?.stderr).toContain('SMES_FACTORY_SEED=on');
  }, 15_000);
});

// ---- 桩表取用（窄化辅助：Record<string, A|B> → 具体 table 类型） ----

function table(tables: Record<string, CreateManyTable | UpsertTable>, name: string): CreateManyTable {
  return tables[name] as CreateManyTable;
}

function warehouses(tables: Record<string, CreateManyTable | UpsertTable>): UpsertTable {
  return tables['warehouses'] as UpsertTable;
}

function warehouseLocations(tables: Record<string, CreateManyTable | UpsertTable>): UpsertTable {
  return tables['warehouseLocations'] as UpsertTable;
}

function goodsShelves(tables: Record<string, CreateManyTable | UpsertTable>): UpsertTable {
  return tables['goodsShelves'] as UpsertTable;
}

function shelfLocations(tables: Record<string, CreateManyTable | UpsertTable>): UpsertTable {
  return tables['shelfLocations'] as UpsertTable;
}
