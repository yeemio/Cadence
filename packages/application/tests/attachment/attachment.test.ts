/**
 * 附件中心（U3 A13）测试：对象存储端口两适配器（内存/本地文件——put/签发/
 * 开门面/过期/防篡改）、元数据端口内存实现（租户收口/排序/逻辑删除/原子批）、
 * 用例（文档五接口面行为）、输入解析边界、控制器权限码元数据、模块装配。
 */
import 'reflect-metadata';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { TenantContext } from '../../src/core/tenant-context.js';
import {
  AttachmentConflictError,
  AttachmentInputError,
  AttachmentNotFoundError,
  AttachmentStorageError,
} from '../../src/attachment/attachment-errors.js';
import {
  encodeReadReferenceToken,
  newReadReferenceSigningKey,
  verifyReadReferenceToken,
} from '../../src/attachment/read-reference-tokens.js';
import { InMemoryObjectStorage } from '../../src/attachment/in-memory-object-storage.js';
import {
  LocalFileSystemObjectStorage,
  type LocalFileSystemObjectStorageOptions,
} from '../../src/attachment/local-file-object-storage.js';
import { InMemoryAttachmentStore } from '../../src/attachment/in-memory-attachment-stores.js';
import { AttachmentService } from '../../src/attachment/attachment.service.js';
import { AttachmentController } from '../../src/attachment/attachment.controllers.js';
import { AttachmentModule } from '../../src/attachment/attachment.module.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('user-alice');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function newService(
  options: { ttlSeconds?: number } = {},
): { service: AttachmentService; store: InMemoryAttachmentStore; storage: InMemoryObjectStorage } {
  const store = new InMemoryAttachmentStore();
  const storage = new InMemoryObjectStorage();
  const service = new AttachmentService(store, storage, {
    ...(options.ttlSeconds === undefined ? {} : { downloadTtlSeconds: options.ttlSeconds }),
  });
  return { service, store, storage };
}

describe('只读引用令牌', () => {
  it('encode→verify 往返；过期 → null；篡改载荷 → null；异密钥 → null', () => {
    const key = newReadReferenceSigningKey();
    const otherKey = newReadReferenceSigningKey();
    const claims = {
      tenantId: 't1',
      target: 'memory',
      objectKey: 'upload/2026/10/26/x-a.pdf',
      expiresAtMs: Date.now() + 60_000,
      downloadName: '合同.pdf',
      contentType: 'application/pdf',
    };
    const token = encodeReadReferenceToken(key, claims);
    expect(verifyReadReferenceToken(key, token, new Date())).toEqual(claims);

    const expired = { ...claims, expiresAtMs: Date.now() - 1 };
    expect(verifyReadReferenceToken(key, encodeReadReferenceToken(key, expired), new Date())).toBeNull();
    expect(verifyReadReferenceToken(otherKey, token, new Date())).toBeNull();

    const [head, payload, sig] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, objectKey: 'other' }), 'utf8').toString('base64url');
    expect(verifyReadReferenceToken(key, `${head}.${tamperedPayload}.${sig}`, new Date())).toBeNull();
    expect(verifyReadReferenceToken(key, 'not-a-token', new Date())).toBeNull();
  });

  it('载荷形状门：tenantId 非字符串（旧形状令牌）→ null（同无效语义）', () => {
    const key = newReadReferenceSigningKey();
    const legacy = { target: 'memory', objectKey: 'upload/x', expiresAtMs: Date.now() + 60_000, downloadName: 'a', contentType: null };
    const legacyToken = encodeReadReferenceToken(key, legacy as unknown as Parameters<typeof encodeReadReferenceToken>[1]);
    expect(verifyReadReferenceToken(key, legacyToken, new Date())).toBeNull();

    const wrongType = encodeReadReferenceToken(key, {
      target: 'memory', objectKey: 'upload/x', expiresAtMs: Date.now() + 60_000, downloadName: 'a', contentType: null,
      tenantId: 123 as unknown as string,
    });
    expect(verifyReadReferenceToken(key, wrongType, new Date())).toBeNull();
  });
});

describe('对象存储端口：内存适配器', () => {
  it('put 生成 upload/日期对象键；签发引用携带 TTL/过期点；开门面往返取回字节与下载名', async () => {
    const storage = new InMemoryObjectStorage({ target: 'mem-a' });
    const ref = await storage.put(t1, { fileName: 'a.pdf', contentType: 'application/pdf', bytes: PDF_BYTES });
    expect(ref.storageKind).toBe('memory');
    expect(ref.target).toBe('mem-a');
    expect(ref.objectKey).toMatch(/^upload\/\d{4}\/\d{2}\/\d{2}\/.+$/);
    expect(ref.objectKey.endsWith('-a.pdf')).toBe(true);

    const reference = await storage.issueReadReference(t1, ref, { ttlSeconds: 60, downloadName: '合同.pdf' });
    expect(reference.expiresInSeconds).toBe(60);
    expect(new Date(reference.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(reference.url).toMatch(/^\/attachment\/storage\/v1\./);

    const token = reference.url.split('/').pop()!;
    const resolved = await storage.resolveReadReference(t1, token);
    expect(resolved).not.toBeNull();
    expect(Buffer.from(resolved!.bytes).toString('latin1')).toBe('%PDF-1');
    expect(resolved!.contentType).toBe('application/pdf');
    expect(resolved!.downloadName).toBe('合同.pdf');
  });

  it('签发不存在的对象 → AttachmentStorageError；无效/异实例令牌开门 → null', async () => {
    const storage = new InMemoryObjectStorage();
    await expect(
      storage.issueReadReference(t1, { storageKind: 'memory', target: 'memory', objectKey: 'upload/x' }, { ttlSeconds: 60 }),
    ).rejects.toThrow(AttachmentStorageError);
    expect(await storage.resolveReadReference(t1, 'v1.bogus.bogus')).toBeNull();

    const other = new InMemoryObjectStorage(); // 异实例（异密钥/异目标）
    const ref = await other.put(t1, { fileName: 'b.pdf', bytes: PDF_BYTES });
    const reference = await other.issueReadReference(t1, ref, { ttlSeconds: 60 });
    const token = reference.url.split('/').pop()!;
    expect(await storage.resolveReadReference(t1, token)).toBeNull();
  });

  it('令牌绑定租户（D-4）：t1 签发 t2 兑现 → null；t1 兑现 → 正常取回', async () => {
    const storage = new InMemoryObjectStorage();
    const ref = await storage.put(t1, { fileName: 'a.pdf', contentType: 'application/pdf', bytes: PDF_BYTES });
    const reference = await storage.issueReadReference(t1, ref, { ttlSeconds: 60, downloadName: 'a.pdf' });
    const token = reference.url.split('/').pop()!;
    expect(await storage.resolveReadReference(t2, token)).toBeNull(); // 跨租户 → 同无效语义
    const resolved = await storage.resolveReadReference(t1, token);
    expect(resolved).not.toBeNull();
    expect([...resolved!.bytes]).toEqual([...PDF_BYTES]);
  });
});

describe('对象存储端口：本地文件适配器', () => {
  const roots: string[] = [];

  function newLocalStorage(overrides: Partial<LocalFileSystemObjectStorageOptions> = {}): LocalFileSystemObjectStorage {
    return new LocalFileSystemObjectStorage({ rootDirectory: 'unused', ...overrides });
  }

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it('put 落盘对象键路径；签发→开门面往返取回字节（内容类型随 sidecar）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cadence-attachment-'));
    roots.push(root);
    const storage = newLocalStorage({ rootDirectory: root });
    expect((await storage.currentTarget(t1)).storageKind).toBe('local-fs');

    const ref = await storage.put(t1, { fileName: '图.png', contentType: 'image/png', bytes: PDF_BYTES });
    const onDisk = await readFile(join(root, ...ref.objectKey.split('/')));
    expect([...onDisk]).toEqual([...PDF_BYTES]);

    const reference = await storage.issueReadReference(t1, ref, { ttlSeconds: 60, downloadName: '图纸.png' });
    const resolved = await storage.resolveReadReference(t1, reference.url.split('/').pop()!);
    expect(resolved!.contentType).toBe('image/png');
    expect(resolved!.downloadName).toBe('图纸.png');
    expect([...resolved!.bytes]).toEqual([...PDF_BYTES]);
  });

  it('对象键越界（../ 穿越段）→ AttachmentStorageError（路径安全双保险）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cadence-attachment-'));
    roots.push(root);
    const storage = newLocalStorage({ rootDirectory: root });
    await expect(
      storage.issueReadReference(
        t1,
        { storageKind: 'local-fs', target: 'local', objectKey: 'upload/../../escape.txt' },
        { ttlSeconds: 60 },
      ),
    ).rejects.toThrow(AttachmentStorageError);
  });

  it('令牌绑定租户（D-4）：t1 签发 t2 兑现 → null；t1 兑现 → 正常取回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cadence-attachment-'));
    roots.push(root);
    const storage = newLocalStorage({ rootDirectory: root });
    const ref = await storage.put(t1, { fileName: 'a.pdf', contentType: 'application/pdf', bytes: PDF_BYTES });
    const reference = await storage.issueReadReference(t1, ref, { ttlSeconds: 60, downloadName: 'a.pdf' });
    const token = reference.url.split('/').pop()!;
    expect(await storage.resolveReadReference(t2, token)).toBeNull(); // 跨租户 → 同无效语义
    const resolved = await storage.resolveReadReference(t1, token);
    expect(resolved).not.toBeNull();
    expect([...resolved!.bytes]).toEqual([...PDF_BYTES]);
  });
});

describe('元数据端口（内存实现先行）', () => {
  it('listByBizId 按 (tenant, bizId) 收口、过滤已删；序 = createdAt DESC + id ASC', async () => {
    const store = new InMemoryAttachmentStore();
    const first = await store.create(saveInput({ fileName: 'a.pdf' }));
    const second = await store.create(saveInput({ fileName: 'b.pdf' }));
    await store.create({ ...saveInput({ fileName: '他biz.pdf' }), bizId: 'biz-other' });
    await store.create({ ...saveInput({ fileName: '他租户.pdf' }), tenant: t2 });

    const rows = await store.listByBizId(t1, 'biz-1');
    const expected = [first, second].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1),
    );
    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));

    await store.softDelete(t1, [second.id], '2026-10-26T12:00:00.000Z');
    expect((await store.listByBizId(t1, 'biz-1')).map((row) => row.id)).toEqual([first.id]);
    expect((await store.findById(t1, second.id))?.deletedAt).toBe('2026-10-26T12:00:00.000Z'); // findById 含已删
  });

  it('softDelete 只置有效行、返回实际置删 id、幂等', async () => {
    const store = new InMemoryAttachmentStore();
    const a = await store.create(saveInput({ fileName: 'a.pdf' }));
    const b = await store.create(saveInput({ fileName: 'b.pdf' }));
    const first = await store.softDelete(t1, [a.id, 'ghost'], '2026-10-26T12:00:00.000Z');
    expect(first).toEqual([a.id]);
    const second = await store.softDelete(t1, [a.id, b.id], '2026-10-26T13:00:00.000Z');
    expect(second).toEqual([b.id]); // 已删不重复置删
    const cross = await store.softDelete(t2, [b.id], '2026-10-26T14:00:00.000Z');
    expect(cross).toEqual([]); // 跨租户不可见
  });

  function saveInput(overrides: Partial<Parameters<InMemoryAttachmentStore['create']>[0]> = {}) {
    return {
      tenant: t1,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      storageKind: 'memory',
      target: 'memory',
      objectKey: 'upload/2026/10/26/x-a.pdf',
      bizType: 'workorder',
      bizId: 'biz-1',
      createdBy: alice,
      ...overrides,
    };
  }
});

describe('用例：上传（字节经端口 put）', () => {
  it('upload 落元数据行且 VO 不下发存储三字段；对象真实入端口', async () => {
    const { service, storage } = newService();
    const view = await service.upload(t1, alice, {
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(PDF_BYTES),
      bizType: 'workorder',
      bizId: 'wo-1',
    });
    expect(view.fileName).toBe('a.pdf');
    expect(view.bizType).toBe('workorder');
    expect(view.createdBy).toBe('user-alice');
    expect(view).not.toHaveProperty('storageKind');
    expect(view).not.toHaveProperty('objectKey');
    expect(view).not.toHaveProperty('target');

    // 端口侧确有字节（经下载引用可取回）
    const reference = await service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-1' });
    const resolved = await service.resolveReadReference(t1, reference.url.split('/').pop()!);
    expect([...resolved.bytes]).toEqual([...PDF_BYTES]);
  });

  it('upload 输入边界：缺 fileName / 非法 base64 / 非法 bizType / 超 32MiB 护栏 → AttachmentInputError', async () => {
    const { service } = newService();
    await expect(service.upload(t1, alice, { contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1' })).rejects.toThrow(AttachmentInputError);
    await expect(
      service.upload(t1, alice, { fileName: 'a.pdf', contentBase64: '!!!', bizType: 'workorder', bizId: 'wo-1' }),
    ).rejects.toThrow(AttachmentInputError);
    await expect(
      service.upload(t1, alice, { fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'Workorder', bizId: 'wo-1' }),
    ).rejects.toThrow(AttachmentInputError);
    await expect(
      service.upload(t1, alice, {
        fileName: 'big.bin',
        contentBase64: 'A'.repeat(Math.ceil((32 * 1024 * 1024 + 1024) / 3) * 4), // 解码后 > 32MiB 护栏
        bizType: 'workorder',
        bizId: 'wo-1',
      }),
    ).rejects.toThrow(AttachmentInputError);
  });
});

describe('用例：登记挂取（save / save-batch，文档二.2/二.3）', () => {
  it('save：target 服务端按端口当前目标写入（调用方不传）；storageKind/objectKey 取调用方', async () => {
    const { service, store } = newService();
    const view = await service.save(t1, alice, {
      fileName: '外传.pdf',
      storageKind: 'memory',
      objectKey: 'upload/2026/10/26/ext-1.pdf',
      bizType: 'purchase-order',
      bizId: 'po-9',
    });
    const record = await store.findById(t1, view.id);
    expect(record?.target).toBe('memory'); // 端口当前目标
    expect(record?.storageKind).toBe('memory');
    expect(record?.fileUrl).toBeNull();
  });

  it('save-batch：≥1 条、逐条校验、整批原子（任一条非法零落行）、顺序一致', async () => {
    const { service } = newService();
    const views = await service.saveBatch(t1, alice, [
      { fileName: '1.pdf', storageKind: 'memory', objectKey: 'upload/x/1.pdf', bizType: 'workorder', bizId: 'wo-1' },
      { fileName: '2.pdf', storageKind: 'memory', objectKey: 'upload/x/2.pdf', bizType: 'workorder', bizId: 'wo-1' },
    ]);
    expect(views.map((view) => view.fileName)).toEqual(['1.pdf', '2.pdf']);

    await expect(
      service.saveBatch(t1, alice, [
        { fileName: '3.pdf', storageKind: 'memory', objectKey: 'upload/x/3.pdf', bizType: 'workorder', bizId: 'wo-2' },
        { fileName: '', storageKind: 'memory', objectKey: 'upload/x/4.pdf', bizType: 'workorder', bizId: 'wo-2' },
      ]),
    ).rejects.toThrow(/第 2 条/);
    expect(await service.listByBizId(t1, 'wo-2')).toEqual([]); // 整批零落行

    await expect(service.saveBatch(t1, alice, [])).rejects.toThrow(AttachmentInputError);
  });

  it('listByBizId：仅按 bizId 过滤（不按 bizType——文档二.1）；同 bizId 多条追加共存', async () => {
    const { service } = newService();
    await service.upload(t1, alice, { fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'same-id' });
    await service.upload(t1, alice, { fileName: 'b.pdf', contentBase64: b64(PDF_BYTES), bizType: 'purchase-order', bizId: 'same-id' });
    const rows = await service.listByBizId(t1, 'same-id');
    expect(rows).toHaveLength(2); // 跨 bizType 共存（bizId 全局唯一由业务侧 id 生成保证）
  });
});

describe('用例：删除与下载引用（文档二.4/二.5）', () => {
  it('remove：逗号分隔多 id、返回实际置删、逻辑删后列表/引用不可见、幂等', async () => {
    const { service } = newService();
    const a = await service.upload(t1, alice, { fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1' });
    const b = await service.upload(t1, alice, { fileName: 'b.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1' });

    const first = await service.remove(t1, { ids: `${a.id},${b.id},ghost` });
    expect(first.removedIds).toEqual([a.id, b.id]);
    const second = await service.remove(t1, { ids: `${a.id},${b.id}` });
    expect(second.removedIds).toEqual([]); // 幂等
    expect(await service.listByBizId(t1, 'wo-1')).toEqual([]);
    await expect(service.issueDownloadReference(t1, { id: a.id, bizId: 'wo-1' })).rejects.toThrow(
      AttachmentNotFoundError, // 预签名拒绝已删（文档 1.4）
    );
  });

  it('issueDownloadReference：默认 TTL 60 秒、downloadName 缺省用 file_name、url/过期点齐备', async () => {
    const { service } = newService();
    const view = await service.upload(t1, alice, {
      fileName: '合同.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(PDF_BYTES),
      bizType: 'purchase-order',
      bizId: 'po-1',
    });
    const reference = await service.issueDownloadReference(t1, { id: view.id, bizId: 'po-1' });
    expect(reference.expiresInSeconds).toBe(60); // 文档 1.6 参数表默认
    expect(reference.downloadName).toBe('合同.pdf');
    expect(reference.url).toMatch(/^\/attachment\/storage\//);
    expect(new Date(reference.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const named = await service.issueDownloadReference(t1, { id: view.id, bizId: 'po-1', downloadName: '采购申请合同' });
    expect(named.downloadName).toBe('采购申请合同'); // 文档：可传业务语义名
  });

  it('TTL 模块配置：合法覆盖（120）、非法回退 60（文档：未配置或非法回退 60 秒）', async () => {
    const custom = newService({ ttlSeconds: 120 });
    const view = await custom.service.upload(t1, alice, {
      fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    expect((await custom.service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-1' })).expiresInSeconds).toBe(120);

    const broken = new AttachmentService(new InMemoryAttachmentStore(), new InMemoryObjectStorage(), {
      downloadTtlSeconds: Number.NaN,
    });
    const brokenView = await broken.upload(t1, alice, {
      fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    expect((await broken.issueDownloadReference(t1, { id: brokenView.id, bizId: 'wo-1' })).expiresInSeconds).toBe(60);
  });

  it('bizId 不一致 → Conflict；不存在/跨租户 → NotFound（不泄漏存在性）', async () => {
    const { service } = newService();
    const view = await service.upload(t1, alice, {
      fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    await expect(service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-OTHER' })).rejects.toThrow(
      AttachmentConflictError,
    );
    await expect(service.issueDownloadReference(t1, { id: 'ghost', bizId: 'wo-1' })).rejects.toThrow(
      AttachmentNotFoundError,
    );
    await expect(service.issueDownloadReference(t2, { id: view.id, bizId: 'wo-1' })).rejects.toThrow(
      AttachmentNotFoundError,
    );
  });

  it('开门面：有效令牌取回字节；乱串 → NotFound', async () => {
    const { service } = newService();
    const view = await service.upload(t1, alice, {
      fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    const reference = await service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-1' });
    const resolved = await service.resolveReadReference(t1, reference.url.split('/').pop()!);
    expect([...resolved.bytes]).toEqual([...PDF_BYTES]);
    await expect(service.resolveReadReference(t1, 'v1.junk.junk')).rejects.toThrow(AttachmentNotFoundError);
  });

  it('开门面租户绑定（D-4）：A 租户令牌在 B 租户兑现 → NotFound（同既有无效语义）；同租户行为不变', async () => {
    const { service } = newService();
    const view = await service.upload(t1, alice, {
      fileName: 'a.pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    const reference = await service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-1' });
    const token = reference.url.split('/').pop()!;
    const resolved = await service.resolveReadReference(t1, token);
    expect([...resolved.bytes]).toEqual([...PDF_BYTES]); // 同租户：行为不变
    await expect(service.resolveReadReference(t2, token)).rejects.toThrow(AttachmentNotFoundError); // 跨租户：同无效语义
    await expect(service.resolveReadReference(t1, token)).resolves.toBeTruthy(); // 拒绝不影响原租户继续兑现
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('attachment 路由：读面 attachment:read；写面 attachment:write；开门面无权限码（令牌即凭证）', () => {
    expect(routePermissions(AttachmentController, 'upload')).toBe('attachment:write');
    expect(routePermissions(AttachmentController, 'save')).toBe('attachment:write');
    expect(routePermissions(AttachmentController, 'saveBatch')).toBe('attachment:write');
    expect(routePermissions(AttachmentController, 'remove')).toBe('attachment:write');
    expect(routePermissions(AttachmentController, 'listByBizId')).toBe('attachment:read');
    expect(routePermissions(AttachmentController, 'downloadReference')).toBe('attachment:read');
    expect(routePermissions(AttachmentController, 'openStorage')).toBeUndefined();
  });

  it('AttachmentModule.register 装配控制器（缺省内存存储/内存对象存储）', () => {
    const dynamic = AttachmentModule.register();
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, dynamic) as unknown[];
    expect(dynamic.module).toBe(AttachmentModule);
    expect(controllers).toContain(AttachmentController);
  });

  it('openStorage 经 TenantContext 取租户并回 StreamableFile（disposition 承载 downloadName）', async () => {
    const store = new InMemoryAttachmentStore();
    const storage = new InMemoryObjectStorage();
    const service = new AttachmentService(store, storage);
    const tenantContext = new TenantContext();
    const controller = new AttachmentController(tenantContext, service);
    const view = await service.upload(t1, alice, {
      fileName: '合同.pdf', contentType: 'application/pdf', contentBase64: b64(PDF_BYTES), bizType: 'workorder', bizId: 'wo-1',
    });
    const reference = await service.issueDownloadReference(t1, { id: view.id, bizId: 'wo-1' });
    const token = reference.url.split('/').pop()!;

    // 兑现租户取自 TenantContext（ALS）——同租户上下文内取回（真实请求流等价物）
    const streamable = await tenantContext.run(t1, () => controller.openStorage(token));
    expect(streamable).toBeInstanceOf(Object);
    expect(streamable.getHeaders()).toMatchObject({ type: 'application/pdf' });
    expect(streamable.getHeaders().disposition).toContain(encodeURIComponent('合同.pdf'));

    // D-4：同一令牌换到其他租户上下文（换 Host 形态）兑现 → 同既有无效 token 语义拒绝
    await expect(tenantContext.run(t2, () => controller.openStorage(token))).rejects.toThrow(AttachmentNotFoundError);
    await expect(tenantContext.run(t1, () => controller.openStorage('v1.junk.junk'))).rejects.toThrow(AttachmentNotFoundError);
  });
});
