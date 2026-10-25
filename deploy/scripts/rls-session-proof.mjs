/**
 * RLS session 接线有效性容器实证（ADR-0005 M4 正式线——Done-when 2 双对照；
 * M4 收尾波扩展：14 家新接线工厂取 baseline 为代表探针）。
 *
 * 一次性 postgres:16 容器（挂 deploy/pg-init，app_user 真实就位）→
 * superuser 全量 migrate deploy + 组织种子 → 双对照：
 *
 *   对照组（不接线）：server 以 app_user 连库、SMES_RLS_SESSION 不设 →
 *     /health 200（启动零 DB 依赖不破）但全部 org 门禁端点 403——
 *     RLS fail-closed：策略读 0 行 → 无任何权限身份（app_user 全拒）。
 *
 *   实验组（接线）：同 app_user + SMES_RLS_SESSION=on（连接工厂装
 *     withRlsTenantSession 扩展）→ org 用户/角色 CRUD + 策略授予全过，
 *     重启存活——证明 app_user + RLS + SET 贯通后系统真功能正常。
 *
 *   接线工厂探针（M4 收尾波：18/18 全接线后从"ESCALATION 证据"转正式断言）：
 *   masterdata / workbench（先例四家）与 baseline（新接线十四家代表——
 *   baseline.process.define.v1 走 PgProcessDefStore 普通模型操作）写端点
 *   在实验组 201、对照组 403——app_user+RLS 下写成功只能因 SET 贯通，
 *   无内存回落假阳性（本 server 显式设 DATABASE_URL）。
 *
 * 容器/assert/run 机制脚手架与 rls-proof.mjs 共享 ./harness.mjs
 * （M4 收尾波双写去重——本脚本只保留被证事实与 server 进程管理）。
 *
 * 用法：node deploy/scripts/rls-session-proof.mjs   （需 docker；自管清理）
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  cleanupProofPostgres,
  createProofAsserts,
  REPO_ROOT,
  run,
  startProofPostgres,
} from './harness.mjs';

const PG_PORT = 55530; // 避开既有脚本（55491/55494/55521…）
const PORT_CONTROL = 3595; // 对照组：不接线
const PORT_WIRED = 3596; // 实验组：SMES_RLS_SESSION=on
const APP_PASSWORD = 'app_proof_password';
const SUPERUSER_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const APP_USER_URL = `postgresql://app_user:${APP_PASSWORD}@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-rls-session-proof-${process.pid}`;
// 两对照组同模块集（含 baseline——新接线工厂探针的双对照前提）。
const MODULES = 'core,org,masterdata,workbench,approval,baseline';

const ADMIN = 'user-seed-admin';
const AUTH = { 'x-smes-user': ADMIN };
const VIEWER = 'user-seed-viewer';

const kit = createProofAsserts();

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

/** 命令信封（与 e2e-live-db.mjs 同款最小形状）。 */
let opCounter = 0;
function envelope(kind, payload, expectedRevision = 'initial') {
  opCounter += 1;
  return {
    operationId: `rls-session-proof-${kind}-${opCounter}`,
    expectedRevision,
    command: { kind, payload },
  };
}

function startServer(port, extraEnv = {}, omitKeys = []) {
  const env = {
    ...process.env,
    SMES_DEV_AUTH: 'on',
    MODULES_ENABLED: MODULES,
    PORT: String(port),
    ...extraEnv,
  };
  for (const key of omitKeys) delete env[key];
  const child = spawn(process.execPath, [resolve(REPO_ROOT, 'apps/server/dist/main.js')], {
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
  await startProofPostgres({
    container: CONTAINER,
    port: PG_PORT,
    appPassword: APP_PASSWORD,
    assert: kit,
  });

  // 2) 构建（接线代码进 dist：application → business-store → server）
  const buildOk = [
    run('pnpm', ['--filter', '@smes/application', 'build']),
    run('pnpm', ['--filter', '@smes/business-store', 'build']),
    run('pnpm', ['--filter', '@smes/server', 'build']),
  ].every((result) => result.status === 0);
  kit.assert(buildOk, '三包构建（application / business-store / server）');

  // 3) superuser 迁移 + 种子（启动零 DB 依赖合同：显式种子，非启动种子）
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL: SUPERUSER_URL },
  });
  kit.assert(migrate.status === 0, 'prisma migrate deploy（superuser，RLS 迁移入库）');
  const seed = run('node', [resolve(REPO_ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL: SUPERUSER_URL },
    capture: true,
  });
  kit.assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子（superuser）：${seed.stdout.trim().slice(-80)}`);

  // 4) 对照组：不接线（SMES_RLS_SESSION 缺省 off）——app_user 全拒
  const control = startServer(PORT_CONTROL, { DATABASE_URL: APP_USER_URL }, ['SMES_RLS_SESSION']);
  if (!(await waitHealthy(PORT_CONTROL, control))) {
    kit.fail(`对照组 server 未就绪，日志尾部：\n${control.log.slice(-15).join('')}`);
    throw new Error('control server boot failed');
  }
  kit.pass('对照组就绪（app_user 连接 + 不接线，/health 200——启动零 DB 依赖不破）');

  const controlUsers = await call(PORT_CONTROL, 'GET', '/org/users', { headers: AUTH });
  kit.assert(controlUsers.status === 403,
    `对照组 GET /org/users（admin）→ ${controlUsers.status}（403：RLS 下策略读 0 行，无权限身份——app_user 全拒）`);
  const controlRole = await call(PORT_CONTROL, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '计划员' } });
  kit.assert(controlRole.status === 403,
    `对照组 POST /org/roles → ${controlRole.status}（写端点同拒）`);
  // 双对照（M4 收尾波）：新接线工厂（baseline 代表）在未接线形态同拒——
  // 实验组的 201 才可归因 SET 贯通，而非缺省回落/权限旁路。
  const controlBaseline = await call(PORT_CONTROL, 'POST', '/baseline/processes/commands', {
    headers: AUTH,
    body: envelope('baseline.process.define.v1', { code: 'PROBE-PROC-1', name: '接线探针工序' }),
  });
  kit.assert(controlBaseline.status === 403,
    `对照组 POST /baseline/processes/commands → ${controlBaseline.status}（新接线工厂未接线形态同拒：RLS 写被拒）`);
  await stopServer(control);

  // 5) 实验组：接线（SMES_RLS_SESSION=on）——org 全链路真功能
  const wired = startServer(PORT_WIRED, { DATABASE_URL: APP_USER_URL, SMES_RLS_SESSION: 'on' });
  if (!(await waitHealthy(PORT_WIRED, wired))) {
    kit.fail(`实验组 server 未就绪，日志尾部：\n${wired.log.slice(-15).join('')}`);
    throw new Error('wired server boot failed');
  }
  kit.pass('实验组就绪（app_user + SMES_RLS_SESSION=on）');

  const health = await call(PORT_WIRED, 'GET', '/health');
  kit.assert(health.status === 200 && health.body?.status === 'ok' && health.body?.tenant === 'default',
    `GET /health → ${health.status} ${JSON.stringify(health.body)}`);

  const usersView = await call(PORT_WIRED, 'GET', '/org/users', { headers: AUTH });
  const names = usersView.body?.users?.map((user) => user.username);
  kit.assert(usersView.status === 200 && names?.includes('admin'),
    `GET /org/users（admin，接线读）→ ${usersView.status} ${JSON.stringify(names)}（种子可见）`);

  const createRole = await call(PORT_WIRED, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '计划员' } });
  kit.assert(createRole.status === 201 && createRole.body?.name === 'planner',
    `POST /org/roles {planner}（接线写）→ ${createRole.status}`);
  const dupRole = await call(PORT_WIRED, 'POST', '/org/roles', { headers: AUTH, body: { name: 'planner', displayName: '重名' } });
  kit.assert(dupRole.status === 409, `POST /org/roles 重复名 → ${dupRole.status}（409，唯一键读跨 RLS 正常）`);

  const createUser = await call(PORT_WIRED, 'POST', '/org/users', { headers: AUTH, body: { username: 'li-ming', displayName: '李明' } });
  const newUserId = createUser.body?.id;
  kit.assert(createUser.status === 201 && typeof newUserId === 'string',
    `POST /org/users {li-ming}（接线写）→ ${createUser.status}，id=${newUserId}`);

  const grant = await call(PORT_WIRED, 'PUT', '/org/roles/planner/permissions', { headers: AUTH, body: { permissions: ['demo:read'] } });
  kit.assert(grant.status === 200 && grant.body?.granted === 1,
    `PUT /org/roles/planner/permissions（策略写穿 RLS）→ ${grant.status} ${JSON.stringify(grant.body)}`);

  const assign = await call(PORT_WIRED, 'PUT', `/org/users/${newUserId}/roles`, { headers: AUTH, body: { roles: ['planner'] } });
  kit.assert(assign.status === 200 && assign.body?.granted === 1, `PUT /org/users/:id/roles → ${assign.status}`);

  const rolesView = await call(PORT_WIRED, 'GET', '/org/roles', { headers: AUTH });
  const planner = rolesView.body?.roles?.find((role) => role.name === 'planner');
  kit.assert(rolesView.status === 200 && JSON.stringify(planner?.permissions) === JSON.stringify(['demo:read']),
    `GET /org/roles → planner 权限 ${JSON.stringify(planner?.permissions)}（接线读写一致）`);

  // 6) 接线工厂断言（ESCALATION-1 先例 masterdata/workbench + M4 收尾波
  //    14 家新接线取 baseline 代表——app_user+RLS 环境下写成功只能因 SET 贯通）
  const todoProbe = await call(PORT_WIRED, 'POST', '/workbench/todos', {
    headers: AUTH,
    body: { assignee: VIEWER, title: '接线实证探针', source: 'masterdata' },
  });
  kit.assert(todoProbe.status === 201,
    `POST /workbench/todos → ${todoProbe.status}（workbench 工厂接线：app_user+RLS 下 201 即 SET 贯通）`);

  const itemProbe = await call(PORT_WIRED, 'POST', '/masterdata/items', {
    headers: AUTH,
    body: { code: 'P-PROBE-1', name: '接线探针物品', spec: 'A-1', unit: '件', category: 'part' },
  });
  kit.assert(itemProbe.status === 201,
    `POST /masterdata/items → ${itemProbe.status}（masterdata 工厂接线：同上）`);

  const baselineProbe = await call(PORT_WIRED, 'POST', '/baseline/processes/commands', {
    headers: AUTH,
    body: envelope('baseline.process.define.v1', { code: 'PROBE-PROC-1', name: '接线探针工序' }),
  });
  kit.assert(baselineProbe.status === 201,
    `POST /baseline/processes/commands → ${baselineProbe.status}（M4 收尾波 14 家新接线工厂代表 baseline：普通模型操作 201 即 SET 贯通）`);

  // 7) 重启存活（接线形态下持久化真值）
  await stopServer(wired);
  const reborn = startServer(PORT_WIRED, { DATABASE_URL: APP_USER_URL, SMES_RLS_SESSION: 'on' });
  if (!(await waitHealthy(PORT_WIRED, reborn))) {
    kit.fail(`重启 server 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('reborn server boot failed');
  }
  const usersAfter = await call(PORT_WIRED, 'GET', '/org/users', { headers: AUTH });
  const namesAfter = usersAfter.body?.users?.map((user) => user.username);
  kit.assert(usersAfter.status === 200 && namesAfter?.includes('li-ming'),
    `重启后 GET /org/users → ${JSON.stringify(namesAfter)}（接线写入持久存活）`);
  await stopServer(reborn);

  console.log(`\n[rls-session-proof] 完成：${kit.failures === 0 ? '双对照全部通过（接线工厂探针见上）' : `${kit.failures} 项失败`}`);
  process.exitCode = kit.failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('rls-session-proof 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupProofPostgres(CONTAINER, 'rls-session-proof');
  });
