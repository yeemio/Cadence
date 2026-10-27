/**
 * PgLoginAttemptStore 纯桩面锚定（M2 安全前置批 SP-1；不连库，体例同
 * inspection-revert.test.ts / inventory-rls-raw.test.ts）。
 *
 * 三面：
 *  1) isLocked / clear 走 Prisma 模型操作（where 形状：锁定判定 = 非 null 且
 *     晚于 now；清零 = 按键删行）；
 *  2) registerFailure 的**单语句原子 upsert**：恰一条 $executeRaw（ON CONFLICT
 *     ("tenant_id","username") DO UPDATE，CASE 与当前行值比较——并发爆破不
 *     漏计），且经交互式事务先 setRlsTenantOn(tx) 再同句柄执行 raw（D-14
 *     收口体例，app_user + RLS 形态放行）；
 *  3) 参数计算在 JS 侧（now/lockUntil/windowStart ISO 字符串 + 显式
 *     ::timestamptz / ::int 转型——不依赖会话时区的隐式解释）。
 * 容器级活库复证（计数语义/原子性实态）：随线 A 收口一次（自管 PG 容器），
 * 见回传报告。
 */
import { describe, expect, it, vi } from 'vitest';
import { TenantId } from '@smes/business-core';

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class MockKnownRequestError extends Error {} },
  PrismaClient: class MockPrismaClient {},
}));

import { PgLoginAttemptStore } from '../src/org/pg-org-stores.js';
import type { PrismaClient } from '@prisma/client';

const TENANT = TenantId.create('t-rl1');
const NOW = new Date('2026-10-27T08:00:00.000Z');

interface RawCall {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly tx: unknown;
}

interface ModelCall {
  readonly operation: string;
  readonly args: unknown;
}

interface StubPrisma {
  readonly rawCalls: readonly RawCall[];
  readonly modelCalls: readonly ModelCall[];
  readonly setCalls: readonly unknown[][];
  setModelResult(result: unknown): void;
  asPrisma(): PrismaClient;
}

function makeStubPrisma(): StubPrisma {
  const rawCalls: RawCall[] = [];
  const modelCalls: ModelCall[] = [];
  const setCalls: unknown[][] = [];
  let modelResult: unknown = null;

  const tx = {
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
      // setRlsTenantOn 的固定形态：SELECT set_config('app.current_tenant', …, true)
      if (strings.join('?').includes('set_config')) {
        setCalls.push(values);
      }
      return Promise.resolve([]);
    },
    $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
      rawCalls.push({ sql: strings.join('?'), params: values, tx });
      return Promise.resolve(1);
    },
  };
  const prisma = {
    $transaction(fn: (handle: unknown) => Promise<unknown>): Promise<unknown> {
      return fn(tx);
    },
    loginAttemptRecord: {
      findFirst(args: unknown): Promise<unknown> {
        modelCalls.push({ operation: 'findFirst', args });
        return Promise.resolve(modelResult);
      },
      deleteMany(args: unknown): Promise<unknown> {
        modelCalls.push({ operation: 'deleteMany', args });
        return Promise.resolve(1);
      },
    },
  };
  return {
    rawCalls,
    modelCalls,
    setCalls,
    setModelResult(result: unknown): void {
      modelResult = result;
    },
    asPrisma(): PrismaClient {
      return prisma as unknown as PrismaClient;
    },
  };
}

describe('PgLoginAttemptStore（纯桩面）', () => {
  it('isLocked：模型查询 where 含键与 lockedUntil 非 null 且晚于 now；行存在即锁', async () => {
    const stub = makeStubPrisma();
    const store = new PgLoginAttemptStore(stub.asPrisma(), { maxFailures: 2, windowMs: 60_000, lockMs: 120_000 });

    stub.setModelResult(null);
    await expect(store.isLocked(TENANT, 'alice', NOW)).resolves.toBe(false);
    stub.setModelResult({ id: 'row-1' });
    await expect(store.isLocked(TENANT, 'alice', NOW)).resolves.toBe(true);

    expect(stub.modelCalls).toHaveLength(2);
    for (const call of stub.modelCalls) {
      expect(call.args).toEqual({
        where: {
          tenantId: TENANT,
          username: 'alice',
          lockedUntil: { not: null, gt: NOW },
        },
      });
    }
  });

  it('clear：按键删行（成功登录清零 = 与从未失败不可区分）', async () => {
    const stub = makeStubPrisma();
    const store = new PgLoginAttemptStore(stub.asPrisma());
    await store.clear(TENANT, 'alice');
    expect(stub.modelCalls).toEqual([
      { operation: 'deleteMany', args: { where: { tenantId: TENANT, username: 'alice' } } },
    ]);
  });

  it('registerFailure：单语句原子 upsert（恰一条 $executeRaw，ON CONFLICT 计数键）', async () => {
    const stub = makeStubPrisma();
    const store = new PgLoginAttemptStore(stub.asPrisma(), {
      maxFailures: 5,
      windowMs: 900_000,
      lockMs: 900_000,
    });
    await store.registerFailure(TENANT, 'alice', NOW);

    // 原子性锚：一条语句完成插入/计数/窗口/锁定判定（无读-改-写序列）
    expect(stub.rawCalls).toHaveLength(1);
    const raw = stub.rawCalls[0]!;
    expect(raw.sql).toContain('INSERT INTO "login_attempts"');
    expect(raw.sql).toContain('ON CONFLICT ("tenant_id", "username") DO UPDATE');
    expect(raw.sql).toContain('"failure_count" + 1'); // 计数自增在语句内（防并发漏计）
    expect(raw.sql).toContain('"locked_until"'); // 锁定判定同语句
    // SET 与 raw 同一 tx 句柄（D-14 体例：RLS 形态放行）
    expect(stub.setCalls).toHaveLength(1);
    expect(raw.tx).toBeDefined();
  });

  it('registerFailure：日期/阈值参数以 ISO 字符串 + 显式转型传入（不依赖会话时区）', async () => {
    const stub = makeStubPrisma();
    const store = new PgLoginAttemptStore(stub.asPrisma(), {
      maxFailures: 3,
      windowMs: 60_000,
      lockMs: 120_000,
    });
    await store.registerFailure(TENANT, 'bob', NOW);
    const { sql, params } = stub.rawCalls[0]!;

    expect(sql).toContain('::timestamptz');
    expect(sql).toContain('::int');
    // now / lockUntil(now+120s) / windowStart(now-60s) 三锚 + 键 + 阈值 + id
    expect(params).toContain(NOW.toISOString());
    expect(params).toContain(new Date(NOW.getTime() + 120_000).toISOString());
    expect(params).toContain(new Date(NOW.getTime() - 60_000).toISOString());
    expect(params).toContain(String(TENANT));
    expect(params).toContain('bob');
    expect(params).toContain(3); // maxFailures（::int 比较）
    // 常态（maxFailures > 1）INSERT 分支不直接锁定
    expect(params).toContain(null);
  });
});
