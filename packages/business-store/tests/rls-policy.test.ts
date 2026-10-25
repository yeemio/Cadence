/**
 * RLS 策略生成器单测：逐行断言生成 SQL（语义取舍见 src/rls/generate-rls-sql.ts 头注）。
 * schema 事实一致性与迁移快照守恒在 tests/rls-conformance.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { generateRlsSql } from '../src/rls/index.js';

describe('generateRlsSql：生成 SQL 逐行正确', () => {
  it('单表默认参数：ENABLE + FORCE + DROP IF EXISTS + CREATE（TO PUBLIC，默认会话变量）', () => {
    const sql = generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }] });
    expect(sql).toBe(
      [
        'ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "users" FORCE ROW LEVEL SECURITY;',
        'DROP POLICY IF EXISTS "tenant_isolation" ON "users";',
        'CREATE POLICY "tenant_isolation" ON "users" FOR ALL TO PUBLIC USING ("tenant_id" = current_setting(\'app.current_tenant\', true)::text) WITH CHECK ("tenant_id" = current_setting(\'app.current_tenant\', true)::text);',
        '',
      ].join('\n'),
    );
  });

  it('多表按输入顺序展开，每表固定四段', () => {
    const sql = generateRlsSql({
      tables: [
        { name: 'users', tenantColumn: 'tenant_id' },
        { name: 'roles', tenantColumn: 'tenant_id' },
      ],
    });
    const lines = sql.trimEnd().split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;');
    expect(lines[4]).toBe('ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;');
  });

  it('自定义会话变量与角色：谓词引用变量，TO 子句引用角色', () => {
    const sql = generateRlsSql({
      tables: [{ name: 'users', tenantColumn: 'tenant_id' }],
      sessionVar: 'app.tenant',
      roles: ['app_user', 'app_reader'],
    });
    expect(sql).toContain("current_setting('app.tenant', true)::text");
    expect(sql).toContain('TO "app_user", "app_reader"');
    expect(sql).not.toContain('TO PUBLIC');
  });

  it('fail-closed 语义：谓词经 current_setting(..., true)——未设变量返回 NULL 而非报错', () => {
    const sql = generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }] });
    // missing_ok = true 是关键：false 时未设变量直接 ERROR（fail-loud），
    // true 时 NULL → 谓词 NULL → 策略 false（fail-closed 拒绝且不炸查询）。
    expect(sql).toContain("current_setting('app.current_tenant', true)");
  });

  it('withTenantIndex：生成可预测命名的幂等索引', () => {
    const sql = generateRlsSql({
      tables: [{ name: 'users', tenantColumn: 'tenant_id' }],
      withTenantIndex: true,
    });
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "users_tenant_id_idx" ON "users"("tenant_id");');
  });

  it('默认不生成单列租户索引（既有复合索引已前导 tenant_id，见 conformance 测试）', () => {
    const sql = generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }] });
    expect(sql).not.toContain('CREATE INDEX');
  });
});

describe('generateRlsSql：输入防御', () => {
  it('表名 / 列名 / 角色名 / 策略名非法标识符抛错（防注入面收口）', () => {
    expect(() => generateRlsSql({ tables: [{ name: 'users; DROP TABLE x', tenantColumn: 'tenant_id' }] })).toThrow();
    expect(() => generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id --x' }] })).toThrow();
    expect(() => generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }], roles: ['bad role'] })).toThrow();
    expect(() => generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }], policyName: 'p; x' })).toThrow();
  });

  it('会话变量必须是带命名空间的自定义 GUC（含点号），否则抛错', () => {
    expect(() => generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }], sessionVar: 'current_tenant' })).toThrow();
    expect(() =>
      generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }], sessionVar: 'app.current_tenant; DROP TABLE x' }),
    ).toThrow();
    expect(() =>
      generateRlsSql({ tables: [{ name: 'users', tenantColumn: 'tenant_id' }], sessionVar: 'app.current_tenant' }),
    ).not.toThrow();
  });

  it('空表清单抛错（RLS 全量合同不允许静默空覆盖）', () => {
    expect(() => generateRlsSql({ tables: [] })).toThrow();
  });
});
