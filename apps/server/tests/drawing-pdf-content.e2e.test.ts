import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AttachmentService, AuthService, PermissionService, TenantContext } from '@smes/application';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import { DrawingService, inMemoryDrawingStores } from '@smes/drawing';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { DrawingErrorFilter } from '../src/drawing-error.filter.js';
import { UWaveErrorFilter } from '../src/u-wave-error.filter.js';

describe('drawing PDF bytes through the composed HTTP boundary', () => {
  const tenantA = TenantId.create('pdf-tenant-a');
  const tenantB = TenantId.create('pdf-tenant-b');
  const actor = UserId.create('pdf-reader');
  const stores = inMemoryDrawingStores();
  let app: INestApplication;
  let origin: string;
  let drawing: DrawingService;
  let attachments: AttachmentService;
  let first: Buffer;
  let second: Buffer;
  let deletedId: string;
  let protectedId: string;
  let ordinaryId: string;
  let operation = 0;

  async function publish(id: string, fileRef: string, revision: 'initial' | number = 'initial', classification = 'public') {
    await drawing.execute(tenantA, makeCommandEnvelope({
      tenantId: tenantA, issuedBy: actor, operationId: OperationId.create(`pdf-publish-${++operation}`),
      expectedRevision: revision, issuedAt: new Date().toISOString(),
      command: { kind: 'drawing.publish.v1', payload: { drawingId: id, fileRef, classification, changeNote: 'isolated PDF fixture' } },
    }));
  }
  async function upload(bizId: string, bytes: Buffer, bizType = 'drawing-pdf') {
    return attachments.upload(tenantA, actor, { fileName: 'part.pdf', contentType: 'application/pdf', contentBase64: bytes.toString('base64'), bizType, bizId });
  }
  function get(id: string, version = '1', clearance = 'public', token: string | null = 'reader-a', tenant = 'a') {
    return fetch(`${origin}/drawing/revisions/${id}/content?version=${version}&clearance=${clearance}`, {
      headers: { 'x-pdf-test-tenant': tenant, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    });
  }

  beforeAll(async () => {
    vi.stubEnv('SMES_DEV_AUTH', 'off');
    app = await NestFactory.create(buildAppModule(parseModulesEnabled('core,org,drawing,attachment'), { drawingStores: stores }), { logger: false });
    const context = app.get(TenantContext);
    app.use((req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
      context.run(req.headers['x-pdf-test-tenant'] === 'b' ? tenantB : tenantA, next);
    });
    vi.spyOn(app.get(AuthService), 'resolveSession').mockImplementation(async token =>
      ['reader-a', 'denied-a', 'attachment-reader-a'].includes(token) ? { userId: UserId.create(token), tenant: tenantA }
        : token === 'reader-b' ? { userId: actor, tenant: tenantB } : null);
    vi.spyOn(app.get(PermissionService), 'authorize').mockImplementation(async (_tenant, user, code) =>
      String(user) === 'attachment-reader-a' ? String(code) === 'attachment:read'
        : String(user) !== 'denied-a' && String(code) === 'drawing:read');
    app.useGlobalFilters(new DrawingErrorFilter(), new UWaveErrorFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    drawing = app.get(DrawingService);
    attachments = app.get(AttachmentService);
    first = await readFile(new URL('../../web/public/fixtures/mfgcap-drawing-A.pdf', import.meta.url));
    second = await readFile(new URL('../../web/public/fixtures/mfgcap-drawing-B.pdf', import.meta.url));
    const a = await upload('part-A', first);
    protectedId = a.id;
    ordinaryId = (await upload('ordinary', first, 'drawing')).id;
    const b = await upload('part-A', second);
    await publish('part-A', `attachment:${a.id}`);
    await publish('part-A', `attachment:${b.id}`, 1, 'restricted');
    await publish('external', 'http://127.0.0.1:1/private.pdf');
    await publish('wrong-drawing', `attachment:${a.id}`);
    const wrongType = await upload('wrong-type', first, 'other-business');
    await publish('wrong-type', `attachment:${wrongType.id}`);
    const invalid = await upload('invalid', Buffer.from('not a PDF'));
    await publish('invalid', `attachment:${invalid.id}`);
    const deleted = await upload('deleted', first);
    deletedId = deleted.id;
    await publish('deleted', `attachment:${deletedId}`);
    await attachments.remove(tenantA, { ids: deletedId });
  });
  afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('delivers pinned PDF bytes from the shared upload store, disables caching and audits each open', async () => {
    const before = (await drawing.viewAudit(tenantA)).length;
    for (const [version, expected] of [['1', first], ['2', second], ['1', first]] as const) {
      const response = await get('part-A', version, 'restricted');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/pdf');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-disposition')).toContain(`part-A-v${version}.pdf`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    }
    const trail = await drawing.viewAudit(tenantA);
    expect(trail).toHaveLength(before + 3);
    expect(trail.slice(before).map(row => row.version)).toEqual([1, 2, 1]);
  });

  it('preserves login, drawing permission, clearance and tenant denials before content or audit', async () => {
    const before = (await drawing.viewAudit(tenantA)).length;
    expect((await get('part-A', '1', 'public', null)).status).toBe(401);
    expect((await get('part-A', '1', 'public', 'denied-a')).status).toBe(403);
    for (const response of [await get('part-A', '2', 'public'), await get('missing'), await get('part-A', '1', 'restricted', 'reader-b', 'b')]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'drawing.not_found' });
    }
    expect(await drawing.viewAudit(tenantA)).toHaveLength(before);
    expect(await drawing.viewAudit(tenantB)).toHaveLength(0);
  });

  it('prevents generic attachment download from bypassing drawing audit while preserving ordinary attachments', async () => {
    const before = (await drawing.viewAudit(tenantA)).length;
    const headers = { authorization: 'Bearer attachment-reader-a' };
    const denied = await fetch(`${origin}/attachment/download-reference?id=${protectedId}&bizId=part-A`, { headers });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: 'attachment.conflict' });
    expect((await get('part-A', '1', 'public', 'attachment-reader-a')).status).toBe(403);
    const ordinary = await fetch(`${origin}/attachment/download-reference?id=${ordinaryId}&bizId=ordinary`, { headers });
    expect(ordinary.status).toBe(200);
    const reference = await ordinary.json() as { url: string };
    const bytes = await fetch(`${origin}${reference.url}`);
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(first);
    expect(await drawing.viewAudit(tenantA)).toHaveLength(before);
  });

  it.each(['external', 'wrong-drawing', 'wrong-type', 'invalid', 'deleted'])('does not deliver unbound, unrelated, invalid or removed content: %s', async id => {
    const response = await get(id);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'drawing.not_found' });
  });

  it('does not return PDF bytes when the required audit event cannot be appended', async () => {
    const failure = vi.spyOn(stores.events, 'append').mockRejectedValueOnce(new Error('isolated audit failure'));
    try {
      const response = await get('part-A');
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.text()).not.toContain('%PDF-');
    } finally { failure.mockRestore(); }
  });
});
