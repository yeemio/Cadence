/**
 * fix-wave-6 6b-3（A14 / RREQ-INT-032）列显隐偏好三面守恒：不依赖活库 /
 * prisma generate——schema 列面、RLS 补登、迁移建表三向一致。
 * 模式同 attachment-module.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026200000_column_preferences_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('column_preferences schema 列面（A14）', () => {
  it('三元组 + hiddenProps JSONB；不套证据公共列；库级 UNIQUE 支撑幂等 upsert（与源文档差异已登记）', () => {
    const block = modelBlock('ColumnPreferenceRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/userId\s+String\s+@map\("user_id"\)/);
    expect(block).toMatch(/pageKey\s+String\s+@map\("page_key"\)/);
    expect(block).toMatch(/tableKey\s+String\s+@map\("table_key"\)/);
    expect(block).toMatch(/hiddenProps\s+Json\s+@map\("hidden_props"\)/);
    expect(block).toMatch(/updatedAt\s+DateTime\s+@updatedAt\s+@db\.Timestamptz\(6\)\s+@map\("updated_at"\)/);
    // 三元组有效记录唯一（tenant 前导——兼作按页拉取热路径与 RLS 索引前导断言面）
    expect(block).toContain('@@unique([tenantId, userId, pageKey, tableKey])');
    expect(block).toContain('@@map("column_preferences")');
    expect(block).not.toContain('supersedes'); // 偏好数据：无修正链
    expect(block).not.toContain('objectVersion');
  });
});

describe('column_preferences RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含 column_preferences（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('column_preferences')).toBe(true);
  });
});

describe('column_preferences 迁移建表（20261026200000）', () => {
  it('建表列面与 schema 一致；三元组 UNIQUE 索引落地', () => {
    expect(moduleMigration).toContain('CREATE TABLE "column_preferences"');
    expect(moduleMigration).toContain('"tenant_id" TEXT NOT NULL');
    expect(moduleMigration).toContain('"user_id" TEXT NOT NULL');
    expect(moduleMigration).toContain('"page_key" TEXT NOT NULL');
    expect(moduleMigration).toContain('"table_key" TEXT NOT NULL');
    expect(moduleMigration).toContain('"hidden_props" JSONB NOT NULL');
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "column_preferences_tenant_id_user_id_page_key_table_key_key" ON "column_preferences"("tenant_id", "user_id", "page_key", "table_key")',
    );
    // 建表迁移不含 RLS（谓词统一走全量重放迁移 20261026200100）
    expect(moduleMigration).not.toContain('ROW LEVEL SECURITY');
  });

  it('全量重放迁移（20261026200100）为最新快照且含 column_preferences 策略', () => {
    const replay = readFileSync(
      join(
        packageRoot,
        'prisma',
        'migrations',
        '20261026200100_rls_tenant_isolation_replay',
        'migration.sql',
      ),
      'utf8',
    );
    expect(replay).toContain('ALTER TABLE "column_preferences" ENABLE ROW LEVEL SECURITY');
    expect(replay).toContain(
      'CREATE POLICY "tenant_isolation" ON "column_preferences" FOR ALL TO PUBLIC',
    );
  });
});
