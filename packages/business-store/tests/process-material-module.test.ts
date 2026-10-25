/**
 * U4 listing 工序×原材料关联表三面守恒（S10 数据面：生产购置清单 §1.3.4
 * mes_purchase_part_process_material 重述）：不依赖活库 / prisma generate——
 * schema 列面、RLS 补登、迁移建表三向一致。模式同 attachment-module.test.ts
 * （约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026160000_process_material_module', 'migration.sql'),
  'utf8',
);
const replayMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026160100_rls_tenant_isolation_replay', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('process_material_links schema 列面（U4）', () => {
  it('挂取键（清单行/工序引用/原材料）+ 尺寸快照五列 + 单价/数量；不套证据公共列；无行级乐观版本', () => {
    const block = modelBlock('ProcessMaterialLinkRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/listingLineId\s+String\s+@map\("listing_line_id"\)/);
    expect(block).toMatch(/processId\s+String\s+@map\("process_id"\)/);
    expect(block).toMatch(/sortOrder\s+Int\s+@map\("sort_order"\)/);
    expect(block).toMatch(/rawMaterialId\s+String\s+@map\("raw_material_id"\)/);
    expect(block).toMatch(/quantity\s+Int/);
    expect(block).toMatch(/unitPriceMinor\s+Int\?\s+@map\("unit_price_minor"\)/);
    expect(block).toMatch(/measureType\s+String\s+@map\("measure_type"\)/);
    expect(block).toMatch(/partLength\s+Float\s+@map\("part_length"\)/);
    expect(block).toMatch(/partWidth\s+Float\?\s+@map\("part_width"\)/);
    expect(block).toMatch(/partHeight\s+Float\?\s+@map\("part_height"\)/);
    expect(block).toMatch(/cutSizeForm\s+String\s+@map\("cut_size_form"\)/);
    expect(block).toMatch(/cutSizeUnit\s+String\s+@map\("cut_size_unit"\)/);
    // (tenant, process) 组唯一：行序 + 同工序原材料不重复（顺带钉住工序引用归属）
    expect(block).toContain('@@unique([tenantId, processId, sortOrder])');
    expect(block).toContain('@@unique([tenantId, processId, rawMaterialId])');
    // 清单行全工序读（下单回填 / A5 项目成本取数面）
    expect(block).toContain('@@index([tenantId, listingLineId])');
    expect(block).toContain('@@map("process_material_links")');
    // 运营投影（整表替换唯一写面）：无证据公共列、无 objectVersion、无逻辑删除
    expect(block).not.toContain('objectVersion');
    expect(block).not.toContain('auditStatus');
    expect(block).not.toContain('deletedAt');
  });
});

describe('process_material_links RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含 process_material_links（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('process_material_links')).toBe(true);
  });

  it('全量重放迁移 20261026160100 收敛含本表策略', () => {
    expect(replayMigration).toMatch(/CREATE POLICY "tenant_isolation" ON "process_material_links"/);
  });
});

describe('process_material_links 建表迁移（20261026160000）', () => {
  it('单表 CREATE TABLE + 行序/原材料两 UNIQUE + 清单行索引；RLS 语句不在建表迁移（归 160100 重放迁移）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "process_material_links"/);
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "process_material_links_tenant_id_process_id_sort_order_key" ON "process_material_links"("tenant_id", "process_id", "sort_order")',
    );
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "process_material_links_tenant_id_process_id_raw_material_id_key" ON "process_material_links"("tenant_id", "process_id", "raw_material_id")',
    );
    expect(moduleMigration).toContain(
      'CREATE INDEX "process_material_links_tenant_id_listing_line_id_idx" ON "process_material_links"("tenant_id", "listing_line_id")',
    );
    for (const column of [
      '"listing_line_id" TEXT NOT NULL',
      '"process_id" TEXT NOT NULL',
      '"sort_order" INTEGER NOT NULL',
      '"raw_material_id" TEXT NOT NULL',
      '"quantity" INTEGER NOT NULL',
      '"unit_price_minor" INTEGER',
      '"measure_type" TEXT NOT NULL',
      '"part_length" DOUBLE PRECISION NOT NULL',
      '"part_width" DOUBLE PRECISION',
      '"part_height" DOUBLE PRECISION',
      '"cut_size_form" TEXT NOT NULL',
      '"cut_size_unit" TEXT NOT NULL',
    ]) {
      expect(moduleMigration).toContain(column);
    }
    expect(moduleMigration).not.toMatch(/ROW LEVEL SECURITY/); // RLS 归 160100 重放迁移
  });
});
