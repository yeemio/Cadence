/**
 * seed 幂等锚定（D-15）：prisma/seed.mjs 的 seedMain 幂等可重跑 + 默认仓形状。
 *
 * 纯桩面（不连库；体例同 inventory-rls-raw.test.ts 的 mock 先例）：内存桩
 * PrismaClient 实现被 seed 用到的三个操作的真实语义——
 *   - createMany(skipDuplicates) 按表唯一键去重（users=id / policies=ruleKey；
 *     近似真库唯一约束，足够锚定"重跑不重复增行"）；
 *   - upsert 命中 where → 应用 update（空对象 = 不动既有行）；未命中 → create。
 *
 * 锚定三面：
 *  1) 幂等：seedMain 连跑两次，四张"表"行数/内容不变（第二次零新增）；
 *  2) 默认仓形状：固定 id wh-seed-main / code MAIN / defaultLocationId
 *     loc-seed-main，库位同挂（SMES_DEFAULT_WAREHOUSE_ID 开箱可引用）；
 *  3) 既有 MAIN 仓不动：用户自建同名仓（不同 id）时 seed 不覆盖其字段，
 *     库位挂到实际仓 id 下（upsert update 空对象语义）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  // seed.mjs 顶层 import 但仅直跑入口实例化（测试 argv[1] = vitest bin 不触发）
  PrismaClient: class MockPrismaClient {},
}));

import { seedMain } from '../prisma/seed.mjs';

// ---- 内存桩表 ----

interface UpsertCall {
  readonly model: string;
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

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

function makeUpsertTable(compositeKey: (where: Record<string, unknown>) => string, rowKey: (row: Record<string, unknown>) => string) {
  const rows: Record<string, unknown>[] = [];
  const calls: UpsertCall[] = [];
  return {
    rows,
    calls,
    async upsert({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) {
      calls.push({ model: 'table', where, create, update });
      const key = compositeKey(where);
      const existing = rows.find((row) => rowKey(row) === key);
      if (existing !== undefined) return { ...existing, ...update };
      const row = { ...create };
      rows.push(row);
      return row;
    },
  };
}

function makePrismaStub() {
  const users = makeCreateManyTable((row) => String(row['id']));
  const policies = makeCreateManyTable((row) => String(row['ruleKey']));
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
  return {
    prisma: {
      userRecord: { createMany: users.createMany.bind(users) },
      policyRecord: { createMany: policies.createMany.bind(policies) },
      warehouseRecord: { upsert: warehouses.upsert.bind(warehouses) },
      warehouseLocationRecord: { upsert: warehouseLocations.upsert.bind(warehouseLocations) },
    },
    tables: { users, policies, warehouses, warehouseLocations },
  };
}

describe('seed.mjs 幂等（D-15 默认收货仓）', () => {
  it('seedMain 连跑两次：四表零重复，默认仓固定形状（id/code/defaultLocationId 供 env 引用）', async () => {
    const { prisma, tables } = makePrismaStub();
    const logs: string[] = [];
    const originalLog = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      await seedMain(prisma);
      await seedMain(prisma);
    } finally {
      (console.log as unknown as { mockRestore: () => void }).mockRestore();
      void originalLog;
    }

    // 幂等：第二次 createMany 全跳过（两次计数 [4, 0] / [6, 0]），upsert 命中走空 update。
    expect(tables.users.counts).toEqual([4, 0]);
    expect(tables.policies.counts).toEqual([6, 0]);
    expect(tables.users.rows).toHaveLength(4);
    expect(tables.policies.rows).toHaveLength(6);
    expect(tables.warehouses.rows).toHaveLength(1);
    expect(tables.warehouseLocations.rows).toHaveLength(1);

    // 默认仓形状（D-15）：固定 id + 固定库位锚（SMES_DEFAULT_WAREHOUSE_ID=wh-seed-main 开箱可用）。
    const warehouse = tables.warehouses.rows[0]!;
    expect(warehouse).toMatchObject({
      id: 'wh-seed-main',
      tenantId: 'default',
      code: 'MAIN',
      name: '默认仓（种子）',
      defaultLocationId: 'loc-seed-main',
    });
    expect(tables.warehouseLocations.rows[0]).toMatchObject({
      id: 'loc-seed-main',
      tenantId: 'default',
      warehouseId: 'wh-seed-main',
      code: 'MAIN-01',
    });

    // upsert 幂等键锚定：复合唯一键（(tenant, code) / (tenant, warehouse, code)）。
    expect(tables.warehouses.calls.every((call) => 'tenantId_code' in call.where)).toBe(true);
    expect(tables.warehouseLocations.calls.every((call) => 'tenantId_warehouseId_code' in call.where)).toBe(true);
  });

  it('既有 MAIN 仓（用户自建）不被覆盖：字段原样，种子库位挂到实际仓 id 下', async () => {
    const { prisma, tables } = makePrismaStub();
    // 预置用户自建 MAIN 仓（不同 id/name/defaultLocationId）。
    tables.warehouses.rows.push({
      id: 'wh-custom',
      tenantId: 'default',
      code: 'MAIN',
      name: '用户自建主仓',
      defaultLocationId: 'loc-custom',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await seedMain(prisma);
      await seedMain(prisma);
    } finally {
      (console.log as unknown as { mockRestore: () => void }).mockRestore();
    }

    expect(tables.warehouses.rows).toHaveLength(1);
    expect(tables.warehouses.rows[0]).toMatchObject({
      id: 'wh-custom',
      name: '用户自建主仓',
      defaultLocationId: 'loc-custom',
    });
    // 种子库位挂 upsert 回读的实际仓 id（wh-custom）而非固定 wh-seed-main。
    expect(tables.warehouseLocations.rows).toHaveLength(1);
    expect(tables.warehouseLocations.rows[0]).toMatchObject({
      id: 'loc-seed-main',
      warehouseId: 'wh-custom',
      code: 'MAIN-01',
    });
  });
});
