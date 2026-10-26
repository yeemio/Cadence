/**
 * U7 项目成本六块三面守恒（A5：段事实 + 六块快照 + 录入价格三表）：不依赖活库 /
 * prisma generate——schema 列面、RLS 补登、迁移建表三向一致。模式同
 * aftercare-claim-module.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026170000_project_cost_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('cost_project_entries schema 列面（U7）', () => {
  it('段事实：append-only（(tenant, source_key) 幂等唯一 + delta 指回基准 + 证据公共列 + block/segment 两段词汇）', () => {
    const block = modelBlock('CostProjectEntryRecord');
    expect(block).toMatch(/id\s+String\s+@id @default\(uuid\(7\)\)/);
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/seq\s+BigInt\s+@default\(autoincrement\(\)\) @db\.BigInt/);
    expect(block).toMatch(/workOrderId\s+String\s+@map\("work_order_id"\)/);
    // 六块 block + 段词汇 + issue 行类别镜像
    expect(block).toMatch(/block\s+String/);
    expect(block).toMatch(/segment\s+String\?/);
    expect(block).toMatch(/lineKind\s+String\?\s+@map\("line_kind"\)/);
    // 金额可空（labor 段口径层换算）+ 数量/工种/供应商/设备维
    expect(block).toMatch(/amountMinor\s+Int\?\s+@map\("amount_minor"\)/);
    expect(block).toMatch(/supplierRef\s+String\?\s+@map\("supplier_ref"\)/);
    expect(block).toMatch(/equipmentRef\s+String\?\s+@map\("equipment_ref"\)/);
    // 幂等锚点 + delta 冲销
    expect(block).toContain('@@unique([tenantId, sourceKey])');
    expect(block).toMatch(/deltaOf\s+String\?\s+@map\("delta_of"\)/);
    // 证据公共列（append-only 事实）
    expect(block).toMatch(/objectVersion\s+Int\s+@default\(1\) @map\("object_version"\)/);
    expect(block).toMatch(/auditStatus\s+String\s+@map\("audit_status"\)/);
    expect(block).toContain('@@map("cost_project_entries")');
  });
});

describe('cost_project_snapshots schema 列面（U7）', () => {
  it('六块快照：supersedes 链（版本唯一 + 前任唯一）+ totals JSONB 冻结值', () => {
    const block = modelBlock('CostProjectSnapshotRecord');
    expect(block).toMatch(/workOrderId\s+String\s+@map\("work_order_id"\)/);
    expect(block).toMatch(/modelCode\s+String\s+@map\("model_code"\)/);
    expect(block).toMatch(/modelVersion\s+Int\s+@map\("model_version"\)/);
    expect(block).toMatch(/totals\s+Json/);
    expect(block).toMatch(/supersedes\s+String\?/);
    expect(block).toContain('@@unique([tenantId, workOrderId, modelCode, modelVersion, objectVersion])');
    expect(block).toContain('@@unique([tenantId, supersedes])');
    expect(block).toContain('@@map("cost_project_snapshots")');
  });
});

describe('cost_price_entries schema 列面（U7）', () => {
  it('录入价格：行锚唯一 upsert 投影（不套证据公共列）+ 单价/总金额可空 + 手改标记', () => {
    const block = modelBlock('CostPriceEntryRecord');
    expect(block).toMatch(/recordId\s+String\s+@map\("record_id"\)/);
    expect(block).toMatch(/taskLineId\s+String\s+@map\("task_line_id"\)/);
    expect(block).toMatch(/reservedQty\s+Float\s+@map\("reserved_qty"\)/);
    expect(block).toMatch(/unitPriceMinor\s+Int\?\s+@map\("unit_price_minor"\)/);
    expect(block).toMatch(/totalMinor\s+Int\?\s+@map\("total_minor"\)/);
    expect(block).toMatch(/amountManual\s+Boolean\s+@default\(false\) @map\("amount_manual"\)/);
    expect(block).toContain('@@unique([tenantId, workOrderId, recordId, taskLineId])');
    expect(block).toContain('@@map("cost_price_entries")');
    // 运营投影：不套证据公共列（取舍同 issue_records）
    expect(block).not.toContain('supersedes');
    expect(block).not.toContain('auditStatus');
  });
});

describe('project cost RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含三表（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('cost_project_entries')).toBe(true);
    expect(names.has('cost_project_snapshots')).toBe(true);
    expect(names.has('cost_price_entries')).toBe(true);
    // 守恒计数 102 → 103：A8/A10 首波 machining_daily_stats 补登（schema-conformance 同步）
    expect(RLS_TABLES).toHaveLength(103);
  });
});

describe('project cost 建表迁移（20261026170000）', () => {
  it('三表 CREATE TABLE + 唯一/复合索引；RLS 语句不在建表迁移（归 170100 重放迁移）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "cost_project_entries"/);
    expect(moduleMigration).toMatch(/CREATE TABLE "cost_project_snapshots"/);
    expect(moduleMigration).toMatch(/CREATE TABLE "cost_price_entries"/);
    expect(moduleMigration).toMatch(
      /CREATE UNIQUE INDEX "cost_project_entries_tenant_id_source_key_key" ON "cost_project_entries"\("tenant_id", "source_key"\)/,
    );
    expect(moduleMigration).toMatch(
      /CREATE UNIQUE INDEX "cost_project_snapshots_tenant_id_supersedes_key" ON "cost_project_snapshots"\("tenant_id", "supersedes"\)/,
    );
    expect(moduleMigration).toMatch(
      /CREATE UNIQUE INDEX "cost_price_entries_tenant_id_work_order_id_record_id_task_line_id_key" ON "cost_price_entries"\("tenant_id", "work_order_id", "record_id", "task_line_id"\)/,
    );
    expect(moduleMigration).not.toMatch(/ROW LEVEL SECURITY/);
  });
});
