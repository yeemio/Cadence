/**
 * RLS session 接线有效性容器实证（ADR-0005 M4 正式线——Done-when 2 双对照）。
 *
 * 一次性 postgres:16 容器（挂 deploy/pg-init，app_user 真实就位）→
 * superuser 全量 migrate deploy + 组织种子 → 双对照：
 *
 *   对照组（不接线）：server 以 app_user 连库、SMES_RLS_SESSION 不设 →
 *     /health 200（启动零 DB 依赖不破）但全部 org 门禁端点 403——
 *     RLS fail-closed：策略读 0 行 → 无任何权限身份（app_user 全拒）。
 *
 *   实验组（接线）：同 app_user + SMES_RLS_SESSION=on（org 连接工厂装
 *     withRlsTenantSession 扩展）→ org 用户/角色 CRUD + 策略授予全过，
 *     重启存活——证明 app_user + RLS + SET 贯通后系统真功能正常。
 *
 *   未接线仓储探针（ESCALATION 证据，非失败）：同一实验组 server 上
 *     workbench / masterdata / approval 写端点被 RLS 拒——这三模块的
 *     connect*Store 工厂各自 new PrismaClient（构造权不在 org 工厂），
 *     不在 P1 泳道内接线。打印为 ESCALATION 行，供总控裁定泳道扩展。
 *
 * 用法：node deploy/scripts/rls-session-proof.mjs   （需 docker；自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEPLOY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DEPLOY, '..');

const PG_PORT = 55530; // 避开既有脚本（55491/55494/55521…）
const PORT_CONTROL = 3595; // 对照组：不接线
const PORT_WIRED = 3596; // 实验组：SMES_RLS_SESSION=on
const APP_PASSWORD = 'app_proof_password';
const SUPERUSER_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const APP_USER_URL = `postgresql://app_user:${APP_PASSWORD}@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-rls-session-proof-${process.pid}`;

const ADMIN = 'user-seed-admin';
const AUTH = { 'x-smes-user': ADMIN };
const VIEWER = 'user-seed-viewer';

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
    cwd: options.cwd ?? ROOT,
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

function startServer(port, extraEnv = {}, omitKeys = []) {
  const env = { ...process.env, SMES_DEV_AUTH: 'on', PORT: String(port), ...extraEnv };
  for (const key of omitKeys) delete env[key];
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
    if (server.child.exitCode !== null) break;
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
  console.log(`[rls-session-proof] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

  // 1) 一次性容器（挂 pg-init：app_user 由 initdb 钩子真实创建）
  run('docker', ['rm', '-f', CONTAINER], { capture: true });
  const up = run('docker', [
    'run', '-d', '--rm', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
    `-e`, `POSTGRES_APP_PASSWORD=${APP_PASSWORD}`,
    '-v', `${DEPLOY}/pg-init:/docker-entrypoint-initdb.d:ro`,
    '-p', `${PG_PORT}:5432`, 'postgres:16',
  ]);
  if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt += 1) {
    ready = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'cadence'], { capture: true }).status === 0;
    if (!ready) await delay(500);
  }
  assert(ready, 'postgres:16 容器就绪');

  let appUserReady = false;
  for (let attempt = 0; attempt < 30 && !appUserReady; attempt += 1) {
    const role = run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'cadence', '-tA', '-c',
      "SELECT count(*) FROM pg_roles WHERE rolname='app_user' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls"], { capture: true });
    appUserReady = role.status === 0 && role.stdout.trim() === '1';
    if (!appUserReady) await delay(500);
  }
  assert(appUserReady, 'pg-init 生效：app_user 存在（非 superuser、无 BYPASSRLS）');

  // 2) 构建（接线代码进 dist：application → business-store → server）
  const buildOk = [
    run('pnpm', ['--filter', '@smes/application', 'build']),
    run('pnpm', ['--filter', '@smes/business-store', 'build']),
    run('pnpm', ['--filter', '@smes/server', 'build']),
  ].every((result) => result.status === 0);
  assert(buildOk, '三包构建（application / business-store / server）');

  // 3) superuser 迁移 + 种子（启动零 DB 依赖合同：显式种子，非启动种子）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL: SUPERUSER_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（superuser，RLS 迁移入库）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL: SUPERUSER_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子（superuser）：${seed.stdout.trim().slice(-80)}`);

  // 4) 对照组：不接线（SMES_RLS_SESSION 缺省 off）——app_user 全拒
  const control = startServer(PORT_CONTROL, { DATABASE_URL: APP_USER_URL }, ['SMES_RLS_SESSION']);
  if (!(await waitHealthy(PORT_CONTROL, control))) {
    fail(`对照组 server 未就绪，日志尾部：\n${control.log.slice(-15).join('')}`);
    throw new Error('control server boot failed');
  }
  pass('对照组就绪（app_user 连接 + 不接线，/health 200——启动零 DB 依赖不破）');

  const controlUsers = await call(PORT_CONTROL, 'GET', '/org/users', { headers: AUTH });
  assert(controlUsers.status === 403,
    `对照组 GET /org/users（admin）→ ${controlUsers.status}（403：RLS 下策略读 0 行，无权限身份——app_user 全拒）`);
  const controlRole = await call(PORT_CONTROL, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '计划员' } });
  assert(controlRole.status === 403,
    `对照组 POST /org/roles → ${controlRole.status}（写端点同拒）`);
  await stopServer(control);

  // 5) 实验组：接线（SMES_RLS_SESSION=on）——org 全链路真功能
  const wired = startServer(PORT_WIRED, { DATABASE_URL: APP_USER_URL, SMES_RLS_SESSION: 'on' });
  if (!(await waitHealthy(PORT_WIRED, wired))) {
    fail(`实验组 server 未就绪，日志尾部：\n${wired.log.slice(-15).join('')}`);
    throw new Error('wired server boot failed');
  }
  pass('实验组就绪（app_user + SMES_RLS_SESSION=on）');

  const health = await call(PORT_WIRED, 'GET', '/health');
  assert(health.status === 200 && health.body?.status === 'ok' && health.body?.tenant === 'default',
    `GET /health → ${health.status} ${JSON.stringify(health.body)}`);

  const usersView = await call(PORT_WIRED, 'GET', '/org/users', { headers: AUTH });
  const names = usersView.body?.users?.map((user) => user.username);
  assert(usersView.status === 200 && names?.includes('admin'),
    `GET /org/users（admin，接线读）→ ${usersView.status} ${JSON.stringify(names)}（种子可见）`);

  const createRole = await call(PORT_WIRED, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '计划员' } });
  assert(createRole.status === 201 && createRole.body?.name === 'planner',
    `POST /org/roles {planner}（接线写）→ ${createRole.status}`);
  const dupRole = await call(PORT_WIRED, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '重名' } });
  assert(dupRole.status === 409, `POST /org/roles 重复名 → ${dupRole.status}（409，唯一键读跨 RLS 正常）`);

  const createUser = await call(PORT_WIRED, 'POST', '/org/users', { headers: AUTH, body: { username: 'li-ming', displayName: '李明' } });
  const newUserId = createUser.body?.id;
  assert(createUser.status === 201 && typeof newUserId === 'string',
    `POST /org/users {li-ming}（接线写）→ ${createUser.status}，id=${newUserId}`);

  const grant = await call(PORT_WIRED, 'PUT', '/org/roles/planner/permissions', { headers: AUTH, body: { permissions: ['demo:read'] } });
  assert(grant.status === 200 && grant.body?.granted === 1,
    `PUT /org/roles/planner/permissions（策略写穿 RLS）→ ${grant.status} ${JSON.stringify(grant.body)}`);

  const assign = await call(PORT_WIRED, 'PUT', `/org/users/${newUserId}/roles`, { headers: AUTH, body: { roles: ['planner'] } });
  assert(assign.status === 200 && assign.body?.granted === 1, `PUT /org/users/:id/roles → ${assign.status}`);

  const rolesView = await call(PORT_WIRED, 'GET', '/org/roles', { headers: AUTH });
  const planner = rolesView.body?.roles?.find((role) => role.name === 'planner');
  assert(rolesView.status === 200 && JSON.stringify(planner?.permissions) === JSON.stringify(['demo:read']),
    `GET /org/roles → planner 权限 ${JSON.stringify(planner?.permissions)}（接线读写一致）`);

  // 6) 全工厂接线断言（总控裁定 ESCALATION-1 后，masterdata/workbench/approval 三家工厂
  //    已同 org 模式接线——app_user+RLS 环境下写成功只能因 SET 贯通，无内存回落假阳性）
  const todoProbe = await call(PORT_WIRED, 'POST', '/workbench/todos', {
    headers: AUTH,
    body: { assignee: VIEWER, title: '接线实证探针', source: 'masterdata' },
  });
  assert(todoProbe.status === 201,
    `POST /workbench/todos → ${todoProbe.status}（workbench 工厂接线：app_user+RLS 下 201 即 SET 贯通）`);

  const itemProbe = await call(PORT_WIRED, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: 'P-PROBE-1', name: '接线探针物品', spec: 'A-1', unit: '件', category: 'part' },
  });
  assert(itemProbe.status === 201,
    `POST /masterdata/items → ${itemProbe.status}（masterdata 工厂接线：同上）`);

  // 7) 重启存活（接线形态下持久化真值）
  await stopServer(wired);
  const reborn = startServer(PORT_WIRED, { DATABASE_URL: APP_USER_URL, SMES_RLS_SESSION: 'on' });
  if (!(await waitHealthy(PORT_WIRED, reborn))) {
    fail(`重启 server 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('reborn server boot failed');
  }
  const usersAfter = await call(PORT_WIRED, 'GET', '/org/users', { headers: AUTH });
  const namesAfter = usersAfter.body?.users?.map((user) => user.username);
  assert(usersAfter.status === 200 && namesAfter?.includes('li-ming'),
    `重启后 GET /org/users → ${JSON.stringify(namesAfter)}（接线写入持久存活）`);
  await stopServer(reborn);

  console.log(`\n[rls-session-proof] 完成：${failures === 0 ? '双对照全部通过（ESCALATION 探针见上）' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('rls-session-proof 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[rls-session-proof] 容器 ${CONTAINER} 已清理`);
  });
