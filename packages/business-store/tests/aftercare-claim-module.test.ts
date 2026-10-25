/**
 * U5 aftercare claim 售后报销三面守恒（A12：一单一投影 + 明细行两表）：
 * 不依赖活库 / prisma generate——schema 列面、RLS 补登、迁移建表三向一致。
 * 模式同 attachment-module.test.ts / issue-module.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026160500_aftercare_claim_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('aftercare_claims schema 列面（U5）', () => {
  it('报销单投影：一单一报销（(tenant, dispatch) 唯一）+ 乐观版本；不套证据公共列', () => {
    const block = modelBlock('AftercareClaimRecord');
    expect(block).toMatch(/id\s+String\s+@id @default\(uuid\(7\)\)/);
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/dispatchId\s+String\s+@map\("dispatch_id"\)/);
    expect(block).toMatch(/objectVersion\s+Int\s+@default\(1\) @map\("object_version"\)/);
    // 一单一报销 = DB 兜底唯一（「该派工单已存在报销记录，请直接编辑」）
    expect(block).toContain('@@unique([tenantId, dispatchId])');
    expect(block).toContain('@@map("aftercare_claims")');
    // 版本化运营数据：不套证据公共列（取舍同 outsourcing_lines）
    expect(block).not.toContain('supersedes');
    expect(block).not.toContain('auditStatus');
  });
});

describe('aftercare_claim_lines schema 列面（U5）', () => {
  it('明细行：身份快照四列冻结 + 四费默认 0 + 明细键 reportId 单内唯一；无独立行版本', () => {
    const block = modelBlock('AftercareClaimLineRecord');
    expect(block).toMatch(/claimId\s+String\s+@map\("claim_id"\)/);
    expect(block).toMatch(/lineNo\s+Int\s+@map\("line_no"\)/);
    expect(block).toMatch(/reportId\s+String\s+@map\("report_id"\)/);
    expect(block).toMatch(/reportDate\s+DateTime\s+@db\.Timestamptz\(6\) @map\("report_date"\)/);
    expect(block).toMatch(/worker\s+String/);
    expect(block).toMatch(/approvedBy\s+String\?\s+@map\("approved_by"\)/);
    expect(block).toMatch(/approvedMinutes\s+Int\s+@map\("approved_minutes"\)/);
    // 四类费用（食宿/交通/加班/其他）：未填默认 0 落库
    expect(block).toMatch(/lodgingMinor\s+Int\s+@default\(0\) @map\("lodging_minor"\)/);
    expect(block).toMatch(/trafficMinor\s+Int\s+@default\(0\) @map\("traffic_minor"\)/);
    expect(block).toMatch(/overtimeMinor\s+Int\s+@default\(0\) @map\("overtime_minor"\)/);
    expect(block).toMatch(/otherMinor\s+Int\s+@default\(0\) @map\("other_minor"\)/);
    expect(block).toMatch(/remark\s+String\?/);
    // 行号唯一 + 明细键唯一（report_id）；租户前导复合索引（RLS 索引前导同源）
    expect(block).toContain('@@unique([tenantId, claimId, lineNo])');
    expect(block).toContain('@@unique([tenantId, claimId, reportId])');
    expect(block).toContain('@@index([tenantId, claimId])');
    expect(block).toContain('@@map("aftercare_claim_lines")');
    // 行无独立版本（随报销单 updateFees 批量推进）
    expect(block).not.toContain('objectVersion');
    // 小计/合计读面计算——不落冗余列
    expect(block).not.toContain('totalMinor');
  });
});

describe('aftercare claim RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含两表（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('aftercare_claims')).toBe(true);
    expect(names.has('aftercare_claim_lines')).toBe(true);
  });
});

describe('aftercare claim 建表迁移（20261026160500）', () => {
  it('两表 CREATE TABLE + 唯一/复合索引；RLS 语句不在建表迁移（归 161000 重放迁移）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "aftercare_claims"/);
    expect(moduleMigration).toMatch(/CREATE TABLE "aftercare_claim_lines"/);
    // 一单一报销唯一 + 明细键/行号唯一 + 行集读取索引
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "aftercare_claims_tenant_id_dispatch_id_key" ON "aftercare_claims"("tenant_id", "dispatch_id")',
    );
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "aftercare_claim_lines_tenant_id_claim_id_report_id_key" ON "aftercare_claim_lines"("tenant_id", "claim_id", "report_id")',
    );
    expect(moduleMigration).toContain(
      'CREATE INDEX "aftercare_claim_lines_tenant_id_claim_id_idx" ON "aftercare_claim_lines"("tenant_id", "claim_id")',
    );
    // 四费 NOT NULL DEFAULT 0（未填默认 0 落库）
    expect(moduleMigration).toMatch(/"lodging_minor" INTEGER NOT NULL DEFAULT 0/);
    expect(moduleMigration).toMatch(/"other_minor" INTEGER NOT NULL DEFAULT 0/);
    // 建表迁移不混入 RLS 语句（全表策略归全量重放迁移）
    expect(moduleMigration).not.toContain('ROW LEVEL SECURITY');
  });
});
