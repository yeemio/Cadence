/**
 * T1 能力子集端到端验证（0920 #1 运营总览数据面 / #98+99 菜单管理 / #101
 * 通知中心 / #102 审批配置）。一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy → 组织种子 → 起 server（PG 形态，三新模块 + 总览四源模块）→
 *   ① #98/99 菜单配置 CRUD/门禁/冲突/权限码聚合（web+mobile 两配置集）；
 *   ② #101 通知：发布/未读/已读/置读 + **待办桥**（审批发起 → 收件箱同源通知）；
 *   ③ #102 审批配置：试写/创建即启用（单激活）/运行时解析器（active 流驱动
 *      新案 flowConfigId/state + 决策闭环）/版本历史/启用历史版本/停用回落；
 *   ④ #1 总览四源端点读回（workbench/workorder/inspection/hours 四 GET 200）；
 *   ⑤ 重启 server：配置集/收件箱/案件存活（PG 持久化）。
 * 前端装配/合并/页面形状由 web/product-ui 测试覆盖，不在本文件。
 *
 * 用法：pnpm --filter @smes/server capability:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55497;
const PORT_MAIN = 3499;
const PORT_RESTART = 3500;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-capability-${process.pid}`;
const MODULES =
  'core,org,workbench,approval,menu-config,notifications,approval-config,workorder,inspection,hours';

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

/** 合法两步流（SUBMIT → in_review → APPROVE → approved）。 */
const TWO_STEP = {
  schemaVersion: 1,
  flowId: 'two-step',
  initial: 'draft',
  states: [{ id: 'draft' }, { id: 'in_review' }, { id: 'approved', final: true }],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'in_review' },
    { from: 'in_review', event: 'APPROVE', to: 'approved', decision: 'approve' },
  ],
};

async function main() {
  console.log(`[e2e-capability] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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

  // 3) 迁移 deploy + 组织种子
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（含 S5 能力子集三表 + history 列 + RLS 重放）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`);

  // 4) 起 server A（三新模块 + 总览四源模块，PG 形态）
  const mainServer = startServer(PORT_MAIN, { DATABASE_URL, MODULES_ENABLED: MODULES });
  if (!(await waitHealthy(PORT_MAIN, mainServer))) {
    fail(`server A 未就绪，日志尾部：\n${mainServer.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（三新模块 + 总览四源模块，DATABASE_URL=postgres）');

  const modulesView = await call(PORT_MAIN, 'GET', '/modules');
  assert(JSON.stringify(modulesView.body?.modules) === JSON.stringify(MODULES.split(',')),
    `GET /modules → ${JSON.stringify(modulesView.body?.modules)}`);

  // ---- ① #98/99 菜单配置 CRUD ----
  const deniedMenu = await call(PORT_MAIN, 'GET', '/menu-config/configs', { headers: VIEWER_AUTH });
  assert(deniedMenu.status === 403, `GET /menu-config/configs（viewer 无策略）→ ${deniedMenu.status}（403 门禁）`);

  const webSet = await call(PORT_MAIN, 'POST', '/menu-config/configs', {
    headers: AUTH,
    body: {
      code: 'default',
      name: 'Web 菜单',
      nodes: [
        { code: 'overview', title: '运营总览', routePath: '/overview', permission: 'workbench:read' },
        { code: 'workbench', title: '工作台', routePath: '/', permission: 'workbench:read' },
        { code: 'system', title: '系统管理', children: [{ code: 'system-menus', title: '菜单管理', permission: 'menu:read' }] },
      ],
    },
  });
  assert(webSet.status === 201 && webSet.body?.code === 'default',
    `#98 POST /menu-config/configs {default}（web 配置集）→ ${webSet.status}`);
  const mobileSet = await call(PORT_MAIN, 'POST', '/menu-config/configs', {
    headers: AUTH,
    body: {
      code: 'mobile',
      name: '移动菜单',
      nodes: [
        { code: 'm.workbench', title: '工作台', routePath: '/m', permission: 'workbench:read' },
        { code: 'm.report', title: '报工', routePath: '/m/report', permission: 'report:submit' },
      ],
    },
  });
  assert(mobileSet.status === 201 && mobileSet.body?.code === 'mobile',
    `#99 POST /menu-config/configs {mobile}（移动配置集）→ ${mobileSet.status}`);

  const dupSet = await call(PORT_MAIN, 'POST', '/menu-config/configs', { headers: AUTH, body: { code: 'default', name: '重码', nodes: [] } });
  assert(dupSet.status === 409, `POST /menu-config/configs 重复 code → ${dupSet.status}（409 冲突）`);

  const badTree = await call(PORT_MAIN, 'PUT', `/menu-config/configs/${mobileSet.body?.id}`, {
    headers: AUTH,
    body: { nodes: [{ code: 'm.workbench', title: '工作台' }, { code: 'm.workbench', title: '重码节点' }] },
  });
  assert(badTree.status === 400, `PUT 节点树内 code 重复 → ${badTree.status}（400 输入层拒绝）`);

  const codes = await call(PORT_MAIN, 'GET', '/menu-config/permission-codes', { headers: AUTH });
  assert(codes.status === 200 && JSON.stringify(codes.body?.codes) === JSON.stringify(['menu:read', 'report:submit', 'workbench:read']),
    `GET /menu-config/permission-codes → ${JSON.stringify(codes.body?.codes)}（读实态权限码聚合）`);

  // ---- ③-1 #102 审批配置：试写 + 创建即启用 ----
  const precheck = await call(PORT_MAIN, 'POST', '/approval-config/validate', { headers: AUTH, body: TWO_STEP });
  assert(precheck.status === 201 && precheck.body?.valid === true && precheck.body?.flowId === 'two-step',
    `#102 POST /approval-config/validate → ${precheck.status}（试写预检，engine-flow 权威校验）`);
  const badFlow = await call(PORT_MAIN, 'POST', '/approval-config/flows', {
    headers: AUTH,
    body: { config: { ...TWO_STEP, schemaVersion: 99 } },
  });
  assert(badFlow.status === 400, `POST /approval-config/flows 非法配置 → ${badFlow.status}（400）`);

  const flowA = await call(PORT_MAIN, 'POST', '/approval-config/flows', {
    headers: AUTH,
    body: { name: '两步流', config: TWO_STEP },
  });
  assert(flowA.status === 201 && flowA.body?.active === true && flowA.body?.flowId === 'two-step',
    `POST /approval-config/flows {two-step}（创建即启用）→ ${flowA.status}`);
  const flowB = await call(PORT_MAIN, 'POST', '/approval-config/flows', {
    headers: AUTH,
    body: { config: { ...TWO_STEP, flowId: 'replacement-flow' } },
  });
  assert(flowB.status === 201 && flowB.body?.active === true, `POST {replacement-flow} → ${flowB.status}`);
  const flowsMid = await call(PORT_MAIN, 'GET', '/approval-config/flows', { headers: AUTH });
  const aRow = flowsMid.body?.flows?.find((row) => row.flowId === 'two-step');
  assert(flowsMid.status === 200 && aRow?.active === false,
    `创建 replacement-flow 后 two-step 被单启用收口置停用（active=${aRow?.active}）`);

  // ---- ② #101 通知：显式发布 + 未读/已读/置读 ----
  const deniedNotify = await call(PORT_MAIN, 'GET', '/notifications', { headers: VIEWER_AUTH });
  assert(deniedNotify.status === 403, `GET /notifications（viewer）→ ${deniedNotify.status}（notification:read 门禁）`);
  const published = await call(PORT_MAIN, 'POST', '/notifications', {
    headers: AUTH,
    body: { recipient: ADMIN, title: '联调补发通知', source: 'ops' },
  });
  assert(published.status === 201 && published.body?.readAt === null,
    `#101 POST /notifications（运维补发）→ ${published.status}`);
  const unread1 = await call(PORT_MAIN, 'GET', '/notifications/unread-count', { headers: AUTH });
  assert(unread1.status === 200 && unread1.body?.count === 1, `GET /notifications/unread-count → ${unread1.body?.count}`);

  // ---- ③-2 #102 运行时解析器：active 流驱动新案 + 决策闭环 ----
  const started = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'capability-e2e', id: 'cap-1' }, approvers: [ADMIN], reason: '活库组合态验证' },
  });
  assert(started.status === 201 && started.body?.case?.flowConfigId === 'replacement-flow' && started.body?.case?.state === 'in_review',
    `POST /approval/cases → flowConfigId=${started.body?.case?.flowConfigId} state=${started.body?.case?.state}（active 流驱动新案）`);
  const decision = await call(PORT_MAIN, `POST`, `/approval/cases/${started.body?.case?.id}/decisions`, {
    headers: AUTH,
    body: { decision: 'approve', reason: '同意' },
  });
  assert(decision.status === 201 && decision.body?.case?.state === 'approved',
    `POST /approval/cases/:id/decisions approve → ${decision.status} state=${decision.body?.case?.state}（启用配置的决策闭环）`);

  // ---- ②-2 待办桥：审批派待办 → 收件箱同源通知 ----
  const unread2 = await call(PORT_MAIN, 'GET', '/notifications/unread-count', { headers: AUTH });
  assert(unread2.status === 200 && unread2.body?.count === 2,
    `审批发起后 unread-count=${unread2.body?.count}（补发 1 + 待办桥 1——接线 #27）`);
  const inbox = await call(PORT_MAIN, 'GET', '/notifications', { headers: AUTH });
  const bridgeRow = (inbox.body?.notifications ?? []).find((row) => row.source === 'approval');
  assert(bridgeRow !== undefined && bridgeRow.refType === 'approval-case' && bridgeRow.title.includes('capability-e2e'),
    `收件箱含待办桥通知（source=approval refType=${bridgeRow?.refType}）`);
  const marked = await call(PORT_MAIN, 'POST', `/notifications/${bridgeRow?.id}/read`, { headers: AUTH });
  assert(marked.status === 201 && marked.body?.readAt !== null, `POST /notifications/:id/read → ${marked.status}（已读）`);
  const sweep = await call(PORT_MAIN, 'POST', '/notifications/read-all', { headers: AUTH });
  assert(sweep.status === 201 && sweep.body?.updated === 1, `POST /notifications/read-all → updated=${sweep.body?.updated}（剩余未读清零；@Post 默认 201）`);

  // ---- ③-3 #102 版本历史 + 启用历史版本 + 停用回落 ----
  const replaced = await call(PORT_MAIN, 'PUT', `/approval-config/flows/${flowB.body?.id}`, {
    headers: AUTH,
    body: {
      config: {
        ...TWO_STEP,
        flowId: 'replacement-flow',
        states: [{ id: 'draft' }, { id: 'reviewing' }, { id: 'approved', final: true }],
        transitions: [
          { from: 'draft', event: 'SUBMIT', to: 'reviewing' },
          { from: 'reviewing', event: 'APPROVE', to: 'approved', decision: 'approve' },
        ],
      },
    },
  });
  assert(replaced.status === 200 && replaced.body?.history?.length === 1,
    `PUT 整文档替换 → history=${replaced.body?.history?.length}（先前配置入档）`);
  const restored = await call(PORT_MAIN, 'PUT', `/approval-config/flows/${flowB.body?.id}`, {
    headers: AUTH,
    body: { config: replaced.body?.history?.[0]?.config },
  });
  assert(restored.status === 200 && restored.body?.history?.length === 2 && restored.body?.config?.states?.some((s) => s.id === 'in_review'),
    `PUT 启用历史版本 → history=${restored.body?.history?.length}（当前配置再入档，快照恢复）`);
  const reactivate = await call(PORT_MAIN, 'POST', `/approval-config/flows/${flowA.body?.id}/activate`, { headers: AUTH });
  assert(reactivate.status === 201 && reactivate.body?.active === true,
    `POST /approval-config/flows/:id/activate → ${reactivate.status}（启用指定流）`);
  const flowsAfter = await call(PORT_MAIN, 'GET', '/approval-config/flows', { headers: AUTH });
  const bRow = flowsAfter.body?.flows?.find((row) => row.flowId === 'replacement-flow');
  assert(bRow?.active === false, `activate 后其余流 active=${bRow?.active}（单启用收口）`);
  const started2 = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'capability-e2e', id: 'cap-2' }, approvers: [ADMIN], reason: '切换后驱动' },
  });
  assert(started2.status === 201 && started2.body?.case?.flowConfigId === 'two-step',
    `切换启用后新案 flowConfigId=${started2.body?.case?.flowConfigId}（运行时解析器实时生效）`);
  const deactivated = await call(PORT_MAIN, 'PUT', `/approval-config/flows/${flowA.body?.id}`, { headers: AUTH, body: { active: false } });
  assert(deactivated.status === 200 && deactivated.body?.active === false, `PUT active=false → 停用`);
  const fallback = await call(PORT_MAIN, 'POST', '/approval/cases', {
    headers: AUTH,
    body: { subjectRef: { type: 'capability-e2e', id: 'cap-3' }, approvers: [ADMIN], reason: '回落默认' },
  });
  assert(fallback.status === 201 && fallback.body?.case?.flowConfigId === 'general-approval',
    `停用全部流后新案 flowConfigId=${fallback.body?.case?.flowConfigId}（回落内置默认流）`);

  // ---- ④ #1 总览四源端点（聚合页的数据面；页面装配见 web 测试） ----
  const summary = await call(PORT_MAIN, 'GET', '/workbench/summary', { headers: AUTH });
  assert(summary.status === 200 && typeof summary.body?.openTotal === 'number',
    `#1 GET /workbench/summary → ${summary.status}（openTotal=${summary.body?.openTotal}）`);
  const delivery = await call(PORT_MAIN, 'GET', '/workorder/delivery-situation', { headers: AUTH });
  assert(delivery.status === 200 && Array.isArray(delivery.body?.orders) && typeof delivery.body?.generatedAt === 'string',
    `#1 GET /workorder/delivery-situation → ${delivery.status}（orders=${delivery.body?.orders?.length}）`);
  const inspection = await call(PORT_MAIN, 'GET', '/inspection/summary', { headers: AUTH });
  assert(inspection.status === 200 && typeof inspection.body?.pendingCount === 'number',
    `#1 GET /inspection/summary → ${inspection.status}（pendingCount=${inspection.body?.pendingCount}）`);
  const machining = await call(PORT_MAIN, 'GET', '/hours/machining/stats', { headers: AUTH });
  assert(machining.status === 200 && Array.isArray(machining.body?.stats),
    `#1 GET /hours/machining/stats → ${machining.status}（stats=${machining.body?.stats?.length}）`);

  // ---- ⑤ 重启存活 ----
  await stopServer(mainServer);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL, MODULES_ENABLED: MODULES });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库同模块集）');

  const configsAfter = await call(PORT_RESTART, 'GET', '/menu-config/configs', { headers: AUTH });
  const configCodes = (configsAfter.body?.configs ?? []).map((row) => row.code);
  assert(configsAfter.status === 200 && configCodes.includes('default') && configCodes.includes('mobile'),
    `重启后 GET /menu-config/configs → ${JSON.stringify(configCodes)}（两配置集存活）`);
  const flowsSurvive = await call(PORT_RESTART, 'GET', '/approval-config/flows', { headers: AUTH });
  const aSurvive = flowsSurvive.body?.flows?.find((row) => row.flowId === 'two-step');
  assert(flowsSurvive.status === 200 && aSurvive?.history !== undefined && aSurvive?.active === false,
    `重启后 GET /approval-config/flows → two-step active=${aSurvive?.active}（流配置与启用态存活）`);
  const bSurvive = flowsSurvive.body?.flows?.find((row) => row.flowId === 'replacement-flow');
  assert(bSurvive?.history?.length === 2, `重启后 replacement-flow history=${bSurvive?.history?.length}（版本历史存活）`);
  const inboxAfter = await call(PORT_RESTART, 'GET', '/notifications', { headers: AUTH });
  const rowsAfter = inboxAfter.body?.notifications ?? [];
  const readCount = rowsAfter.filter((row) => row.readAt !== null).length;
  // 4 条 = 补发 1 + 桥 3（cap-1/cap-2/cap-3 三次发起各派 1 待办）；已读 2 =
  // 补发（read-all）+ cap-1 桥（单条已读）；cap-2/cap-3 桥未读（发起后未处理）
  assert(inboxAfter.status === 200 && rowsAfter.length === 4 && readCount === 2,
    `重启后 GET /notifications → ${rowsAfter.length} 条（已读 ${readCount}——收件箱与已读状态存活）`);
  const caseAfter = await call(PORT_RESTART, 'GET', `/approval/cases/${started.body?.case?.id}`, { headers: AUTH });
  assert(caseAfter.status === 200 && caseAfter.body?.case?.state === 'approved',
    `重启后审批案件 ${started.body?.case?.id} state=${caseAfter.body?.case?.state}（案件/事件账本存活）`);
  await stopServer(reborn);

  console.log(`\n[e2e-capability] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-capability 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-capability] 容器 ${CONTAINER} 已清理`);
  });
