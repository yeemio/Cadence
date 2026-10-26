/**
 * fix-wave-4 W4-2（D-3）attachment_objects 三面守恒 + PgObjectStorage 桩单测。
 * 不依赖活库（模式同 attachment-module.test.ts / rls-session.test.ts）：
 *  - 守恒面：schema 列面 ↔ 建表迁移 ↔ RLS_TABLES 清单（机器守恒主线在
 *    rls-conformance / schema-conformance，此处锚定本表的关键列与索引）；
 *  - 适配器面：桩表驱动（真实表语义的可见子集——tenantId 过滤 + select
 *    列裁剪 + object_key 唯一），容器级贯通（上传→restart→下载）归总控
 *    统一复证（W4-2 合同"容器复证"节）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import {
  AttachmentStorageError,
  MAX_UPLOAD_BYTES,
  verifyReadReferenceToken,
} from '@smes/application';
import {
  connectAttachmentObjectStorage,
  PG_STORAGE_KIND,
  PgObjectStorage,
} from '../src/attachment/pg-object-storage.js';
import { RLS_TABLES } from '../src/rls/tables.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');
const moduleMigration = readFileSync(
  join(packageRoot, 'prisma', 'migrations', '20261026180000_attachment_objects', 'migration.sql'),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText);
  expect(match, `model ${name} 应存在于 schema.prisma`).not.toBeNull();
  return match![1]!;
}

describe('attachment_objects schema 列面（W4-2）', () => {
  it('bytea 字节列 + 租户 + 库内唯一对象键 + contentType；租户前导索引；无逻辑删除面', () => {
    const block = modelBlock('AttachmentObjectRecord');
    expect(block).toMatch(/tenantId\s+String\s+@map\("tenant_id"\)/);
    expect(block).toMatch(/objectKey\s+String\s+@unique\s+@map\("object_key"\)/);
    expect(block).toMatch(/bytes\s+Bytes/); // PG bytea（Prisma Bytes 仓内首例）
    expect(block).toMatch(/contentType\s+String\?\s+@map\("content_type"\)/);
    expect(block).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(6\)\s+@map\("created_at"\)/);
    // 查取热路径：租户前导 + object_key（存在性验证/兑现）
    expect(block).toContain('@@index([tenantId, objectKey])');
    expect(block).toContain('@@map("attachment_objects")');
    expect(block).not.toContain('deletedAt'); // put 追加无删除面；逻辑删除归元数据表
    expect(block).not.toContain('bizType'); // 挂取键归元数据表，字节表零业务字段
  });
});

describe('attachment_objects RLS 补登（ADR-0005 全表覆盖）', () => {
  it('RLS_TABLES 含 attachment_objects（tenant_id 谓词列）', () => {
    const names = new Set(RLS_TABLES.map((table) => table.name));
    expect(names.has('attachment_objects')).toBe(true);
  });
});

describe('attachment_objects 建表迁移（20261026180000）', () => {
  it('BYTEA 列 + 对象键唯一索引 + 租户前导索引；RLS 语句不在建表迁移（归 180100 重放）', () => {
    expect(moduleMigration).toMatch(/CREATE TABLE "attachment_objects"/);
    expect(moduleMigration).toContain('"bytes" BYTEA NOT NULL');
    expect(moduleMigration).toContain('"tenant_id" TEXT NOT NULL');
    expect(moduleMigration).toContain(
      'CREATE UNIQUE INDEX "attachment_objects_object_key_key" ON "attachment_objects"("object_key")',
    );
    expect(moduleMigration).toContain(
      'CREATE INDEX "attachment_objects_tenant_id_object_key_idx" ON "attachment_objects"("tenant_id", "object_key")',
    );
    expect(moduleMigration).not.toMatch(/ROW LEVEL SECURITY/); // RLS 归 180100 重放迁移
  });
});

// ---------------------------------------------------------------------------
// 桩表：attachment_objects 的可见子集（tenantId 过滤 = RLS 谓词端口层等价物；
// select 列裁剪 = 证 R4 签发不读字节列；object_key 唯一 = 迁移 UNIQUE 索引）。
// ---------------------------------------------------------------------------

interface StubRow {
  readonly id: string;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

interface FindFirstArgs {
  readonly where: { readonly tenantId: string; readonly objectKey: string };
  readonly select?: Readonly<Record<string, boolean>>;
}

interface CreateArgs {
  readonly data: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string | null;
  };
}

class StubAttachmentObjectTable {
  readonly rows: StubRow[] = [];
  readonly calls: { readonly op: 'create' | 'findFirst'; readonly args: unknown }[] = [];

  /** 新"连接"（同库新客户端——跨实例持久性等价物测试用它模拟重启后新进程）。 */
  client(): PrismaClient {
    const table = this;
    return {
      attachmentObjectRecord: {
        async create(args: CreateArgs): Promise<StubRow> {
          table.calls.push({ op: 'create', args });
          if (table.rows.some((row) => row.objectKey === args.data.objectKey)) {
            throw new Error(`stub: object_key 唯一冲突 ${args.data.objectKey}`);
          }
          const row: StubRow = {
            id: `row-${table.rows.length + 1}`,
            tenantId: args.data.tenantId,
            objectKey: args.data.objectKey,
            bytes: args.data.bytes,
            contentType: args.data.contentType,
          };
          table.rows.push(row);
          return { ...row };
        },
        async findFirst(args: FindFirstArgs): Promise<unknown> {
          table.calls.push({ op: 'findFirst', args });
          // tenantId 必须命中——端口 where 与 RLS 谓词的双保险可见子集
          const hit =
            table.rows.find(
              (row) => row.tenantId === args.where.tenantId && row.objectKey === args.where.objectKey,
            ) ?? null;
          if (hit === null) return null;
          // select 列裁剪：不含 bytes 则不回字节列（签发路径证 R4）
          if (args.select !== undefined && args.select['bytes'] !== true) {
            return { contentType: hit.contentType };
          }
          return { bytes: hit.bytes, contentType: hit.contentType };
        },
      },
    } as unknown as PrismaClient;
  }
}

const T_A = TenantId.create('tenant-a');
const T_B = TenantId.create('tenant-b');
/** 显式密钥（测试可解令牌 claims；生产形态随机轮换，见适配器文件头注）。 */
const SIGNING_KEY = new Uint8Array(32).fill(7);

function adapter(table: StubAttachmentObjectTable): PgObjectStorage {
  return new PgObjectStorage(table.client(), { signingKey: SIGNING_KEY });
}

describe('PgObjectStorage 端口四方法（桩表驱动）', () => {
  it('currentTarget：pg/pg 自述（storageKind/target 同串，预研 §4-1 缺省建议）', async () => {
    const storage = adapter(new StubAttachmentObjectTable());
    expect(await storage.currentTarget(T_A)).toEqual({ storageKind: PG_STORAGE_KIND, target: 'pg' });
  });

  it('put：租户+字节+contentType 落行，对象键 upload/yyyy/mm/dd/<uuid>-<slug> 体例', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = await storage.put(T_A, { fileName: '报告 v1.pdf', contentType: 'application/pdf', bytes });
    expect(ref).toMatchObject({ storageKind: 'pg', target: 'pg' });
    expect(ref.objectKey).toMatch(/^upload\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      tenantId: 'tenant-a',
      objectKey: ref.objectKey,
      contentType: 'application/pdf',
    });
    expect(Buffer.from(table.rows[0]!.bytes)).toEqual(Buffer.from(bytes));
  });

  it('32MiB 护栏：恰 32MiB 过（上界内），超 1 字节拒（AttachmentStorageError 且不触达存储）', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const atLimit = new Uint8Array(MAX_UPLOAD_BYTES); // 32MiB 恰在护栏上（> 才拒）
    const refAtLimit = await storage.put(T_A, { fileName: 'at-limit.bin', bytes: atLimit });
    expect(table.rows).toHaveLength(1);

    const overLimit = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(
      storage.put(T_A, { fileName: 'over.bin', bytes: overLimit }),
    ).rejects.toBeInstanceOf(AttachmentStorageError);
    expect(table.rows).toHaveLength(1); // 未新增行
    expect(table.calls.filter((call) => call.op === 'create')).toHaveLength(1); // 未触达存储
    expect(refAtLimit.objectKey).toMatch(/^upload\//);
  });

  it('issueReadReference：存在即签发——claims 含租户/键/contentType，且 select 不含 bytes（R4：签发不解 TOAST）', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const ref = await storage.put(T_A, { fileName: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array([9, 9]) });
    const reference = await storage.issueReadReference(T_A, ref, { ttlSeconds: 60, downloadName: '展示名.txt' });
    expect(reference.url).toMatch(/^\/attachment\/storage\/v1\./);
    expect(reference.expiresInSeconds).toBe(60);
    const token = reference.url.split('/').pop()!;
    const claims = verifyReadReferenceToken(SIGNING_KEY, token, new Date());
    expect(claims).not.toBeNull();
    expect(claims).toMatchObject({
      tenantId: 'tenant-a',
      target: 'pg',
      objectKey: ref.objectKey,
      downloadName: '展示名.txt',
      contentType: 'text/plain',
    });
    // R4 锚点：签发路径的 findFirst select 显式排除 bytes 列
    const issueCall = table.calls.find((call) => call.op === 'findFirst');
    expect(issueCall).toBeDefined();
    expect((issueCall!.args as FindFirstArgs).select).toEqual({ contentType: true });
  });

  it('issueReadReference：对象不存在 → AttachmentStorageError（502 语义消息形态同既有适配器）', async () => {
    const storage = adapter(new StubAttachmentObjectTable());
    await expect(
      storage.issueReadReference(T_A, { storageKind: 'pg', target: 'pg', objectKey: 'upload/2026/10/26/x-missing.txt' }, { ttlSeconds: 60 }),
    ).rejects.toThrow("对象存储内不存在目标 'pg' 的对象 'upload/2026/10/26/x-missing.txt'");
  });

  it('issueReadReference：非 PG 目标引用（历史遗留 memory 元数据行）→ 明确业务错误不静默串目标', async () => {
    const storage = adapter(new StubAttachmentObjectTable());
    await expect(
      storage.issueReadReference(T_A, { storageKind: 'memory', target: 'memory', objectKey: 'upload/2026/10/26/legacy-a.txt' }, { ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(AttachmentStorageError);
  });

  it('跨租户读拒（端口层 RLS 等价断言）：tenant-a 落的字节，tenant-b 按同键签发即不存在', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const ref = await storage.put(T_A, { fileName: 'secret.txt', bytes: new Uint8Array([1]) });
    await expect(
      storage.issueReadReference(T_B, ref, { ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(AttachmentStorageError); // 同键跨租户不可见（where 恒含 tenantId）
    // 且查取 where 带的是签发租户（tenant-b），非行属租户
    const findCall = table.calls.find((call) => call.op === 'findFirst');
    expect((findCall!.args as FindFirstArgs).where).toEqual({ tenantId: 'tenant-b', objectKey: ref.objectKey });
  });

  it('resolveReadReference：同租户兑现 → 字节+contentType+downloadName', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const ref = await storage.put(T_A, { fileName: 'a.bin', contentType: 'application/octet-stream', bytes: new Uint8Array([7, 7, 7]) });
    const reference = await storage.issueReadReference(T_A, ref, { ttlSeconds: 60, downloadName: 'dl.bin' });
    const token = reference.url.split('/').pop()!;
    const resolved = await storage.resolveReadReference(T_A, token);
    expect(resolved).not.toBeNull();
    expect(Buffer.from(resolved!.bytes)).toEqual(Buffer.from([7, 7, 7]));
    expect(resolved).toMatchObject({ contentType: 'application/octet-stream', downloadName: 'dl.bin' });
  });

  it('resolveReadReference：跨租户兑现旧 token → null（D-4 同无效语义），且不触达存储', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const ref = await storage.put(T_A, { fileName: 'a.txt', bytes: new Uint8Array([1]) });
    const reference = await storage.issueReadReference(T_A, ref, { ttlSeconds: 60 });
    const token = reference.url.split('/').pop()!;
    const callsBefore = table.calls.length;
    expect(await storage.resolveReadReference(T_B, token)).toBeNull();
    expect(table.calls.length).toBe(callsBefore); // 租户比对前置，无存储查询
  });

  it('resolveReadReference：过期/篡改 token → null（不区分原因）', async () => {
    const storage = adapter(new StubAttachmentObjectTable());
    expect(await storage.resolveReadReference(T_A, 'garbage')).toBeNull();
    expect(await storage.resolveReadReference(T_A, 'v1.e30.x')).toBeNull(); // 结构非法
  });

  it('resolveReadReference：对象已被清理（行不在）→ null', async () => {
    const table = new StubAttachmentObjectTable();
    const storage = adapter(table);
    const ref = await storage.put(T_A, { fileName: 'gone.txt', bytes: new Uint8Array([2]) });
    const reference = await storage.issueReadReference(T_A, ref, { ttlSeconds: 60 });
    table.rows.length = 0; // 模拟对象行被清理
    expect(await storage.resolveReadReference(T_A, reference.url.split('/').pop()!)).toBeNull();
  });

  it('持久性等价物（跨实例）：实例 A put → 新实例 B（新客户端新密钥）按元数据引用签发并读回同字节', async () => {
    // 重启等价：PG 形态下字节随库存活——新进程 = 新适配器实例 + 新签发密钥，
    // 元数据行的 (storageKind/target/objectKey) 三字段跨实例有效；token 由
    // 新实例重新签发（旧 token 随密钥轮换失效，与短时 TTL 语义一致）
    const table = new StubAttachmentObjectTable();
    const instanceA = new PgObjectStorage(table.client()); // 随机密钥
    const ref = await instanceA.put(T_A, { fileName: 'persist.txt', contentType: 'text/plain', bytes: new Uint8Array([4, 2]) });

    const instanceB = new PgObjectStorage(table.client()); // 同库新客户端 = 重启后新进程
    expect(await instanceB.currentTarget(T_A)).toEqual({ storageKind: 'pg', target: 'pg' });
    const reference = await instanceB.issueReadReference(T_A, ref, { ttlSeconds: 60, downloadName: 'persist.txt' });
    const resolved = await instanceB.resolveReadReference(T_A, reference.url.split('/').pop()!);
    expect(resolved).not.toBeNull();
    expect(Buffer.from(resolved!.bytes)).toEqual(Buffer.from([4, 2]));
    expect(resolved).toMatchObject({ contentType: 'text/plain', downloadName: 'persist.txt' });
  });

  it('工厂 connectAttachmentObjectStorage：datasourceUrl 惰性构造（不连库）+ handle 形状', () => {
    const handle = connectAttachmentObjectStorage({
      datasourceUrl: 'postgresql://stub:stub@127.0.0.1:5432/stub',
    });
    expect(handle.objectStorage).toBeInstanceOf(PgObjectStorage);
    expect(typeof handle.disconnect).toBe('function');
  });
});
