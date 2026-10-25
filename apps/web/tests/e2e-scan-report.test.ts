/**
 * M5 正式端到端实证：扫码报工页通道 → 真实 reporting 端点 → PG 落库
 * （在线提交 + 离线入队 → server 恢复 → FIFO 重放）。
 *
 * 形态取舍（写明）：参考 apps/server/scripts/e2e-*.mjs 的环境注入模式
 * （一次性 docker postgres:16 + MODULES_ENABLED + DATABASE_URL + 用完清理），
 * 但跑在 vitest 里——提交通道直接 import 页面真实函数
 * （src/data/reportingApi.ts 的 submitReportDraft/reportSubmitEnvelope 与
 * src/pages/scan/reportDraft.ts 的构造守卫）与 product-ui 真实 OfflineQueue，
 * 证据链是"页面装配代码本体"而非脚本内联复刻（node 直跑 import 不了
 * product-ui 源码——main 指 src/index.ts，.js 后缀解析需 vite 管道）。
 *
 * 环境注入：SMES_DEV_AUTH 不开（真实认证——登录走 POST /auth/login 拿
 * Bearer，与浏览器页面同路径）；MODULES_ENABLED 九模块 + core（对齐
 * e2e-live-db 同清单）。
 *
 * 触发：RUN_E2E=1（缺省 describe.skip——`pnpm test` 不依赖 docker）：
 *   RUN_E2E=1 pnpm --filter @smes/web exec vitest run tests/e2e-scan-report.test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN_E2E = process.env['RUN_E2E'] === '1';
const d = RUN_E2E ? describe : describe.skip;

const ROOT = '/Users/yeemio/AI/gitrep/Cadence';
const CONTAINER = `cadence-e2e-scanreport-${process.pid}`;
const MODULES =
  'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,org,masterdata,workbench,approval,demo';

const PG_PORT = 55512;
const PORT = 3597;
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;

function run(command: string, args: string[], options: { env?: Record<string, string>; capture?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function pgCount(sql: string): number {
  const result = run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'cadence', '-tAc', sql], {
    capture: true,
  });
  return result.status === 0 ? Number(result.stdout.trim()) : -1;
}

async function call(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: json as any };
}

interface ServerHandle {
  child: ReturnType<typeof spawn>;
  log: string[];
  exited: Promise<number | null>;
}

function startServer(): ServerHandle {
  const child = spawn(process.execPath, [`${ROOT}/apps/server/dist/main.js`], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL, MODULES_ENABLED: MODULES },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const collect = (chunk: Buffer) => log.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, log, exited };
}

async function waitHealthy(server: ServerHandle): Promise<boolean> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    if (server.child.exitCode !== null) return false;
    await delay(500);
  }
  return false;
}

async function stopServer(server: ServerHandle | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([server.exited, delay(8000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await server.exited.catch(() => {});
  }
}

// ---- 页面侧真实模块（vite 管道；stubEnv/stubGlobal 先于 import） ----
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key: string) => storageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void storageBacking.set(key, value),
  removeItem: (key: string) => void storageBacking.delete(key),
  clear: () => storageBacking.clear(),
  key: () => null,
  get length() {
    return storageBacking.size;
  },
};

/** 真实登录并把 token 写进页面会话存储 stub（apiClient Bearer 注入源）。 */
async function loginAndSeedSession(username: string): Promise<string> {
  const login = await call('POST', '/auth/login', { body: { username, password: 'demo-password' } });
  expect([200, 201], `登录 ${username} 应 2xx`).toContain(login.status);
  const { createBrowserTokenSessionStore, TOKEN_SESSION_STORAGE_KEY } = await import('@smes/product-ui');
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: login.body.user.id,
    // 登录响应的租户字段在 user.tenant（UserAccount 形状；product-ui toSession
    // 同映射）——写错键会令 parseTokenSession 读回 null、页面通道不带 Bearer
    tenantId: login.body.user.tenant,
    displayName: login.body.user.displayName,
    permissions: login.body.permissions,
    token: login.body.token,
    expiresAt: login.body.expiresAt,
  });
  return login.body.token as string;
}

let opCounter = 0;
function envelope(kind: string, payload: unknown, expectedRevision: unknown = 'initial') {
  opCounter += 1;
  return {
    operationId: `scanreport-e2e-${kind}-${opCounter}`,
    expectedRevision,
    command: { kind, payload },
  };
}

d('M5 正式 e2e：扫码报工真实通道（RUN_E2E=1 触发）', () => {
  let server: ServerHandle | null = null;
  let reportingApi: typeof import('../src/data/reportingApi.js');
  let reportDraft: typeof import('../src/pages/scan/reportDraft.js');
  let offline: typeof import('@smes/product-ui');
  let adminToken = '';
  let dispatchId = '';
  let workOrderId = '';

  beforeAll(async () => {
    // 1) 一次性容器
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    const up = run('docker', [
      'run', '-d', '--rm', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
      '-p', `${PG_PORT}:5432`, 'postgres:16',
    ]);
    if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'cadence'], { capture: true }).status === 0;
      if (!ready) await delay(500);
    }
    expect(ready, 'postgres:16 容器就绪').toBe(true);

    // 2) 构建（server 及其依赖；对齐 e2e-live-db 自包含模式）
    const buildOk = [
      run('pnpm', ['--filter', '@smes/application', 'build']),
      run('pnpm', ['--filter', '@smes/business-store', 'build']),
      run('pnpm', ['--filter', '@smes/server', 'build']),
    ].every((result) => result.status === 0);
    expect(buildOk, '三包构建（application / business-store / server）').toBe(true);

    // 3) 迁移 + 种子
    const migrate = run(
      'pnpm',
      ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { env: { DATABASE_URL } },
    );
    expect(migrate.status, 'prisma migrate deploy').toBe(0);
    const seed = run('node', [`${ROOT}/packages/business-store/prisma/seed.mjs`], {
      env: { DATABASE_URL },
      capture: true,
    });
    expect(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`).toBe(true);

    // 4) 起 server（真实认证：不开 SMES_DEV_AUTH）
    server = startServer();
    if (!(await waitHealthy(server))) {
      throw new Error(`server 未就绪，日志尾部：\n${server.log.slice(-25).join('')}`);
    }

    // 5) 页面真实模块加载（stub 先行：API_BASE 指向真实 server；window.localStorage 供 Bearer 注入）
    vi.stubEnv('VITE_API_BASE_URL', BASE);
    vi.stubGlobal('window', {
      localStorage: localStorageStub,
      location: { pathname: '/', assign: () => {} },
    });
    reportingApi = await import('../src/data/reportingApi.js');
    reportDraft = await import('../src/pages/scan/reportDraft.js');
    offline = await import('@smes/product-ui');
  }, 600_000);

  afterAll(async () => {
    await stopServer(server);
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    vi.unstubAllGlobals();
  }, 60_000);

  it('门禁：无 Bearer → 401；无策略 viewer → 403（report:submit 精确码门禁证据）', async () => {
    const anonymous = await call('POST', '/reports', {
      body: envelope('report.submit.v1', { dispatchId: 'dsp-any', doneQty: 1, laborMinutes: 1, businessTime: null, remark: null }),
    });
    expect(anonymous.status).toBe(401);

    await loginAndSeedSession('viewer');
    const viewerSubmit = await call('POST', '/reports', {
      headers: { authorization: `Bearer ${storageReadToken()}` },
      body: envelope('report.submit.v1', { dispatchId: 'dsp-any', doneQty: 1, laborMinutes: 1, businessTime: null, remark: null }),
    });
    expect(viewerSubmit.status).toBe(403);
  });

  it('在线路径：登录 → 建工作令/派工单/派工 → 页面通道提交 → committed → 列表读回 + 落库取证', async () => {
    // demo-admin = user-demo-admin（种子注释"Web 演示管理员，真实登录流同款"）——
    // 与浏览器登录页演示凭据同路径；登 'admin' 则 reporter 为 user-seed-admin
    adminToken = await loginAndSeedSession('demo-admin');

    const wo = await call('POST', '/workorder/work-orders', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: envelope('workorder.create.v1', { projectName: 'M5-e2e-扫码报工' }),
    });
    expect(wo.status, `工作令创建：${JSON.stringify(wo.body)}`).toBe(201);
    workOrderId = wo.body.workOrder.id;

    const dispatch = await call('POST', '/dispatch/orders', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: envelope('dispatch.create.v1', {
        workOrderId,
        kind: 'part',
        drawingNo: 'DWG-M5-E2E-01',
        operationCode: 'OP-10',
        quantity: 20,
      }),
    });
    expect(dispatch.status, `派工单创建：${JSON.stringify(dispatch.body)}`).toBe(201);
    dispatchId = dispatch.body.dispatchOrder.id;

    const assigned = await call('POST', `/dispatch/orders/${dispatchId}/assign`, {
      headers: { authorization: `Bearer ${adminToken}` },
      body: envelope('dispatch.assign.v1', { assignee: 'user-demo-admin', remark: null }, dispatch.body.dispatchOrder.objectVersion),
    });
    expect(assigned.body.status, `派工指派：${JSON.stringify(assigned.body)}`).toBe('committed');

    // 页面真实通道提交（ref = 派工单 id —— 扫码/手填对象引用语义）
    const submission = reportDraft.buildReportDraftSubmission({
      key: 'rpt-m5-e2e-online-0001',
      ref: dispatchId,
      quantity: 8,
      laborMinutes: 90,
      note: 'M5 在线路径实证',
      submittedAt: '2026-10-25T08:30:00.000Z',
    });
    await expect(reportingApi.submitReportDraft(submission)).resolves.toBeUndefined();

    const list = await call('GET', `/reports?dispatchId=${dispatchId}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.status).toBe(200);
    const row = list.body.reports.find((report: any) => report.dispatchId === dispatchId && report.doneQty === 8);
    expect(row, `列表读回报工行：${JSON.stringify(list.body.reports)}`).toBeTruthy();
    expect(row.state).toBe('reported'); // SUBMIT 后 reported@v2
    expect(row.laborMinutes).toBe(90); // 草稿真实录入直传（M5 首波起 api 层缺省 1 占位已移除）
    expect(row.remark).toBe('M5 在线路径实证');
    expect(row.businessTime).toBe('2026-10-25T08:30:00.000Z'); // submittedAt → businessTime
    expect(row.reporter).toBe('user-demo-admin'); // 申报人 = 命令签发人（本人）

    const inDb = pgCount(`select count(*) from work_reports where dispatch_id = '${dispatchId}'`);
    expect(inDb).toBe(1);
    const opsInDb = pgCount("select count(*) from reporting_operations where aggregate_type = 'work-report'");
    expect(opsInDb).toBeGreaterThanOrEqual(1);
  });

  it('幂等：同 key（→ operationId）重发 → rejected（离线重放不产生重复报工的依据）', async () => {
    const duplicate = reportDraft.buildReportDraftSubmission({
      key: 'rpt-m5-e2e-online-0001',
      ref: dispatchId,
      quantity: 8,
      laborMinutes: 90,
      note: 'M5 在线路径实证',
      submittedAt: '2026-10-25T08:30:00.000Z',
    });
    await expect(reportingApi.submitReportDraft(duplicate)).rejects.toThrow(/报工被拒绝.*幂等/);
    const inDb = pgCount(`select count(*) from work_reports where dispatch_id = '${dispatchId}'`);
    expect(inDb).toBe(1); // 无重复行
  });

  it('离线路径：server 停（API 不可达）→ 入队 → 序列化往返 → server 恢复 → FIFO 重放 → 落库读回', async () => {
    // ---- 断网：server 停 ----
    await stopServer(server);
    server = null;
    // 停机后页面通道提交应失败（fetch 不可达）——离线入队兜底的触发条件
    const unreachable = reportDraft.buildReportDraftSubmission({
      key: 'rpt-m5-e2e-offline-0001',
      ref: dispatchId,
      quantity: 3,
      laborMinutes: 45,
      note: null,
      submittedAt: '2026-10-25T09:00:00.000Z',
    });
    await expect(reportingApi.submitReportDraft(unreachable)).rejects.toThrow();

    // ---- 页面同款装配：OfflineQueue + 守卫入队 2 条（FIFO 顺序）----
    const QUEUE_NAME = 'report-draft';
    const queue = offline.createOfflineQueue<import('../src/pages/scan/reportDraft.js').ReportDraftSubmission>({
      name: QUEUE_NAME,
      isPayload: reportDraft.isReportDraftSubmission,
    });
    queue.enqueue(unreachable.key, unreachable);
    const second = reportDraft.buildReportDraftSubmission({
      key: 'rpt-m5-e2e-offline-0002',
      ref: dispatchId,
      quantity: 4,
      laborMinutes: 30,
      note: '第二条（顺序证据）',
      submittedAt: '2026-10-25T09:05:00.000Z',
    });
    queue.enqueue(second.key, second);
    expect(queue.size()).toBe(2);

    // 序列化往返（页面 localStorage 持久化语义：serialize → hydrate）
    const raw = queue.serialize();
    const restored = offline.hydrateOfflineQueue<import('../src/pages/scan/reportDraft.js').ReportDraftSubmission>(raw, {
      name: QUEUE_NAME,
      isPayload: reportDraft.isReportDraftSubmission,
    });
    expect(restored?.pending().map((entry) => entry.key)).toEqual(['rpt-m5-e2e-offline-0001', 'rpt-m5-e2e-offline-0002']);

    // ---- 恢复：server 重启 + 重新登录（现场长会话跨重启的等价路径：PG 会话存活，
    //      此处重新 login 刷新 stub 内 token——两种都走真实 Bearer）----
    server = startServer();
    expect(await waitHealthy(server), 'server 重启就绪').toBe(true);
    adminToken = await loginAndSeedSession('admin');

    // ---- 重放（页面同款：queue.replay(submitReportDraft)）----
    const summary = await restored!.replay((entry) => reportingApi.submitReportDraft(entry.payload));
    expect(summary, `重放摘要：${JSON.stringify(summary)}`).toMatchObject({ attempted: 2, done: 2, failed: 0, remaining: 0 });
    expect(restored!.size()).toBe(0);

    // ---- 落库读回（列表端点 + psql 双取证）----
    const list = await call('GET', `/reports?dispatchId=${dispatchId}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.status).toBe(200);
    const rows = list.body.reports.filter((report: any) => report.dispatchId === dispatchId);
    expect(rows).toHaveLength(3); // 在线 1 + 重放 2
    const qty3 = rows.find((report: any) => report.doneQty === 3);
    const qty4 = rows.find((report: any) => report.doneQty === 4);
    expect(qty3?.remark).toBeNull();
    expect(qty4?.remark).toBe('第二条（顺序证据）');

    const inDb = pgCount(`select count(*) from work_reports where dispatch_id = '${dispatchId}'`);
    expect(inDb).toBe(3);
  });
});

/** 从 stub 存储读当前 token（门禁断言用）。 */
function storageReadToken(): string {
  const raw = storageBacking.get('cadence.session.v2');
  if (raw === undefined) return '';
  try {
    return (JSON.parse(raw) as { token?: string }).token ?? '';
  } catch {
    return '';
  }
}
