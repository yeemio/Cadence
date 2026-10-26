/**
 * fix-wave-6 6b-1（S9 / PRD 11 册 RREQ-MD-019/020）物品价格台账 + 初始价格
 * 三面守恒：不依赖活库 / prisma generate——schema 列面、迁移加列、RLS 守恒
 * 三向一致。模式同 issue-module.test.ts（约定字段块 + 机器守恒）。
 *
 * RREQ-MD-019 台账**不建新表**：数据源 = listing 采购订单明细
 * （purchase_orders.lines）只读消费（PgItemPriceLedgerStore，经
 * @smes/application 共享物化纯函数——行为面在 application 侧
 * tests/masterdata-price-ledger.test.ts 覆盖）；本文件守恒"无新表"约束
 * （迁移仅 ALTER，RLS 表清单零变更）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026220000_masterdata_item_initial_price', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('items 初始价格列面（RREQ-MD-020，S9）', () => {
  it('ItemRecord 含 initial_price_minor 可空整数分；Int 分口径与全库 minor 列一致', () => {
    const block = modelBlock('ItemRecord');
    expect(block).toMatch(/initialPriceMinor\s+Int\?\s+@map\("initial_price_minor"\)/);
    // 主数据配置表取舍不变：不套证据公共列
    expect(block).not.toContain('supersedes');
    expect(block).not.toContain('objectVersion');
  });

  it('迁移加列与 schema 一致（可空 INTEGER，存量行 null = 未维护）', () => {
    expect(moduleMigration).toContain('ALTER TABLE "items" ADD COLUMN "initial_price_minor" INTEGER;');
  });

  it('纯加列零 RLS 变更：迁移不混入 RLS 语句（同 outsourcing_line_cancel_columns 先例）', () => {
    expect(moduleMigration).not.toMatch(/POLICY|ENABLE ROW LEVEL SECURITY|rls_tenant_isolation/i);
  });
});

describe('价格台账无新表守恒（RREQ-MD-019，S9）', () => {
  it('迁移仅 ALTER items——台账不建自有表（数据源 = listing 采购明细只读消费）', () => {
    expect(moduleMigration).not.toMatch(/CREATE TABLE/i);
    expect(moduleMigration).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
  });

  it('RLS_TABLES 不因本批变更：items 既有在册（tenant_id 谓词列），无新增表项', () => {
    const names = RLS_TABLES.map((table) => table.name);
    expect(names).toContain('items');
    expect(names).toContain('purchase_orders'); // 台账只读数据源（listing 域在册，本批不触碰）
    expect(names).toContain('listing_events');
  });
});
