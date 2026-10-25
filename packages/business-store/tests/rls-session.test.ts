/**
 * RLS session 接线单测（ADR-0005 M4 正式线；实现见 src/rls-session.ts，
 * M4 正式线上提包顶层，本测试经 src/org/index.js re-export 面消费）。
 *
 * 纯数据面：不构造 PrismaClient、不连库——扩展行为经 rlsSessionOperation 用
 * 事务桩直接驱动（协议面与官方 $extends 一致：tx.$queryRaw 标签模板 + 模型
 * 委托重派）。容器级贯通实证在 deploy/scripts/rls-session-proof.mjs。
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
