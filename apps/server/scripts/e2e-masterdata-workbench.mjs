/**
 * 基础数据 + 工作台/待办端到端验证（M1 增量 4-I）。
 *
 * 一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy → 组织种子 → 起 server（DATABASE_URL 指容器，默认模块集
 *   core,org,masterdata,workbench,demo）→ 门禁 403/200（无身份/viewer/
 *   分码授权身份）→ Item/Resource 创建/列表/更新/冲突 → 给指定用户创建
 *   Todo → summary 计数 → done 后计数下降 → **重启 server 后数据存活** →
 *   无 DATABASE_URL 内存回落 boot 正常 → MODULES_ENABLED 开关与缺 core
 *   拒启零回归。
 *
 * 用法：pnpm --filter @smes/server mdwb:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55492;
const PORT_MAIN = 3591; // 默认模块集（六模块：core,org,masterdata,workbench,approval,demo）
const PORT_RESTART = 3592; // 重启存活
const PORT_NODB = 3593; // 无 DATABASE_URL boot
const PORT_SUBSET = 3594; // MODULES_ENABLED=core,org
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-mdwb-${process.pid}`;

const ADMIN = 'user-seed-admin';
const VIEWER = 'user-seed-viewer';
const AUTH = { 'x-smes-user': ADMIN };

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
  // 头——真实认证后该路径默认关闭，测试环境显式开启（extraEnv 可覆盖；
  // 本脚本的 omitKeys 不含该键）。
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
  console.log(`[e2e-mdwb] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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

  // 3) 迁移 deploy + 组织种子（admin/viewer 身份与策略）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（三份迁移入库）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`);

  // 4) 起 server A（DATABASE_URL 指容器；默认模块集含 masterdata/workbench）
  const mainServer = startServer(PORT_MAIN, { DATABASE_URL });
  if (!(await waitHealthy(PORT_MAIN, mainServer))) {
    fail(`server A 未就绪，日志尾部：\n${mainServer.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（DATABASE_URL=postgres，默认模块集）');

  // 5) 门禁对比：无身份 / viewer（无策略）/ admin（bypass）
  const modules = await call(PORT_MAIN, 'GET', '/modules');
  assert(modules.status === 200 && JSON.stringify(modules.body?.modules) === JSON.stringify(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']),
    `GET /modules → ${modules.status} ${JSON.stringify(modules.body?.modules)}（六模块口径，M1 收尾波-①）`);

  const noIdentity = await call(PORT_MAIN, 'GET', '/masterdata/items');
  assert(noIdentity.status === 401, `GET /masterdata/items（无身份头）→ ${noIdentity.status}（401：缺凭据，收尾波-③ 起 401/403 分离）`);
  const viewerItems = await call(PORT_MAIN, 'GET', '/masterdata/items', { headers: { 'x-smes-user': VIEWER } });
  assert(viewerItems.status === 403, `GET /masterdata/items（viewer 无策略）→ ${viewerItems.status}（403 门禁）`);
  const adminItems = await call(PORT_MAIN, 'GET', '/masterdata/items', { headers: AUTH });
  assert(adminItems.status === 200 && Array.isArray(adminItems.body?.items) && adminItems.body.items.length === 0,
    `GET /masterdata/items（admin）→ ${adminItems.status}（200，空列表）`);

  // 6) 分码门禁：data-editor 只有 item:read/item:write，无 resource:read
  await call(PORT_MAIN, 'POST', '/org/roles', { headers: AUTH, body: { name: 'data-editor', displayName: '基础数据员' } });
  await call(PORT_MAIN, 'PUT', '/org/roles/data-editor/permissions', {
    headers: AUTH,
    body: { permissions: ['item:read', 'item:write'] },
  });
  const editorUser = await call(PORT_MAIN, 'POST', '/org/users', { headers: AUTH, body: { username: 'zhao', displayName: '赵数据' } });
  const editorId = editorUser.body?.id;
  await call(PORT_MAIN, 'PUT', `/org/users/${editorId}/roles`, { headers: AUTH, body: { roles: ['data-editor'] } });
  const EDITOR_AUTH = { 'x-smes-user': editorId };
  const editorItemsOk = await call(PORT_MAIN, 'GET', '/masterdata/items', { headers: EDITOR_AUTH });
  assert(editorItemsOk.status === 200, `GET /masterdata/items（data-editor 持 item:read）→ ${editorItemsOk.status}（200）`);
  const editorCreateOk = await call(PORT_MAIN, 'POST', '/masterdata/items', {
    headers: EDITOR_AUTH,
    body: { code: 'P-2002', name: '编辑员建的物品' },
  });
  assert(editorCreateOk.status === 201, `POST /masterdata/items（data-editor 持 item:write）→ ${editorCreateOk.status}（201）`);
  const editorResources = await call(PORT_MAIN, 'GET', '/masterdata/resources', { headers: EDITOR_AUTH });
  assert(editorResources.status === 403, `GET /masterdata/resources（data-editor 无 resource:read）→ ${editorResources.status}（403 分码拒绝）`);
  const editorSummary = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: EDITOR_AUTH });
  assert(editorSummary.status === 403, `GET /workbench/summary（data-editor 无 workbench:read）→ ${editorSummary.status}（403 分码拒绝）`);

  // 7) Item：创建 → 冲突 → 非法输入 → 列表读回 → 更新（软停用）→ 读回
  const createItem = await call(PORT_MAIN, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: 'P-1001', name: '轴承', spec: '6204-2RS', unit: '个', category: 'part' },
  });
  const itemId = createItem.body?.id;
  assert(createItem.status === 201 && typeof itemId === 'string' && createItem.body?.active === true,
    `POST /masterdata/items {P-1001}（admin）→ ${createItem.status}`);
  const dupItem = await call(PORT_MAIN, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: 'P-1001', name: '重名' },
  });
  assert(dupItem.status === 409, `POST /masterdata/items 重复 code → ${dupItem.status}（409 冲突）`);
  const badItem = await call(PORT_MAIN, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: '非法 码', name: 'x' },
  });
  assert(badItem.status === 400, `POST /masterdata/items 非法 code → ${badItem.status}（400 输入）`);

  // 8) Resource：创建 → 冲突 → 列表读回
  const createResource = await call(PORT_MAIN, 'POST', '/masterdata/resources', {
    headers: AUTH,
    body: { code: 'M-01', name: '一号铣床', type: 'machine' },
  });
  const resourceId = createResource.body?.id;
  assert(createResource.status === 201 && typeof resourceId === 'string',
    `POST /masterdata/resources {M-01}（admin）→ ${createResource.status}`);
  const dupResource = await call(PORT_MAIN, 'POST', '/masterdata/resources', {
    headers: AUTH,
    body: { code: 'M-01', name: '重名' },
  });
  assert(dupResource.status === 409, `POST /masterdata/resources 重复 code → ${dupResource.status}（409 冲突）`);

  const itemsView = await call(PORT_MAIN, 'GET', '/masterdata/items', { headers: AUTH });
  const itemCodes = itemsView.body?.items?.map((item) => item.code);
  assert(itemsView.status === 200 && itemCodes?.includes('P-1001') && itemCodes?.includes('P-2002'),
    `GET /masterdata/items（admin）→ ${JSON.stringify(itemCodes)}（两件物品读回）`);
  const resourcesView = await call(PORT_MAIN, 'GET', '/masterdata/resources', { headers: AUTH });
  assert(resourcesView.status === 200 && resourcesView.body?.resources?.map((r) => r.code)?.includes('M-01'),
    `GET /masterdata/resources（admin）→ ${JSON.stringify(resourcesView.body?.resources?.map((r) => r.code))}`);

  const deactivate = await call(PORT_MAIN, 'PUT', `/masterdata/items/${itemId}`, {
    headers: AUTH,
    body: { active: false, name: '轴承 6204' },
  });
  assert(deactivate.status === 200 && deactivate.body?.active === false && deactivate.body?.spec === '6204-2RS',
    `PUT /masterdata/items/:id 软停用（字段级期望态）→ ${deactivate.status}`);
  const updateMissing = await call(PORT_MAIN, 'PUT', '/masterdata/items/ghost', {
    headers: AUTH,
    body: { active: false },
  });
  assert(updateMissing.status === 404, `PUT /masterdata/items/ghost → ${updateMissing.status}（404）`);
  const updateCode = await call(PORT_MAIN, 'PUT', `/masterdata/items/${itemId}`, {
    headers: AUTH,
    body: { code: 'P-9999' },
  });
  assert(updateCode.status === 400, `PUT /masterdata/items/:id 改 code → ${updateCode.status}（400 拒绝）`);

  // 9) 待办：给指定用户（viewer）创建 → 本人读回 → summary 计数 → done → 计数下降
  const todoRole = await call(PORT_MAIN, 'POST', '/org/roles', { headers: AUTH, body: { name: 'todo-user', displayName: '待办用户' } });
  assert(todoRole.status === 201 || todoRole.status === 409, `POST /org/roles {todo-user} → ${todoRole.status}`);
  await call(PORT_MAIN, 'PUT', '/org/roles/todo-user/permissions', {
    headers: AUTH,
    body: { permissions: ['workbench:read', 'todo:write'] },
  });
  const usersView = await call(PORT_MAIN, 'GET', '/org/users', { headers: AUTH });
  const viewerId = usersView.body?.users?.find((user) => user.username === 'viewer')?.id;
  assert(typeof viewerId === 'string', `GET /org/users 找到 viewer 的 id（${JSON.stringify(viewerId)}）`);
  await call(PORT_MAIN, 'PUT', `/org/users/${viewerId}/roles`, { headers: AUTH, body: { roles: ['todo-user'] } });
  const VIEWER_AUTH = { 'x-smes-user': viewerId };

  const createTodo = await call(PORT_MAIN, 'POST', '/workbench/todos', {
    headers: AUTH,
    body: { assignee: viewerId, title: '盘点物品主数据', source: 'masterdata', refType: 'item', refId: itemId, dueAt: '2026-11-01T09:00:00Z' },
  });
  const todoId = createTodo.body?.id;
  assert(createTodo.status === 201 && createTodo.body?.status === 'open' && createTodo.body?.assignee === viewerId,
    `POST /workbench/todos（admin 给 viewer 派发）→ ${createTodo.status}`);
  const badTodo = await call(PORT_MAIN, 'POST', '/workbench/todos', {
    headers: AUTH,
    body: { assignee: viewerId, title: 'x', source: 'MasterData' },
  });
  assert(badTodo.status === 400, `POST /workbench/todos 非法 source → ${badTodo.status}（400 输入）`);

  const adminTodos = await call(PORT_MAIN, 'GET', '/workbench/todos', { headers: AUTH });
  assert(adminTodos.status === 200 && adminTodos.body?.todos?.length === 0,
    `GET /workbench/todos（admin 本人视角）→ ${adminTodos.status}（0 条——数据级过滤，不泄漏他人待办）`);
  const adminSummary = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: AUTH });
  assert(adminSummary.status === 200 && adminSummary.body?.openTotal === 0,
    `GET /workbench/summary（admin 本人视角）→ ${adminSummary.status} openTotal=${adminSummary.body?.openTotal}`);

  const viewerTodos = await call(PORT_MAIN, 'GET', '/workbench/todos', { headers: VIEWER_AUTH });
  assert(viewerTodos.status === 200 && viewerTodos.body?.todos?.length === 1 && viewerTodos.body?.todos?.[0]?.title === '盘点物品主数据',
    `GET /workbench/todos（viewer 本人视角）→ ${viewerTodos.status}（1 条读回）`);
  const viewerSummary = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: VIEWER_AUTH });
  assert(viewerSummary.status === 200 && viewerSummary.body?.openTotal === 1 &&
    JSON.stringify(viewerSummary.body?.bySource) === JSON.stringify([{ source: 'masterdata', open: 1 }]),
    `GET /workbench/summary（viewer）→ ${viewerSummary.status} ${JSON.stringify(viewerSummary.body)}`);

  const doneTodo = await call(PORT_MAIN, 'POST', `/workbench/todos/${todoId}/done`, { headers: VIEWER_AUTH });
  assert(doneTodo.status === 201 && doneTodo.body?.status === 'done',
    `POST /workbench/todos/:id/done（viewer 本人）→ ${doneTodo.status}`);
  const doneAgain = await call(PORT_MAIN, 'POST', `/workbench/todos/${todoId}/done`, { headers: VIEWER_AUTH });
  assert(doneAgain.status === 201 && doneAgain.body?.status === 'done',
    `重复 done 幂等 → ${doneAgain.status}（仍 done）`);
  const summaryAfter = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: VIEWER_AUTH });
  assert(summaryAfter.status === 200 && summaryAfter.body?.openTotal === 0 && summaryAfter.body?.bySource?.length === 0,
    `done 后 summary 计数下降 → openTotal=${summaryAfter.body?.openTotal}`);
  const adminDoneForeign = await call(PORT_MAIN, `POST`, `/workbench/todos/${todoId}/done`, { headers: AUTH });
  assert([403, 404].includes(adminDoneForeign.status),
    `POST done（admin 对 viewer 的待办）→ ${adminDoneForeign.status}（仅本人可完成）`);

  // 10) 重启存活：基础数据与待办都在 PG
  await stopServer(mainServer);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库）');

  const itemsAfter = await call(PORT_RESTART, 'GET', '/masterdata/items', { headers: AUTH });
  const p1001After = itemsAfter.body?.items?.find((item) => item.code === 'P-1001');
  assert(itemsAfter.status === 200 && p1001After?.active === false && p1001After?.name === '轴承 6204',
    `重启后 GET /masterdata/items → P-1001 active=${p1001After?.active}（软停用存活）`);
  const resourcesAfter = await call(PORT_RESTART, 'GET', '/masterdata/resources', { headers: AUTH });
  assert(resourcesAfter.status === 200 && resourcesAfter.body?.resources?.some((r) => r.code === 'M-01'),
    '重启后 GET /masterdata/resources → M-01 存活');
  const todosAfter = await call(PORT_RESTART, 'GET', '/workbench/todos', { headers: VIEWER_AUTH });
  assert(todosAfter.status === 200 && todosAfter.body?.todos?.some((todo) => todo.id === todoId && todo.status === 'done'),
    `重启后 GET /workbench/todos（viewer）→ 待办 ${todoId} done 状态存活`);
  const editorAfter = await call(PORT_RESTART, 'GET', '/masterdata/items', { headers: EDITOR_AUTH });
  assert(editorAfter.status === 200, `重启后 GET /masterdata/items（data-editor）→ ${editorAfter.status}（策略存活）`);
  await stopServer(reborn);

  // 11) 启动零 DB 依赖：显式剥离 DATABASE_URL 后仍 boot（内存存储回落）
  const noDb = startServer(PORT_NODB, {}, ['DATABASE_URL']);
  const booted = await waitHealthy(PORT_NODB, noDb);
  assert(booted, '无 DATABASE_URL：server boot 成功，/health 200（内存存储回落）');
  if (booted) {
    const noDbItems = await call(PORT_NODB, 'GET', '/masterdata/items', { headers: AUTH });
    assert(noDbItems.status === 403,
      `无 DATABASE_URL：GET /masterdata/items（admin 头）→ ${noDbItems.status}（内存无策略，门禁照常）`);
    const noDbSummary = await call(PORT_NODB, 'GET', '/workbench/summary', { headers: AUTH });
    assert(noDbSummary.status === 403,
      `无 DATABASE_URL：GET /workbench/summary（admin 头）→ ${noDbSummary.status}（同上）`);
    const noDbHealth = await call(PORT_NODB, 'GET', '/health');
    assert(noDbHealth.status === 200 && noDbHealth.body?.status === 'ok', `无 DATABASE_URL：/health → ${noDbHealth.status}`);
  }
  await stopServer(noDb);

  // 12) MODULES_ENABLED 开关（既有行为零回归）
  const subset = startServer(PORT_SUBSET, { MODULES_ENABLED: 'core,org' });
  if (await waitHealthy(PORT_SUBSET, subset)) {
    const subsetModules = await call(PORT_SUBSET, 'GET', '/modules');
    assert(JSON.stringify(subsetModules.body?.modules) === JSON.stringify(['core', 'org']),
      `MODULES_ENABLED=core,org → /modules ${JSON.stringify(subsetModules.body?.modules)}`);
    const mdGone = await call(PORT_SUBSET, 'GET', '/masterdata/items', { headers: AUTH });
    assert(mdGone.status === 404, `MODULES_ENABLED=core,org → /masterdata/items ${mdGone.status}（404 停用）`);
    const wbGone = await call(PORT_SUBSET, 'GET', '/workbench/todos', { headers: AUTH });
    assert(wbGone.status === 404, `MODULES_ENABLED=core,org → /workbench/todos ${wbGone.status}（404 停用）`);
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

  console.log(`\n[e2e-mdwb] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-mdwb 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-mdwb] 容器 ${CONTAINER} 已清理`);
  });
