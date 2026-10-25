/**
 * 审批纵贯端到端验证（M1 收尾波-①：engine-flow 进组合根）。
 *
 * 一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy（四份）→ 种子（admin/viewer/approver——approver 持
 *   approval:read/write + workbench:read 精确授权，无 bypass）→ 起 server
 *   （DATABASE_URL 指容器，默认六模块）→ admin 以通用 item 引用发起审批 →
 *   审批人待办出现（summary 计数）→ 无权限身份 403 → 审批人 approve（带
 *   reason 与版本声明）→ 案件 approved + 其待办 done + 事件/记录落库可查 →
 *   reject 路径一例 → 过期 objectVersion 被拒（409）→ 列表状态过滤 →
 *   重启 server 后案件/记录/事件存活。
 *
 * 用法：pnpm --filter @smes/server approval:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55493;
const PORT_MAIN = 3596;
const PORT_RESTART = 3597;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-approval-${process.pid}`;

const ADMIN = 'user-seed-admin';
const VIEWER = 'user-seed-viewer';
const APPROVER = 'user-seed-approver';
const AUTH = { 'x-smes-user': ADMIN };
const APPROVER_AUTH = { 'x-smes-user': APPROVER };

let failures = 0;

function pass(message) {
  console.log(`PASS: ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

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

async function call(port, method, path, { headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: json };
}

function startServer(port, extraEnv = {}) {
  // SMES_DEV_AUTH=on（收尾波-③）：本脚本全部身份断言基于 x-smes-user dev 回落
  // 头——真实认证后该路径默认关闭，测试环境显式开启（extraEnv 可覆盖）。
  const env = { ...process.env, SMES_DEV_AUTH: 'on', PORT: String(port), ...extraEnv };
  const child = spawn(process.execPath, [resolve(ROOT, 'apps/server/dist/main.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const collect = (chunk) => log.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, log, exited };
}

async function waitHealthy(port, server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    const { exited } = server;
    if (exited !== undefined && server.child.exitCode !== null) break;
    await delay(500);
  }
  return false;
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([server.exited, delay(8000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await server.exited.catch(() => {});
  }
}

async function main() {
  console.log(`[e2e-approval] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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
  assert(ready, 'postgres:16 容器就绪');

  // 2) 构建（自包含：application → business-store（含 prisma generate）→ server）
  const buildOk = [
    run('pnpm', ['--filter', '@smes/application', 'build']),
    run('pnpm', ['--filter', '@smes/business-store', 'build']),
    run('pnpm', ['--filter', '@smes/server', 'build']),
  ].every((result) => result.status === 0);
  assert(buildOk, '三包构建（application / business-store / server）');

  // 3) 迁移 deploy（四份迁移入库）+ 种子（admin/viewer/approver + 审批演示策略）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（四份迁移入库）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `种子（含 approver 审批演示策略）：${seed.stdout.trim()}`);

  // 4) 起 server A（默认六模块：approval 进默认装配）
  const mainServer = startServer(PORT_MAIN, { DATABASE_URL });
  if (!(await waitHealthy(PORT_MAIN, mainServer))) {
    fail(`server A 未就绪，日志尾部：\n${mainServer.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（DATABASE_URL=postgres，六模块默认装配）');

  const modules = await call(PORT_MAIN, 'GET', '/modules');
  assert(modules.status === 200 && JSON.stringify(modules.body?.modules) === JSON.stringify(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']),
    `GET /modules → ${modules.status} ${JSON.stringify(modules.body?.modules)}`);

  // 5) admin 以通用 item 引用为被审批对象（masterdata 纵贯既有端点）
  const item = await call(PORT_MAIN, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: 'P-8001', name: '审批对象样品', spec: 'A-1', unit: '件', category: 'part' },
  });
  const itemId = item.body?.id;
  assert(item.status === 201 && typeof itemId === 'string', `POST /masterdata/items（审批对象）→ ${item.status}`);

  // 6) admin 发起审批 → 案件 in_review@v3（SUBMIT + START_REVIEW 两跳）
  const created = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: {
      subjectRef: { type: 'item', id: itemId },
      approvers: [APPROVER],
      title: '请审批这批样品',
      reason: '采购放行前请审批',
    },
  });
  const case1 = created.body?.case?.id;
  assert(created.status === 201 && created.body?.case?.state === 'in_review' &&
    created.body?.case?.objectVersion === 3 && created.body?.case?.subjectRef?.id === itemId,
    `POST /approval/cases（admin 发起，通用 item 引用）→ ${created.status} state=${created.body?.case?.state} v${created.body?.case?.objectVersion}`);
  assert(Array.isArray(created.body?.events) && created.body.events.length === 2,
    `发起即落两条迁移事件（submitted + review-started）→ ${created.body?.events?.length}`);
  const badStart = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'item', id: itemId }, approvers: [], reason: 'x' },
  });
  assert(badStart.status === 400, `POST /approval/cases 空审批人 → ${badStart.status}（400 输入）`);

  // 7) 审批人待办出现（summary 计数：source=approval +1）
  const summaryBefore = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: APPROVER_AUTH });
  assert(summaryBefore.status === 200 && summaryBefore.body?.openTotal === 1 &&
    JSON.stringify(summaryBefore.body?.bySource) === JSON.stringify([{ source: 'approval', open: 1 }]),
    `审批人待办出现：GET /workbench/summary → ${summaryBefore.status} ${JSON.stringify(summaryBefore.body)}`);
  const todosBefore = await call(PORT_MAIN, 'GET', '/workbench/todos', { headers: APPROVER_AUTH });
  assert(todosBefore.status === 200 && todosBefore.body?.todos?.length === 1 &&
    todosBefore.body?.todos?.[0]?.refId === case1 && todosBefore.body?.todos?.[0]?.source === 'approval',
    `GET /workbench/todos（审批人）→ 1 条 refId=案件 id`);

  // 8) 无权限身份 403（viewer 无任何策略：读与决策全拒）
  const viewerList = await call(PORT_MAIN, 'GET', '/approval/cases', { headers: { 'x-smes-user': VIEWER } });
  assert(viewerList.status === 403, `GET /approval/cases（viewer 无策略）→ ${viewerList.status}（403 门禁）`);
  const viewerDecide = await call(PORT_MAIN, 'POST', `/approval/cases/${case1}/decisions`, {
    headers: { 'x-smes-user': VIEWER },
    body: { decision: 'approve', reason: '越权尝试' },
  });
  assert(viewerDecide.status === 403, `POST /approval/cases/:id/decisions（viewer）→ ${viewerDecide.status}（403 门禁）`);

  // 9) 审批人 approve（带 reason + 版本声明）→ 案件 approved@v4 + 其待办 done
  const approved = await call(PORT_MAIN, 'POST', `/approval/cases/${case1}/decisions`, {
    headers: APPROVER_AUTH,
    body: { decision: 'approve', reason: '同意放行', objectVersion: 3 },
  });
  assert(approved.status === 201 && approved.body?.case?.state === 'approved' && approved.body?.case?.objectVersion === 4,
    `审批人 approve → ${approved.status} state=${approved.body?.case?.state} v${approved.body?.case?.objectVersion}`);
  assert(approved.body?.record?.decision === 'approve' && approved.body?.record?.reason === '同意放行',
    `决策记录落账 → ${JSON.stringify(approved.body?.record?.decision)}`);
  const summaryAfter = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: APPROVER_AUTH });
  assert(summaryAfter.status === 200 && summaryAfter.body?.openTotal === 0 && summaryAfter.body?.bySource?.length === 0,
    `决策后本人待办自动 done：summary → openTotal=${summaryAfter.body?.openTotal}`);
  assert(Array.isArray(approved.body?.todosCompleted) && approved.body.todosCompleted.length === 1,
    '决策响应带本人完成的待办（幂等口径）');

  // 10) 事件与记录落库可查（GET 案件详情一次读回）
  const detail = await call(PORT_MAIN, 'GET', `/approval/cases/${case1}`, { headers: APPROVER_AUTH });
  const eventTypes = detail.body?.events?.map((event) => event.eventType);
  assert(detail.status === 200 &&
    JSON.stringify(eventTypes) === JSON.stringify([
      'smes.general-approval.v1.submitted',
      'smes.general-approval.v1.review-started',
      'smes.general-approval.v1.approved',
    ]),
    `GET /approval/cases/:id 事件账本可查 → ${JSON.stringify(eventTypes)}`);
  assert(detail.body?.records?.length === 1 && detail.body?.records?.[0]?.decision === 'approve',
    `GET /approval/cases/:id 决策记录可查 → ${detail.body?.records?.length} 条`);

  // 11) reject 路径一例
  const created2 = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'item', id: itemId }, approvers: [APPROVER], title: '第二件', reason: '再审一件' },
  });
  const case2 = created2.body?.case?.id;
  const rejected = await call(PORT_MAIN, `POST`, `/approval/cases/${case2}/decisions`, {
    headers: APPROVER_AUTH,
    body: { decision: 'reject', reason: '规格不符', objectVersion: 3 },
  });
  assert(rejected.status === 201 && rejected.body?.case?.state === 'rejected' && rejected.body?.record?.decision === 'reject',
    `reject 路径 → ${rejected.status} state=${rejected.body?.case?.state}`);

  // 12) 版本冲突：过期 objectVersion 被拒（409），且案件状态不变
  const created3 = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'item', id: itemId }, approvers: [APPROVER], title: '第三件', reason: '版本冲突用例' },
  });
  const case3 = created3.body?.case?.id;
  const stale = await call(PORT_MAIN, 'POST', `/approval/cases/${case3}/decisions`, {
    headers: APPROVER_AUTH,
    body: { decision: 'approve', reason: '过期版本', objectVersion: 2 },
  });
  assert(stale.status === 409, `过期 objectVersion=2（当前 3）→ ${stale.status}（409 拒绝）`);
  const case3Detail = await call(PORT_MAIN, 'GET', `/approval/cases/${case3}`, { headers: AUTH });
  assert(case3Detail.body?.case?.state === 'in_review' && case3Detail.body?.case?.objectVersion === 3,
    `被拒后案件未迁移 → state=${case3Detail.body?.case?.state} v${case3Detail.body?.case?.objectVersion}`);
  const finalStateErr = await call(PORT_MAIN, 'POST', `/approval/cases/${case1}/decisions`, {
    headers: AUTH,
    body: { decision: 'reject', reason: '终态再决策' },
  });
  assert(finalStateErr.status === 409, `终态案件再决策 → ${finalStateErr.status}（409 状态冲突）`);

  // 13) 列表 + 状态过滤
  const listAll = await call(PORT_MAIN, 'GET', '/approval/cases', { headers: AUTH });
  assert(listAll.status === 200 && listAll.body?.cases?.length === 3,
    `GET /approval/cases → ${listAll.body?.cases?.length} 件`);
  const listApproved = await call(PORT_MAIN, 'GET', '/approval/cases?state=approved', { headers: AUTH });
  assert(listApproved.status === 200 && listApproved.body?.cases?.length === 1 && listApproved.body?.cases?.[0]?.id === case1,
    `GET /approval/cases?state=approved → 只剩 ${listApproved.body?.cases?.length} 件（状态过滤）`);
  const listBad = await call(PORT_MAIN, 'GET', '/approval/cases?state=In Review', { headers: AUTH });
  assert(listBad.status === 400, `非法状态过滤参数 → ${listBad.status}（400）`);

  // 14) 重启存活：案件 / 记录 / 事件都在 PG
  await stopServer(mainServer);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库）');

  const detailAfter = await call(PORT_RESTART, 'GET', `/approval/cases/${case1}`, { headers: AUTH });
  assert(detailAfter.status === 200 && detailAfter.body?.case?.state === 'approved' &&
    detailAfter.body?.case?.objectVersion === 4 && detailAfter.body?.records?.length === 1 &&
    detailAfter.body?.events?.length === 3,
    `重启后案件/记录/事件存活 → approved@v4 records=${detailAfter.body?.records?.length} events=${detailAfter.body?.events?.length}`);
  const rejectedAfter = await call(PORT_RESTART, 'GET', `/approval/cases/${case2}`, { headers: AUTH });
  assert(rejectedAfter.body?.case?.state === 'rejected', '重启后 reject 案件存活（rejected）');
  const todosAfter = await call(PORT_RESTART, 'GET', '/workbench/todos', { headers: APPROVER_AUTH });
  assert(todosAfter.status === 200 && todosAfter.body?.todos?.filter((todo) => todo.refId === case1 && todo.status === 'done').length === 1,
    '重启后审批人待办 done 状态存活');
  await stopServer(reborn);

  console.log(`\n[e2e-approval] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-approval 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-approval] 容器 ${CONTAINER} 已清理`);
  });
