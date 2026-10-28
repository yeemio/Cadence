/**
 * M2 安全前置批 SP-3（波 b）接线与密钥 round-trip 单测。
 *
 * 覆盖三面（合同「验证」节：组合根传参到位 / key 注入 round-trip）：
 *  1. 组合根传参：buildAppModule({drawingReadReferenceSigner}) →
 *     MODULE_DEFINITIONS.drawing → DrawingHttpModule.register providers 里
 *     DRAWING_READ_REFERENCES 拿到**同一实例**（app-registry 透传链闭合）；
 *     不注入 → 模块内随机密钥实例（缺省行为不变）。
 *  2. 附件域 key round-trip：InMemoryObjectStorage / LocalFileSystemObjectStorage
 *     / PgObjectStorage（stub prisma，无 DB 连接）注入 signingKey 后签发的
 *     token 用同 key verify 通过、异 key 拒绝——证明注入 key 真被用作 HMAC key
 *     （pg-object-storage 的 options 透传修复点）。
 *  3. 图纸域 key round-trip：DrawingReadReferenceSigner 同 key 异实例（= 跨
 *     重启/跨实例）verify 通过、异 key 拒绝。
 *
 * env 解析（格式非法 fail-fast / 未设 warn）与「重启进程后同 URL 仍兑现」的
 * 端到端证据归 deploy/scripts/sp3-signing-key-smoke.mjs（真实进程起停——
 * main.ts 单点 env 读取不进单测导入面）。
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  InMemoryObjectStorage,
  LocalFileSystemObjectStorage,
  verifyReadReferenceToken,
  type ObjectStoragePort,
} from '@smes/application';
import { PgObjectStorage } from '@smes/business-store/attachment';
import { DrawingReadReferenceSigner } from '@smes/drawing';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { DRAWING_READ_REFERENCES, DrawingHttpModule } from '../src/drawing-http.module.js';

const KEY = new Uint8Array(32).fill(0xab);
const OTHER_KEY = new Uint8Array(32).fill(0xcd);

/** 32 字节密钥（SP-3 形状）；HMAC 语义由 token verify 断言，不依赖具体值。 */
function keyOf(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (seed + i * 7) % 256);
}

/** stub prisma：put 触 create、issueReadReference 只触 findFirst（select 显式
 * 排除 bytes 列），零连接零 IO——PgObjectStorage 构造签名 (prisma, options)
 * 的单测面。 */
function stubPrismaReturningRow() {
  return {
    attachmentObjectRecord: {
      create: async () => ({}),
      findFirst: async () => ({ contentType: 'text/plain' }),
    },
  } as unknown as ConstructorParameters<typeof PgObjectStorage>[0];
}

describe('SP-3 图纸签发器组合根透传（app-registry → DrawingHttpModule）', () => {
  it('buildAppModule 注入 readReferenceSigner → DRAWING_READ_REFERENCES provider 拿到同一实例', () => {
    const signer = new DrawingReadReferenceSigner({ signingKey: KEY });
    const root = buildAppModule(parseModulesEnabled('core,drawing'), {
      drawingReadReferenceSigner: signer,
    });
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, root) as DynamicModule[];
    const drawingModule = imports.find((m) => m.module === DrawingHttpModule);
    expect(drawingModule).toBeDefined();
    const provider = (drawingModule!.providers as Provider[]).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === DRAWING_READ_REFERENCES,
    );
    expect(provider).toBeDefined();
    expect(provider!.useValue).toBe(signer);
  });

  it('不注入 → 模块缺省随机密钥实例（行为不变：仍是 DrawingReadReferenceSigner）', () => {
    const root = buildAppModule(parseModulesEnabled('core,drawing'), {});
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, root) as DynamicModule[];
    const drawingModule = imports.find((m) => m.module === DrawingHttpModule);
    const provider = (drawingModule!.providers as Provider[]).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === DRAWING_READ_REFERENCES,
    );
    expect(provider!.useValue).toBeInstanceOf(DrawingReadReferenceSigner);
  });
});

describe('SP-3 附件域签名密钥注入 round-trip（三适配器统一）', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  async function assertAdapterRoundTrip(storage: ObjectStoragePort, label: string): Promise<void> {
    const stored = await storage.put('default' as never, {
      fileName: 'sp3-proof.txt',
      contentType: 'text/plain',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const reference = await storage.issueReadReference('default' as never, stored, {
      ttlSeconds: 60,
      downloadName: 'sp3-proof.txt',
    });
    const token = reference.url.split('/').pop()!;
    // 同 key 验签通过（claims 携带 objectKey）＝注入 key 真被用作 HMAC key
    const claims = verifyReadReferenceToken(KEY, token, new Date());
    expect(claims, label).not.toBeNull();
    expect(claims!.objectKey, label).toBe(stored.objectKey);
    // 异 key 拒绝（不是"忽略注入恒用随机"的假通过）
    expect(verifyReadReferenceToken(OTHER_KEY, token, new Date()), label).toBeNull();
  }

  it('InMemoryObjectStorage：注入 signingKey 签发 token 同 key 过/异 key 拒', async () => {
    await assertAdapterRoundTrip(new InMemoryObjectStorage({ signingKey: KEY }), 'in-memory');
  });

  it('LocalFileSystemObjectStorage：注入 signingKey 签发 token 同 key 过/异 key 拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp3-local-fs-'));
    tempDirs.push(dir);
    await assertAdapterRoundTrip(
      new LocalFileSystemObjectStorage({ rootDirectory: dir, signingKey: KEY }),
      'local-fs',
    );
  });

  it('PgObjectStorage：options.signingKey 透传（构造第二参）——同 key 过/异 key 拒', async () => {
    // 修复点回归锚：connectAttachmentObjectStorage 此前构造未透传 signingKey
    // （pg-object-storage.ts L209）——本断言钉住 (prisma, {signingKey}) 契约。
    await assertAdapterRoundTrip(
      new PgObjectStorage(stubPrismaReturningRow(), { signingKey: KEY }),
      'pg',
    );
  });
});

describe('SP-3 图纸域签名密钥 round-trip（跨实例 = 跨重启/跨实例可用性）', () => {
  it('同 key 异实例签发/验签 round-trip；异 key 拒绝', () => {
    const issuer = new DrawingReadReferenceSigner({ signingKey: keyOf(11) });
    const reference = issuer.issue(
      'default',
      { userId: 'u-sp3', clearance: 'public' },
      'DWG-SP3-001',
      1,
      300,
    );
    // 「重启后的新实例」：同 key 重构——token 仍可验（env 固化的语义增量本体）
    const restarted = new DrawingReadReferenceSigner({ signingKey: keyOf(11) });
    const claims = restarted.verify(reference.token);
    expect(claims).not.toBeNull();
    expect(claims!.drawingId).toBe('DWG-SP3-001');
    expect(claims!.tenantId).toBe('default');
    // 异 key（= 未设 env 的随机实例）拒绝——语义边界：固化只改可用性，不放开验签
    const otherInstance = new DrawingReadReferenceSigner({ signingKey: keyOf(99) });
    expect(otherInstance.verify(reference.token)).toBeNull();
  });
});
