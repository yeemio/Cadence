/**
 * F8: real nginx + existing Nest controllers/services, isolated in-memory data.
 * Opt in with CADENCE_NGINX_BIN=/absolute/path/to/nginx. Only listen/root/upstream
 * are substituted in the checked-in web config; its locations stay unchanged.
 * No browser renderer or production DNS/TLS is claimed by these HTTP tests.
 */
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AttachmentController, AttachmentService, InMemoryAttachmentStore, InMemoryObjectStorage,
  TenantContext, encodeReadReferenceToken, verifyReadReferenceToken,
  type AuthService, type PermissionService,
} from '@smes/application';
import { OperationId, TenantId, UserId, hostBasedTenantResolver, makeCommandEnvelope } from '@smes/business-core';
import { DrawingId, DrawingReadReferenceSigner, DrawingService, inMemoryDrawingStores } from '@smes/drawing';
import { AuthGuard } from '../src/auth.guard.js';
import { DrawingErrorFilter } from '../src/drawing-error.filter.js';
import { DRAWING_READ_REFERENCES, DrawingQueriesController, WORKORDER_DRAWING_REFS } from '../src/drawing-http.module.js';
import { UWaveErrorFilter } from '../src/u-wave-error.filter.js';

const nginxBinary = process.env['CADENCE_NGINX_BIN'];
const tenantA = TenantId.create('tenant-a');
const viewer = { userId: UserId.create('drawing-engineer'), clearance: 'restricted' };
const fileRef = 'storage://synthetic-drawings/part-A/v1.pdf';
const navigationAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const shell = '<!doctype html><html><body>cadence-spa-navigation-fixture</body></html>';

@Module({})
class NavigationFixtureModule {}

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

describe.skipIf(!nginxBinary)('F8 signed references through the web nginx origin', () => {
  let app: INestApplication | undefined;
  let nginx: ChildProcess | undefined;
  let directory: string | undefined;
  let origin: string;
  let drawing: DrawingService;
  let signer: DrawingReadReferenceSigner;
  let drawingPath: string;
  let attachmentPath: string;
  let expiredAttachmentPath: string;
  let clockMs = Date.now();
  const incoming: { url: string; host: string | undefined; forwardedProto: string | undefined }[] = [];
  const authorization = vi.fn(async () => false);
  const session = vi.fn(async () => null);
  let nginxErrors = '';

  function navigate(path: string, host = 'tenant-a.cadence.test', accept = navigationAccept): Promise<Response> {
    // Use node:http so Host is explicitly controlled while connecting only to
    // loopback. Fetch runtimes may replace Host with the numeric connection URL.
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}${path}`, { headers: { Host: host, Accept: accept } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
            else if (value !== undefined) headers.set(key, value);
          }
          resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: res.statusCode ?? 500, headers }));
        });
      });
      req.setTimeout(5_000, () => req.destroy(new Error('isolated nginx request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    vi.stubEnv('SMES_DEV_AUTH', 'off');
    const context = new TenantContext().useResolver(hostBasedTenantResolver({ domain: 'cadence.test', lookup: () => ['tenant-a', 'tenant-b'] }));
    signer = new DrawingReadReferenceSigner({ nowMs: () => clockMs });
    drawing = new DrawingService(inMemoryDrawingStores(), { readReferences: signer });
    const key = new Uint8Array(32).fill(23); // synthetic fixture key, never deployment configuration
    const objects = new InMemoryObjectStorage({ signingKey: key });
    const attachments = new AttachmentService(new InMemoryAttachmentStore(), objects);
    await drawing.execute(tenantA, makeCommandEnvelope({
      tenantId: tenantA, issuedBy: viewer.userId, operationId: OperationId.create('navigation-publish'),
      expectedRevision: 'initial', issuedAt: new Date().toISOString(),
      command: { kind: 'drawing.publish.v1', payload: { drawingId: 'part-A', fileRef, classification: 'restricted', changeNote: 'isolated fixture' } },
    }));
    const view = await drawing.viewRevision(tenantA, viewer, DrawingId.create('part-A'), 'latest', { readReferenceTtlSeconds: 300 });
    drawingPath = view.readReference!.url;
    const attachment = await attachments.upload(tenantA, viewer.userId, {
      fileName: 'drawing-note.txt', contentType: 'text/plain', contentBase64: Buffer.from('synthetic attachment bytes\n').toString('base64'),
      bizType: 'drawing', bizId: 'part-A',
    });
    const reference = await attachments.issueDownloadReference(tenantA, { id: attachment.id, bizId: 'part-A' });
    attachmentPath = reference.url;
    const claims = verifyReadReferenceToken(key, reference.url.split('/').at(-1)!, new Date())!;
    expiredAttachmentPath = `/attachment/storage/${encodeReadReferenceToken(key, { ...claims, expiresAtMs: 0 })}`;

    app = await NestFactory.create({
      module: NavigationFixtureModule,
      controllers: [DrawingQueriesController, AttachmentController],
      providers: [
        { provide: TenantContext, useValue: context },
        { provide: DrawingService, useValue: drawing },
        { provide: AttachmentService, useValue: attachments },
        { provide: WORKORDER_DRAWING_REFS, useValue: {} },
        { provide: DRAWING_READ_REFERENCES, useValue: signer },
      ],
    }, { logger: ['error'] });
    app.useGlobalGuards(new AuthGuard(new Reflector(), context,
      { authorize: authorization } as unknown as PermissionService,
      { resolveSession: session } as unknown as AuthService));
    app.useGlobalFilters(new DrawingErrorFilter(), new UWaveErrorFilter());
    app.use((req: { originalUrl: string; headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
      incoming.push({ url: req.originalUrl, host: req.headers['host'], forwardedProto: req.headers['x-forwarded-proto'] });
      context.run(context.resolve(req), next);
    });
    await app.listen(0, '127.0.0.1');
    const backendPort = (app.getHttpServer().address() as AddressInfo).port;
    const webPort = await availablePort();
    origin = `http://127.0.0.1:${webPort}`;
    directory = await mkdtemp(join(tmpdir(), 'cadence-reference-nav-'));
    const webRoot = join(directory, 'web');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await writeFile(join(webRoot, 'index.html'), shell);
    await writeFile(join(webRoot, 'login.html'), '<html>cadence-login-fixture</html>');
    await writeFile(join(webRoot, 'assets', 'fixture.txt'), 'static asset');
    const checkedIn = await readFile(new URL('../../web/nginx.conf', import.meta.url), 'utf8');
    const serverConfig = checkedIn
      .replace('listen 80;', `listen 127.0.0.1:${webPort};`)
      .replace('root /usr/share/nginx/html;', `root "${webRoot}";`)
      .replaceAll('http://server:3000', `http://127.0.0.1:${backendPort}`);
    const config = join(directory, 'nginx.conf');
    // The single-process fixture keeps its existing uid. A root user namespace
    // may not map nginx's default nobody uid; do not chown fixture dirs to it.
    const fixtureUser = process.getuid?.() === 0 ? 'user root;\n' : '';
    await writeFile(config, `${fixtureUser}master_process off;\nworker_processes 1;\npid "${directory}/nginx.pid";\nerror_log stderr;\nevents {}\nhttp {\naccess_log off;\nclient_body_temp_path client;\nproxy_temp_path proxy;\nfastcgi_temp_path fastcgi;\nuwsgi_temp_path uwsgi;\nscgi_temp_path scgi;\n${serverConfig}\n}\n`);
    const args = ['-p', `${directory}/`, '-c', config, '-e', 'stderr'];
    const syntax = spawnSync(nginxBinary!, [...args, '-t'], { encoding: 'utf8' });
    expect(syntax.error, syntax.stderr).toBeUndefined();
    expect(syntax.status, syntax.stderr).toBe(0);
    nginx = spawn(nginxBinary!, [...args, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
    nginx.stderr!.on('data', chunk => { nginxErrors += String(chunk); });
    nginx.on('error', error => { nginxErrors += error.message; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (nginx.exitCode !== null) throw new Error(`nginx exited: ${nginxErrors}`);
      try {
        const response = await navigate('/');
        if (response.status === 200) return;
      } catch { /* wait only for this isolated process to bind */ }
      await delay(25);
    }
    throw new Error(`nginx did not become ready: ${nginxErrors}`);
  }, 20_000);

  afterAll(async () => {
    if (nginx && nginx.exitCode === null) {
      const exited = once(nginx, 'exit');
      nginx.kill('SIGQUIT');
      await Promise.race([exited, delay(2_000)]);
      if (nginx.exitCode === null) { nginx.kill('SIGKILL'); await exited; }
    }
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('anonymous document navigation reaches drawing redemption, preserves Host/query and audits every view', async () => {
    const before = (await drawing.viewAudit(tenantA)).length;
    for (let i = 0; i < 2; i += 1) {
      const response = await navigate(`${drawingPath}?from=navigation`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ fileRef });
      expect(incoming.at(-1)).toMatchObject({ url: `${drawingPath}?from=navigation`, host: 'tenant-a.cadence.test', forwardedProto: 'http' });
    }
    expect(await drawing.viewAudit(tenantA)).toHaveLength(before + 2);
    expect(authorization).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    // The protected view endpoint still requires a login; the exception is only
    // the existing capability URL, not all drawing endpoints.
    expect((await navigate('/drawing/revisions/part-A/view?clearance=restricted', 'tenant-a.cadence.test', 'application/json')).status).toBe(401);
  });

  it('expired, invalid and cross-tenant drawing references remain backend 404s without new audit rows', async () => {
    const before = (await drawing.viewAudit(tenantA)).length;
    const oldClock = clockMs;
    const expired = signer.issue(String(tenantA), { userId: String(viewer.userId), clearance: 'restricted' }, 'part-A', 1, 1);
    clockMs += 1_001;
    try {
      for (const [path, host] of [[expired.url, 'tenant-a.cadence.test'], ['/drawing/read-references/invalid', 'tenant-a.cadence.test'], [drawingPath, 'tenant-b.cadence.test']]) {
        const response = await navigate(path!, host!);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'drawing.not_found' });
      }
    } finally { clockMs = oldClock; }
    expect(await drawing.viewAudit(tenantA)).toHaveLength(before);
  });

  it('anonymous attachment navigation returns bytes and keeps expiry/tenant rejection', async () => {
    const response = await navigate(attachmentPath);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('content-disposition')).toContain('drawing-note.txt');
    expect(await response.text()).toBe('synthetic attachment bytes\n');
    for (const [path, host] of [[expiredAttachmentPath, 'tenant-a.cadence.test'], [attachmentPath, 'tenant-b.cadence.test'], ['/attachment/storage/invalid', 'tenant-a.cadence.test']]) {
      const denied = await navigate(path!, host!);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toMatchObject({ code: 'attachment.not_found' });
    }
    expect(authorization).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });

  it('keeps SPA deep links, login, static assets and non-navigation API fallback', async () => {
    for (const path of ['/drawing-library', '/inventory/stock', '/m/report', '/bigscreen/digital-operation']) {
      const response = await navigate(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(shell);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('vary')).toBe('Accept');
    }
    expect(await (await navigate('/login')).text()).toContain('cadence-login-fixture');
    const asset = await navigate('/assets/fixture.txt');
    expect(await asset.text()).toBe('static asset');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const api = await navigate('/inventory/stock', 'tenant-a.cadence.test', 'application/json');
    expect(api.status).toBe(404); // no such endpoint in this deliberately narrow Nest fixture
    expect(api.headers.get('content-type')).toContain('application/json');
  });
});
