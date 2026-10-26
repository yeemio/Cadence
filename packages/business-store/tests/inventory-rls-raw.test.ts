/**
 * inventory 裸 raw 写路径 RLS 租户会话收口锚定（D-14，2026-10-26）。
 *
 * 缺陷（retest-541ffff D-14）：PgStockAccountStore.adjust /
 * PgStockLocationBalanceStore.adjust / PgStockReservationStore.consume 三处
 * client 级 $executeRaw 不经 $allOperations 钩子（rls-session.ts 头注"已知
 * 边界"）——SaaS 形态（app_user + SMES_RLS_SESSION=on）下无 SET
 * app.current_tenant，RLS WITH CHECK 拒写（42501），入库/发料/调拨全 500。
 *
 * 修复形态（零 SQL 漂移）：三处 raw 各自包进交互式事务，回调内先
 * setRlsTenantOn(tx) 再在**同一 tx 句柄**上执行原 raw。
 *
 * 纯桩面（不连库；体例同 rls-session.test.ts）：桩 prisma 模拟交互式事务语义
 * （回调后 commit / 抛错 rollback），tx 句柄记录 $queryRaw / $executeRaw 全
 * 时序。锚定三层：
 *  1) 缺省（无扩展）：三处路径各自在同一事务句柄上先事务级 SET（true、参数化、
 *     当前 RLS 租户）再执行 raw——写携带租户不依赖扩展存在；
 *  2) =on 装配（withRlsTenantSession 全链）：接管层 SET + store 侧 SET 幂等
 *     重设同租户，raw 落同一事务连接，读回经钩子独立事务——D-14 修复后的
 *     SaaS 运行时形态；
 *  3) 守卫零漂移：raw 零行命中（守卫拒）行为不变——adjust 抛
 *     InventoryConflictError / consume 返回 null，事务照常提交空写。
 */
import { describe, expect, it, vi } from 'vitest';
import { TenantId } from '@smes/business-core';
import { InventoryConflictError } from '@smes/application';
import type { PrismaClient } from '@prisma/client';

vi.mock('@prisma/client', () => ({
  // 本测试路径只触发 isUniqueViolation 的形状消费（实际不命中）；不连库。
  Prisma: { PrismaClientKnownRequestError: class MockKnownRequestError extends Error {} },
  PrismaClient: class MockPrismaClient {},
}));

import {
  runWithRlsTenant,
  setRlsTenantOn,
  TENANT_SESSION_VAR,
  withRlsTenantSession,
} from '../src/rls-session.js';
import {
  PgStockAccountStore,
  PgStockLocationBalanceStore,
  PgStockReservationStore,
} from '../src/inventory/pg-inventory-stores.js';

// ---- 桩 prisma（交互式事务语义 + tx/root 两级句柄全时序记录） ----

interface RawCall {
  readonly kind: 'set' | 'exec';
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly tx: unknown;
}

interface ModelCall {
  readonly model: string;
  readonly operation: string;
  readonly args: unknown;
  readonly tx: unknown;
}

/** 捕获到的扩展对象结构面（与 withRlsTenantSession 注册形状一致）。 */
interface CapturedExtension {
  readonly query: {
    readonly $allModels: {
      readonly $allOperations: (params: {
        readonly model: string;
        readonly operation: string;
        readonly args: unknown;
      }) => Promise<unknown>;
    };
  };
  readonly client: {
    readonly $transaction: (
      arg: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
  };
}

interface StubPrisma {
  readonly rawCalls: readonly RawCall[];
  readonly modelCalls: readonly ModelCall[];
  readonly commits: readonly string[];
  readonly txs: readonly unknown[];
  readonly captured: () => CapturedExtension;
  setRawResult(result: number): void;
  asPrisma(): PrismaClient;
}

const T0 = new Date('2026-10-26T00:00:00.000Z');

function makeStubPrisma(): StubPrisma {
  const rawCalls: RawCall[] = [];
  const modelCalls: ModelCall[] = [];
  const commits: string[] = [];
  const txs: unknown[] = [];
  let rawResult = 1;
  let capturedExt: CapturedExtension | undefined;

  const accountRow = {
    id: 'sa-1', tenantId: 'tenant-a', itemId: 'item-1', warehouseId: 'wh-1',
    qtyOnHand: 8, qtyReserved: 0, createdAt: T0, updatedAt: T0,
  };
  const balanceRow = {
    id: 'lb-1', tenantId: 'tenant-a', warehouseId: 'wh-1', locationId: 'loc-1',
    itemId: 'item-1', qty: 8, createdAt: T0, updatedAt: T0,
  };
  const reservationRow = {
    id: 'rs-1', tenantId: 'tenant-a', reservationKey: 'rk-1', itemId: 'item-1',
    warehouseId: 'wh-1', quantity: 8, remaining: 3, status: 'active',
    refType: 'workorder', refId: 'wo-1', createdAt: T0, updatedAt: T0,
  };

  /** 三处路径的读回委托挂到指定句柄（tx 句柄 = 钩子重派落点；root = 缺省形态读回）。 */
  function delegatesFor(owner: Record<string, unknown>, tx: unknown): void {
    owner.stockAccountRecord = {
      async findUniqueOrThrow(args: unknown) {
        modelCalls.push({ model: 'stockAccountRecord', operation: 'findUniqueOrThrow', args, tx });
        return accountRow;
      },
    };
    owner.stockLocationBalanceRecord = {
      async findUniqueOrThrow(args: unknown) {
        modelCalls.push({ model: 'stockLocationBalanceRecord', operation: 'findUniqueOrThrow', args, tx });
        return balanceRow;
      },
    };
    owner.stockReservationRecord = {
      async findUnique(args: unknown) {
        modelCalls.push({ model: 'stockReservationRecord', operation: 'findUnique', args, tx });
        return reservationRow;
      },
    };
  }

  const stub: Record<string, unknown> = {
    async $transaction(arg: (tx: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
      const tx: Record<string, unknown> = {
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          rawCalls.push({ kind: 'set', sql: strings.join('$?'), params: values, tx });
          return [];
        },
        async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          rawCalls.push({ kind: 'exec', sql: strings.join('$?'), params: values, tx });
          return rawResult;
        },
      };
      delegatesFor(tx, tx);
      txs.push(tx);
      try {
        const result = await arg(tx);
        commits.push('commit');
        return result;
      } catch (error) {
        commits.push('rollback');
        throw error;
      }
    },
    $extends(ext: unknown) {
      capturedExt = ext as CapturedExtension;
      return stub;
    },
  };
  delegatesFor(stub, 'root');

  return {
    rawCalls,
    modelCalls,
    commits,
    txs,
    captured: () => {
      if (capturedExt === undefined) throw new Error('extension not captured');
      return capturedExt;
    },
    setRawResult(result: number) {
      rawResult = result;
    },
    asPrisma: () => stub as unknown as PrismaClient,
  };
}

/** 组装扩展客户端面（真实 $extends 产物形状）：$transaction 用接管实现，模型委托经钩子重派。 */
function extendedClient(stub: StubPrisma): PrismaClient {
  const ext = stub.captured();
  const client: Record<string, unknown> = {
    $transaction: ext.client.$transaction,
    stockAccountRecord: {
      findUniqueOrThrow: (args: unknown) =>
        ext.query.$allModels.$allOperations({ model: 'stockAccountRecord', operation: 'findUniqueOrThrow', args }),
    },
    stockLocationBalanceRecord: {
      findUniqueOrThrow: (args: unknown) =>
        ext.query.$allModels.$allOperations({ model: 'stockLocationBalanceRecord', operation: 'findUniqueOrThrow', args }),
    },
    stockReservationRecord: {
      findUnique: (args: unknown) =>
        ext.query.$allModels.$allOperations({ model: 'stockReservationRecord', operation: 'findUnique', args }),
    },
  };
  return client as unknown as PrismaClient;
}

const TENANT_A = TenantId.create('tenant-a');

// ---- helper 直锚 ----

describe('setRlsTenantOn（D-14 收口 helper）', () => {
  it('事务级 SET（true）、参数位传值（不拼 SQL）、租户取 ALS 上下文', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push({ sql: strings.join('$?'), params: values });
        return [];
      },
    };
    await runWithRlsTenant(TenantId.create('t-x'), () => setRlsTenantOn(tx));
    expect(calls).toEqual([{ sql: 'SELECT set_config($?, $?, true)', params: [TENANT_SESSION_VAR, 't-x'] }]);
  });
});

// ---- 缺省形态（无扩展）：写携带租户不依赖扩展存在 ----

describe('三处 raw 写路径缺省形态（无扩展）：事务内 SET 先行、同句柄执行 raw', () => {
  it('库存账 adjust：守卫 upsert 前在同一 tx 句柄上事务级 SET 当前租户', async () => {
    const stub = makeStubPrisma();
    const store = new PgStockAccountStore(stub.asPrisma());
    const account = await runWithRlsTenant(TENANT_A, () =>
      store.adjust(TENANT_A, 'item-1', 'wh-1', 8, 0),
    );
    expect(account.qtyOnHand).toBe(8);
    expect(stub.txs).toHaveLength(1); // raw 恰经一个交互式事务
    expect(stub.rawCalls).toHaveLength(2); // SET + raw（读回在根句柄，零 raw）
    const set = stub.rawCalls[0]!;
    const exec = stub.rawCalls[1]!;
    expect(set.kind).toBe('set');
    expect(set.sql).toBe('SELECT set_config($?, $?, true)'); // 事务级 true：池化连接零残留
    expect(set.params).toEqual([TENANT_SESSION_VAR, 'tenant-a']);
    expect(set.tx).toBe(stub.txs[0]);
    expect(exec.kind).toBe('exec');
    expect(exec.tx).toBe(set.tx); // raw 与 SET 同连接（SET 贯通）
    expect(exec.sql).toContain('INSERT INTO "stock_accounts"');
    expect(exec.sql).toContain('ON CONFLICT ("tenant_id", "item_id", "warehouse_id")');
    expect(String(exec.params[0])).toBe('tenant-a');
    expect(stub.commits).toEqual(['commit']);
    // 读回在事务外根句柄（与修复前同序：raw 提交后独立查询）
    expect(stub.modelCalls).toEqual([
      { model: 'stockAccountRecord', operation: 'findUniqueOrThrow', args: expect.any(Object), tx: 'root' },
    ]);
  });

  it('库位余额 adjust：同形态——SET 先行同句柄，守卫 upsert SQL 原样', async () => {
    const stub = makeStubPrisma();
    const store = new PgStockLocationBalanceStore(stub.asPrisma());
    const balance = await runWithRlsTenant(TENANT_A, () =>
      store.adjust(TENANT_A, 'wh-1', 'loc-1', 'item-1', 8),
    );
    expect(balance.qty).toBe(8);
    expect(stub.txs).toHaveLength(1);
    const set = stub.rawCalls[0]!;
    const exec = stub.rawCalls[1]!;
    expect(set.kind).toBe('set');
    expect(set.params).toEqual([TENANT_SESSION_VAR, 'tenant-a']);
    expect(exec.kind).toBe('exec');
    expect(exec.tx).toBe(set.tx);
    expect(exec.sql).toContain('INSERT INTO "stock_location_balances"');
    expect(exec.sql).toContain('ON CONFLICT ("tenant_id", "warehouse_id", "location_id", "item_id")');
    expect(stub.commits).toEqual(['commit']);
    expect(stub.modelCalls).toEqual([
      { model: 'stockLocationBalanceRecord', operation: 'findUniqueOrThrow', args: expect.any(Object), tx: 'root' },
    ]);
  });

  it('预占 consume：同形态——SET 先行同句柄，条件推进 UPDATE 原样', async () => {
    const stub = makeStubPrisma();
    const store = new PgStockReservationStore(stub.asPrisma());
    const consumed = await runWithRlsTenant(TENANT_A, () =>
      store.consume(TENANT_A, 'rk-1', 3),
    );
    expect(consumed?.remaining).toBe(3);
    expect(stub.txs).toHaveLength(1);
    const set = stub.rawCalls[0]!;
    const exec = stub.rawCalls[1]!;
    expect(set.kind).toBe('set');
    expect(set.params).toEqual([TENANT_SESSION_VAR, 'tenant-a']);
    expect(exec.kind).toBe('exec');
    expect(exec.tx).toBe(set.tx);
    expect(exec.sql).toContain('UPDATE "stock_reservations"');
    expect(exec.sql).toContain("AND \"remaining\" >=");
    expect(stub.commits).toEqual(['commit']);
    expect(stub.modelCalls).toEqual([
      { model: 'stockReservationRecord', operation: 'findUnique', args: expect.any(Object), tx: 'root' },
    ]);
  });
});

// ---- 守卫零漂移：raw 零行命中（守卫拒）行为不变 ----

describe('守卫零漂移：零行命中路径不受事务包裹影响', () => {
  it('adjust 零行：抛 InventoryConflictError，空事务照常提交、不读回', async () => {
    const stub = makeStubPrisma();
    stub.setRawResult(0);
    const store = new PgStockAccountStore(stub.asPrisma());
    await expect(
      runWithRlsTenant(TENANT_A, () => store.adjust(TENANT_A, 'item-1', 'wh-1', -8, 0)),
    ).rejects.toBeInstanceOf(InventoryConflictError);
    expect(stub.commits).toEqual(['commit']); // 零行不是错误：空事务提交（= 修复前单语句自提交 0 行）
    expect(stub.modelCalls).toHaveLength(0); // 守卫拒 → 不读回
  });

  it('consume 零行：返回 null、不回查', async () => {
    const stub = makeStubPrisma();
    stub.setRawResult(0);
    const store = new PgStockReservationStore(stub.asPrisma());
    const consumed = await runWithRlsTenant(TENANT_A, () => store.consume(TENANT_A, 'rk-1', 99));
    expect(consumed).toBeNull();
    expect(stub.commits).toEqual(['commit']);
    expect(stub.modelCalls).toHaveLength(0);
  });
});

// ---- =on 装配（SaaS 运行时形态）：接管层 + store 侧双 SET 幂等，raw 同句柄 ----

describe('三处 raw 写路径 =on 装配（withRlsTenantSession 全链）', () => {
  it('库存账 adjust：接管 SET + store SET 幂等同租户，raw 同事务连接，读回独立事务', async () => {
    const stub = makeStubPrisma();
    withRlsTenantSession(stub.asPrisma());
    const store = new PgStockAccountStore(extendedClient(stub));
    await runWithRlsTenant(TENANT_A, () => store.adjust(TENANT_A, 'item-1', 'wh-1', 8, 0));
    expect(stub.txs).toHaveLength(2); // tx1 = raw 包裹事务；tx2 = 读回（钩子自开）
    const tx1 = stub.txs[0]!;
    const tx2 = stub.txs[1]!;
    const tx1Raw = stub.rawCalls.filter((call) => call.tx === tx1);
    expect(tx1Raw.map((call) => call.kind)).toEqual(['set', 'set', 'exec']); // 接管 SET + store SET（幂等重设）+ raw
    expect(tx1Raw[0]!.params).toEqual([TENANT_SESSION_VAR, 'tenant-a']);
    expect(tx1Raw[1]!.params).toEqual([TENANT_SESSION_VAR, 'tenant-a']);
    expect(tx1Raw[2]!.sql).toContain('INSERT INTO "stock_accounts"');
    const tx2Raw = stub.rawCalls.filter((call) => call.tx === tx2);
    expect(tx2Raw.map((call) => call.kind)).toEqual(['set']); // 读回事务：钩子 SET
    expect(stub.modelCalls).toEqual([
      { model: 'stockAccountRecord', operation: 'findUniqueOrThrow', args: expect.any(Object), tx: tx2 },
    ]);
    expect(stub.commits).toEqual(['commit', 'commit']);
  });

  it('库位余额 adjust：同形态贯通', async () => {
    const stub = makeStubPrisma();
    withRlsTenantSession(stub.asPrisma());
    const store = new PgStockLocationBalanceStore(extendedClient(stub));
    await runWithRlsTenant(TENANT_A, () => store.adjust(TENANT_A, 'wh-1', 'loc-1', 'item-1', 8));
    expect(stub.txs).toHaveLength(2);
    const tx1Raw = stub.rawCalls.filter((call) => call.tx === stub.txs[0]!);
    expect(tx1Raw.map((call) => call.kind)).toEqual(['set', 'set', 'exec']);
    expect(tx1Raw[2]!.sql).toContain('INSERT INTO "stock_location_balances"');
    expect(stub.modelCalls).toEqual([
      { model: 'stockLocationBalanceRecord', operation: 'findUniqueOrThrow', args: expect.any(Object), tx: stub.txs[1]! },
    ]);
    expect(stub.commits).toEqual(['commit', 'commit']);
  });

  it('预占 consume：同形态贯通', async () => {
    const stub = makeStubPrisma();
    withRlsTenantSession(stub.asPrisma());
    const store = new PgStockReservationStore(extendedClient(stub));
    const consumed = await runWithRlsTenant(TENANT_A, () => store.consume(TENANT_A, 'rk-1', 3));
    expect(consumed?.remaining).toBe(3);
    expect(stub.txs).toHaveLength(2);
    const tx1Raw = stub.rawCalls.filter((call) => call.tx === stub.txs[0]!);
    expect(tx1Raw.map((call) => call.kind)).toEqual(['set', 'set', 'exec']);
    expect(tx1Raw[2]!.sql).toContain('UPDATE "stock_reservations"');
    expect(stub.modelCalls).toEqual([
      { model: 'stockReservationRecord', operation: 'findUnique', args: expect.any(Object), tx: stub.txs[1]! },
    ]);
    expect(stub.commits).toEqual(['commit', 'commit']);
  });
});
