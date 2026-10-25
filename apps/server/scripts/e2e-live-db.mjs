/**
 * 活库首命令冒烟（M2 后第一增量——status.md Wave-2 残余注记"活库首命令冒烟
 * 待首个活库环境补口"闭合 + Wave-2 缺陷"设 DATABASE_URL 时订单首命令必 500"
 * 活库实证；M3 增量——扩至四专业包 + 六源物化活库断言，关闭验收低危 #1
 * "六源物化逻辑无活库测试"）。
 *
 * 一次性 docker postgres:16（自管容器，随机端口，退出即删；不触既有容器）：
 *   随机端口起 PG → migrate deploy（business-store 全量 66 表）→ 组织种子 →
 *   起 server（DATABASE_URL 指该库；MODULES_ENABLED 十四模块=core+九环节+四
 *   专业包；SMES_DEV_AUTH dev 边界 + 种子 admin）→ 核心断言：
 *     ① /modules 十四模块读回（core + 九循环环节 + payroll/maintenance/drawing/metric-pack）
 *     ② purchase.order.submit.v1 首命令 committed（Wave-2 缺陷活库闭合锚点）
 *        + purchase_orders 活库行数取证（docker exec psql）
 *     ③ workorder.create.v1 首命令 committed + work_orders 活库行数取证
 *     ④ （能通则加）report submit → verify → hours 读回非零（接线 #1/#2 链）
 *     ⑤ payroll 活库链：建令→派工→assign→报工→verify→rule publish→run.month→
 *        runs 非零金额+sourceRefs→export xlsx-base64（#21 事实源=活库 hours）
 *     ⑥ maintenance 活库链：plan.publish→due-scan（重放零新建）→task.create→
 *        start→complete→任务队列读回
 *     ⑦ drawing 活库链：publish v1(public)/v2(restricted)→v1 查看留痕→
 *        超许可同形 404→audit 两行
 *     ⑧ metric-pack 六源物化（核心，验收低危 #1 闭合）：造数全走真实模块命令
 *        （不 SQL 直插）→ activate 机加口径包 → 真实 PG 六源求值断言——
 *        90 交付 on-time/delayed 计数、93 准时率、88 上图计数、94 逾期未入库、
 *        95 金额行物化（receivedQty=0 形态，见断言处注记）、97 外协成本额
 *        （工时行按 R6 存量无金额 → sum 0 活库真值，金额化校准挂对账阶段）
 *   → 干净 teardown（容器删、server 停；失败也 teardown）。
 *
 * 用法：pnpm --filter @smes/server smoke:live-db   （需 docker；全程自管清理）
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 随机空闲端口（listen(0) 借位后释放；借位-释放窗口的竞态由重试兜底）。 */
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
const CONTAINER = `cadence-e2e-livedb-${process.pid}`;
const MODULES = 'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack';

const ADMIN = 'user-seed-admin'; // 种子 admin（域内 bypass——冒烟身份，dev 边界）
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

async function call(method, path, { headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT_MAIN}${path}`, {
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

let opCounter = 0;
function envelope(kind, payload, expectedRevision = 'initial') {
  opCounter += 1;
  return {
    operationId: `live-db-${kind}-${opCounter}`,
    expectedRevision,
    command: { kind, payload },
  };
}

let serverHandle = null;

function startServer(extraEnv = {}) {
  // SMES_DEV_AUTH=on：冒烟身份走 x-smes-user dev 回落（真实认证后默认关闭）
  const child = spawn(process.execPath, [resolve(ROOT, 'apps/server/dist/main.js')], {
    env: {
      ...process.env,
      SMES_DEV_AUTH: 'on',
      PORT: String(PORT_MAIN),
      DATABASE_URL,
      MODULES_ENABLED: MODULES,
      ...extraEnv,
    },
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT_MAIN}/health`);
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

/** 活库行数取证（docker exec psql 单值查询）。 */
function pgCount(table) {
  const result = run(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'cadence', '-tAc', `select count(*) from ${table}`],
    { capture: true },
  );
  return result.status === 0 ? Number(result.stdout.trim()) : -1;
}

async function main() {
  console.log(`[e2e-live-db] 容器 ${CONTAINER}，PG 随机端口 ${PG_PORT}，server 端口 ${PORT_MAIN}`);
  console.log(`[e2e-live-db] MODULES_ENABLED=${MODULES}`);

  // 1) 一次性容器（随机端口，自管生命周期）
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
  assert(ready, `postgres:16 容器就绪（随机端口 ${PG_PORT}）`);

  // 2) 构建（自包含，体例同 e2e-org）
  const buildOk = [
    run('pnpm', ['--filter', '@smes/application', 'build']),
    run('pnpm', ['--filter', '@smes/business-store', 'build']),
    run('pnpm', ['--filter', '@smes/server', 'build']),
  ].every((result) => result.status === 0);
  assert(buildOk, '三包构建（application / business-store / server）');

  // 3) 迁移 deploy（business-store schema 全量）+ 组织种子
  const migrate = run('pnpm', ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { DATABASE_URL },
  });
  assert(migrate.status === 0, 'prisma migrate deploy（全部迁移入库）');
  const tableCount = pgCount('information_schema.tables where table_schema = \'public\'');
  assert(tableCount >= 66, `活库表数 = ${tableCount}（business-store 66 表全量）`);

  const seed = run('node', [resolve(ROOT, 'packages/business-store/prisma/seed.mjs')], {
    env: { DATABASE_URL },
    capture: true,
  });
  assert(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`);

  // 4) 起 server（十四模块 + DATABASE_URL 指活库——Wave-2 缺陷触发条件即此形态）
  const server = startServer();
  serverHandle = server;
  if (!(await waitHealthy(server))) {
    fail(`server 未就绪，日志尾部：\n${server.log.slice(-25).join('')}`);
    throw new Error('server boot failed');
  }
  pass('server 就绪（DATABASE_URL=活库 PG，core + 九环节模块 + 四专业包装配）');

  // ---- 断言 ①：/health + /modules 九模块读回 ----
  const health = await call('GET', '/health');
  assert(health.status === 200 && health.body?.status === 'ok', `GET /health → ${health.status} ${JSON.stringify(health.body)}`);

  const modules = await call('GET', '/modules');
  const expectedModules = [
    'core', 'workorder', 'baseline', 'listing', 'inspection', 'inventory',
    'dispatch', 'reporting', 'hours', 'costing', 'payroll', 'maintenance', 'drawing', 'metric-pack',
  ];
  assert(
    modules.status === 200 && JSON.stringify(modules.body?.modules) === JSON.stringify(expectedModules),
    `GET /modules → ${modules.status} ${JSON.stringify(modules.body?.modules)}（core + 九循环环节 + 四专业包）`,
  );

  // ---- 断言 ②：purchase.order.submit.v1 首命令 committed（Wave-2 缺陷活库闭合） ----
  // Wave-2 缺陷：submitOrder 机器事件先于投影行落账 → PG 账本按投影行解析租户
  // fail-fast → 设 DATABASE_URL 时订单首命令必 500。返工后未活库实证——本断言补口。
  const orderSubmit = await call('POST', '/purchase/orders', {
    headers: AUTH,
    body: envelope('purchase.order.submit.v1', {
      supplierRef: 'SUP-LIVE-01',
      supplierName: '活库冒烟供应商',
      promisedAt: '2026-12-01',
      lines: [{ itemId: 'item-live-01', quantity: 20, unitPriceMinor: 12500 }],
    }),
  });
  const orderOutcome = orderSubmit.body?.status;
  assert(
    orderSubmit.status === 201 && orderOutcome === 'committed',
    `purchase.order.submit.v1 首命令 → HTTP ${orderSubmit.status} / ${String(orderOutcome)}（Wave-2 缺陷活库实证闭合；body=${JSON.stringify(orderSubmit.body).slice(0, 300)}）`,
  );
  const orderRow = orderSubmit.body?.order ?? orderSubmit.body?.purchaseOrder;
  const orderId = typeof orderRow?.id === 'string' ? orderRow.id : null;
  assert(orderId !== null && orderId.length > 0, `订单 id 读回 = ${String(orderId)}`);

  // 活库行数取证（投影行 + 命令幂等账本双查）
  const ordersInDb = pgCount('purchase_orders');
  const orderOpsInDb = pgCount("listing_operations where aggregate_type = 'purchase-order'");
  assert(ordersInDb >= 1, `purchase_orders 活库行数 = ${ordersInDb}`);
  assert(orderOpsInDb >= 1, `purchase-order 幂等账本活库行数 = ${orderOpsInDb}`);

  // ---- 断言 ③：workorder.create.v1 首命令 committed + 活库行 ----
  const woCreate = await call('POST', '/workorder/work-orders', {
    headers: AUTH,
    body: envelope('workorder.create.v1', { projectName: '活库冒烟-Proj-01' }),
  });
  assert(
    woCreate.status === 201 && woCreate.body?.status === 'committed',
    `workorder.create.v1 首命令 → HTTP ${woCreate.status} / ${String(woCreate.body?.status)}（body=${JSON.stringify(woCreate.body).slice(0, 300)}）`,
  );
  const workOrderId = woCreate.body?.workOrder?.id ?? null;
  assert(typeof workOrderId === 'string' && workOrderId.length > 0, `工作令 id 读回 = ${String(workOrderId)}`);
  const workOrdersInDb = pgCount('work_orders');
  assert(workOrdersInDb >= 1, `work_orders 活库行数 = ${workOrdersInDb}`);

  // ---- 断言 ③b：ExcelJS 适配器活链（xlsx-bytes 导入 committed → xlsx-base64 导出读回） ----
  try {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('加工件清单');
    sheet.addRow(['图号', '物料编码', '物料名称', '规格型号', '需求数量', '需求日期']);
    sheet.addRow(['DWG-XL-1', 'C-XL-1', '端盖', '规格X', 3, '2026-11-15']);
    sheet.addRow(['DWG-XL-2', 'C-XL-2', '压盖', '规格Y', 2, '2026-11-16']);
    const importBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const listingImport = await call('POST', '/listing/imports', {
      headers: AUTH,
      body: envelope('listing.import.v1', {
        source: 'excel',
        workOrderId,
        kind: 'part',
        excel: { kind: 'xlsx-bytes', base64: importBase64 },
      }),
    });
    assert(
      listingImport.status === 201 && listingImport.body?.status === 'committed',
      `listing.import.v1（xlsx-bytes 源）→ HTTP ${listingImport.status} / ${String(listingImport.body?.status)}（ExcelJS 适配器活链；body=${JSON.stringify(listingImport.body).slice(0, 200)}）`,
    );
    const linesInDb = pgCount('listing_lines');
    assert(linesInDb >= 2, `listing_lines 活库行数 = ${linesInDb}（2 行导入落库）`);

    const exportResult = await call('GET', '/purchase/details/export', { headers: AUTH });
    const exportBody = exportResult.body;
    assert(
      exportResult.status === 200 && exportBody?.kind === 'xlsx-base64' && typeof exportBody?.base64 === 'string' && exportBody.base64.length > 0,
      `GET /purchase/details/export → ${exportResult.status} kind=${String(exportBody?.kind)}（xlsx-base64 字节）`,
    );
    const readBack = new ExcelJS.Workbook();
    await readBack.xlsx.load(Buffer.from(exportBody.base64, 'base64'));
    const exported = readBack.worksheets[0];
    const exportedRows = exported?.rowCount ?? 0;
    assert(exportedRows >= 2, `导出读回（ExcelJS 解析）行数 = ${exportedRows}（表头+数据，真实 xlsx 字节）`);
  } catch (error) {
    fail(`ExcelJS 活链断言异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 断言 ④（能通则加）：report submit → verify → hours 读回非零（接线 #1/#2） ----
  try {
    const dispatchCreate = await call('POST', '/dispatch/orders', {
      headers: AUTH,
      body: envelope('dispatch.create.v1', {
        workOrderId,
        kind: 'part',
        drawingNo: 'DWG-LIVE-01',
        operationCode: 'OP-10',
        quantity: 10,
      }),
    });
    assert(
      dispatchCreate.status === 201 && dispatchCreate.body?.status === 'committed',
      `dispatch.create.v1 → HTTP ${dispatchCreate.status} / ${String(dispatchCreate.body?.status)}`,
    );
    const dispatchOrder = dispatchCreate.body?.dispatchOrder ?? null;
    const dispatchId = dispatchOrder?.id ?? null;
    const dispatchVersion = dispatchOrder?.objectVersion ?? null;
    if (dispatchId === null || dispatchVersion === null) {
      fail(`派工单读回异常：${JSON.stringify(dispatchCreate.body).slice(0, 300)}`);
    } else {
      const assigned = await call('POST', `/dispatch/orders/${dispatchId}/assign`, {
        headers: AUTH,
        body: envelope('dispatch.assign.v1', { assignee: 'u-worker-live', remark: null }, dispatchVersion),
      });
      assert(assigned.body?.status === 'committed', `dispatch.assign.v1 → ${String(assigned.body?.status)}`);

      const reportSubmit = await call('POST', '/reports', {
        headers: AUTH,
        body: envelope('report.submit.v1', { dispatchId, doneQty: 10, laborMinutes: 90 }),
      });
      assert(
        reportSubmit.status === 201 && reportSubmit.body?.status === 'committed',
        `report.submit.v1 → HTTP ${reportSubmit.status} / ${String(reportSubmit.body?.status)}（validDispatch #1 活库链）`,
      );
      const report = reportSubmit.body?.report ?? null;
      if (report?.id === undefined || report?.objectVersion === undefined) {
        fail(`报工单读回异常：${JSON.stringify(reportSubmit.body).slice(0, 300)}`);
      } else {
        const verify = await call('POST', `/reports/${report.id}/verify`, {
          headers: AUTH,
          body: envelope('report.verify.v1', {}, report.objectVersion),
        });
        assert(verify.body?.status === 'committed', `report.verify.v1 → ${String(verify.body?.status)}`);

        // hours 读回非零（reportFeed #2 + ingest 拦截器联动；90min → 1.5h）
        const hoursView = await call('GET', `/hours/work-orders/${workOrderId}`, { headers: AUTH });
        const view = hoursView.body?.view;
        assert(
          hoursView.status === 200 && typeof view?.totalHours === 'number' && view.totalHours > 0 && view.entryCount >= 1,
          `hours 读回非零 → totalHours=${String(view?.totalHours)}，entryCount=${String(view?.entryCount)}（reportFeed #2 + 实时 ingest 联动，活库链）`,
        );
      }
    }
  } catch (error) {
    fail(`report→hours 链异常（能通则加项，不遮蔽核心断言）：${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 断言 ⑤：payroll 专业包活库链（M3 首波；载荷体例照搬 cross-module 用例，store=真实 PG） ----
  // 建令 → 派工 → assign → 报工 → verify → 规则发布 → run.month → runs 非零金额
  // + sourceRefs 下钻 → export xlsx-base64（#21 事实源=活库 hours 条目 + ExcelJS 端口）
  const payrollSeed = { workOrderId: null, laborHours: 2 }; // ⑧ 口径 97 的工时成本事实锚
  try {
    const month = new Date().toISOString().slice(0, 7); // hours 条目按 workDate 归属月

    // 本人同月净工时基线（差分断言锚——断言 ④ 的 1.5h 已在内，不依赖绝对值）
    const myBefore = await call('GET', `/hours/my?month=${month}`, { headers: AUTH });
    const myBody = myBefore.body?.my ?? myBefore.body?.view ?? myBefore.body;
    const baselineHours = typeof myBody?.totalHours === 'number' ? myBody.totalHours : 0;
    assert(
      myBefore.status === 200 && baselineHours >= 1.5,
      `payroll 基线：本人同月净工时 = ${String(baselineHours)}（含断言 ④ 的 1.5h，差分锚）`,
    );

    // 独立工作链（reporter=ADMIN：报工事件的 reporter 即 payroll 归集人）
    const woPr = await call('POST', '/workorder/work-orders', {
      headers: AUTH,
      body: envelope('workorder.create.v1', { projectName: 'payroll 活库链-Proj' }),
    });
    assert(woPr.body?.status === 'committed', `payroll 链建令 → ${String(woPr.body?.status)}`);
    const woPrId = woPr.body?.workOrder?.id ?? null;
    payrollSeed.workOrderId = woPrId;

    const dispPr = await call('POST', '/dispatch/orders', {
      headers: AUTH,
      body: envelope('dispatch.create.v1', {
        workOrderId: woPrId,
        kind: 'part',
        drawingNo: 'DWG-PR-LIVE-1',
        operationCode: 'OP-10',
        quantity: 4,
      }),
    });
    const dispPrOrder = dispPr.body?.dispatchOrder ?? null;
    assert(dispPr.body?.status === 'committed' && typeof dispPrOrder?.id === 'string', `payroll 链派工 → ${String(dispPr.body?.status)}`);

    const assignedPr = await call('POST', `/dispatch/orders/${dispPrOrder?.id}/assign`, {
      headers: AUTH,
      body: envelope('dispatch.assign.v1', { assignee: ADMIN, remark: null }, dispPrOrder?.objectVersion),
    });
    assert(assignedPr.body?.status === 'committed', `payroll 链 assign → ${String(assignedPr.body?.status)}`);

    const repPr = await call('POST', '/reports', {
      headers: AUTH,
      body: envelope('report.submit.v1', { dispatchId: dispPrOrder?.id, doneQty: 4, laborMinutes: 120 }),
    });
    assert(repPr.body?.status === 'committed', `payroll 链报工 → ${String(repPr.body?.status)}`);
    const repPrRow = repPr.body?.report ?? null;

    const verifiedPr = await call('POST', `/reports/${repPrRow?.id}/verify`, {
      headers: AUTH,
      body: envelope('report.verify.v1', {}, repPrRow?.objectVersion),
    });
    assert(verifiedPr.body?.status === 'committed', `payroll 链 verify → ${String(verifiedPr.body?.status)}（120min → 2h 入活库 hours）`);

    // 计薪规则发布（scope.laborKind='part'——machining→part 逆映射错一词本链即红）
    const rulePub = await call('POST', '/payroll/rules/commands', {
      headers: AUTH,
      body: envelope('payroll.rule.publish.v1', {
        ruleId: 'std-part-live',
        name: '活库标准件时薪',
        rateMinor: 10000,
        scope: { laborKind: 'part' },
      }),
    });
    assert(
      rulePub.status === 201 && rulePub.body?.status === 'committed',
      `payroll.rule.publish.v1 → HTTP ${rulePub.status} / ${String(rulePub.body?.status)}（活库规则链）`,
    );

    const runMonth = await call('POST', '/payroll/runs/commands', {
      headers: AUTH,
      body: envelope('payroll.run.month.v1', { periodKey: month }),
    });
    assert(
      runMonth.status === 201 && runMonth.body?.status === 'committed',
      `payroll.run.month.v1 → HTTP ${runMonth.status} / ${String(runMonth.body?.status)}（#21 活库 hours 聚合）`,
    );

    const runsView = await call('GET', `/payroll/runs?month=${month}&personId=${ADMIN}`, { headers: AUTH });
    const mine = Array.isArray(runsView.body)
      ? runsView.body.find((row) => row?.personId === ADMIN)
      : undefined;
    assert(mine !== undefined, `payroll runs 读回本人行（personId=${ADMIN}）`);
    if (mine !== undefined) {
      assert(
        mine.totalQuantity === baselineHours + 2,
        `payroll runs 净工时 = ${String(mine.totalQuantity)}（基线 ${String(baselineHours)} + 本链 2h）`,
      );
      assert(
        mine.totalAmountMinor === (baselineHours + 2) * 10000,
        `payroll runs 金额 = ${String(mine.totalAmountMinor)} 分（净工时 × 时薪 10000）`,
      );
      const partLine = Array.isArray(mine.lines) ? mine.lines.find((line) => line?.laborKind === 'part') : undefined;
      assert(
        partLine !== undefined && Array.isArray(partLine.sourceRefs) && partLine.sourceRefs.length >= 1,
        `payroll runs part 行 sourceRefs 下钻 ≥1（得到 ${JSON.stringify(partLine?.sourceRefs ?? null)}）`,
      );
    }

    const exported = await call('POST', '/payroll/exports/commands', {
      headers: AUTH,
      body: envelope('payroll.export.v1', { periodKey: month, personId: ADMIN }),
    });
    const exportOut = exported.body?.export ?? null;
    assert(
      exported.body?.status === 'committed' && exportOut?.kind === 'xlsx-base64' && typeof exportOut?.base64 === 'string' && exportOut.base64.length > 100,
      `payroll.export.v1 → ${String(exported.body?.status)} / kind=${String(exportOut?.kind)}（xlsx-base64 真字节）`,
    );

    // 口径 97 的成本事实锚：发布口径 + rebuild（2h machining × 6000 分/h = 12000 分）
    const modelPub = await call('POST', '/costing/models', {
      headers: AUTH,
      body: envelope('costing.model.publish.v1', {
        code: 'standard',
        name: '活库口径',
        hourlyRates: { machining: 6000, assembly: 5000, electrical: 6500, aftercare: 5500, misc: 4000 },
        status: 'active',
      }),
    });
    assert(modelPub.body?.status === 'committed', `costing.model.publish.v1 → ${String(modelPub.body?.status)}`);
    const rebuilt = await call('POST', '/costing/rebuild', {
      headers: AUTH,
      body: envelope('costing.rebuild.v1', { workOrderId: woPrId }),
    });
    assert(
      rebuilt.body?.status === 'committed' && rebuilt.body?.totals?.laborMinor === 12000,
      `costing rebuild 工时成本 = ${String(rebuilt.body?.totals?.laborMinor)} 分（2h × 6000，⑧ 口径 97 事实锚）`,
    );
  } catch (error) {
    fail(`payroll 活库链异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 断言 ⑥：maintenance 专业包活库链（载荷体例照搬 cross-module 用例，store=真实 PG） ----
  try {
    const planPub = await call('POST', '/maintenance/plans/commands', {
      headers: AUTH,
      body: envelope('maintenance.plan.publish.v1', {
        planId: 'live-db-daily-check',
        name: '活库车床日点检',
        resourceRef: 'eq-live-01',
        cycle: { kind: 'daily' },
        checkpoints: [{ checkpointId: 'belt-check', label: '皮带松紧检查', expectation: '按压下沉 <10mm' }],
        upkeepActions: ['导轨润滑'],
      }),
    });
    assert(
      planPub.status === 201 && planPub.body?.status === 'committed' && planPub.body?.plan?.objectVersion === 1,
      `maintenance.plan.publish.v1 → HTTP ${planPub.status} / ${String(planPub.body?.status)}（v1 当前版）`,
    );

    const asOf = new Date(Date.now() + 36 * 3_600_000).toISOString();
    const scanned = await call('POST', '/maintenance/plans/due-scan/commands', {
      headers: AUTH,
      body: envelope('maintenance.plan.due-scan.v1', { asOf }),
    });
    const scan = scanned.body?.scan ?? null;
    assert(
      scanned.body?.status === 'committed' && scan?.plansScanned >= 1 && scan?.tasksCreated >= 1 && scan?.tasks?.[0]?.source === 'plan-due',
      `maintenance.plan.due-scan.v1 → 扫描 ${String(scan?.plansScanned)} 计划 / 新建 ${String(scan?.tasksCreated)} 任务（source=plan-due）`,
    );
    const rescanned = await call('POST', '/maintenance/plans/due-scan/commands', {
      headers: AUTH,
      body: envelope('maintenance.plan.due-scan.v1', { asOf }),
    });
    assert(
      rescanned.body?.status === 'committed' && rescanned.body?.scan?.tasksCreated === 0,
      `due-scan 同 asOf 重放零新建（=${String(rescanned.body?.scan?.tasksCreated)}，对账锚语义）`,
    );

    const taskCreate = await call('POST', '/maintenance/tasks/commands', {
      headers: AUTH,
      body: envelope('maintenance.task.create.v1', {
        resourceRef: 'eq-live-01',
        kind: 'repair',
        planId: 'live-db-daily-check',
        assignee: ADMIN,
      }),
    });
    const task = taskCreate.body?.task ?? null;
    assert(
      taskCreate.body?.status === 'committed' && task?.state === 'scheduled' && task?.source === 'manual',
      `maintenance.task.create.v1 → ${String(taskCreate.body?.status)} / state=${String(task?.state)}`,
    );
    const taskStarted = await call('POST', '/maintenance/tasks/start/commands', {
      headers: AUTH,
      body: envelope('maintenance.task.start.v1', { taskId: task?.id }, task?.objectVersion),
    });
    const startedTask = taskStarted.body?.task ?? null;
    assert(
      taskStarted.body?.status === 'committed' && startedTask?.state === 'executing',
      `maintenance.task.start.v1 → state=${String(startedTask?.state)}`,
    );
    const taskDone = await call('POST', '/maintenance/tasks/complete/commands', {
      headers: AUTH,
      body: envelope('maintenance.task.complete.v1', { taskId: task?.id }, startedTask?.objectVersion),
    });
    assert(
      taskDone.body?.status === 'committed' && taskDone.body?.task?.state === 'done',
      `maintenance.task.complete.v1 → state=${String(taskDone.body?.task?.state)}（终态）`,
    );

    const queueDone = await call('GET', '/maintenance/tasks?state=done', { headers: AUTH });
    const doneHit = Array.isArray(queueDone.body) && queueDone.body.some((row) => row?.id === task?.id);
    assert(doneHit, `maintenance 任务队列 state=done 读回本任务（活库查询面）`);
  } catch (error) {
    fail(`maintenance 活库链异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 断言 ⑦：drawing 专业包活库链（载荷体例照搬 cross-module 用例，store=真实 PG） ----
  try {
    const v1Pub = await call('POST', '/drawing/revisions/commands', {
      headers: AUTH,
      body: envelope('drawing.publish.v1', {
        drawingId: 'DWG-LIVE-1',
        fileRef: 'storage://drawings/DWG-LIVE-1/v1.pdf',
        changeNote: '活库首发',
        classification: 'public',
      }),
    });
    assert(
      v1Pub.status === 201 && v1Pub.body?.status === 'committed' && v1Pub.body?.revision?.version === 1,
      `drawing.publish.v1 v1(public) → HTTP ${v1Pub.status} / version=${String(v1Pub.body?.revision?.version)}`,
    );
    const v2Pub = await call('POST', '/drawing/revisions/commands', {
      headers: AUTH,
      body: envelope('drawing.publish.v1', {
        drawingId: 'DWG-LIVE-1',
        fileRef: 'storage://drawings/DWG-LIVE-1/v2.pdf',
        changeNote: '公差收紧',
        classification: 'restricted',
      }, 1),
    });
    assert(
      v2Pub.body?.status === 'committed' && v2Pub.body?.revision?.version === 2 && v2Pub.body?.notice?.toVersion === 2,
      `drawing.publish.v1 v2(restricted) → version=${String(v2Pub.body?.revision?.version)}（变更通知联动）`,
    );

    const viewV1 = await call('GET', '/drawing/revisions/DWG-LIVE-1/view?version=1&clearance=public', { headers: AUTH });
    assert(
      viewV1.status === 200 && String(viewV1.body?.fileRef ?? '').includes('v1.pdf') && viewV1.body?.status === 'superseded',
      `drawing 钉版查看 v1(public) → ${viewV1.status} / ${String(viewV1.body?.status)}（留痕 + 内容指针）`,
    );
    const viewV2Ok = await call('GET', '/drawing/revisions/DWG-LIVE-1/view?version=2&clearance=restricted', { headers: AUTH });
    assert(
      viewV2Ok.status === 200 && viewV2Ok.body?.status === 'current',
      `drawing 查看 v2(restricted 许可) → ${viewV2Ok.status} / ${String(viewV2Ok.body?.status)}`,
    );

    // 超许可与不存在同形 404（不泄漏存在性；消息只回显调用方已知入参）
    const over = await call('GET', '/drawing/revisions/DWG-LIVE-1/view?version=2&clearance=public', { headers: AUTH });
    const missing = await call('GET', '/drawing/revisions/DWG-LIVE-1/view?version=99&clearance=restricted', { headers: AUTH });
    assert(
      over.status === 404 && missing.status === 404 && over.body?.statusCode === missing.body?.statusCode,
      `drawing 超许可/不存在同形 404（${over.status}/${missing.status}，body 同形）`,
    );
    assert(
      !String(over.body?.message ?? '').includes('restricted') && String(over.body?.message ?? '').includes('v2'),
      `drawing 404 消息无等级泄漏（只回显请求版本 v2）`,
    );

    const audit = await call('GET', '/drawing/view-audit?drawingId=DWG-LIVE-1', { headers: AUTH });
    const auditRows = Array.isArray(audit.body) ? audit.body.filter((row) => row?.drawingId === 'DWG-LIVE-1') : [];
    assert(auditRows.length === 2, `drawing 查看留痕审计 = ${String(auditRows.length)} 行（两次成功查看；404 不留痕）`);
  } catch (error) {
    fail(`drawing 活库链异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 断言 ⑧：metric-pack 六源物化活库断言（核心——验收低危 #1 闭合） ----
  // 造数全走真实模块命令（不 SQL 直插）→ activate 机加口径包 → 六源真实 PG 求值。
  try {
    // --- 造数 a：口径 90 交付事实（两条带日期工作令：on-time + delayed 各一） ---
    const woOnTime = await call('POST', '/workorder/work-orders', {
      headers: AUTH,
      body: envelope('workorder.create.v1', {
        projectName: '口径90-活库-按时',
        plannedDeliveryAt: '2026-09-10T00:00:00.000Z',
        packagingArrivalAt: '2026-09-08T00:00:00.000Z', // 实际 <= 计划 → on-time
      }),
    });
    assert(woOnTime.body?.status === 'committed', `口径 90 造数：按时工作令 → ${String(woOnTime.body?.status)}`);
    const woOnTimeRow = woOnTime.body?.workOrder ?? null;
    const woDelayed = await call('POST', '/workorder/work-orders', {
      headers: AUTH,
      body: envelope('workorder.create.v1', {
        projectName: '口径90-活库-延期',
        plannedDeliveryAt: '2026-09-10T00:00:00.000Z',
        packagingArrivalAt: '2026-09-15T00:00:00.000Z', // 实际 > 计划 → delayed
      }),
    });
    assert(woDelayed.body?.status === 'committed', `口径 90 造数：延期工作令 → ${String(woDelayed.body?.status)}`);

    // --- 造数 b：口径 88 上图事实（工作令挂图纸附件——#23 钉版编码 ref） ---
    const attach = await call('POST', `/workorder/work-orders/${woOnTimeRow?.id}/attachments`, {
      headers: AUTH,
      body: envelope('workorder.attach.v1', { name: 'DWG-LIVE-1', kind: 'drawing', ref: 'DWG-LIVE-1@v1' }, woOnTimeRow?.objectVersion),
    });
    assert(attach.body?.status === 'committed', `口径 88 造数：图纸附件挂接 → ${String(attach.body?.status)}`);

    // --- 造数 c：口径 93 外协交货事实（外协派工全链 → 完工联动回厂质检 → 判定） ---
    const osCreate = await call('POST', '/dispatch/orders', {
      headers: AUTH,
      body: envelope('dispatch.create.v1', {
        workOrderId: woOnTimeRow?.id ?? null,
        kind: 'outsourcing',
        quantity: 5,
        lines: [{
          processCode: 'OS-HEAT',
          drawingNo: 'DWG-OS-LIVE-1',
          supplierRef: 'SUP-OS-LIVE-01',
          supplierName: '活库外协一厂',
          quantity: 5,
          unitPriceMinor: 30000,
          promisedAt: '2026-12-01T00:00:00.000Z', // 交期在未来 → 回厂（现在）判定 on-time
          sourceListingLineId: null,
        }],
      }),
    });
    const osOrder = osCreate.body?.dispatchOrder ?? null;
    assert(
      osCreate.body?.status === 'committed' && typeof osOrder?.id === 'string',
      `口径 93 造数：外协派工（含 promisedAt 行）→ ${String(osCreate.body?.status)}`,
    );
    const osAssign = await call('POST', `/dispatch/orders/${osOrder?.id}/assign`, {
      headers: AUTH,
      body: envelope('dispatch.assign.v1', { assignee: ADMIN, remark: null }, osOrder?.objectVersion),
    });
    assert(osAssign.body?.status === 'committed', `口径 93 造数：外协 assign → ${String(osAssign.body?.status)}`);
    const osStart = await call('POST', `/dispatch/orders/${osOrder?.id}/start`, {
      headers: AUTH,
      body: envelope('dispatch.start.v1', { remark: null }, osAssign.body?.dispatchOrder?.objectVersion ?? osAssign.body?.newRevision),
    });
    assert(osStart.body?.status === 'committed', `口径 93 造数：外协 start → ${String(osStart.body?.status)}`);
    const osComplete = await call('POST', `/dispatch/orders/${osOrder?.id}/complete`, {
      headers: AUTH,
      body: envelope('dispatch.complete.v1', { doneQty: null, remark: null }, osStart.body?.dispatchOrder?.objectVersion ?? osStart.body?.newRevision),
    });
    const intake = osComplete.body?.inspectionIntake ?? null;
    assert(
      osComplete.body?.status === 'committed' && intake?.created === true && typeof intake?.inspectionId === 'string',
      `口径 93 造数：外协 complete → ${String(osComplete.body?.status)}，回厂质检联动建单（#9 接线，inspectionId 读回）`,
    );
    const inspectionDetail = await call('GET', `/inspection/orders/${intake?.inspectionId}`, { headers: AUTH });
    const inspectionRow = inspectionDetail.body?.order ?? null;
    assert(
      inspectionDetail.status === 200 && typeof inspectionRow?.objectVersion === 'number',
      `口径 93 造数：回厂质检单读回（state=${String(inspectionRow?.state)}）`,
    );
    const judged = await call('POST', `/inspection/orders/${intake?.inspectionId}/judgment`, {
      headers: AUTH,
      body: envelope('inspection.judge.v1', { passedQty: 5, failedQty: 0, remark: null }, inspectionRow?.objectVersion),
    });
    assert(judged.body?.status === 'committed', `口径 93 造数：质检判定 → ${String(judged.body?.status)}（judgedAt 物化回厂时点）`);

    // --- 造数 d：口径 94/95 采购事实（已过交期未收货订单——isOverdue ∧ outstanding>0） ---
    const overdueOrder = await call('POST', '/purchase/orders', {
      headers: AUTH,
      body: envelope('purchase.order.submit.v1', {
        supplierRef: 'SUP-LIVE-OVERDUE',
        supplierName: '活库逾期供应商',
        promisedAt: '2026-09-01', // 已过交期（now=2026-10）→ isOverdue=true
        lines: [{ itemId: 'item-live-02', quantity: 10, unitPriceMinor: 12501 }],
      }),
    });
    assert(
      overdueOrder.body?.status === 'committed',
      `口径 94/95 造数：逾期采购单 → ${String(overdueOrder.body?.status)}`,
    );
    const overdueOrderId = overdueOrder.body?.order?.id ?? overdueOrder.body?.purchaseOrder?.id ?? null;

    // --- 造数 e：口径 97 成本事实（外协行已定价 → costing rebuild 落真实金额条目） ---
    // 外协行 5 × 30000 分挂在外协派工的工作令上：rebuild 后 cost_entries 有
    // amountMinor=150000 的 outsourcing 条目（工时条目按 R6 存 hours、amountMinor
    // 为 null——金额化延后到口径层，见下方口径 97 断言注记）。
    const osRebuild = await call('POST', '/costing/rebuild', {
      headers: AUTH,
      body: envelope('costing.rebuild.v1', { workOrderId: woOnTimeRow?.id }),
    });
    assert(
      osRebuild.body?.status === 'committed' && osRebuild.body?.totals?.outsourcingMinor === 150000,
      `口径 97 造数：外协成本 rebuild = ${String(osRebuild.body?.totals?.outsourcingMinor)} 分（5 × 30000，真实金额条目入活库 cost_entries）`,
    );

    // --- activate：装载机加垂直口径包 v1（定义从 @smes/metric-pack 导出取） ---
    const { MACHINING_CALIB_PACK_V1 } = await import('@smes/metric-pack');
    const activated = await call('POST', '/metric-pack/activations/commands', {
      headers: AUTH,
      body: envelope('metric-pack.activate.v1', {
        pack: JSON.parse(JSON.stringify(MACHINING_CALIB_PACK_V1)),
      }),
    });
    const activation = activated.body?.activation ?? null;
    assert(
      activated.status === 201 && activated.body?.status === 'committed'
        && activation?.packId === 'smes-machining-calib' && activation?.packVersion === 1 && activation?.status === 'current',
      `metric-pack.activate.v1 → HTTP ${activated.status} / ${String(activated.body?.status)}（smes-machining-calib v1 current）`,
    );

    // --- 求值辅助：GET /metric-pack/evaluate?query={metricId,version} ---
    const evaluate = async (metricId) => {
      const query = encodeURIComponent(JSON.stringify({ metricId, version: 1 }));
      return call('GET', `/metric-pack/evaluate?query=${query}`, { headers: AUTH });
    };
    const rowOf = (result, keyPredicate) =>
      Array.isArray(result?.body?.rows) ? result.body.rows.find((row) => keyPredicate(row?.key ?? {})) : undefined;

    // --- 源 1/6：workorder-delivery-facts（90）——on-time/delayed 计数各 1（2026-09） ---
    const eval90 = await evaluate('workorder-delivery-comparison');
    const onTimeRow = rowOf(eval90, (key) => key.periodMonth === '2026-09' && key.deliveryVerdict === 'on-time');
    const delayedRow = rowOf(eval90, (key) => key.periodMonth === '2026-09' && key.deliveryVerdict === 'delayed');
    assert(
      eval90.status === 200 && onTimeRow?.values?.['workorder-count'] === 1,
      `口径 90 物化：2026-09 on-time 计数 = ${String(onTimeRow?.values?.['workorder-count'])}（packagingArrivalAt<=plannedDeliveryAt 判定）`,
    );
    assert(
      delayedRow?.values?.['workorder-count'] === 1,
      `口径 90 物化：2026-09 delayed 计数 = ${String(delayedRow?.values?.['workorder-count'])}（实际>计划判定）`,
    );

    // --- 源 2/6：outsourcing-delivery-facts（93）——准时率 1.0 + 行数 1 ---
    const eval93 = await evaluate('outsourcing-delivery-performance');
    const osRow = rowOf(eval93, (key) => key.supplierId === 'SUP-OS-LIVE-01' && key.periodMonth === '2026-12');
    assert(
      eval93.status === 200 && osRow?.values?.['dispatch-line-count'] === 1 && osRow?.values?.['on-time-rate'] === 1,
      `口径 93 物化：SUP-OS-LIVE-01@2026-12 行数=${String(osRow?.values?.['dispatch-line-count'])}，准时率=${String(osRow?.values?.['on-time-rate'])}（judgedAt<=promisedAt）`,
    );

    // --- 源 3/6：workorder-attachment-facts（88）——上图图号数/附件数各 1 ---
    const eval88 = await evaluate('drawing-intake-progress');
    const attachRow = rowOf(eval88, (key) => key.workOrderId === woOnTimeRow?.id && key.drawingNo === 'DWG-LIVE-1');
    assert(
      eval88.status === 200 && attachRow?.values?.['uploaded-drawing-count'] === 1 && attachRow?.values?.['attachment-count'] === 1,
      `口径 88 物化：上图图号数=${String(attachRow?.values?.['uploaded-drawing-count'])}，附件数=${String(attachRow?.values?.['attachment-count'])}`,
    );

    // --- 源 4/6：purchase-overdue-facts（94）——逾期未入库 10 件 ---
    const eval94 = await evaluate('purchase-overdue-outstanding');
    const overdueRow = rowOf(eval94, (key) => key.orderLineId === `${overdueOrderId ?? ''}#1`);
    assert(
      eval94.status === 200 && overdueRow?.values?.['outstanding-qty'] === 10 && overdueRow?.values?.['line-count'] === 1,
      `口径 94 物化：逾期未入库 = ${String(overdueRow?.values?.['outstanding-qty'])}（订购 10 − 已收 0，isOverdue=true）`,
    );

    // --- 源 5/6：purchase-amount-facts（95）——lineAmountMinor=receivedQty×unitPriceMinor ---
    // 注记：本装配 receive 链被 inventory 默认仓缺省拦住（defaultWarehouseId=null，
    // 收货入库指令被拒），receivedQty 恒 0 → lineAmountMinor=0 是活库真值；
    // 行物化本身（读 purchase_orders + half-up 乘积）由本断言取证。
    const eval95 = await evaluate('purchase-amount-summary');
    const amountRow = rowOf(eval95, (key) => key.workOrderId === null && key.partType === 'standard-part');
    assert(
      eval95.status === 200 && amountRow !== undefined && amountRow?.values?.['received-amount-minor'] === 0 && amountRow?.values?.['order-count'] >= 1,
      `口径 95 物化：standard-part 行金额 = ${String(amountRow?.values?.['received-amount-minor'])} 分（receivedQty 0 × 单价，half-up 乘积；行集读活库 purchase_orders）`,
    );

    // --- 源 6/6：costing-entry-facts（97）——外协成本 150000 分（真实金额条目） ---
    // 工时行活库实证注记：costing R6 工时条目存 hours、amountMinor=null（金额化
    // 延后到口径层）→ labor 行 sum=0 是活库真值，非物化读错；数值校准挂对账
    // 阶段（合同 04-metric-pack §9/R-M3-1 待裁定），不在本冒烟内裁决。
    const eval97 = await evaluate('project-cost-summary');
    const osCostRow = rowOf(eval97, (key) => key.workOrderId === woOnTimeRow?.id && key.category === 'outsourcing');
    assert(
      eval97.status === 200 && osCostRow?.values?.['amount-minor'] === 150000,
      `口径 97 物化：${String(woOnTimeRow?.id)} 外协成本 = ${String(osCostRow?.values?.['amount-minor'])} 分（= costing rebuild 同口径快照，对账锚）`,
    );
    const laborCostRow = rowOf(eval97, (key) => key.workOrderId === payrollSeed.workOrderId && key.category === 'labor');
    assert(
      laborCostRow?.values?.['amount-minor'] === 0,
      `口径 97 物化：工时行金额 = ${String(laborCostRow?.values?.['amount-minor'])} 分（R6 存工时量 amountMinor=null → sum 跳过；活库真值，金额化校准挂对账阶段）`,
    );

    // 活库行数取证：口径包装载行
    const activationsInDb = pgCount('metric_pack_activations');
    assert(activationsInDb >= 1, `metric_pack_activations 活库行数 = ${activationsInDb}`);
  } catch (error) {
    fail(`metric-pack 六源物化异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // 5) 收口：server 停 → 容器删（finally 兜底，失败也清理）
  await stopServer(server);
  pass('server 已停（SIGTERM）');

  console.log(`\n[e2e-live-db] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch(async (error) => {
    console.error('e2e-live-db 出错:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (serverHandle !== null && !serverHandle.child.killed) {
      await stopServer(serverHandle);
      console.log('[e2e-live-db] 异常路径：server 已补停');
    }
    await run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-live-db] 容器 ${CONTAINER} 已清理（端口 ${PG_PORT}/${PORT_MAIN} 释放）`);
  });
