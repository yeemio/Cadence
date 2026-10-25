/**
 * RLS 一致性守恒（模式同 schema-conformance.test.ts：不依赖活库）：
 *   1. 表清单来自 schema 事实——RLS_TABLES 与 schema.prisma 全部带 tenant_id
 *      的表双向相等（新表漏登 → 红；修复 = 补 src/rls/tables.ts 一行并重放
 *      生成器同步迁移快照）。
 *   2. 迁移快照 = 生成器输出——prisma/migrations/*_rls_tenant_isolation/
 *      migration.sql 剥离注释行后与 generateRlsSql(RLS_TABLES) 逐字节一致
 *      （改生成器不同步迁移 → 红）。
 *   3. 索引前导断言——除 outbox_records（投递器按投递时间全租户扫描，无租户
 *      过滤热路径）外，每表已有 tenant_id 前导的 @@index/@@unique，故生成器
 *      默认不产单列租户索引（取证于 generate-rls-sql.ts 头注的取舍）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateRlsSql } from '../src/rls/index.js';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');

interface SchemaModel {
  name: string;
  fieldNames: Set<string>;
  tenantColumn: string | null; // tenantId 字段的 @map 物理列名（无 tenantId → null）
  physicalTable: string; // @@map 表名（无 @@map → 模型名）
  leadingKeyIndexes: string[][]; // @@index/@@unique 的字段序列（首字段即索引前导）
}

function parseSchemaModels(source: string): Map<string, SchemaModel> {
  const models = new Map<string, SchemaModel>();
  const modelPattern = /^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelPattern.exec(source)) !== null) {
    let tenantColumn: string | null = null;
    const fieldNames = new Set<string>();
    const leadingKeyIndexes: string[][] = [];
    let physicalTable = match[1]!;
    for (const line of match[2]!.split('\n')) {
      const field = /^\s+(\w+)\s+\S+\s*((?:@.*)*)$/.exec(line);
      if (field) {
        fieldNames.add(field[1]!);
        if (field[1] === 'tenantId') {
          const column = /@map\("([^"]+)"\)/.exec(field[2] ?? '');
          tenantColumn = column ? column[1]! : 'tenantId';
        }
        continue;
      }
      const keyAttr = /^\s+@@(?:index|unique)\(\[([^\]]+)\]/.exec(line);
      if (keyAttr) {
        leadingKeyIndexes.push(keyAttr[1]!.split(',').map((part) => part.trim().split(/\s+/)[0]!));
        continue;
      }
      const tableMap = /^\s+@@map\("([^"]+)"\)/.exec(line);
      if (tableMap) physicalTable = tableMap[1]!;
    }
    models.set(match[1]!, { name: match[1]!, fieldNames, tenantColumn, physicalTable, leadingKeyIndexes });
  }
  return models;
}

function findRlsMigrationDir(): string {
  const migrationsRoot = join(packageRoot, 'prisma', 'migrations');
  // RLS 迁移可能多份（表清单增长 → 全量重放新迁移）；快照比对取时间戳最新的一份
  const candidates = readdirSync(migrationsRoot)
    .filter((entry) => entry.includes('_rls_'))
    .sort();
  expect(candidates.length).toBeGreaterThanOrEqual(1);
  return join(migrationsRoot, candidates[candidates.length - 1]!, 'migration.sql');
}

describe('RLS 表清单 = schema 事实（双向）', () => {
  const models = parseSchemaModels(schemaText);
  const tenantTables = [...models.values()].filter((model) => model.tenantColumn !== null);
  const schemaTableNames = new Set(tenantTables.map((model) => model.physicalTable));
  const rlsTableNames = new Set(RLS_TABLES.map((table) => table.name));

  it('schema 全部模型都带 tenantId 且映射为 tenant_id（ADR-0005 前提）', () => {
    expect(tenantTables).toHaveLength(models.size);
    for (const model of tenantTables) {
      expect(model.tenantColumn, `${model.name}.tenantId 应 @map("tenant_id")`).toBe('tenant_id');
    }
  });

  it('RLS_TABLES 覆盖 schema 全部带 tenant_id 的表（无遗漏）', () => {
    expect([...schemaTableNames].filter((name) => !rlsTableNames.has(name))).toEqual([]);
  });

  it('RLS_TABLES 无 schema 之外的陈旧表（无幻影）', () => {
    expect([...rlsTableNames].filter((name) => !schemaTableNames.has(name))).toEqual([]);
  });

  it('每表租户列名为 tenant_id（与谓词列一致）', () => {
    for (const table of RLS_TABLES) {
      expect(table.tenantColumn).toBe('tenant_id');
    }
  });
});

describe('迁移快照 = 生成器输出', () => {
  it('migration.sql 剥离注释后与 generateRlsSql(RLS_TABLES) 逐字节一致', () => {
    const migrationText = readFileSync(findRlsMigrationDir(), 'utf8');
    const stripped = migrationText
      .split('\n')
      .filter((line) => !/^\s*--/.test(line) && line.trim() !== '')
      .join('\n');
    expect(stripped).toBe(generateRlsSql({ tables: RLS_TABLES }).trimEnd());
  });

  it('RLS_TABLES 覆盖数 = 生成 SQL 的策略条数（24 表 × 1 策略）', () => {
    const sql = generateRlsSql({ tables: RLS_TABLES });
    expect(sql.match(/^CREATE POLICY /gm)).toHaveLength(RLS_TABLES.length);
    expect(sql.match(/^ALTER TABLE .* FORCE ROW LEVEL SECURITY;$/gm)).toHaveLength(RLS_TABLES.length);
  });
});

describe('索引前导断言（生成器默认不产单列租户索引的取证）', () => {
  const models = parseSchemaModels(schemaText);
  const WITHOUT_TENANT_LEADING_INDEX = new Set(['outbox_records']); // 投递器全租户扫描，无租户过滤热路径

  it('除豁免清单外每表都有 tenant_id 前导索引', () => {
    const missing = [...models.values()]
      .filter((model) => !WITHOUT_TENANT_LEADING_INDEX.has(model.physicalTable))
      .filter((model) => !model.leadingKeyIndexes.some((fields) => fields[0] === 'tenantId'))
      .map((model) => model.physicalTable);
    expect(missing).toEqual([]);
  });
});
