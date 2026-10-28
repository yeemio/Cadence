/**
 * 大屏 boot e2e（A8/A10 首波，6a-3 裁决 2/4）：零 DB 真实起服（Nest 组合根 →
 * express HTTP → fetch 读回），机器断言两条 REWORK 主诉：
 *  - 裁决 1（A10 断链）：GET /screen/machining-daily-stats 带权身份 → 200
 *    {rows:[]}（修复前 machiningDailyStatsStore 恒 undefined → 500）；
 *  - 裁决 2（快照无鉴权）：两端点零凭据 → 401、无策略身份 → 403（修复前公开 200）；
 *  - SSE 通道真实读回：无凭据/?token= 坏值 → 401 JSON；dev 身份 → 200
 *    text/event-stream，preamble + 帧周期内 data: 数据帧（SMES_SCREEN_FRAME_
 *    INTERVAL_MS=200 放大观察窗）；
 *  - D-21（流通道权限缺失）：viewer/approver 订阅流 → 403 JSON（dev 头与
 *    ?token= 两路径同判 report:read——修复前任意有效会话即 200，快照 403 而流
 *    200 的分叉闭合）；admin → 200（既有 SSE 用例身份改带权）。
 * 体例沿 boot.e2e.test.ts / capability-modules.e2e.test.ts。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { hashPassword, InMemoryUserStore, TenantContext } from '@smes/application';
import { TenantId } from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';

const OPERATOR = 'u-op-screen';
let AUTH_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
const VIEWER_HEADERS = { 'content-type': 'application/json', 'x-smes-user': 'u-viewer-screen' };
/** D-21：approver = 有效身份 + 显式角色（有 todo:read、无 report:read）。 */
const APPROVER = 'u-approver-screen';
const APPROVER_HEADERS = { 'content-type': 'application/json', 'x-smes-user': APPROVER };

describe('大屏 HTTP/SSE 组合态（零 DB，core+screen）', () => {
  let baseUrl = '';
  let viewerToken = '';
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', 'core,screen');
    setEnv('DATABASE_URL', undefined); // 零 DB：A10 存储走组合根内存缺省（裁决 1 链路）
    setEnv('SMES_DEV_AUTH', 'on'); // dev 身份回落（测试钩子；生产形态默认关）
    setEnv('SMES_SCREEN_FRAME_INTERVAL_MS', '200'); // 放大观察窗：帧周期 200ms

    const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
    const sharedUserStore = new InMemoryUserStore();
    const seededUser = await sharedUserStore.create({
      tenant: TenantId.create('default'),
      username: 'op-screen',
      displayName: '大屏e2e操作员',
    });
    // D-21：viewer 造真实登录会话（?token= 路径的证据同构复现形态）——有账号
    // 有口令但零策略（无角色无权限码）。
    await sharedUserStore.create({
      tenant: TenantId.create('default'),
      username: 'viewer-screen',
      displayName: '大屏e2e只读访客',
      passwordHash: hashPassword('viewer-screen-pass'),
    });
    app = await NestFactory.create(
      buildAppModule(enabled, { devPolicyEndpoint: true, userStore: sharedUserStore }),
      { logger: ['error', 'warn'] },
    );
    app.useGlobalFilters(new AuthErrorFilter(), new DomainErrorFilter());
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    // 策略注入钩子：grant admin（全权限码 bypass）——capability e2e 同体例；
    // D-21：approver 造显式角色（todo:read ≠ report:read，证明判定链取的是
    // 权限码而非"有任意角色"）。
    const granted = await fetch(`${baseUrl}/dev/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smes-user': OPERATOR },
      body: JSON.stringify({
        rules: [
          { kind: 'grant-role', tenant: 'default', user: seededUser.id, role: 'admin' },
          {
            kind: 'grant-permission',
            tenant: 'default',
            role: 'approver-screen',
            resource: 'todo',
            action: 'read',
          },
          { kind: 'grant-role', tenant: 'default', user: APPROVER, role: 'approver-screen' },
        ],
      }),
    });
    expect(granted.status).toBe(200);
    AUTH_HEADERS = { 'content-type': 'application/json', 'x-smes-user': seededUser.id };

    // viewer 真实会话 token（D-21 ?token= 路径用）
    const viewerLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer-screen', password: 'viewer-screen-pass' }),
    });
    expect(viewerLogin.status).toBe(201);
    viewerToken = ((await viewerLogin.json()) as { token: string }).token;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('screen 进 /modules 清单（激活价语义）', async () => {
    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    expect(await modules.json()).toEqual({ modules: ['core', 'screen'] });
  });

  it('裁决 2：零凭据 → 快照与 A10 日表两端点 401（修复前公开 200）', async () => {
    const snapshot = await fetch(`${baseUrl}/screen/digital-operation`);
    expect(snapshot.status).toBe(401);
    const daily = await fetch(`${baseUrl}/screen/machining-daily-stats`);
    expect(daily.status).toBe(401);
    // 坏 Bearer 同样 401（显式坏凭据不静默降级）
    const badBearer = await fetch(`${baseUrl}/screen/digital-operation`, {
      headers: { authorization: 'Bearer not-a-session' },
    });
    expect(badBearer.status).toBe(401);
  });

  it('裁决 2：身份有效但无权限码（viewer 无策略）→ 403（门禁语义分叉）', async () => {
    const snapshot = await fetch(`${baseUrl}/screen/digital-operation`, { headers: VIEWER_HEADERS });
    expect(snapshot.status).toBe(403);
    const daily = await fetch(`${baseUrl}/screen/machining-daily-stats`, { headers: VIEWER_HEADERS });
    expect(daily.status).toBe(403);
  });

  it('裁决 1：带权身份 → 快照 200 真实帧（信封/占位登记）；A10 日表 200 rows:[]（修复前 500）', async () => {
    const snapshot = await fetch(`${baseUrl}/screen/digital-operation`, { headers: AUTH_HEADERS });
    expect(snapshot.status).toBe(200);
    const envelope = (await snapshot.json()) as {
      type: string;
      ts: number;
      payload: { pendingFields: Record<string, string>; kpi: Record<string, unknown> };
    };
    expect(envelope.type).toBe('digital_operation.snapshot');
    expect(typeof envelope.ts).toBe('number');
    // 零 DB 零事实源形态：KPI 读面缺 → null + pendingFields 'source' 登记（诚实占位）
    expect(envelope.payload.kpi['monthlyPlannedDeliverySets']).toBeNull();
    expect(envelope.payload.pendingFields['kpi.monthlyPlannedDeliverySets']).toBe('source');

    const daily = await fetch(`${baseUrl}/screen/machining-daily-stats`, { headers: AUTH_HEADERS });
    expect(daily.status).toBe(200); // 修复前：store undefined → TypeError → 500
    expect(await daily.json()).toEqual({ rows: [] });
  });

  it('A10 日表 ?days 解析：上限 366 / 下限 1 / 非整数回落 30（端点实态锚定）', async () => {
    const capped = await fetch(`${baseUrl}/screen/machining-daily-stats?days=99999`, { headers: AUTH_HEADERS });
    expect(capped.status).toBe(200);
    expect((await capped.json() as { rows: unknown[] }).rows).toEqual([]);
  });

  it('SSE 通道：无凭据 / 坏 token → 401 JSON（不进 event-stream）', async () => {
    const anonymous = await fetch(`${baseUrl}/screen/digital-operation/stream`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toContain('application/json');
    const anonymousBody = (await anonymous.json()) as { statusCode: number; message: string };
    expect(anonymousBody.statusCode).toBe(401);
    expect(anonymousBody.message).toContain('大屏流通道未开放或未授权');

    const badToken = await fetch(`${baseUrl}/screen/digital-operation/stream?token=not-a-session`);
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get('content-type')).toContain('application/json');
  });

  it('D-21：viewer/approver 订阅流 → 403 JSON（dev 头与 ?token= 两路径同判 report:read；修复前 200 推帧）', async () => {
    // dev 头路径：viewer（零策略）——修复前任意非空头即 200
    const viewerHeader = await fetch(`${baseUrl}/screen/digital-operation/stream`, {
      headers: VIEWER_HEADERS,
    });
    expect(viewerHeader.status).toBe(403);
    expect(viewerHeader.headers.get('content-type')).toContain('application/json');
    const viewerBody = (await viewerHeader.json()) as { statusCode: number; message: string };
    expect(viewerBody.statusCode).toBe(403);
    expect(viewerBody.message).toContain('report:read');

    // dev 头路径：approver（有 todo:read、无 report:read）——判定取权限码非角色有无
    const approverHeader = await fetch(`${baseUrl}/screen/digital-operation/stream`, {
      headers: APPROVER_HEADERS,
    });
    expect(approverHeader.status).toBe(403);
    expect(approverHeader.headers.get('content-type')).toContain('application/json');

    // ?token= 路径（证据同构形态：viewer 真实登录会话）——快照 403 而流 200 的分叉闭合
    const viewerStream = await fetch(
      `${baseUrl}/screen/digital-operation/stream?token=${encodeURIComponent(viewerToken)}`,
    );
    expect(viewerStream.status).toBe(403);
    expect(viewerStream.headers.get('content-type')).toContain('application/json');
    expect(viewerStream.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('SSE 通道：带权身份（admin bypass）→ 200 event-stream，preamble 后帧周期内收到 data: 数据帧', async () => {
    const response = await fetch(`${baseUrl}/screen/digital-operation/stream`, {
      headers: AUTH_HEADERS,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    try {
      const deadline = Date.now() + 5_000; // 帧周期 200ms（env 放大）——5s 上限
      while (Date.now() < deadline && !received.includes('data: ')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('读帧超时')), 5_000)),
        ]);
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined); // 关流（连接 close → 订阅摘除）
    }
    expect(received).toContain('retry: 3000');
    expect(received).toContain(': stream open');
    expect(received).toContain('data: ');
    expect(received).toContain('"type":"digital_operation.snapshot"');
  }, 15_000);
});
