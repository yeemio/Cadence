/**
 * S1 backfill 端到端验证（0920 #3/#7/#8/#9/#100/#103 + #89/#91/#92/96）。
 *
 * 一次性 docker postgres:16（自管容器，退出即删）：
 *   迁移 deploy → 组织种子 → 起 server（MODULES_ENABLED 显式含
 *   audit,standardreports，DATABASE_URL 指容器）→
 *   ① 六面 CRUD（departments/positions/customers/suppliers/units +
 *   audit-logs 查询）门禁/创建/列表/冲突 →
 *   ② 操作日志写入读回（写操作拦截器落账 + 时间窗/用户过滤）→
 *   ③ 四张标准报表各一查询（psql 直插事实行 → 非空口径 + 远古时间窗空集）→
 *   ④ **重启 server 后六面数据与日志存活** →
 *   ⑤ 零 DB 形态：audit 模块可装、日志写后读回（内存）；standardreports
 *   求值显式 503（口径在、源未绑定的诚实失败）。
 *
 * 用法：pnpm --filter @smes/server backfill:e2e   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PG_PORT = 55496;
const PORT_MAIN = 3496;
const PORT_RESTART = 3497;
const PORT_NODB = 3498;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;
const CONTAINER = `cadence-e2e-backfill-${process.pid}`;
const MODULES = 'core,org,masterdata,workbench,audit,standardreports';

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

/** 容器内 psql 直插报表事实行（表列 NOT NULL 最小集；seq/默认列自管）。 */
function psql(sql) {
  return run(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'cadence', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { capture: true },
  );
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
  // SMES_DEV_AUTH=on：身份断言基于 x-smes-user dev 回落头（测试环境显式开启）。
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

/** 单面 CRUD 检查：403 门禁 ×2、创建 201、重复 code 409、列表含新行。 */
async function crudFace(port, mount, listKey, code, extraBody = {}) {
  const deniedRead = await call(port, 'GET', `/${mount}`, { headers: VIEWER_AUTH });
  assert(deniedRead.status === 403, `GET /${mount}（viewer 无策略）→ ${deniedRead.status}（403 门禁）`);
  const deniedWrite = await call(port, 'POST', `/${mount}`, { headers: VIEWER_AUTH, body: { code, name: 'x' } });
  assert(deniedWrite.status === 403, `POST /${mount}（viewer）→ ${deniedWrite.status}（写门禁）`);

  const created = await call(port, 'POST', `/${mount}`, { headers: AUTH, body: { code, name: `${code}-name`, ...extraBody } });
  const id = created.body?.id;
  assert(created.status === 201 && typeof id === 'string' && id.length > 0,
    `POST /${mount} {${code}}（admin）→ ${created.status}，id=${id}`);
  const dup = await call(port, 'POST', `/${mount}`, { headers: AUTH, body: { code, name: '重码' } });
  assert(dup.status === 409, `POST /${mount} 重复 code → ${dup.status}（409 冲突）`);
  const listed = await call(port, 'GET', `/${mount}`, { headers: AUTH });
  const codes = listed.body?.[listKey]?.map((row) => row.code);
  assert(listed.status === 200 && codes?.includes(code),
    `GET /${mount}（admin）→ ${listed.status}，含 ${code}`);
  return id;
}

async function main() {
  console.log(`[e2e-backfill] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

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
  assert(migrate.status === 0, 'prisma migrate deploy（含 backfill 六表 + RLS 重放 86 表）');
  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`);

  // 4) 起 server A（audit + standardreports 显式开启，PG 形态）
  const mainServer = startServer(PORT_MAIN, { DATABASE_URL, MODULES_ENABLED: MODULES });
  if (!(await waitHealthy(PORT_MAIN, mainServer))) {
    fail(`server A 未就绪，日志尾部：\n${mainServer.log.slice(-15).join('')}`);
    throw new Error('server A boot failed');
  }
  pass('server A 就绪（MODULES_ENABLED 含 audit,standardreports，DATABASE_URL=postgres）');

  const modulesView = await call(PORT_MAIN, 'GET', '/modules');
  assert(JSON.stringify(modulesView.body?.modules) === JSON.stringify(MODULES.split(',')),
    `GET /modules → ${JSON.stringify(modulesView.body?.modules)}`);

  // ---- ① 六面 CRUD ----
  const deptRootId = await crudFace(PORT_MAIN, 'org/departments', 'departments', 'ORG-01');
  const childDept = await call(PORT_MAIN, 'POST', '/org/departments', { headers: AUTH, body: { code: 'ORG-01-1', name: '机加车间', parentId: deptRootId } });
  assert(childDept.status === 201 && childDept.body?.parentId === deptRootId,
    `POST /org/departments 子节点挂父 → ${childDept.status}，parentId 命中`);
  const cycleDept = await call(PORT_MAIN, 'PUT', `/org/departments/${deptRootId}`, { headers: AUTH, body: { parentId: childDept.body?.id } });
  assert(cycleDept.status === 400, `PUT /org/departments 换挂成环 → ${cycleDept.status}（400 拒绝）`);
  const ghostParent = await call(PORT_MAIN, 'POST', '/org/departments', { headers: AUTH, body: { code: 'GHOST-1', name: 'x', parentId: 'no-such' } });
  assert(ghostParent.status === 404, `POST /org/departments 父不存在 → ${ghostParent.status}（404）`);

  const posId = await crudFace(PORT_MAIN, 'org/positions', 'positions', 'POS-01', { departmentRef: deptRootId });
  const posView = await call(PORT_MAIN, 'GET', '/org/positions', { headers: AUTH });
  const pos = posView.body?.positions?.find((row) => row.code === 'POS-01');
  assert(pos?.departmentRef === deptRootId, `GET /org/positions → POS-01 归属机构命中`);

  await crudFace(PORT_MAIN, 'masterdata/customers', 'customers', 'CUST-001', { contact: '010-88886666' });
  await crudFace(PORT_MAIN, 'masterdata/suppliers', 'suppliers', 'SUP-001');
  const unitId = await crudFace(PORT_MAIN, 'masterdata/units', 'units', 'PCS', { symbol: 'PCS' });

  // ---- ② 操作日志：写入读回 ----
  const auditDenied = await call(PORT_MAIN, 'GET', '/audit/logs', { headers: VIEWER_AUTH });
  assert(auditDenied.status === 403, `GET /audit/logs（viewer）→ ${auditDenied.status}（audit:read 门禁）`);
  const auditBad = await call(PORT_MAIN, 'GET', '/audit/logs?limit=0', { headers: AUTH });
  assert(auditBad.status === 400, `GET /audit/logs?limit=0 → ${auditBad.status}（400 输入）`);

  // 上面 ① 的写操作此刻应已在日志里（同步落账取舍：写后立即可查）
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const logs = await call(PORT_MAIN, 'GET', `/audit/logs?from=${encodeURIComponent(since)}&limit=100`, { headers: AUTH });
  const logRows = logs.body?.logs ?? [];
  assert(logs.status === 200 && logRows.length >= 6,
    `GET /audit/logs（近 5 分钟）→ ${logs.status}，${logRows.length} 条（① 的成功写操作全部落账；失败写不落账）`);
  const deptLog = logRows.find((row) => row.method === 'POST' && row.path === '/org/departments');
  assert(deptLog !== undefined && deptLog.userId === ADMIN,
    `日志含 POST /org/departments（userId=${deptLog?.userId}，租户/用户收口命中）`);
  assert(logRows.every((row) => row.summary === `${row.method} ${row.path}`), '日志 summary = method + path（载荷全文不进日志）');

  const byUser = await call(PORT_MAIN, `GET`, `/audit/logs?from=${encodeURIComponent(since)}&userId=${VIEWER}`, { headers: AUTH });
  assert(byUser.status === 200 && (byUser.body?.logs ?? []).length === 0,
    `GET /audit/logs?userId=viewer → 0 条（viewer 只读过没写过——GET 不记）`);
  const narrow = await call(PORT_MAIN, 'GET', '/audit/logs?limit=2', { headers: AUTH });
  assert(narrow.status === 200 && (narrow.body?.logs ?? []).length === 2, `GET /audit/logs?limit=2 → 恰 2 条（limit 截取）`);

  // ---- ③ 四张标准报表 ----
  const catalog = await call(PORT_MAIN, 'GET', '/standard-reports/metrics', { headers: AUTH });
  assert(catalog.status === 200 && catalog.body?.packId === 'standard-reports' && catalog.body?.metrics?.length === 4,
    `GET /standard-reports/metrics → ${catalog.status}，四口径（含降级标注）`);
  const catalogDenied = await call(PORT_MAIN, 'GET', '/standard-reports/metrics', { headers: VIEWER_AUTH });
  assert(catalogDenied.status === 403, `GET /standard-reports/metrics（viewer）→ ${catalogDenied.status}（report:read 门禁）`);
  const unknownMetric = await call(PORT_MAIN, 'POST', '/standard-reports/query', { headers: AUTH, body: { metricId: 'nope' } });
  assert(unknownMetric.status === 404, `POST /standard-reports/query 未知口径 → ${unknownMetric.status}（404）`);

  // psql 直插事实行（报表口径消费的现有事实表；RLS 下 superuser 直插不受限）
  const facts = psql(`
    INSERT INTO stock_movements (id, tenant_id, kind, item_id, warehouse_id, quantity, occurred_at, recorded_by, audit_status, business_time)
    VALUES
      ('e2e-mv-1', 'default', 'production-in', 'e2e-item-1', 'e2e-wh-1', 10, '2026-10-20T10:00:00Z', 'e2e', 'posted', '2026-10-20T10:00:00Z'),
      ('e2e-mv-2', 'default', 'issue-out',     'e2e-item-1', 'e2e-wh-1',  4, '2026-10-21T10:00:00Z', 'e2e', 'posted', '2026-10-21T10:00:00Z'),
      ('e2e-mv-3', 'default', 'purchase-in',   'e2e-item-1', 'e2e-wh-1',  7, '2026-10-22T10:00:00Z', 'e2e', 'posted', '2026-10-22T10:00:00Z');
    INSERT INTO labor_entries (id, tenant_id, worker_id, work_date, trade, hours, direction, source_report_id, source_key, work_order_id, occurred_at, recorded_by, audit_status, business_time)
    VALUES
      ('e2e-le-1', 'default', 'e2e-worker-1', '2026-10-20', 'machining', 8, 'commit', 'e2e-r-1', 'e2e-le-1', 'e2e-wo-1', '2026-10-20T18:00:00Z', 'e2e', 'posted', '2026-10-20T18:00:00Z'),
      ('e2e-le-2', 'default', 'e2e-worker-1', '2026-10-21', 'machining', 2, 'reverse', 'e2e-r-1', 'e2e-le-2', 'e2e-wo-1', '2026-10-21T18:00:00Z', 'e2e', 'posted', '2026-10-21T18:00:00Z'),
      ('e2e-le-3', 'default', 'e2e-worker-2', '2026-10-21', 'assembly',  6, 'commit', 'e2e-r-2', 'e2e-le-3', 'e2e-wo-1', '2026-10-21T18:00:00Z', 'e2e', 'posted', '2026-10-21T18:00:00Z'),
      ('e2e-le-4', 'default', 'e2e-worker-3', '2026-10-21', 'misc',      5, 'commit', 'e2e-r-3', 'e2e-le-4', NULL,          '2026-10-21T18:00:00Z', 'e2e', 'posted', '2026-10-21T18:00:00Z');
    INSERT INTO dispatch_orders (id, tenant_id, kind, flow_config_id, state, title, drawing_no, operation_code, quantity, done_qty, work_order_id)
    VALUES
      ('e2e-do-1', 'default', 'part', 'e2e-flow', 'assigned', 'e2e 派工', 'D-100', 'OP-10', 20, 12, 'e2e-wo-1'),
      ('e2e-do-2', 'default', 'assembly', 'e2e-flow', 'assigned', 'e2e 装配', 'D-100', 'OP-10', 5, 5, 'e2e-wo-1');
  `);
  assert(facts.status === 0, `psql 直插报表事实行（stock_movements×3 / labor_entries×4 含零工行 / dispatch_orders×2）${facts.status === 0 ? '' : `：${facts.stderr.trim()}`}`);

  // #89 库存报表：i-1 收 17（10+7）发 4 净 13（POST 端点 → 201，Nest 默认）
  const inv = await call(PORT_MAIN, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'inventory-movements', from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' },
  });
  const invRow = inv.body?.rows?.find((row) => row.key?.itemId === 'e2e-item-1');
  assert(inv.status === 201 && invRow?.values?.['received-qty'] === 17 && invRow?.values?.['issued-qty'] === 4 && invRow?.values?.['net-qty'] === 13,
    `#89 库存报表 → ${inv.status}，i-1 收/发/净 = ${invRow?.values?.['received-qty']}/${invRow?.values?.['issued-qty']}/${invRow?.values?.['net-qty']}`);

  // #91 工作令工时报表：wo-1 机加 8-2=6 装配 6 合计净 12；零工行（misc、
  // work_order_id NULL，e2e-le-4 5h）被根过滤排除——不产 {workOrderId:null} 幻影行
  const labor = await call(PORT_MAIN, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'workorder-labor-hours' },
  });
  const laborRow = labor.body?.rows?.find((row) => row.key?.workOrderId === 'e2e-wo-1');
  assert(labor.status === 201 && laborRow?.values?.['machining-hours'] === 6 && laborRow?.values?.['assembly-hours'] === 6 && laborRow?.values?.['total-hours'] === 12,
    `#91 工作令工时报表 → ${labor.status}，wo-1 机加/装配/合计 = ${laborRow?.values?.['machining-hours']}/${laborRow?.values?.['assembly-hours']}/${laborRow?.values?.['total-hours']}（冲销负值计入）`);
  const phantom = (labor.body?.rows ?? []).find((row) => row.key?.workOrderId === null);
  assert(phantom === undefined && (labor.body?.rows ?? []).length === 1,
    `#91 零工幻影行回归 → ${((labor.body?.rows ?? []).length)} 行，null 分组 ${phantom === undefined ? '不存在' : JSON.stringify(phantom)}（misc 5h 未混入任何分组）`);

  // #92 派工报工报表：kind=part 根过滤——assembly 行不进，OP-10 派 20 报 12
  const dispatch = await call(PORT_MAIN, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'part-dispatch-report' },
  });
  const dispatchRows = dispatch.body?.rows ?? [];
  assert(dispatch.status === 201 && dispatchRows.length === 1 && dispatchRows[0]?.values?.['dispatched-qty'] === 20 && dispatchRows[0]?.values?.['reported-qty'] === 12,
    `#92 派工报工报表 → ${dispatch.status}，${dispatchRows.length} 行（assembly 行被 kind=part 根过滤排除），派/报 = ${dispatchRows[0]?.values?.['dispatched-qty']}/${dispatchRows[0]?.values?.['reported-qty']}`);

  // #96 入库日报表：kind=production-in——issue-out/purchase-in 不进；10-20 一行收 10
  const daily = await call(PORT_MAIN, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'production-receipt-daily' },
  });
  const dailyRows = daily.body?.rows ?? [];
  assert(daily.status === 201 && dailyRows.length === 1 && dailyRows[0]?.key?.periodDay === '2026-10-20' && dailyRows[0]?.values?.['received-qty'] === 10,
    `#96 入库日报表 → ${daily.status}，${dailyRows.length} 行（仅 production-in），10-20 收 ${dailyRows[0]?.values?.['received-qty']}`);

  // 空集：远古时间窗
  const empty = await call(PORT_MAIN, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'inventory-movements', from: '1999-01-01T00:00:00Z', to: '1999-12-31T23:59:59Z' },
  });
  assert(empty.status === 201 && (empty.body?.rows ?? []).length === 0,
    `#89 远古时间窗 → ${empty.status}，空行集（空集口径命中，非报错）`);

  // ---- ④ 重启存活 ----
  await stopServer(mainServer);
  const reborn = startServer(PORT_RESTART, { DATABASE_URL, MODULES_ENABLED: MODULES });
  if (!(await waitHealthy(PORT_RESTART, reborn))) {
    fail(`server B 未就绪，日志尾部：\n${reborn.log.slice(-15).join('')}`);
    throw new Error('server B boot failed');
  }
  pass('server B 重启就绪（同库同模块集）');

  const deptsAfter = await call(PORT_RESTART, 'GET', '/org/departments', { headers: AUTH });
  const deptCodes = deptsAfter.body?.departments?.map((row) => row.code);
  assert(deptsAfter.status === 200 && deptCodes?.includes('ORG-01') && deptCodes?.includes('ORG-01-1'),
    `重启后 GET /org/departments → ${JSON.stringify(deptCodes)}（机构树存活）`);
  const unitsAfter = await call(PORT_RESTART, 'GET', '/masterdata/units', { headers: AUTH });
  assert(unitsAfter.status === 200 && unitsAfter.body?.units?.some((row) => row.code === 'PCS'),
    `重启后 GET /masterdata/units → 含 PCS（计量单位存活）`);
  const logsAfter = await call(PORT_RESTART, 'GET', '/audit/logs?limit=1000', { headers: AUTH });
  assert(logsAfter.status === 200 && (logsAfter.body?.logs ?? []).some((row) => row.method === 'POST' && row.path === '/org/departments'),
    `重启后 GET /audit/logs → 含 POST /org/departments（操作日志存活）`);
  const invAfter = await call(PORT_RESTART, 'POST', '/standard-reports/query', {
    headers: AUTH,
    body: { metricId: 'inventory-movements' },
  });
  const invRowAfter = invAfter.body?.rows?.find((row) => row.key?.itemId === 'e2e-item-1');
  assert(invAfter.status === 201 && invRowAfter?.values?.['net-qty'] === 13,
    `重启后 #89 无时间下界查询 → 净额 ${invRowAfter?.values?.['net-qty']}（期末现存量口径 + 事实源存活）`);
  await stopServer(reborn);

  // ---- ⑤ 零 DB 形态：模块可装 + 诚实失败 ----
  // 内存策略空 = 一切 403——开 dev 策略钩子注入 admin 角色（grant-role → 域内
  // bypass，PermissionService 业务层判定），走与 e2e-org 相同的"内存回落"验证面。
  const noDb = startServer(PORT_NODB, {
    MODULES_ENABLED: 'core,org,masterdata,workbench,audit,standardreports',
    SMES_DEV_POLICY_ENDPOINT: 'on',
  }, ['DATABASE_URL']);
  const booted = await waitHealthy(PORT_NODB, noDb);
  assert(booted, '无 DATABASE_URL：audit+standardreports 模块 boot 成功（内存/未绑定回落）');
  if (booted) {
    const inject = await call(PORT_NODB, 'POST', '/dev/policies', {
      body: { rules: [{ kind: 'grant-role', tenant: 'default', user: ADMIN, role: 'admin' }] },
    });
    assert(inject.status === 200 && inject.body?.applied === 1, `dev 策略钩子注入 admin 角色 → ${inject.status}`);
    const noDbWrite = await call(PORT_NODB, 'POST', '/masterdata/units', { headers: AUTH, body: { code: 'KG', name: '千克', symbol: 'KG' } });
    assert(noDbWrite.status === 201, `无 DATABASE_URL：POST /masterdata/units → ${noDbWrite.status}（内存存储回落）`);
    const noDbLogs = await call(PORT_NODB, 'GET', '/audit/logs', { headers: AUTH });
    assert(noDbLogs.status === 200 && (noDbLogs.body?.logs ?? []).some((row) => row.method === 'POST' && row.path === '/masterdata/units'),
      `无 DATABASE_URL：GET /audit/logs → 含刚写的一条（内存日志写后读回）`);
    const noDbReport = await call(PORT_NODB, 'POST', '/standard-reports/query', { headers: AUTH, body: { metricId: 'inventory-movements' } });
    assert(noDbReport.status === 503, `无 DATABASE_URL：POST /standard-reports/query → ${noDbReport.status}（503 源未绑定——口径在、数据面诚实缺失）`);
  }
  await stopServer(noDb);

  console.log(`\n[e2e-backfill] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-backfill 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-backfill] 容器 ${CONTAINER} 已清理`);
  });
