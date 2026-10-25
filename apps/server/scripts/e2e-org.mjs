/**
 * 组织/用户/角色管理端到端验证（M1 增量 3-D）。
 *
 * 一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy → 组织种子 → 起 server（DATABASE_URL 指容器）→
 *   真实 CRUD 端点 + 403/200 门禁对比 → **重启 server 后策略与用户存活** →
 *   既有行为零回归（/health、/modules、MODULES_ENABLED 开关、缺 core 拒启）→
 *   启动零 DB 依赖（无 DATABASE_URL 仍 boot，/health 200）。
 *
 * 用法：pnpm --filter @smes/server org:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55491;
const PORT_MAIN = 3491; // 默认模块集（core,org,masterdata,workbench,demo——M1 增量 4-I 起口径）
const PORT_RESTART = 3492; // 重启存活
const PORT_NODB = 3493; // 无 DATABASE_URL boot
const PORT_SUBSET = 3494; // MODULES_ENABLED=core,org
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-org-${process.pid}`;

const ADMIN = 'user-seed-admin';
const VIEWER = 'user-seed-viewer';
const AUTH = { 'x-smes-user': ADMIN };
const VIEWER_AUTH = { 'x-smes-user': VIEWER };

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

function startServer(port, extraEnv = {}, omitKeys = []) {
  // SMES_DEV_AUTH=on（收尾波-③）：本脚本全部身份断言基于 x-smes-user dev 回落
  // 头——真实认证后该路径默认关闭，测试环境显式开启（extraEnv 可覆盖）。
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
  console.log(`[e2e-org] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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

  // 3) 迁移 deploy + 组织种子（显式种子，非启动种子——启动零 DB 依赖合同）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（全部迁移入库）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`);

  // 4) 起 server（DATABASE_URL 指容器；默认模块集 core,org,masterdata,workbench,demo）
  const main = startServer(PORT_MAIN, { DATABASE_URL });
  if (!(await waitHealthy(PORT_MAIN, main))) {
    fail(`server A 未就绪，日志尾部：\n${main.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（DATABASE_URL=postgres，默认模块集）');

  // 5) 既有行为零回归 + 门禁对比
  const health = await call(PORT_MAIN, 'GET', '/health');
  assert(health.status === 200 && health.body?.status === 'ok' && health.body?.tenant === 'default',
    `GET /health → ${health.status} ${JSON.stringify(health.body)}`);

  const modules = await call(PORT_MAIN, 'GET', '/modules');
  assert(modules.status === 200 && JSON.stringify(modules.body?.modules) === JSON.stringify(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']),
    `GET /modules → ${modules.status} ${JSON.stringify(modules.body?.modules)}（六模块口径，M1 收尾波-①）`);

  const noIdentity = await call(PORT_MAIN, 'GET', '/org/users');
  assert(noIdentity.status === 401, `GET /org/users（无身份头）→ ${noIdentity.status}（401：缺凭据，收尾波-③ 起 401/403 分离）`);
  const viewerList = await call(PORT_MAIN, 'GET', '/org/users', { headers: VIEWER_AUTH });
  assert(viewerList.status === 403, `GET /org/users（viewer 无策略身份）→ ${viewerList.status}（403 门禁）`);
  const viewerCreate = await call(PORT_MAIN, 'POST', '/org/users', { headers: VIEWER_AUTH, body: { username: 'x', displayName: 'x' } });
  assert(viewerCreate.status === 403, `POST /org/users（viewer）→ ${viewerCreate.status}（写端点同样 403）`);

  // 6) 管理员经真实 CRUD 端点操作（非 dev 钩子）
  const createRole = await call(PORT_MAIN, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '计划员' } });
  assert(createRole.status === 201 && createRole.body?.name === 'planner',
    `POST /org/roles {planner}（admin）→ ${createRole.status}`);
  const dupRole = await call(PORT_MAIN, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '重名' } });
  assert(dupRole.status === 409, `POST /org/roles 重复名 → ${dupRole.status}（409 冲突）`);
  const badRole = await call(PORT_MAIN, 'POST', '/org/roles', { headers: AUTH, body: { name: 'Bad-Name', displayName: 'x' } });
  assert(badRole.status === 400, `POST /org/roles 非法角色名 → ${badRole.status}（400 输入）`);

  const createUser = await call(PORT_MAIN, 'POST', '/org/users', { headers: AUTH, body: { username: 'li-ming', displayName: '李明' } });
  const newUserId = createUser.body?.id;
  assert(createUser.status === 201 && typeof newUserId === 'string' && newUserId.length > 0,
    `POST /org/users {li-ming}（admin）→ ${createUser.status}，id=${newUserId}`);
  const dupUser = await call(PORT_MAIN, 'POST', '/org/users', { headers: AUTH, body: { username: 'li-ming', displayName: '重名' } });
  assert(dupUser.status === 409, `POST /org/users 重复用户名 → ${dupUser.status}（409 冲突）`);
  const badUser = await call(PORT_MAIN, 'POST', '/org/users', { headers: AUTH, body: { username: 'Li_Ming', displayName: 'x' } });
  assert(badUser.status === 400, `POST /org/users 非法用户名 → ${badUser.status}（400 输入）`);

  const grant = await call(PORT_MAIN, 'PUT', '/org/roles/planner/permissions', { headers: AUTH, body: { permissions: ['demo:read'] } });
  assert(grant.status === 200 && grant.body?.granted === 1,
    `PUT /org/roles/planner/permissions {demo:read}（admin）→ ${grant.status} ${JSON.stringify(grant.body)}`);
  const grantAgain = await call(PORT_MAIN, 'PUT', '/org/roles/planner/permissions', { headers: AUTH, body: { permissions: ['demo:read'] } });
  assert(grantAgain.status === 200 && grantAgain.body?.granted === 0 && grantAgain.body?.revoked === 0,
    `同期望态重复 PUT → ${grantAgain.status} ${JSON.stringify(grantAgain.body)}（幂等）`);

  const assign = await call(PORT_MAIN, 'PUT', `/org/users/${newUserId}/roles`, { headers: AUTH, body: { roles: ['planner'] } });
  assert(assign.status === 200 && assign.body?.granted === 1,
    `PUT /org/users/${newUserId}/roles {planner}（admin）→ ${assign.status} ${JSON.stringify(assign.body)}`);

  const rolesView = await call(PORT_MAIN, 'GET', '/org/roles', { headers: AUTH });
  const planner = rolesView.body?.roles?.find((role) => role.name === 'planner');
  assert(rolesView.status === 200 && JSON.stringify(planner?.permissions) === JSON.stringify(['demo:read']),
    `GET /org/roles（admin）→ planner 权限 ${JSON.stringify(planner?.permissions)}`);

  const usersView = await call(PORT_MAIN, 'GET', '/org/users', { headers: AUTH });
  const names = usersView.body?.users?.map((user) => user.username);
  assert(usersView.status === 200 && names?.includes('li-ming') && names?.includes('admin'),
    `GET /org/users（admin）→ ${JSON.stringify(names)}`);

  // 门禁全链路：新用户经 planner 角色 demo:read 放行 demo 端点；无策略身份仍 403
  const allowed = await call(PORT_MAIN, 'GET', '/demo/data', { headers: { 'x-smes-user': newUserId } });
  assert(allowed.status === 200 && allowed.body?.user === newUserId,
    `GET /demo/data（新用户 li-ming，经角色授权）→ ${allowed.status}（200 放行）`);
  const denied = await call(PORT_MAIN, 'GET', '/demo/data', { headers: VIEWER_AUTH });
  assert(denied.status === 403, `GET /demo/data（viewer 无策略）→ ${denied.status}（403 拒绝）`);

  // 7) 重启存活：策略与用户都在 PG
  await stopServer(main);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库）');

  const usersAfter = await call(PORT_RESTART, 'GET', '/org/users', { headers: AUTH });
  const namesAfter = usersAfter.body?.users?.map((user) => user.username);
  assert(usersAfter.status === 200 && namesAfter?.includes('li-ming'),
    `重启后 GET /org/users → ${JSON.stringify(namesAfter)}（用户存活）`);

  const rolesAfter = await call(PORT_RESTART, 'GET', '/org/roles', { headers: AUTH });
  const plannerAfter = rolesAfter.body?.roles?.find((role) => role.name === 'planner');
  assert(rolesAfter.status === 200 && JSON.stringify(plannerAfter?.permissions) === JSON.stringify(['demo:read']),
    `重启后 GET /org/roles → planner 权限 ${JSON.stringify(plannerAfter?.permissions)}（策略存活）`);

  const allowedAfter = await call(PORT_RESTART, 'GET', '/demo/data', { headers: { 'x-smes-user': newUserId } });
  assert(allowedAfter.status === 200, `重启后 GET /demo/data（新用户）→ ${allowedAfter.status}（PG adapter 判定路径存活）`);
  const viewerAfter = await call(PORT_RESTART, 'GET', '/org/users', { headers: VIEWER_AUTH });
  assert(viewerAfter.status === 403, `重启后 GET /org/users（viewer）→ ${viewerAfter.status}（仍 403）`);
  await stopServer(reborn);

  // 8) 启动零 DB 依赖：显式剥离 DATABASE_URL 后仍 boot
  const noDb = startServer(PORT_NODB, {}, ['DATABASE_URL']);
  const booted = await waitHealthy(PORT_NODB, noDb);
  assert(booted, '无 DATABASE_URL：server boot 成功，/health 200（内存存储回落）');
  if (booted) {
    const noDbOrg = await call(PORT_NODB, 'GET', '/org/users', { headers: AUTH });
    assert(noDbOrg.status === 403,
      `无 DATABASE_URL：GET /org/users（admin 头）→ ${noDbOrg.status}（内存无策略，门禁照常）`);
    const noDbHealth = await call(PORT_NODB, 'GET', '/health');
    assert(noDbHealth.status === 200 && noDbHealth.body?.status === 'ok', `无 DATABASE_URL：/health → ${noDbHealth.status}`);
  }
  await stopServer(noDb);

  // 9) MODULES_ENABLED 开关（既有行为零回归）
  const subset = startServer(PORT_SUBSET, { MODULES_ENABLED: 'core,org' });
  if (await waitHealthy(PORT_SUBSET, subset)) {
    const subsetModules = await call(PORT_SUBSET, 'GET', '/modules');
    assert(JSON.stringify(subsetModules.body?.modules) === JSON.stringify(['core', 'org']),
      `MODULES_ENABLED=core,org → /modules ${JSON.stringify(subsetModules.body?.modules)}`);
    const demoGone = await call(PORT_SUBSET, 'GET', '/demo/ping');
    assert(demoGone.status === 404, `MODULES_ENABLED=core,org → /demo/ping ${demoGone.status}（404 停用）`);
    const orgAlive = await call(PORT_SUBSET, 'GET', '/org/users', { headers: AUTH });
    assert(orgAlive.status === 403, `MODULES_ENABLED=core,org → /org/users（无 DB 策略）${orgAlive.status}（org 已装配，内存存储）`);
  } else {
    fail('MODULES_ENABLED=core,org server 未就绪');
  }
  await stopServer(subset);

  const deny = spawnSync(process.execPath, [resolve(ROOT, 'apps/server/dist/main.js')], {
    env: { ...process.env, PORT: String(PORT_SUBSET + 1), MODULES_ENABLED: 'demo' },
    stdio: 'pipe',
  });
  assert(deny.status !== 0 && /core/.test(deny.stderr.toString()),
    `MODULES_ENABLED=demo（缺 core）→ 进程退出码 ${deny.status}（拒启，stderr 含 core）`);

  console.log(`\n[e2e-org] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-org 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-org] 容器 ${CONTAINER} 已清理`);
  });
