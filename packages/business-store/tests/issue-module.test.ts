/**
 * U1 issue 发料链路五面守恒（A11 增量：发料任务/发料记录）：不依赖活库 /
 * prisma generate——schema 列面、RLS 补登、迁移建表三向一致。模式同
 * s5-capability.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026140000_issue_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('issue 五表 schema 列面（U1）', () => {
  it('issue_tasks：维度拼键唯一 + 汇总推导列 + 触发锚点 JSONB；不套证据公共列', () => {
    const block = modelBlock('IssueTaskRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/taskNo\s+String\s+@map\("task_no"\)/);
    expect(block).toMatch(/dispatchKind\s+String\s+@map\("dispatch_kind"\)/);
    expect(block).toMatch(/rollup\s+Boolean\s+@default\(false\)/);
    expect(block).toMatch(/equipmentRef\s+String\?\s+@map\("equipment_ref"\)/);
    expect(block).toMatch(/dimensionKey\s+String\s+@map\("dimension_key"\)/);
    expect(block).toMatch(/state\s+String/);
    expect(block).toMatch(/objectVersion\s+Int\s+@default\(1\)\s+@map\("object_version"\)/);
    expect(block).toMatch(/operators\s+Json\s+@default\("\[\]"\)/);
    expect(block).toMatch(/triggerRefs\s+Json\s+@default\("\[\]"\)\s+@map\("trigger_refs"\)/);
    expect(block).toMatch(/totalRequiredQty\s+Float\s+@default\(0\)\s+@map\("total_required_qty"\)/);
    expect(block).toMatch(/totalIssuedQty\s+Float\s+@default\(0\)\s+@map\("total_issued_qty"\)/);
    expect(block).toContain('@@unique([tenantId, dimensionKey])');
    expect(block).toContain('@@index([tenantId, state])');
    expect(block).toContain('@@index([tenantId, workOrderId])');
    expect(block).toContain('@@map("issue_tasks")');
    expect(block).not.toContain('supersedes'); // 运营投影：无修正链
  });

  it('issue_task_lines：同步补全幂等锚点 (tenant, task, source_line_id) 唯一 + 行号续排', () => {
    const block = modelBlock('IssueTaskLineRecord');
    expect(block).toMatch(/taskId\s+String\s+@map\("task_id"\)/);
    expect(block).toMatch(/lineNo\s+Int\s+@map\("line_no"\)/);
    expect(block).toMatch(/kind\s+String/);
    expect(block).toMatch(/sourceLineId\s+String\s+@map\("source_line_id"\)/);
    expect(block).toMatch(/itemId\s+String\?\s+@map\("item_id"\)/);
    expect(block).toMatch(/requiredQty\s+Float\s+@map\("required_qty"\)/);
    expect(block).toContain('@@unique([tenantId, taskId, sourceLineId])');
    expect(block).toContain('@@index([tenantId, sourceLineId])');
    expect(block).toContain('@@map("issue_task_lines")');
  });

  it('issue_records：快照 JSONB lines + 撤销态 + 库存联动回滚锚点随载荷；issuedAt 降序索引', () => {
    const block = modelBlock('IssueRecordRecord');
    expect(block).toMatch(/recordNo\s+String\s+@map\("record_no"\)/);
    expect(block).toMatch(/taskId\s+String\s+@map\("task_id"\)/);
    expect(block).toMatch(/lineKind\s+String\s+@map\("line_kind"\)/);
    expect(block).toMatch(/issuedAt\s+DateTime\s+@db\.Timestamptz\(6\)\s+@map\("issued_at"\)/);
    expect(block).toMatch(/expressId\s+String\?\s+@map\("express_id"\)/);
    expect(block).toMatch(/state\s+String\s+@default\("active"\)/);
    expect(block).toMatch(/revokedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)\s+@map\("revoked_at"\)/);
    expect(block).toMatch(/lines\s+Json/);
    expect(block).toContain('@@index([tenantId, taskId])');
    expect(block).toContain('@@index([tenantId, issuedAt(sort: Desc)])');
    expect(block).toContain('@@map("issue_records")');
    expect(block).not.toContain('supersedes');
  });

  it('issue_expresses：发货头元数据 + 图片引用数组默认空；无对象存储依赖列', () => {
    const block = modelBlock('IssueExpressRecord');
    expect(block).toMatch(/trackingNo\s+String\s+@map\("tracking_no"\)/);
    expect(block).toMatch(/shipper\s+String/);
    expect(block).toMatch(/shipTime\s+DateTime\s+@db\.Timestamptz\(6\)\s+@map\("ship_time"\)/);
    expect(block).toMatch(/imageRefs\s+Json\s+@default\("\[\]"\)\s+@map\("image_refs"\)/);
    expect(block).toMatch(/workOrderId\s+String\?\s+@map\("work_order_id"\)/);
    expect(block).toContain('@@index([tenantId, workOrderId, trackingNo])');
    expect(block).toContain('@@map("issue_expresses")');
  });

  it('issue_operations：幂等记账自然主键（租户|operationId 拼键）', () => {
    const block = modelBlock('IssueOperationRecord');
    expect(block).toMatch(/operationKey\s+String\s+@id\s+@map\("operation_key"\)/);
    expect(block).toMatch(/operationId\s+String\s+@map\("operation_id"\)/);
    expect(block).toMatch(/occurredAt\s+DateTime\s+@db\.Timestamptz\(6\)\s+@map\("occurred_at"\)/);
    expect(block).toContain('@@index([tenantId])');
    expect(block).toContain('@@map("issue_operations")');
  });
});

describe('issue 建表迁移 ↔ schema 事实', () => {
  it('五表全部建表 + 维度唯一/同步幂等锚点/撤诈权限索引齐全', () => {
    for (const table of [
      'issue_tasks',
      'issue_task_lines',
      'issue_records',
      'issue_expresses',
      'issue_operations',
    ]) {
      expect(moduleMigration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "issue_tasks_tenant_id_dimension_key_key" ON "issue_tasks"("tenant_id", "dimension_key")',
    );
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "issue_task_lines_tenant_id_task_id_source_line_id_key" ON "issue_task_lines"("tenant_id", "task_id", "source_line_id")',
    );
    expect(moduleMigration).toContain(
      'CREATE INDEX "issue_records_tenant_id_issued_at_idx" ON "issue_records"("tenant_id", "issued_at" DESC)',
    );
    // 状态/进度汇总列落库（refreshSummary 写入面）
    expect(moduleMigration).toContain('"total_required_qty" DOUBLE PRECISION NOT NULL DEFAULT 0');
    expect(moduleMigration).toContain('"state" TEXT NOT NULL DEFAULT \'active\'');
    // 快照载荷列
    expect(moduleMigration).toContain('"lines" JSONB NOT NULL');
    expect(moduleMigration).toContain('"image_refs" JSONB NOT NULL DEFAULT \'[]\'');
  });
});

describe('RLS 补登（U1 issue 五表）', () => {
  it('RLS_TABLES 含 issue 五表', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    for (const table of [
      'issue_tasks',
      'issue_task_lines',
      'issue_records',
      'issue_expresses',
      'issue_operations',
    ]) {
      expect(names.has(table), `RLS_TABLES 应含 ${table}`).toBe(true);
    }
  });
});
