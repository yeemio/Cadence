/**
 * 真实认证纵贯端到端验证（M1 收尾波-③：密码 + opaque token 会话 + 登录流）。
 *
 * 一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy（五份）→ 种子（含口令 demo-password）→ 起 server A
 *   （生产默认形态：SMES_DEV_AUTH 关，纯 Bearer 链路）→
 *   login 发 token → Bearer 调受保护端点 → 错密码/未知用户 401 同态 →
 *   无 token/坏 token/dev 头（默认关）401 → viewer 有效身份无权限 403 →
 *   users.active 停用：停用即登录拒 + 既有 token 全撤 → 恢复启用 →
 *   未设口令用户（组织端点创建）登录拒 → refresh：旧 token 换新、旧即刻
 *   失效、窗口内可用 → /auth/me → logout 后同 token 401 →
 *   重启 server B（SMES_DEV_AUTH=on）：PG 会话存活（旧 token 可用）+
 *   dev 回落头正路径 + Bearer 与 dev 头并存。
 *
 * 用法：pnpm --filter @smes/server auth:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55494;
const PORT_MAIN = 3696; // 生产默认形态（SMES_DEV_AUTH 关）
const PORT_RESTART = 3697; // 重启 + SMES_DEV_AUTH=on（dev 回落并存形态）
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-auth-${process.pid}`;

const SEED_PASSWORD = 'demo-password'; // 与 prisma/seed.mjs 的 DEFAULT_SEED_PASSWORD 一致

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
    /* 非 JSON 响应体（204 等） */
  }
  return { status: response.status, body: json };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function login(port, username, password = SEED_PASSWORD) {
  return call(port, 'POST', '/auth/login', { body: { username, password } });
}

function startServer(port, extraEnv = {}, omitKeys = []) {
  const env = { ...process.env, PORT: String(port), ...extraEnv };
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
  console.log(`[e2e-auth] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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

  // 3) 迁移 deploy（五份迁移入库，含 password_hash + sessions）+ 种子（含口令）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（五份迁移入库）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `种子（含口令哈希）：${seed.stdout.trim()}`);

  // 4) server A：生产默认形态（显式剥离 SMES_DEV_AUTH，纯 Bearer 链路）
  const mainServer = startServer(PORT_MAIN, { DATABASE_URL }, ['SMES_DEV_AUTH']);
  if (!(await waitHealthy(PORT_MAIN, mainServer))) {
    fail(`server A 未就绪，日志尾部：\n${mainServer.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（生产默认形态：SMES_DEV_AUTH 关，默认六模块）');

  // 5) 登录发 token
  const badShape = await call(PORT_MAIN, 'POST', '/auth/login', { body: { username: '', password: 'x' } });
  assert(badShape.status === 400, `登录请求体形状非法 → ${badShape.status}（400）`);

  const adminLogin = await login(PORT_MAIN, 'admin');
  const adminToken = adminLogin.body?.token;
  assert(adminLogin.status === 201 && typeof adminToken === 'string' && adminToken.length >= 43,
    `login admin → ${adminLogin.status}（201 签发），token 256bit`);
  assert(adminLogin.body?.user?.username === 'admin' && adminLogin.body?.user?.active === true &&
    typeof adminLogin.body?.expiresAt === 'string' && !('passwordHash' in (adminLogin.body?.user ?? {})),
    `login 响应含 user 视图与 expiresAt，不含口令哈希 → ${JSON.stringify(adminLogin.body?.user ?? {})}`);
  assert(adminLogin.body?.admin === true && Array.isArray(adminLogin.body?.permissions),
    `login 响应含权限投影（admin=true）`);

  // 6) Bearer 调受保护端点
  const orgUsers = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(adminToken) });
  assert(orgUsers.status === 200 && Array.isArray(orgUsers.body?.users),
    `GET /org/users（Bearer admin token）→ ${orgUsers.status}（200 放行）`);

  // 7) 凭据拒绝：错密码 / 未知用户 → 401 且同 message（不泄漏差异）
  const wrongPassword = await login(PORT_MAIN, 'admin', 'wrong-password');
  const unknownUser = await login(PORT_MAIN, 'ghost', SEED_PASSWORD);
  assert(wrongPassword.status === 401 && unknownUser.status === 401,
    `错密码/未知用户 → ${wrongPassword.status}/${unknownUser.status}（均 401）`);
  assert(wrongPassword.body?.message === unknownUser.body?.message,
    `拒绝 message 同态（不泄漏差异）→ '${wrongPassword.body?.message}'`);

  // 8) 无/坏 token 401；dev 头在默认形态被完全忽略
  const noToken = await call(PORT_MAIN, 'GET', '/org/users');
  assert(noToken.status === 401, `无 token → ${noToken.status}（401）`);
  const garbage = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer('garbage-token') });
  assert(garbage.status === 401, `坏 token → ${garbage.status}（401）`);
  const devHeaderIgnored = await call(PORT_MAIN, 'GET', '/org/users', { headers: { 'x-smes-user': 'user-seed-admin' } });
  assert(devHeaderIgnored.status === 401, `x-smes-user（SMES_DEV_AUTH 关）→ ${devHeaderIgnored.status}（401：生产默认无 dev 头路径）`);

  // 9) 有效身份但无权限 → 403（401/403 分离证据）
  const viewerLogin = await login(PORT_MAIN, 'viewer');
  const viewerToken = viewerLogin.body?.token;
  assert(viewerLogin.status === 201, `login viewer（无策略身份）→ ${viewerLogin.status}`);
  const viewerDenied = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(viewerToken) });
  assert(viewerDenied.status === 403, `GET /org/users（viewer Bearer）→ ${viewerDenied.status}（403：身份有效无权限）`);
  assert(viewerDenied.body?.message !== wrongPassword.body?.message, '403 message 与 401 凭据拒绝可区分');

  // 10) users.active 停用：登录拒 + 既有 token 全撤（写时撤销）
  const disable = await call(PORT_MAIN, 'PUT', '/org/users/user-seed-viewer/status', {
    headers: bearer(adminToken),
    body: { active: false },
  });
  assert(disable.status === 200 && disable.body?.active === false, `PUT status active=false（admin）→ ${disable.status}`);
  const viewerLoginAfter = await login(PORT_MAIN, 'viewer');
  assert(viewerLoginAfter.status === 401, `停用后 login viewer → ${viewerLoginAfter.status}（active=false 拒）`);
  const viewerTokenAfter = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(viewerToken) });
  assert(viewerTokenAfter.status === 401, `停用前签发的 viewer token → ${viewerTokenAfter.status}（既有会话全撤）`);

  // 恢复启用：可再登录（撤销不可逆——旧 token 仍 401）
  const enable = await call(PORT_MAIN, 'PUT', '/org/users/user-seed-viewer/status', {
    headers: bearer(adminToken),
    body: { active: true },
  });
  assert(enable.status === 200 && enable.body?.active === true, `PUT status active=true（恢复）→ ${enable.status}`);
  const viewerRelogin = await login(PORT_MAIN, 'viewer');
  assert(viewerRelogin.status === 201, `恢复后 login viewer → ${viewerRelogin.status}（201 可再登录）`);
  assert((await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(viewerToken) })).status === 401,
    '恢复启用不复活已撤销会话（旧 token 仍 401）');

  // 11) 管理员不能停自己（400）；未知用户 404
  const selfDisable = await call(PORT_MAIN, 'PUT', '/org/users/user-seed-admin/status', {
    headers: bearer(adminToken),
    body: { active: false },
  });
  assert(selfDisable.status === 400, `admin 停自己 → ${selfDisable.status}（400 拒）`);
  const missingUser = await call(PORT_MAIN, 'PUT', '/org/users/user-missing/status', {
    headers: bearer(adminToken),
    body: { active: false },
  });
  assert(missingUser.status === 404, `未知用户 status → ${missingUser.status}（404）`);
  const badStatusBody = await call(PORT_MAIN, 'PUT', '/org/users/user-seed-viewer/status', {
    headers: bearer(adminToken),
    body: { active: 'yes' },
  });
  assert(badStatusBody.status === 400, `status active 非布尔 → ${badStatusBody.status}（400）`);

  // 12) 组织端点创建的用户未设口令 → 登录拒（同 401 同态）
  const created = await call(PORT_MAIN, 'POST', '/org/users', {
    headers: bearer(adminToken),
    body: { username: 'no-credential', displayName: '无口令用户' },
  });
  assert(created.status === 201, `POST /org/users（无口令字段）→ ${created.status}`);
  const noCredentialLogin = await login(PORT_MAIN, 'no-credential');
  assert(noCredentialLogin.status === 401 &&
    noCredentialLogin.body?.message === wrongPassword.body?.message,
    `未设口令用户登录 → ${noCredentialLogin.status}（401 同态，不泄漏差异）`);

  // 13) refresh 流程：旧 token 换新、旧即刻失效、已撤销不可再 refresh
  const refreshLogin = await login(PORT_MAIN, 'admin');
  const oldToken = refreshLogin.body?.token;
  const refresh = await call(PORT_MAIN, 'POST', '/auth/refresh', { headers: bearer(oldToken) });
  const newToken = refresh.body?.token;
  assert(refresh.status === 201 && typeof newToken === 'string' && newToken !== oldToken,
    `POST /auth/refresh → ${refresh.status}（201 新 token 签发）`);
  const oldDead = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(oldToken) });
  assert(oldDead.status === 401, `旧 token refresh 后 → ${oldDead.status}（旧撤销）`);
  const newAlive = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(newToken) });
  assert(newAlive.status === 200, `新 token → ${newAlive.status}（200 可用）`);
  const reRefresh = await call(PORT_MAIN, 'POST', '/auth/refresh', { headers: bearer(oldToken) });
  assert(reRefresh.status === 401, `已撤销 token 再 refresh → ${reRefresh.status}（401）`);

  // 14) /auth/me：token 有效性 + 账户 + 权限投影
  const me = await call(PORT_MAIN, 'GET', '/auth/me', { headers: bearer(newToken) });
  assert(me.status === 200 && me.body?.user?.username === 'admin' && me.body?.admin === true &&
    typeof me.body?.expiresAt === 'string',
    `GET /auth/me → ${me.status}（账户 + admin + expiresAt）`);
  const meNoToken = await call(PORT_MAIN, 'GET', '/auth/me');
  assert(meNoToken.status === 401, `GET /auth/me 无 token → ${meNoToken.status}（401）`);

  // 15) logout：撤销后同 token 401
  const logout = await call(PORT_MAIN, 'POST', '/auth/logout', { headers: bearer(newToken) });
  assert(logout.status === 204, `POST /auth/logout → ${logout.status}（204）`);
  const afterLogout = await call(PORT_MAIN, 'GET', '/org/users', { headers: bearer(newToken) });
  assert(afterLogout.status === 401, `logout 后同 token → ${afterLogout.status}（401）`);

  // 16) 重启存活：PG 会话表是事实源——重启前签发的 token 继续可用；dev 回落并存
  const persistLogin = await login(PORT_MAIN, 'admin');
  const persistToken = persistLogin.body?.token;
  await stopServer(mainServer);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL, SMES_DEV_AUTH: 'on' });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库，SMES_DEV_AUTH=on）');

  const persisted = await call(PORT_RESTART, 'GET', '/org/users', { headers: bearer(persistToken) });
  assert(persisted.status === 200, `重启后重启前签发 token → ${persisted.status}（sessions 表存活）`);
  const devFallback = await call(PORT_RESTART, 'GET', '/org/users', { headers: { 'x-smes-user': 'user-seed-admin' } });
  assert(devFallback.status === 200, `SMES_DEV_AUTH=on 时 x-smes-user → ${devFallback.status}（dev 回落正路径）`);
  const bothPaths = await call(PORT_RESTART, 'GET', '/org/users', { headers: { 'x-smes-user': 'user-seed-viewer' } });
  assert(bothPaths.status === 403, `SMES_DEV_AUTH=on 时 viewer dev 头 → ${bothPaths.status}（403 判定照常）`);
  const badBearerOnDev = await call(PORT_RESTART, 'GET', '/org/users', { headers: bearer('garbage') });
  assert(badBearerOnDev.status === 401, `dev 开启时坏 Bearer 仍 → ${badBearerOnDev.status}（Bearer 优先且不降级回落）`);
  await stopServer(reborn);

  console.log(`\n[e2e-auth] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-auth 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-auth] 容器 ${CONTAINER} 已清理`);
  });
