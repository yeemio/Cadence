/**
 * M5 性能验收测量（node 真实 fetch 计时，零新增依赖；Playwright 不在
 * devDeps——按 M5 派发指示走 node fetch 通道）。
 *
 * 测量面（对齐移动四页真实流量）：
 * - 文档：/m /m/report /m/hours /m/stock（mobileRouteFallback 服务端回落
 *   index.html 后深链 200；四页共享同一文档，数字差异体现服务路径分支）。
 * - 关键资产：从 / 的 html 解析 /assets/* 引用（css + 入口 js + preload js），
 *   每个资产单独测；html5-qrcode 懒块不算关键资产（首屏不加载）。
 * - 组合冷加载：文档 + 全部关键资产串行取完的总时长（无缓存浏览器加载的
 *   下界——不含解析/执行/渲染，也不含真实网络 RTT）。
 * - 核心 API：移动页挂载即调的四个读端点 + 公开 /health（形状见下表）；
 *   认证经 SMES_DEV_AUTH=on 的 dev 头（生产 Bearer 路径在同一守卫内多一次
 *   会话查表，零 DB 内存会话下差异可忽略——如实声明）。
 *
 * 方法：每目标预热 5 次丢弃，N 次（缺省 60）串行请求（undici 全局连接池
 * keep-alive 复用，模拟浏览器同源复用）；计时覆盖 fetch 发起 → 响应体完整
 * 收下；p50/p95 用 nearest-rank 法。本机回环测量，数字 = 服务处理 + 传输。
 *
 * 前置（见 PERF-M5.md 环境节）：
 * - API：SMES_DEV_AUTH=on SMES_DEV_POLICY_ENDPOINT=on \
 *         MODULES_ENABLED=core,org,masterdata,workbench,hours,inventory \
 *         PORT=<p> node dist/main.js（零 DB 内存形态）
 * - Web：vite preview（产物 = pnpm build 最新产物）
 * 本脚本自带策略注入（POST /dev/policies，幂等），注入失败即退出非零。
 *
 * 用法：node scripts/perf-m5.mjs [--web http://localhost:4173]
 *       [--api http://127.0.0.1:3988] [--n 60] [--markdown out.md]
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const WEB = argOf('--web', 'http://localhost:4173');
const API = argOf('--api', 'http://127.0.0.1:3988');
const N = Number(argOf('--n', '60'));
const OUT = argOf('--markdown', null);
const WARMUP = 5;
const DEV_HEADERS = { 'x-smes-user': 'perf-user' };

const lines = [];
const emit = (text = '') => {
  console.log(text);
  lines.push(text);
};

/** 单次计时 fetch：发起 → 响应体完整收下（含传输）。 */
async function timedFetch(url, options = {}) {
  const t0 = performance.now();
  const res = await fetch(url, options);
  const body = await res.arrayBuffer();
  const ms = performance.now() - t0;
  return { ms, status: res.status, bytes: body.byteLength };
}

/** nearest-rank 百分位（sorted 升序）。 */
const pct = (sorted, p) => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];

async function measure({ label, url, headers, expectStatus = 200 }) {
  for (let i = 0; i < WARMUP; i += 1) {
    const r = await timedFetch(url, { headers });
    if (r.status !== expectStatus) {
      throw new Error(`预热即失败：${label} ${url} → HTTP ${r.status}（期望 ${expectStatus}）`);
    }
  }
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < N; i += 1) {
    const r = await timedFetch(url, { headers });
    if (r.status !== expectStatus) {
      throw new Error(`采样失败：${label} ${url} → HTTP ${r.status}（期望 ${expectStatus}）`);
    }
    samples.push(r.ms);
    bytes = r.bytes;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return { label, url, n: N, p50: pct(sorted, 50), p95: pct(sorted, 95), min: sorted[0], max: sorted[sorted.length - 1], mean, bytes };
}

function emitTable(title, rows) {
  emit(`\n### ${title}\n`);
  emit('| 测量点 | n | p50 (ms) | p95 (ms) | min (ms) | max (ms) | 均值 (ms) | 载荷 (B) |');
  emit('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    emit(`| ${r.label} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.min.toFixed(1)} | ${r.max.toFixed(1)} | ${r.mean.toFixed(1)} | ${r.bytes} |`);
  }
}

// ---- 0) 就绪探针 ----
const webRoot = await timedFetch(`${WEB}/`);
if (webRoot.status !== 200) throw new Error(`web 未就绪：${WEB}/ → HTTP ${webRoot.status}`);
const health = await timedFetch(`${API}/health`);
if (health.status !== 200) throw new Error(`api 未就绪：${API}/health → HTTP ${health.status}`);

// ---- 1) 策略注入（幂等）：perf-user → perf-role → 三读权限 ----
const policyBody = {
  rules: [
    { kind: 'grant-role', tenant: 'default', user: 'perf-user', role: 'perf-role' },
    { kind: 'grant-permission', tenant: 'default', role: 'perf-role', resource: 'workbench', action: 'read' },
    { kind: 'grant-permission', tenant: 'default', role: 'perf-role', resource: 'hours', action: 'read' },
    { kind: 'grant-permission', tenant: 'default', role: 'perf-role', resource: 'stock', action: 'read' },
  ],
};
const policyRes = await fetch(`${API}/dev/policies`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(policyBody),
});
if (policyRes.status !== 200) {
  throw new Error(`策略注入失败 HTTP ${policyRes.status}（SMES_DEV_POLICY_ENDPOINT=on 未开？）：${await policyRes.text()}`);
}
emit(`[perf-m5] 策略注入 OK：${(await policyRes.json()).applied} 条；web=${WEB} api=${API} n=${N}`);

// ---- 2) 关键资产解析（入口 html 引用的 /assets/*；懒块不含） ----
const html = await (await fetch(`${WEB}/`)).text();
const assetUrls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (assetUrls.length === 0) throw new Error('入口 html 未解析到 /assets/* 引用');

// ---- 3) 测量 ----
const docRows = [];
for (const route of ['/m', '/m/report', '/m/hours', '/m/stock']) {
  docRows.push(await measure({ label: `文档 ${route}`, url: `${WEB}${route}` }));
}

const assetRows = [];
for (const asset of assetUrls) {
  assetRows.push(await measure({ label: `资产 ${asset.replace('/assets/', '')}`, url: `${WEB}${asset}` }));
}

// 组合冷加载：文档 + 关键资产串行一遍
{
  const samples = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now();
    await timedFetch(`${WEB}/m`);
    for (const asset of assetUrls) await timedFetch(`${WEB}${asset}`);
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  docRows.push({
    label: '组合冷加载 /m（文档+关键资产串行）', n: N, p50: pct(sorted, 50), p95: pct(sorted, 95),
    min: sorted[0], max: sorted[sorted.length - 1],
    mean: samples.reduce((s, v) => s + v, 0) / samples.length, bytes: '-',
  });
}

const apiRows = [];
for (const [label, path] of [
  ['GET /health（公开）', '/health'],
  ['GET /workbench/summary', '/workbench/summary'],
  ['GET /workbench/todos', '/workbench/todos'],
  ['GET /hours/my', '/hours/my'],
  ['GET /inventory/stock', '/inventory/stock'],
]) {
  apiRows.push(await measure({ label, url: `${API}${path}`, headers: DEV_HEADERS }));
}

emitTable('移动四页·文档与组合加载（vite preview × 生产 build 产物）', docRows);
emitTable('关键资产（入口引用的 /assets/*）', assetRows);
emitTable('核心 API（零 DB 内存形态，dev 头认证）', apiRows);
emit('');

if (OUT) {
  writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`[perf-m5] 数字表已写入 ${OUT}`);
}
