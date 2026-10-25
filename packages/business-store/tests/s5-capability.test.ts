/**
 * T 波 S5 能力子集三面守恒（#98/99 菜单 / #102 审批配置 / #101 通知）：
 * 不依赖活库 / prisma generate——schema 列面、RLS 补登、迁移建表三向一致。
 * 模式同 schema-conformance.test.ts（约定字段块 + 机器守恒）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026130000_s5_capability_module', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('S5 三表 schema 列面（T 波）', () => {
  it('menu_configs：配置集契约列 + 租户内 code 唯一 + JSONB 节点树；不套证据公共列', () => {
    const block = modelBlock('MenuConfigRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/nodes\s+Json/);
    expect(block).toMatch(/active\s+Boolean\s+@default\(true\)/);
    expect(block).toMatch(
      /updatedAt\s+DateTime\s+@default\(now\(\)\)\s+@updatedAt\s+@db\.Timestamptz\(6\)\s+@map\("updated_at"\)/,
    );
    expect(block).toContain('@@unique([tenantId, code])');
    expect(block).toContain('@@map("menu_configs")');
    expect(block).not.toContain('objectVersion');
    expect(block).not.toContain('supersedes');
  });

  it('approval_flow_configs：flow_id 业务键 + 配置 JSONB + 软停用；不套证据公共列', () => {
    const block = modelBlock('ApprovalFlowConfigRecord');
    expect(block).toMatch(/flowId\s+String\s+@map\("flow_id"\)/);
    expect(block).toMatch(/config\s+Json/);
    expect(block).toMatch(/active\s+Boolean\s+@default\(true\)/);
    expect(block).toContain('@@unique([tenantId, flowId])');
    expect(block).toContain('@@map("approval_flow_configs")');
    expect(block).not.toContain('objectVersion');
    expect(block).not.toContain('supersedes');
  });

  it('notifications：收件人双键前导索引 + 已读时刻可空 + 时间列 timestamptz；不套证据公共列', () => {
    const block = modelBlock('NotificationRecord');
    expect(block).toMatch(/recipientId\s+String\s+@map\("recipient_id"\)/);
    expect(block).toMatch(/readAt\s+DateTime\?\s+@db\.Timestamptz\(6\)\s+@map\("read_at"\)/);
    expect(block).toContain('@@index([tenantId, recipientId, readAt])');
    expect(block).toContain('@@index([tenantId, recipientId, createdAt(sort: Desc)])');
    expect(block).toContain('@@map("notifications")');
    expect(block).not.toContain('objectVersion');
    expect(block).not.toContain('supersedes');
  });
});

describe('S5 三表 RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含三新表（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('menu_configs')).toBe(true);
    expect(names.has('approval_flow_configs')).toBe(true);
    expect(names.has('notifications')).toBe(true);
  });
});

describe('S5 建表迁移（20261026130000）', () => {
  it('三表 CREATE TABLE + 唯一/前导索引齐全；RLS 语句不在建表迁移（归重放迁移）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "menu_configs"/);
    expect(moduleMigration).toMatch(/CREATE TABLE "approval_flow_configs"/);
    expect(moduleMigration).toMatch(/CREATE TABLE "notifications"/);
    expect(moduleMigration).toContain('CREATE UNIQUE INDEX "menu_configs_tenant_id_code_key"');
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "approval_flow_configs_tenant_id_flow_id_key"',
    );
    expect(moduleMigration).toContain(
      'CREATE INDEX "notifications_tenant_id_recipient_id_read_at_idx"',
    );
    expect(moduleMigration).not.toMatch(/ROW LEVEL SECURITY/); // RLS 归 131000 重放迁移
  });
});
