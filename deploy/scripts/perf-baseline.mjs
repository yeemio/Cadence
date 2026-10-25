#!/usr/bin/env node
/**
 * API 性能基线（V2 收官线：deploy/scripts 泳道）。
 *
 * 定位（写明，防误用）：本脚本产出**基线数字**（p50/p95/p99），供后续验收
 * 对照立锚。**无阈值判定**——决策簿 p95 目标未定，基线不宣称"达标/不达标"。
 *
 * 方法（与 apps/server/scripts/e2e-live-db.mjs 同体例的一次性栈）：
 *   随机端口起 docker postgres:16 → migrate deploy → 组织种子 → 起 server
 *   （DATABASE_URL 指该库；MODULES_ENABLED = 浏览器 e2e 同清单 16 码：
 *   core + 九循环 + org/masterdata/workbench/approval/demo + standardreports
 *   ——T1 前该清单为 15 码，T1 补登 standardreports 后为 16，历史口径"15 模块
 *   栈"即此清单）→ **真实登录**（POST /auth/login，种子演示管理员；不开
 *   SMES_DEV_AUTH）→ 对五个核心端点逐个打请求：
 *     每端点 5 次预热（不计）+ 100 次串行计量（计入 p50/p95/p99）。
 *   计时口径：fetch 发起 → 响应体完整读回（await text()）的往返墙钟，
 *   performance.now() 毫秒；串行发送（单用户时延形态，非并发吞吐）。
 *
 * 端点（合同指定五枚）：
 *   GET  /health                  ——进程存活（无鉴权）
 *   GET  /workbench/summary       ——工作台聚合读
 *   GET  /workorder/work-orders   ——工作令列表读
 *   POST /standard-reports/query  ——标准报表求值（metricId=inventory-movements，
 *                                   宽时间窗 2020→2030，空库形态）
 *   GET  /masterdata/items        ——主数据列表读
 *
 * 环境说明（写进产物）：种子后近空库（组织/用户/角色，无业务行）——数字
 * 反映"冷数据形态"的框架+查询机器开销，不代表生产数据量下的表现；后续
 * 验收若在灌数环境重跑，须重立基线而非对照本表。
 *
 * 构建：三包 build 失败且无既有 dist → 硬失败；失败但 dist 存在 → 警告并
 * 沿用既有 dist（体例同 packages/testkit/e2e/scripts/global-setup.ts——
 * 容忍并行线在途中间态，本脚本不因兄弟泳道半成品而不可运行）。
 *
 * 产物：deploy/scripts/perf-baseline-<YYYYMMDD>.md（运行日本地时区命名；
 * 2026-10-26 首跑 = perf-baseline-20261026.md）+ stdout 同文表格。
 *
 * 用法：node deploy/scripts/perf-baseline.mjs   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 运行日本地时区日期（toISOString 是 UTC——本地凌晨跑会差一天，产物名以本地日为准）。 */
function localDateStamp(date = new Date()) {
  const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { local, stamp: local.replaceAll('-', '') };
}
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), `perf-baseline-${localDateStamp().stamp}.md`);

const WARMUP = 5;
const MEASURED = 100;

/** 随机空闲端口（listen(0) 借位后释放；竞态由重试兜底）。 */
async function freePort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = net.createServer();
    const port = await new Promise((resolvePort, rejectPort) => {
      server.once('error', rejectPort);
      server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
    });
    await new Promise((resolveClose) => server.close(resolveClose));
    if (typeof port === 'number' && port > 0) return port;
  }
  throw new Error('随机端口分配失败');
}

const PG_PORT = await freePort();
const PORT_MAIN = await freePort();
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-perf-baseline-${process.pid}`;

/** 与 packages/testkit/e2e/scripts/env.ts 同清单（T1 后 16 码；历史称"15 模块栈"）。 */
const MODULES =
  'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,org,masterdata,workbench,approval,demo,standardreports';

/** 种子演示管理员（prisma/seed.mjs；口令 demo-password）——真实登录，非 dev 回落。 */
const DEMO_ADMIN = { username: 'demo-admin', password: 'demo-password' };

function run(command, args, options = {}) {
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

function buildOrReuse(filter, distRel) {
  const built = run('pnpm', ['--filter', filter, 'build'], { capture: true });
  if (built.status === 0) return `build`;
  if (existsSync(resolve(ROOT, distRel))) {
    console.warn(`[perf-baseline] 警告：${filter} 构建失败（并行线在途？），沿用既有 dist`);
    return 'reuse-dist';
  }
  throw new Error(`${filter} 构建失败且无既有 dist：${built.stderr.slice(-400)}`);
}

async function call(method, path, { headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT_MAIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, text, json };
}

let serverHandle = null;

function startServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'apps/server/dist/main.js')], {
    env: { ...process.env, PORT: String(PORT_MAIN), DATABASE_URL, MODULES_ENABLED: MODULES },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const collect = (chunk) => log.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, log, exited };
}

async function waitHealthy(server) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT_MAIN}/health`);
      if (response.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    if (server.child.exitCode !== null) return false;
    await delay(500);
  }
  return false;
}

async function stopServer(server) {
  if (server === null || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([server.exited, delay(8000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await server.exited.catch(() => {});
  }
}

/** 最近邻秩法百分位（sorted 升序；p ∈ (0,100]）。 */
function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

const ENDPOINTS = [
  { name: 'GET /health', method: 'GET', path: '/health', auth: false },
  { name: 'GET /workbench/summary', method: 'GET', path: '/workbench/summary', auth: true },
  { name: 'GET /workorder/work-orders', method: 'GET', path: '/workorder/work-orders', auth: true },
  {
    name: 'POST /standard-reports/query',
    method: 'POST',
    path: '/standard-reports/query',
    auth: true,
    body: { metricId: 'inventory-movements', from: '2020-01-01T00:00:00Z', to: '2030-12-31T23:59:59Z' },
  },
  { name: 'GET /masterdata/items', method: 'GET', path: '/masterdata/items', auth: true },
];

async function main() {
  console.log(`[perf-baseline] 容器 ${CONTAINER}，PG 随机端口 ${PG_PORT}，server 端口 ${PORT_MAIN}`);
  console.log(`[perf-baseline] MODULES_ENABLED=${MODULES}（${MODULES.split(',').length} 码）`);

  // 1) 一次性 postgres 容器
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
  if (!ready) throw new Error('postgres:16 容器未就绪');

  // 2) 构建（失败沿用既有 dist，见文件头）
  const buildStates = [
    buildOrReuse('@smes/application', 'packages/application/dist'),
    buildOrReuse('@smes/business-store', 'packages/business-store/dist'),
    buildOrReuse('@smes/server', 'apps/server/dist'),
  ];

  // 3) 迁移 + 种子
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy 失败：${migrate.stderr.slice(-400)}`);
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  if (!(seed.status === 0 && /seed 完成/.test(seed.stdout))) {
    throw new Error(`组织种子失败：${seed.stdout.trim()} ${seed.stderr.trim()}`);
  }

  // 4) 起 server（真实认证：不开 SMES_DEV_AUTH）
  const server = startServer();
  serverHandle = server;
  if (!(await waitHealthy(server))) {
    throw new Error(`server 未就绪，日志尾部：\n${server.log.slice(-25).join('')}`);
  }

  // 5) 真实登录（admin 演示账号 → Bearer；时延记入环境信息不计入端点序列）
  const loginStart = performance.now();
  const login = await call('POST', '/auth/login', { body: DEMO_ADMIN });
  const loginMs = performance.now() - loginStart;
  const token = login.json?.token;
  if (login.status !== 201 || typeof token !== 'string') {
    throw new Error(`真实登录失败：HTTP ${login.status} ${login.text.slice(0, 200)}`);
  }
  const bearer = { authorization: `Bearer ${token}` };

  // 6) 逐端点：预热 + 串行计量
  const results = [];
  for (const endpoint of ENDPOINTS) {
    const headers = endpoint.auth ? bearer : {};
    for (let i = 0; i < WARMUP; i += 1) {
      const warm = await call(endpoint.method, endpoint.path, { headers, body: endpoint.body });
      if (!(warm.status >= 200 && warm.status < 300)) {
        throw new Error(`预热失败 ${endpoint.name}：HTTP ${warm.status} ${warm.text.slice(0, 200)}`);
      }
    }
    const samples = [];
    let errors = 0;
    for (let i = 0; i < MEASURED; i += 1) {
      const start = performance.now();
      const response = await call(endpoint.method, endpoint.path, { headers, body: endpoint.body });
      const elapsed = performance.now() - start;
      if (response.status >= 200 && response.status < 300) {
        samples.push(elapsed);
      } else {
        errors += 1;
        console.error(`[perf-baseline] 非 2xx：${endpoint.name} → HTTP ${response.status} ${response.text.slice(0, 120)}`);
      }
    }
    if (errors > 0 || samples.length === 0) {
      throw new Error(`${endpoint.name} 计量失败 ${errors}/${MEASURED} 次——基线无效`);
    }
    samples.sort((a, b) => a - b);
    results.push({
      name: endpoint.name,
      n: samples.length,
      errors,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      min: samples[0],
      max: samples[samples.length - 1],
    });
    console.log(
      `[perf-baseline] ${endpoint.name}：n=${results.at(-1).n} p50=${results.at(-1).p50.toFixed(1)}ms p95=${results.at(-1).p95.toFixed(1)}ms p99=${results.at(-1).p99.toFixed(1)}ms min=${results.at(-1).min.toFixed(1)}ms max=${results.at(-1).max.toFixed(1)}ms`,
    );
  }

  // 7) 基线产物（无阈值判定——决策簿 p95 目标未定，见文件头）
  const nodeVersion = process.version;
  const now = new Date();
  const { local } = localDateStamp(now);
  const lines = [];
  lines.push(`# API 性能基线（${local} 本地 / ${now.toISOString()} UTC）`);
  lines.push('');
  lines.push('产出：deploy/scripts/perf-baseline.mjs 一次性栈实跑（docker postgres:16 + server dist）。');
  lines.push('');
  lines.push(`## 基线表（${MEASURED} 次串行请求/端点，${WARMUP} 次预热不计）`);
  lines.push('');
  lines.push(`| 端点 | n | p50 (ms) | p95 (ms) | p99 (ms) | min | max | 非2xx |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.min.toFixed(1)} | ${r.max.toFixed(1)} | ${r.errors} |`,
    );
  }
  lines.push('');
  lines.push('## 环境与方法说明');
  lines.push('');
  lines.push(`- 栈：docker postgres:16（一次性容器，随机端口）+ apps/server/dist/main.js（Node ${nodeVersion}，本机 darwin arm64）。`);
  lines.push(`- MODULES_ENABLED=${MODULES}（${MODULES.split(',').length} 码——历史口径"15 模块栈"T1 后补登 standardreports 为 16）。`);
  lines.push(`- 鉴权：真实登录 POST /auth/login（种子演示管理员；单次登录时延 ${loginMs.toFixed(1)}ms，未计入端点序列；计量请求走 Bearer token）。`);
  lines.push(`- 数据形态：迁移+组织种子后的**近空库**（组织/用户/角色，无业务行）——数字反映框架+查询机器的冷数据开销，不代表生产数据量；灌数环境重跑须重立基线。`);
  lines.push(`- 方法：每端点 ${WARMUP} 次预热（不计）+ ${MEASURED} 次串行请求；计时 = fetch 发起至响应体完整读回的往返墙钟；连接复用走 Node fetch(undici) 缺省 keep-alive；同机回环网络（无真实网络抖动）。`);
  lines.push(`- 构建形态：${buildStates.join(' / ')}（reuse-dist = 沿用既有 dist，见脚本文件头容忍策略）。`);
  lines.push('');
  lines.push('## 判定声明（无阈值）');
  lines.push('');
  lines.push('**本基线不含达标判定**：决策簿 p95 目标未定，本表只为后续验收立锚（对照口径 = 同脚本同环境重跑的 p50/p95/p99 变化）。任何"达标/不达标"结论须等 Owner 定阈值后另行出具。');
  lines.push('');
  const content = lines.join('\n');
  writeFileSync(OUT, content, 'utf8');
  console.log(`[perf-baseline] 基线已写入 ${OUT}`);
}

try {
  await main();
} finally {
  await stopServer(serverHandle);
  run('docker', ['rm', '-f', CONTAINER], { capture: true });
  console.log('[perf-baseline] 栈已拆除（server / docker 容器）');
}
