/**
 * RLS 策略生成器（ADR-0005 M4 预研：SaaS 形态的 PG 行级安全）。
 *
 * 纯函数：输入表清单 + 会话变量 + 目标角色，输出可重复执行的 SQL 文本。
 * 不读文件、不连库、零依赖——迁移文件由其输出快照而成
 * （tests/rls-conformance.test.ts 守恒两者一致，改这里必同步迁移）。
 *
 * 隔离语义（fail-closed）：
 *   谓词 `"<tenant_column>" = current_setting('<sessionVar>', true)::text`
 *   - 未 SET 变量 → current_setting(..., true) 返回 NULL → 比较为 NULL →
 *     策略判 false → 读 0 行 / 写被拒（WITH CHECK 同谓词）。
 *   - SET 变量后仅放行同租户行；跨租户 UPDATE 匹配 0 行、跨租户 INSERT 被
 *     WITH CHECK 拒绝。
 *
 * 幂等取舍（写明）：PG 无 `CREATE POLICY IF NOT EXISTS`，故采用
 * `DROP POLICY IF EXISTS` + `CREATE POLICY`——重放收敛到最新谓词，
 * 也修复历史策略体漂移；ENABLE/FORCE 语句本身幂等。
 * 备选 `DO $$ ... pg_policies ... $$` 过于复杂，收益仅省一次 DROP，不取。
 *
 * FORCE 取舍：表 owner 也受 RLS 约束（除非 BYPASSRLS/superuser）。
 * superuser 恒绕过——这是跨线安全基准：四套 e2e 用 postgres superuser 跑
 * 全量 migrate deploy + CRUD，RLS 入库对它们零影响（容器实证三面之一）。
 */

/** 单表 RLS 输入：物理表名 + 租户列名。 */
export interface RlsTableSpec {
  /** 物理表名（schema.prisma @@map 事实，如 "users"） */
  name: string;
  /** 租户列名（全仓约定 "tenant_id"） */
  tenantColumn: string;
}

export interface GenerateRlsSqlOptions {
  tables: readonly RlsTableSpec[];
  /** 会话变量名（自定义 GUC，带命名空间点号），默认 "app.current_tenant" */
  sessionVar?: string;
  /**
   * 策略 TO 的角色清单。空数组 = TO PUBLIC（对全部非 BYPASSRLS 主体生效）。
   * 默认 []：迁移不得依赖部署期角色存在（e2e 库只有 postgres），
   * 受限 app 用户由 deploy/pg-init 创建并天然落入 PUBLIC 策略。
   */
  roles?: readonly string[];
  /** 策略名（PG 策略名按表独立命名空间，同名不冲突），默认 "tenant_isolation" */
  policyName?: string;
  /**
   * 是否同时生成单列租户索引 `CREATE INDEX IF NOT EXISTS`。
   * 默认 false：schema 事实里所有租户过滤热路径已有 tenant_id 前导复合
   * 索引（见 tests/rls-conformance.test.ts 的索引前导断言），单列索引纯冗余。
   */
  withTenantIndex?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GUC_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function quoteIdent(identifier: string): string {
  return `"${identifier}"`;
}

function toClause(roles: readonly string[]): string {
  return roles.length === 0 ? 'PUBLIC' : roles.map(quoteIdent).join(', ');
}

/**
 * 生成 RLS SQL 文本。每表四段（顺序固定，输出逐行可断言）：
 *   1. ALTER TABLE ... ENABLE ROW LEVEL SECURITY
 *   2. ALTER TABLE ... FORCE ROW LEVEL SECURITY
 *   3. DROP POLICY IF EXISTS ... （幂等）
 *   4. CREATE POLICY ... FOR ALL TO <roles> USING (...) WITH CHECK (...)
 * 可选第 5 段：CREATE INDEX IF NOT EXISTS "<table>_<tenantCol>_idx"
 * 命名全部可预测（策略名常量 / 索引名 = 表名_列名_idx）。
 */
export function generateRlsSql(options: GenerateRlsSqlOptions): string {
  const sessionVar = options.sessionVar ?? 'app.current_tenant';
  const roles = options.roles ?? [];
  const policyName = options.policyName ?? 'tenant_isolation';

  if (!GUC_NAME.test(sessionVar)) {
    throw new Error(`invalid sessionVar "${sessionVar}": custom GUC must be namespaced (e.g. app.current_tenant)`);
  }
  if (!IDENT.test(policyName)) {
    throw new Error(`invalid policyName "${policyName}"`);
  }
  for (const role of roles) {
    if (!IDENT.test(role)) throw new Error(`invalid role name "${role}"`);
  }
  if (options.tables.length === 0) {
    throw new Error('tables must not be empty');
  }

  // dedup 守卫（M4 正式线低危清偿）：tables.ts 人工维护，重复表项会让同一表
  // 生成两段策略语句——DROP+CREATE 重放虽收敛，但表数守恒断言（rls-conformance
  // 的表数=策略数）会静默漂移。构造期 fail-fast，错误信息带上重复名全清单。
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const table of options.tables) {
    if (seen.has(table.name)) duplicates.add(table.name);
    seen.add(table.name);
  }
  if (duplicates.size > 0) {
    throw new Error(`duplicate table entries: ${[...duplicates].sort().join(', ')}`);
  }

  const predicate = (column: string) =>
    `${quoteIdent(column)} = current_setting('${sessionVar}', true)::text`;

  const lines: string[] = [];
  for (const table of options.tables) {
    if (!IDENT.test(table.name)) throw new Error(`invalid table name "${table.name}"`);
    if (!IDENT.test(table.tenantColumn)) throw new Error(`invalid tenant column "${table.tenantColumn}"`);
    const tableRef = quoteIdent(table.name);
    lines.push(`ALTER TABLE ${tableRef} ENABLE ROW LEVEL SECURITY;`);
    lines.push(`ALTER TABLE ${tableRef} FORCE ROW LEVEL SECURITY;`);
    lines.push(`DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${tableRef};`);
    lines.push(
      `CREATE POLICY ${quoteIdent(policyName)} ON ${tableRef} FOR ALL TO ${toClause(roles)}` +
        ` USING (${predicate(table.tenantColumn)}) WITH CHECK (${predicate(table.tenantColumn)});`,
    );
    if (options.withTenantIndex) {
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table.name}_${table.tenantColumn}_idx`)} ON ${tableRef}(${quoteIdent(table.tenantColumn)});`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
