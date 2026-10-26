/**
 * 只读引用令牌与签发器测试（P1-e / O5 裁定=复用 attachment HMAC 基座模式）。
 *
 * 锚定面：
 *  - codec 等价性（与附件基座 read-reference-tokens 同模式）：round-trip /
 *    篡改 / 过期 / 换密钥 / 结构垃圾 一律 null（不区分原因不泄漏存在性）；
 *  - 服务集成：查看回执可选携带 readReference（装配签发器 + 声明 TTL 才出现；
 *    令牌 claims 不含 fileRef——不新增内容指针外泄路径）；
 *  - 两不变量保持：兑现（verify → 再走 viewRevision）每次必落新查看留痕，
 *    fileRef 唯一取得路径仍是 viewRevision。
 */
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  DrawingId,
  DrawingInputError,
  DrawingNotFoundError,
  DrawingReadReferenceSigner,
  DrawingService,
  encodeDrawingReadReferenceToken,
  inMemoryDrawingStores,
  newDrawingReadReferenceSigningKey,
  verifyDrawingReadReferenceToken,
  type DrawingViewer,
} from '../src/index.js';

const TENANT = TenantId.create('t-drawing-ref');
const OTHER_TENANT = TenantId.create('t-drawing-ref-other');
const TECH = UserId.create('u-tech-1');
const techViewer: DrawingViewer = { userId: TECH, clearance: 'restricted' };

/** 确定时钟（epoch 毫秒）：签发于 t0，兑现/过期按步进推进。 */
const T0_MS = 1_800_000_000_000;
let clockMs = T0_MS;
function makeService(): { service: DrawingService; signer: DrawingReadReferenceSigner } {
  clockMs = T0_MS;
  const stores = inMemoryDrawingStores();
  const signer = new DrawingReadReferenceSigner({ nowMs: () => clockMs });
  const service = new DrawingService(stores, {
    now: () => '2026-11-01T08:00:00.000Z',
    readReferences: signer,
  });
  return { service, signer };
}

async function publishInitial(service: DrawingService): Promise<void> {
  const outcome = await service.execute(
    TENANT,
    makeCommandEnvelope({
      tenantId: TENANT,
      issuedBy: TECH,
      operationId: OperationId.create('op-ref-0001'),
      expectedRevision: 'initial',
      issuedAt: '2026-11-01T08:00:00.000Z',
      command: {
        kind: 'drawing.publish.v1',
        payload: { drawingId: 'dwg-001', fileRef: 'storage://dwg-001/v1.pdf', changeNote: '首发', classification: 'restricted' },
      },
    }),
  );
  expect(outcome.status).toBe('committed');
}

// ---- codec（模式等价于附件基座 read-reference-tokens） ----

describe('只读引用令牌 codec（HMAC+TTL，v1.<claims>.<sig>）', () => {
  const key = newDrawingReadReferenceSigningKey();
  const claims = {
    tenantId: 't-1',
    drawingId: 'dwg-001',
    version: 3,
    viewerId: 'u-tech-1',
    clearance: 'restricted',
    expiresAtMs: T0_MS + 300_000,
  };

  it('round-trip：签发时点内验证回原 claims', () => {
    const token = encodeDrawingReadReferenceToken(key, claims);
    expect(token.startsWith('v1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyDrawingReadReferenceToken(key, token, new Date(T0_MS))).toEqual(claims);
  });

  it('过期即失效；篡改载荷/签名/换密钥/结构垃圾一律 null（不区分原因）', () => {
    const token = encodeDrawingReadReferenceToken(key, claims);
    expect(verifyDrawingReadReferenceToken(key, token, new Date(T0_MS + 300_000))).toBeNull(); // 过期
    const parts = token.split('.');
    const tamperedPayload = `v1.${Buffer.from(
      JSON.stringify({ ...claims, viewerId: 'u-attacker' }),
      'utf8',
    ).toString('base64url')}.${parts[2]}`;
    expect(verifyDrawingReadReferenceToken(key, tamperedPayload, new Date(T0_MS))).toBeNull();
    const tamperedSig = `v1.${parts[1]}.${parts[2]!.slice(0, -2)}xx`;
    expect(verifyDrawingReadReferenceToken(key, tamperedSig, new Date(T0_MS))).toBeNull();
    expect(verifyDrawingReadReferenceToken(newDrawingReadReferenceSigningKey(), token, new Date(T0_MS))).toBeNull();
    expect(verifyDrawingReadReferenceToken(key, '', new Date(T0_MS))).toBeNull();
    expect(verifyDrawingReadReferenceToken(key, 'v2.a.b', new Date(T0_MS))).toBeNull();
    expect(verifyDrawingReadReferenceToken(key, `v1.${parts[1]}`, new Date(T0_MS))).toBeNull();
  });

  it('签发器 TTL 守界：越界 RangeError（不静默钳制）', () => {
    const signer = new DrawingReadReferenceSigner({ nowMs: () => clockMs });
    expect(() => signer.issue('t-1', { userId: 'u', clearance: 'public' }, 'dwg-001', 1, 0)).toThrowError(
      RangeError,
    );
    expect(() => signer.issue('t-1', { userId: 'u', clearance: 'public' }, 'dwg-001', 1, 601)).toThrowError(
      RangeError,
    );
    expect(signer.issue('t-1', { userId: 'u', clearance: 'public' }, 'dwg-001', 1, 600).expiresInSeconds).toBe(600);
  });
});

// ---- 服务集成（查看回执可选携带 readReference；两不变量保持） ----

describe('viewRevision 只读引用集成（P1-e）', () => {
  it('声明 TTL 的查看：回执附 readReference（url=开门面+token；claims 不含 fileRef）', async () => {
    const { service, signer } = makeService();
    await publishInitial(service);
    const view = await service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest', {
      readReferenceTtlSeconds: 300,
    });
    expect(view.readReference).toBeDefined();
    expect(view.readReference!.url.startsWith('/drawing/read-references/v1.')).toBe(true);
    expect(view.readReference!.url.endsWith(view.readReference!.token)).toBe(true);
    expect(view.readReference!.expiresInSeconds).toBe(300);
    expect(view.readReference!.expiresAt).toBe(new Date(T0_MS + 300_000).toISOString());
    const claims = signer.verify(view.readReference!.token);
    expect(claims).toMatchObject({ tenantId: TENANT, drawingId: 'dwg-001', version: 1, viewerId: 'u-tech-1', clearance: 'restricted' });
    // 红线：claims 不含内容指针（fileRef 唯一取得路径仍只是查看回执本身）
    expect(JSON.stringify(claims)).not.toContain('fileRef');
    expect(JSON.stringify(view.readReference!.token)).not.toContain('storage://');
  });

  it('未声明 TTL 或未装配签发器：回执不携带 readReference（缺省行为零变化）', async () => {
    const { service } = makeService();
    await publishInitial(service);
    const plain = await service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest');
    expect(plain.readReference).toBeUndefined();
    const bare = new DrawingService(inMemoryDrawingStores(), { now: () => '2026-11-01T08:00:00.000Z' });
    await publishInitial(bare);
    const bareView = await bare.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest', {
      readReferenceTtlSeconds: 300,
    });
    expect(bareView.readReference).toBeUndefined();
  });

  it('兑现=再走 viewRevision 全路径：同内容指针、每次必落新查看留痕（两不变量保持）', async () => {
    const { service, signer } = makeService();
    await publishInitial(service);
    const first = await service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest', {
      readReferenceTtlSeconds: 300,
    });
    clockMs = T0_MS + 60_000; // 60 秒后兑现（仍在 TTL 内）
    const claims = signer.verify(first.readReference!.token);
    expect(claims).not.toBeNull();
    const redeemed = await service.viewRevision(
      TENANT,
      { userId: UserId.create(claims!.viewerId), clearance: claims!.clearance },
      DrawingId.create(claims!.drawingId),
      claims!.version,
    );
    expect(redeemed.fileRef).toBe('storage://dwg-001/v1.pdf');
    expect(redeemed.readReference).toBeUndefined(); // 兑现回执不再连环签发
    // 两次查看=两行留痕（兑现不是旁路——查看必留痕无例外路径）
    const trails = await service.viewAudit(TENANT);
    expect(trails).toHaveLength(2);
    expect(trails.every((row) => row.viewedBy === 'u-tech-1' && row.version === 1)).toBe(true);
  });

  it('令牌过期后兑现：verify null（开门面同形 404 的域层根因）；门禁失败查看无引用无留痕', async () => {
    const { service, signer } = makeService();
    await publishInitial(service);
    const first = await service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest', {
      readReferenceTtlSeconds: 300,
    });
    clockMs = T0_MS + 300_001; // 过期
    expect(signer.verify(first.readReference!.token)).toBeNull();
    // 超保密门禁查看（public 许可看受限版）：抛同形 404——不产生引用（先门禁后留痕后签发）
    await expect(
      service.viewRevision(
        TENANT,
        { userId: UserId.create('u-line-1'), clearance: 'public' },
        DrawingId.create('dwg-001'),
        'latest',
        { readReferenceTtlSeconds: 300 },
      ),
    ).rejects.toBeInstanceOf(DrawingNotFoundError);
    expect(await service.viewAudit(TENANT)).toHaveLength(1); // 门禁失败不留痕
  });

  it('跨租户令牌：claims 租户 ≠ 兑现租户（开门面比对拒绝的域层前提）', async () => {
    const { service, signer } = makeService();
    await publishInitial(service);
    const view = await service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest', {
      readReferenceTtlSeconds: 300,
    });
    const claims = signer.verify(view.readReference!.token);
    expect(claims!.tenantId).not.toBe(OTHER_TENANT); // 兑现面按当前租户比对即拒
  });

  it('TTL 解析守界（HTTP 面复用）：1..600 过、越界/非整拒绝、缺省不签发', async () => {
    const { parseReadReferenceTtlParam } = await import('../src/index.js');
    expect(parseReadReferenceTtlParam(undefined)).toBeUndefined();
    expect(parseReadReferenceTtlParam('')).toBeUndefined();
    expect(parseReadReferenceTtlParam('300')).toBe(300);
    expect(parseReadReferenceTtlParam('1')).toBe(1);
    expect(() => parseReadReferenceTtlParam('0')).toThrowError(DrawingInputError);
    expect(() => parseReadReferenceTtlParam('601')).toThrowError(/1~600/);
    expect(() => parseReadReferenceTtlParam('abc')).toThrowError(DrawingInputError);
  });
});
