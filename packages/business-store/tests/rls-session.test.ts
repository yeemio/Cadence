/**
 * RLS session 接线单测（ADR-0005 M4 正式线；实现见 src/rls-session.ts，
 * M4 正式线上提包顶层，本测试经 src/org/index.js re-export 面消费）。
 *
 * 纯数据面：不构造 PrismaClient、不连库——扩展行为经 rlsSessionOperation 用
 * 事务桩直接驱动（协议面与官方 $extends 一致：tx.$queryRaw 标签模板 + 模型
 * 委托重派）。容器级贯通实证在 deploy/scripts/rls-session-proof.mjs。
 *
 * D-8 修复（2026-10-26）新增：$transaction 交互式形态接管——桩客户端捕获
 * $extends 扩展对象后直接驱动其 query/client 两个组件，锁定同句柄重派、
 * 回滚不留部分状态、ALS 跨异步传播与数组形态透传。
 */
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  currentRlsTenant,
  rlsSessionEnabled,
  rlsSessionOperation,
  runWithRlsTenant,
  SMES_RLS_SESSION_ENV,
  TENANT_SESSION_VAR,
  withRlsTenantSession,
  type RlsSessionTx,
} from '../src/org/index.js';
import { generateRlsSql } from '../src/rls/index.js';

describe('租户会话上下文（ALS）', () => {
  it('无 ALS store：回落固定默认租户 default（单机形态恒正确）', () => {
    expect(String(currentRlsTenant())).toBe('default');
  });

  it('runWithRlsTenant 内可见指定租户，出界还原', () => {
    const inside = runWithRlsTenant(TenantId.create('t-a'), () => String(currentRlsTenant()));
    expect(inside).toBe('t-a');
    expect(String(currentRlsTenant())).toBe('default');
  });

  it('ALS 语义随异步链传播（setTimeout 后仍读到）', async () => {
    const seen = await runWithRlsTenant(TenantId.create('t-b'), () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve(String(currentRlsTenant())), 5);
      }),
    );
    expect(seen).toBe('t-b');
  });

  it('嵌套 run 内层覆盖外层', () => {
    const seen = runWithRlsTenant(TenantId.create('outer'), () =>
      runWithRlsTenant(TenantId.create('inner'), () => String(currentRlsTenant())),
    );
    expect(seen).toBe('inner');
  });
});

describe('门控 rlsSessionEnabled', () => {
  it(`仅 ${SMES_RLS_SESSION_ENV}=on 启用`, () => {
    expect(rlsSessionEnabled({})).toBe(false);
    expect(rlsSessionEnabled({ [SMES_RLS_SESSION_ENV]: undefined })).toBe(false);
    expect(rlsSessionEnabled({ [SMES_RLS_SESSION_ENV]: 'off' })).toBe(false);
    expect(rlsSessionEnabled({ [SMES_RLS_SESSION_ENV]: 'ON' })).toBe(false);
    expect(rlsSessionEnabled({ [SMES_RLS_SESSION_ENV]: 'on' })).toBe(true);
  });
});

describe('扩展操作 rlsSessionOperation（事务桩驱动）', () => {
  interface StubCall {
    readonly kind: 'set' | 'op';
    readonly sql?: string;
    readonly params?: unknown[];
    readonly model?: string;
    readonly operation?: string;
    readonly args?: unknown;
  }

  function makeTx(calls: StubCall[]): RlsSessionTx & Record<string, unknown> {
    return {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push({ kind: 'set', sql: strings.join('$?'), params: values });
        return [];
      },
      userRecord: {
        async findMany(args: unknown) {
          calls.push({ kind: 'op', model: 'userRecord', operation: 'findMany', args });
          return [{ id: 'stub-row' }];
        },
      },
    };
  }

  it('先 SET（事务级、参数化）再在同一 tx 句柄上重派原操作', async () => {
    const calls: StubCall[] = [];
    const tx = makeTx(calls);
    const result = await rlsSessionOperation(tx, {
      model: 'userRecord',
      operation: 'findMany',
      args: { where: { tenantId: 'default' } },
    });
    expect(result).toEqual([{ id: 'stub-row' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.kind).toBe('set');
    expect(calls[0]?.sql).toBe('SELECT set_config($?, $?, true)');
    expect(calls[0]?.params).toEqual([TENANT_SESSION_VAR, 'default']);
    expect(calls[1]).toEqual({
      kind: 'op',
      model: 'userRecord',
      operation: 'findMany',
      args: { where: { tenantId: 'default' } },
    });
  });

  it('runWithRlsTenant 包裹时 SET 的是该租户（参数位，不拼 SQL）', async () => {
    const calls: StubCall[] = [];
    const tx = makeTx(calls);
    await runWithRlsTenant(TenantId.create('t-a'), () =>
      rlsSessionOperation(tx, { model: 'userRecord', operation: 'findMany', args: {} }),
    );
    expect(calls[0]?.params).toEqual([TENANT_SESSION_VAR, 't-a']);
  });
});

describe('withRlsTenantSession $transaction 接管（D-8 修复：桩客户端驱动）', () => {
  /** 捕获到的扩展对象结构面（与实现注册形状一致）。 */
  interface CapturedExtension {
    readonly name: string;
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
        arg:
          | ((tx: RlsSessionTx & Record<string, unknown>) => Promise<unknown>)
          | readonly unknown[],
        options?: unknown,
      ) => Promise<unknown>;
    };
  }

  interface StubPrisma {
    readonly captured: CapturedExtension;
    readonly baseInteractiveCount: () => number;
    readonly arrayCalls: ReadonlyArray<{ readonly arg: unknown; readonly options?: unknown }>;
    readonly sets: ReadonlyArray<{ readonly tx: unknown; readonly params: unknown[] }>;
    readonly ops: ReadonlyArray<{ readonly tx: unknown; readonly model: string; readonly operation: string }>;
    readonly commits: readonly string[];
    /** 全事件时序（'set:<tenant>' / 'op:<model>.<operation>'），断言 SET 先于操作用。 */
    readonly order: readonly string[];
  }

  /** 底层客户端桩：模拟真实 Prisma 交互式事务语义（回调后 commit / 抛错 rollback）。 */
  function makeStubPrisma(): StubPrisma & Record<string, unknown> {
    let baseInteractive = 0;
    const arrayCalls: Array<{ arg: unknown; options?: unknown }> = [];
    const sets: Array<{ tx: unknown; params: unknown[] }> = [];
    const ops: Array<{ tx: unknown; model: string; operation: string }> = [];
    const commits: string[] = [];
    const order: string[] = [];
    let capturedExt: CapturedExtension | undefined;
    const stub = {
      get captured(): CapturedExtension {
        if (capturedExt === undefined) throw new Error('extension not captured');
        return capturedExt;
      },
      baseInteractiveCount: () => baseInteractive,
      arrayCalls,
      sets,
      ops,
      commits,
      order,
      $extends(ext: unknown) {
        capturedExt = ext as CapturedExtension;
        return stub;
      },
      async $transaction(arg: unknown, options?: unknown): Promise<unknown> {
        if (typeof arg !== 'function') {
          arrayCalls.push({ arg, options });
          return [];
        }
        baseInteractive += 1;
        const tx: RlsSessionTx & Record<string, unknown> = {
          async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
            if (strings.join('$?').includes('set_config')) {
              sets.push({ tx, params: values });
              order.push(`set:${String(values[1])}`);
            }
            return [];
          },
          userRecord: {
            async create(args: unknown) {
              ops.push({ tx, model: 'userRecord', operation: 'create' });
              order.push('op:userRecord.create');
              return { ok: true, args };
            },
            async findMany(args: unknown) {
              ops.push({ tx, model: 'userRecord', operation: 'findMany' });
              order.push('op:userRecord.findMany');
              return [{ id: 'stub-row' }];
            },
          },
        };
        try {
          const result = await (arg as (t: typeof tx) => Promise<unknown>)(tx);
          commits.push('commit');
          return result;
        } catch (error) {
          commits.push('rollback');
          throw error;
        }
      },
    };
    return stub as StubPrisma & Record<string, unknown>;
  }

  function install(): StubPrisma & Record<string, unknown> {
    const stub = makeStubPrisma();
    withRlsTenantSession(stub as unknown as import('@prisma/client').PrismaClient);
    return stub;
  }

  it('交互式事务：回调前同句柄事务级 SET，多操作同句柄重派、不新开事务', async () => {
    const stub = install();
    const ext = stub.captured;
    let callbackTx: unknown;
    await ext.client.$transaction(async (tx) => {
      callbackTx = tx;
      await ext.query.$allModels.$allOperations({ model: 'userRecord', operation: 'create', args: { data: 1 } });
      await ext.query.$allModels.$allOperations({ model: 'userRecord', operation: 'findMany', args: {} });
    });
    // 底层只开了一个交互式事务（原子性前提：操作共享同一句柄）
    expect(stub.baseInteractiveCount()).toBe(1);
    // SET 恰一次、先于任何操作、落在用户回调拿到的同一句柄上
    expect(stub.sets).toHaveLength(1);
    expect(stub.sets[0]?.tx).toBe(callbackTx);
    expect(stub.sets[0]?.params).toEqual([TENANT_SESSION_VAR, 'default']);
    expect(stub.order[0]).toBe('set:default');
    // 两个操作都重派到同一句柄（与 SET 同句柄），且没有额外 SET
    expect(stub.ops).toHaveLength(2);
    expect(stub.ops[0]?.tx).toBe(callbackTx);
    expect(stub.ops[1]?.tx).toBe(callbackTx);
    expect(stub.commits).toEqual(['commit']);
  });

  it('runWithRlsTenant 包裹的交互式事务：SET 的是该租户；事务中段切租户不再重设（租户冻结于事务开启时刻）', async () => {
    const stub = install();
    const ext = stub.captured;
    await runWithRlsTenant(TenantId.create('t-a'), () =>
      ext.client.$transaction(async () => {
        await runWithRlsTenant(TenantId.create('t-other'), () =>
          ext.query.$allModels.$allOperations({ model: 'userRecord', operation: 'findMany', args: {} }),
        );
      }),
    );
    expect(stub.sets).toHaveLength(1); // 事务级 SET 一次，回调内不重设
    expect(stub.sets[0]?.params).toEqual([TENANT_SESSION_VAR, 't-a']);
    expect(stub.ops).toHaveLength(1); // 切租户上下文里的操作仍同句柄执行
  });

  it('回调抛错：整批回滚语义交给底层（rollback），ALS 句柄出界即失效——后续独立操作恢复自开事务', async () => {
    const stub = install();
    const ext = stub.captured;
    await expect(ext.client.$transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(stub.commits).toEqual(['rollback']);
    // 出界后钩子回到"每操作独立事务+SET"现状路径
    await ext.query.$allModels.$allOperations({ model: 'userRecord', operation: 'findMany', args: {} });
    expect(stub.baseInteractiveCount()).toBe(2);
    expect(stub.sets).toHaveLength(2); // 新事务内再 SET（各自事务级生效）
    expect(stub.commits).toEqual(['rollback', 'commit']);
    expect(stub.order).toEqual(['set:default', 'set:default', 'op:userRecord.findMany']);
  });

  it('ALS 上下文随异步链传播：事务内跨 await/tick 的操作仍同句柄', async () => {
    const stub = install();
    const ext = stub.captured;
    await ext.client.$transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ext.query.$allModels.$allOperations({ model: 'userRecord', operation: 'findMany', args: {} });
    });
    expect(stub.baseInteractiveCount()).toBe(1);
    expect(stub.sets).toHaveLength(1);
    expect(stub.ops).toHaveLength(1);
    expect(stub.ops[0]?.tx).toBe(stub.sets[0]?.tx);
  });

  it('数组形态不接管：原样透传底层（含 options），不 SET、不进交互式路径', async () => {
    const stub = install();
    const ext = stub.captured;
    const promises = [Promise.resolve(1), Promise.resolve(2)];
    const options = { isolationLevel: 'Serializable' };
    await ext.client.$transaction(promises, options);
    expect(stub.arrayCalls).toEqual([{ arg: promises, options }]);
    expect(stub.baseInteractiveCount()).toBe(0);
    expect(stub.sets).toHaveLength(0);
  });

  it('事务外独立操作维持现状：钩子自开事务 + SET + 同句柄重派', async () => {
    const stub = install();
    const ext = stub.captured;
    const result = await ext.query.$allModels.$allOperations({
      model: 'userRecord',
      operation: 'findMany',
      args: { where: {} },
    });
    expect(result).toEqual([{ id: 'stub-row' }]);
    expect(stub.baseInteractiveCount()).toBe(1);
    expect(stub.sets).toHaveLength(1);
    expect(stub.ops).toHaveLength(1);
    expect(stub.ops[0]?.tx).toBe(stub.sets[0]?.tx);
    expect(stub.commits).toEqual(['commit']);
  });
});

describe('withRlsTenantSession 装配面', () => {
  it('返回仍是 PrismaClient 形状（模型委托面不缺）——store 构造零改动的前提', () => {
    // 结构桩：只实现 $extends（装配时刻唯一被调用的入口），不连库。
    const wrappedNames: string[] = [];
    const stubPrisma = {
      $extends(extension: { name?: string }) {
        wrappedNames.push(extension.name ?? '(anon)');
        return { policyRecord: {}, userRecord: {}, roleRecord: {}, sessionRecord: {} };
      },
    } as unknown as import('@prisma/client').PrismaClient;
    const client = withRlsTenantSession(stubPrisma);
    expect(wrappedNames).toEqual(['rlsTenantSession']);
    for (const delegate of ['policyRecord', 'userRecord', 'roleRecord', 'sessionRecord']) {
      expect((client as unknown as Record<string, unknown>)[delegate]).toBeDefined();
    }
  });
});

describe('generateRlsSql dedup 守卫（M4 低危清偿）', () => {
  it('重复表项构造期抛错，错误信息含全部重复名', () => {
    expect(() =>
      generateRlsSql({
        tables: [
          { name: 'users', tenantColumn: 'tenant_id' },
          { name: 'roles', tenantColumn: 'tenant_id' },
          { name: 'users', tenantColumn: 'tenant_id' },
          { name: 'roles', tenantColumn: 'tenant_id' },
          { name: 'users', tenantColumn: 'tenant_id' },
        ],
      }),
    ).toThrowError(/duplicate table entries: roles, users/);
  });

  it('不重复的表项不受影响（守卫零误伤）', () => {
    const sql = generateRlsSql({
      tables: [
        { name: 'users', tenantColumn: 'tenant_id' },
        { name: 'roles', tenantColumn: 'tenant_id' },
      ],
    });
    expect(sql).toContain('ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;');
  });
});
