/**
 * U3 attachment 附件中心三面守恒（A13 文件管理：统一附件元数据单表）：
 * 不依赖活库 / prisma generate——schema 列面、RLS 补登、迁移建表三向一致。
 * 模式同 issue-module.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026150000_attachment_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('attachments schema 列面（U3）', () => {
  it('存储引用三字段 + bizType/bizId 挂取键 + 逻辑删除；不套证据公共列；无 UNIQUE（文档禁 UNIQUE 索引）', () => {
    const block = modelBlock('AttachmentRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/fileName\s+String\s+@map\("file_name"\)/);
    expect(block).toMatch(/contentType\s+String\?\s+@map\("content_type"\)/);
    expect(block).toMatch(/storageKind\s+String\s+@map\("storage_kind"\)/);
    expect(block).toMatch(/objectKey\s+String\s+@map\("object_key"\)/);
    expect(block).toMatch(/fileUrl\s+String\?\s+@map\("file_url"\)/);
    expect(block).toMatch(/bizType\s+String\s+@map\("biz_type"\)/);
    expect(block).toMatch(/bizId\s+String\s+@map\("biz_id"\)/);
    expect(block).toMatch(/createdBy\s+String\?\s+@map\("created_by"\)/);
    expect(block).toMatch(/deletedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)\s+@map\("deleted_at"\)/);
    // 列表热路径：租户前导 + bizId + createdAt DESC（排序合同）
    expect(block).toContain('@@index([tenantId, bizId, createdAt(sort: Desc)])');
    expect(block).toContain('@@map("attachments")');
    expect(block).not.toContain('@@unique'); // 文档书写注意：禁止 UNIQUE 索引（同 biz_id 允许多条追加）
    expect(block).not.toContain('supersedes'); // 运营元数据：无修正链
    expect(block).not.toContain('objectVersion');
  });
});

describe('attachments RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含 attachments（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('attachments')).toBe(true);
  });
});

describe('attachments 建表迁移（20261026150000）', () => {
  it('单表 CREATE TABLE + biz 列表索引；RLS 语句不在建表迁移（归 150100 重放迁移）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "attachments"/);
    expect(moduleMigration).toContain(
      'CREATE INDEX "attachments_tenant_id_biz_id_created_at_idx" ON "attachments"("tenant_id", "biz_id", "created_at" DESC)',
    );
    // 存储引用三列 + 挂取键 + 逻辑删除列落库
    for (const column of [
      '"storage_kind" TEXT NOT NULL',
      '"target" TEXT NOT NULL',
      '"object_key" TEXT NOT NULL',
      '"biz_type" TEXT NOT NULL',
      '"biz_id" TEXT NOT NULL',
      '"deleted_at" TIMESTAMPTZ(6)',
    ]) {
      expect(moduleMigration).toContain(column);
    }
    // 文档 §1.3：索引仅普通索引，禁止 UNIQUE
    expect(moduleMigration).not.toMatch(/CREATE UNIQUE INDEX "attachments/);
    expect(moduleMigration).not.toMatch(/ROW LEVEL SECURITY/); // RLS 归 150100 重放迁移
  });
});
