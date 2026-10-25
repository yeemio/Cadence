/**
 * M3 maintenance + drawing 专业包服务层 PG e2e（P3 线 Done-when 5）。
 *
 * 一次性 docker postgres:16（自管容器，随机端口，退出即删；不触既有容器）：
 *   随机端口起 PG → prisma migrate deploy（business-store 全量 80 表，含 RLS
 *   replay 终版）→ 服务层 e2e（MaintenanceService / DrawingService ×
 *   connectMaintenanceStore / connectDrawingStore 的 PG 五端口——结构同形注入，
 *   运行时品牌擦除后即同槽位）→ PG 重启存活 → 干净 teardown（失败也 teardown）。
 *
 * 装配方式（合同 Done-when 5 允许的"直接服务层 e2e"形态，写明取舍）：
 *   - R-M3-3 裁定（m3-drafts/README 差异表）：专业包零框架耦合，HTTP 控制器/
 *     装配归组合根（apps/server 的 MaintenanceHttpModule / DrawingHttpModule，
 *     已由 app-registry 注册并有 boot.e2e 401/路由探针覆盖）——故本 e2e 不起
 *     Nest HTTP，直接驱动服务层 × PG 存储，覆盖"PG 形态下的端口合同语义"；
 *   - 本脚本置于根 scripts/（dep-cruiser 只扫 packages+apps，根脚本天然是
 *     组合根视角装配点——这是仓内唯一能同时 import @smes/maintenance、
 *     @smes/drawing 与 business-store 双实现而不破坏 pro-pack/store 层铁律
 *     的位置，boundary-selftest.mjs 同位先例）；
 *   - RLS 行为面（policy 三面）归 deploy/scripts/rls-proof.mjs（80 表实证），
 *     本 e2e 断言应用层租户收口（tenant 参数隔离），两层互补不重复。
 *
 * 场景清单（Done-when 5）：
 *   maintenance：计划版本演进（v1→v2 supersedes，旧版只读可解释）+ 乐观锁/
 *     幂等账本（G1 被拒不占 operationId）/ due-scan 幂等去重（sourceKey 唯一）/
 *     任务状态机迁移 / 三态记录（ckr-/upr-/rpr- + CheckpointFailed 事件）/
 *     设备历史过滤 / 租户收口（t2 全不可见）
 *   drawing：版本链 append-only（v1..v3）+ 钉版本查看不漂移 + 保密门禁
 *     （public 许可 vs restricted 修订同形 404）+ 查看留痕 + 通知 sinceVersion
 *     游标 + 按工作令钉版清单（升级只数许可内新版）+ 租户收口
 *   共同：PG 容器重启后数据存活（PG 是持久化事实源，内存回落不承担此面）
 *
 * 用法（前置 pnpm build 保证 dist 新鲜）：
 *   pnpm build && node scripts/e2e-maintenance-drawing-pg.mjs   （需 docker；自管清理）
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS, '..');
const PG_PORT = await freePort();
const CONTAINER = `cadence-e2e-pro3-${process.pid}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;

// 组合根视角装配：双专业包（领域服务）+ business-store（PG 五端口 × 2）+ business-core（信封/品牌 id）
const { TenantId, UserId, OperationId, makeCommandEnvelope } = await import(
  new URL('../packages/business-core/dist/index.js', import.meta.url).href
);
const { MaintenanceService, MAINTENANCE_EVENT_TYPES } = await import(
  new URL('../packages/maintenance/dist/index.js', import.meta.url).href
);
const { DrawingService } = await import(new URL('../packages/drawing/dist/index.js', import.meta.url).href);
const { connectMaintenanceStore } = await import(
  new URL('../packages/business-store/dist/maintenance/index.js', import.meta.url).href
);
const { connectDrawingStore } = await import(
  new URL('../packages/business-store/dist/drawing/index.js', import.meta.url).href
);

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
function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(message);
  else fail(`${message}（期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}）`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '' };
}

/** 随机空闲端口（listen(0) 借位后释放；竞态由重试兜底——体例同 e2e-live-db）。 */
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

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { capture: true });
    if (probe.status === 0) return;
    await delay(500);
  }
  throw new Error('postgres 就绪等待超时');
}

// ---- 测试身份与信封 ----

const T1 = TenantId.create('t-pro3-a');
const T2 = TenantId.create('t-pro3-b');
const OPERATOR = UserId.create('u-pro3-op');
const WORKER = UserId.create('u-pro3-worker');
const PUBLIC_VIEWER = { userId: UserId.create('u-pro3-public'), clearance: 'public' };
const RESTRICTED_VIEWER = { userId: UserId.create('u-pro3-restricted'), clearance: 'restricted' };

let opCounter = 0;
function envelope(kind, payload, expectedRevision = 'initial', operationId) {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: T1,
    issuedBy: OPERATOR,
    operationId: OperationId.create(operationId ?? `op-pro3-${String(opCounter).padStart(4, '0')}`),
    expectedRevision,
    issuedAt: new Date().toISOString(),
    command: { kind, payload },
  });
}

async function main() {
  console.log(`[e2e-pro3] 容器 ${CONTAINER}，PG 端口 ${PG_PORT}`);

  // 1) 一次性容器 + 全量迁移（含 RLS replay 终版 20261026110000）
  run('docker', ['rm', '-f', CONTAINER], { capture: true });
  const up = run('docker', [
    'run', '-d', '--rm', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=cadence',
    '-p', `${PG_PORT}:5432`, 'postgres:16',
  ]);
  if (up.status !== 0) throw new Error(`容器启动失败：${up.stderr}`);
  try {
    await waitForPostgres();
    const migrate = run(
      'pnpm',
      ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { capture: true, env: { DATABASE_URL } },
    );
    assert(migrate.status === 0, 'prisma migrate deploy（全量迁移含 maintenance/drawing 建表 + RLS replay）');

    // 2) 服务层装配（PG 五端口 × 双专业包；结构同形注入）
    const maintenanceHandle = connectMaintenanceStore({ datasourceUrl: DATABASE_URL });
    const maintenance = new MaintenanceService(maintenanceHandle.stores);
    const drawingHandle = connectDrawingStore({ datasourceUrl: DATABASE_URL });
    const drawing = new DrawingService(drawingHandle.stores);

    // ---- maintenance：计划版本演进（旧版只读，supersedes 链） ----
    const DAILY_PLAN = {
      planId: 'lathe-daily-check',
      name: '车床日保点检',
      resourceRef: 'res-lathe-01',
      cycle: { kind: 'daily' },
      checkpoints: [
        { checkpointId: 'oil-level', label: '油位', expectation: '视窗 1/2~2/3' },
        { checkpointId: 'air-pressure', label: '气压', expectation: '0.4~0.6 MPa' },
      ],
      upkeepActions: ['导轨润滑', '清屑'],
    };
    const v1 = await maintenance.execute(T1, envelope('maintenance.plan.publish.v1', DAILY_PLAN));
    assert(v1.status === 'committed', 'M1 计划首发 v1 committed（PG：maintenance_plans 落账）');
    assertEqual(v1.plan?.objectVersion, 1, 'M1 v1 objectVersion=1（supersedes=null 首发链头）');

    const v2 = await maintenance.execute(
      T1,
      envelope('maintenance.plan.publish.v1', { ...DAILY_PLAN, checkpoints: [...DAILY_PLAN.checkpoints, { checkpointId: 'spindle-temp', label: '主轴温度' }] }, 1),
    );
    assert(v2.status === 'committed', 'M2 修订 v2 committed（expectedRevision=1 乐观锁过）');
    assertEqual(v2.plan?.objectVersion, 2, 'M2 v2 objectVersion=2');

    const versions = await maintenance.planVersions(T1, 'lathe-daily-check');
    assertEqual(versions.map((row) => row.objectVersion), [2, 1], 'M2 版本链读回 [v2,v1]（当前版在前；旧版只读可解释）');
    assertEqual(versions[0]?.status, 'current', 'M2 v2 status=current');
    assertEqual(versions[1]?.status, 'superseded', 'M2 旧版 v1 status=superseded（只读，不再被生成面消费）');
    assertEqual(versions[0]?.supersedes, versions[1]?.id, 'M2 v2.supersedes 指向 v1 行 id（证据列修正链）');
    const currents = await maintenance.plans(T1);
    assertEqual(currents.map((row) => row.status), ['current', 'superseded'], 'M2 计划表当前版在前（v2 current / v1 superseded）');

    // 乐观锁 + G1（被拒不占 operationId）+ 幂等账本（同 id 重发拒）
    const staleOp = 'op-pro3-stale';
    const stale = await maintenance.execute(
      T1,
      envelope('maintenance.plan.publish.v1', { ...DAILY_PLAN }, 1, staleOp),
    );
    assert(stale.status === 'rejected', 'M3 过期乐观锁（expectedRevision=1 vs 当前 v2）rejected');
    const retry = await maintenance.execute(
      T1,
      envelope('maintenance.plan.publish.v1', { ...DAILY_PLAN, upkeepActions: ['导轨润滑', '清屑', '冷却液检查'] }, 2, staleOp),
    );
    assert(retry.status === 'committed', 'M3 G1 被拒不占 operationId（同 id 修正重发 committed → v3）');
    const replay = await maintenance.execute(
      T1,
      envelope('maintenance.plan.publish.v1', { ...DAILY_PLAN }, 3, staleOp),
    );
    assert(replay.status === 'rejected', 'M3 幂等账本：已 committed 的 operationId 重发 rejected（maintenance_operations 唯一锚）');

    // ---- maintenance：due-scan 幂等去重（sourceKey 唯一 = DB 级第二防线） ----
    const asOf = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const scan1 = await maintenance.execute(T1, envelope('maintenance.plan.due-scan.v1', { asOf }));
    assert(scan1.status === 'committed' && scan1.scan.tasksCreated >= 1, `M4 due-scan 首扫生成 ${scan1.scan?.tasksCreated} 条 plan-due 任务（锚点=首发行 createdAt）`);
    assert(
      scan1.scan.tasks.every((task) => task.sourceKey?.startsWith('due:lathe-daily-check:')),
      'M4 任务 sourceKey=due:<planId>:<occurrenceKey>（到期锚点）',
    );
    const scan2 = await maintenance.execute(T1, envelope('maintenance.plan.due-scan.v1', { asOf }));
    assertEqual(scan2.scan?.tasksCreated, 0, 'M4 同 asOf 重扫（新 operationId）零追加——幂等去重');

    // ---- maintenance：任务状态机迁移（scheduled → executing → done） ----
    const created = await maintenance.execute(
      T1,
      envelope('maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'checkpoint', planId: 'lathe-daily-check', assignee: String(WORKER) }),
    );
    assert(created.status === 'committed', 'M6 手工建单 committed（scheduled@v1 初始投影）');
    const taskId = created.task?.id;
    assertEqual(created.task?.planVersion, 3, 'M6 建单溯源当前计划版本 planVersion=3 快照');
    const started = await maintenance.execute(
      T1,
      envelope('maintenance.task.start.v1', { taskId }, 1),
    );
    assertEqual(started.task?.state, 'executing', 'M6 start：scheduled → executing（乐观锁 objectVersion 1→2）');
    const completed = await maintenance.execute(
      T1,
      envelope('maintenance.task.complete.v1', { taskId }, 2),
    );
    assertEqual(completed.task?.state, 'done', 'M6 complete：executing → done 终态（2→3）');

    // ---- maintenance：三态记录（checkpoint/upkeep/repair）+ 历史过滤 ----
    const ck = await maintenance.execute(
      T1,
      envelope('maintenance.record.append.v1', { kind: 'checkpoint', resourceRef: 'res-lathe-01', planId: 'lathe-daily-check', checkpointId: 'oil-level', result: 'fail', note: '低于视窗下限' }),
    );
    assert(ck.status === 'committed' && ck.record?.kind === 'checkpoint', 'M7 点检记录 committed（ckr- 前缀 id=' + String(ck.record?.id).slice(0, 4) + '…）');
    assertEqual(
      ck.events.map((event) => event.eventType),
      [MAINTENANCE_EVENT_TYPES.activityAppended, MAINTENANCE_EVENT_TYPES.checkpointFailed],
      'M7 点检 fail → ActivityAppended + CheckpointFailed 双事件（event_records + outbox_records 同事务）',
    );
    const up = await maintenance.execute(
      T1,
      envelope('maintenance.record.append.v1', { kind: 'upkeep', resourceRef: 'res-lathe-01', planId: 'lathe-daily-check', actionsDone: ['导轨润滑'] }),
    );
    assert(up.status === 'committed' && String(up.record?.id).startsWith('upr-'), 'M7 保养记录 committed（upr- 前缀）');
    const rp = await maintenance.execute(
      T1,
      envelope('maintenance.record.append.v1', { kind: 'repair', resourceRef: 'res-lathe-01', faultRef: 'fault-17', restored: true }),
    );
    assert(rp.status === 'committed' && String(rp.record?.id).startsWith('rpr-'), 'M7 维修记录 committed（rpr- 前缀，faultRef 引用 + restored）');
    const byKind = await maintenance.resourceHistory(T1, { resourceRef: 'res-lathe-01', kind: 'checkpoint' });
    assertEqual(byKind.length, 1, 'M7 设备历史按 kind 过滤（checkpoint → 1 行；append-only 原行不改）');
    const byTask = await maintenance.resourceHistory(T1, { taskId });
    assertEqual(byTask.length, 0, 'M7 历史按任务过滤（无挂任务的留痕 → 0 行，task_id 收口）');

    // ---- maintenance：租户收口（t2 对 t1 数据全不可见） ----
    assertEqual((await maintenance.plans(T2)).length, 0, 'M8 租户收口：t2 计划表 0 行');
    let crossTenantPlan404 = false;
    try {
      await maintenance.planVersions(T2, 'lathe-daily-check');
    } catch (error) {
      crossTenantPlan404 = error?.name === 'MaintenanceNotFoundError';
    }
    assert(crossTenantPlan404, 'M8 租户收口：t2 版本链 → 与不存在同形 MaintenanceNotFoundError');
    assertEqual((await maintenance.taskQueue(T2)).length, 0, 'M8 租户收口：t2 任务队列 0 行');
    assertEqual((await maintenance.resourceHistory(T2, { resourceRef: 'res-lathe-01' })).length, 0, 'M8 租户收口：t2 设备历史 0 行');

    // ---- drawing：版本链 append-only + 钉版本 + 门禁 + 留痕 + 游标 ----
    const d1 = await drawing.execute(
      T1,
      envelope('drawing.publish.v1', { drawingId: 'dwg-mold-01', fileRef: 's3://dwg/mold-01/v1.step', changeNote: '首发', classification: 'public' }, 'initial'),
    );
    assert(d1.status === 'committed' && d1.revision?.version === 1, 'D1 图纸首发 v1 committed + 通知 0→1');
    assertEqual(d1.notice?.toVersion, 1, 'D1 发布联动变更通知（from 0 → to 1）');
    const d2 = await drawing.execute(
      T1,
      envelope('drawing.publish.v1', { drawingId: 'dwg-mold-01', fileRef: 's3://dwg/mold-01/v2.step', changeNote: '公差修订', classification: 'public' }, 1),
    );
    assert(d2.status === 'committed' && d2.revision?.supersedesVersion === 1, 'D2 v2 committed（supersedesVersion=1 派生链）');
    const d3 = await drawing.execute(
      T1,
      envelope('drawing.publish.v1', { drawingId: 'dwg-mold-01', fileRef: 's3://dwg/mold-01/v3-restricted.step', changeNote: '热处理工艺收紧（受限）', classification: 'restricted' }, 2),
    );
    assert(d3.status === 'committed' && d3.revision?.version === 3, 'D2 v3 committed（restricted 保密等级）');

    const chain = await drawing.revisionChain(T1, PUBLIC_VIEWER, 'dwg-mold-01');
    assertEqual(chain.map((row) => row.version), [1, 2], 'D2 public 许可修订链只列 [v1,v2]（v3 restricted 按许可过滤；清单无 fileRef）');
    const chainFull = await drawing.revisionChain(T1, RESTRICTED_VIEWER, 'dwg-mold-01');
    assertEqual(chainFull.map((row) => row.version), [1, 2, 3], 'D2 restricted 许可修订链 [v1,v2,v3]');

    const pinned = await drawing.viewRevision(T1, PUBLIC_VIEWER, 'dwg-mold-01', 2);
    assertEqual(pinned.version, 2, 'D3 钉版本查看：v3 发布后 v2 引用读回仍 v2（钉版不漂移）');
    assert(!!pinned.fileRef, 'D3 fileRef 唯一取得路径 = 留痕后的 viewRevision');
    let notVisibleAs404 = false;
    try {
      await drawing.viewRevision(T1, PUBLIC_VIEWER, 'dwg-mold-01', 3);
    } catch (error) {
      notVisibleAs404 = error?.name === 'DrawingNotFoundError';
    }
    assert(notVisibleAs404, 'D4 public 许可看 restricted v3 → 与不存在同形 DrawingNotFoundError（不泄漏存在性）');
    const restrictedView = await drawing.viewRevision(T1, RESTRICTED_VIEWER, 'dwg-mold-01', 'latest');
    assertEqual(restrictedView.version, 3, 'D4 restricted 许可 latest → v3 可见（门禁=许可等级 ≥ 修订等级）');

    const audit = await drawing.viewAudit(T1);
    assertEqual(audit.length, 2, 'D5 查看留痕 2 行（谁/何时/哪修订/当时等级快照；append-only 审计）');

    const noticesSince1 = await drawing.notices(T1, 'dwg-mold-01', 1);
    assertEqual(noticesSince1.map((row) => row.toVersion), [2, 3], 'D6 通知 sinceVersion=1 游标 → [to v2, to v3] 升序');
    const woViews = await drawing.drawingsForWorkOrder(T1, PUBLIC_VIEWER, [{ drawingId: 'dwg-mold-01', version: 2 }]);
    assertEqual(woViews.map((row) => row.status), ['ok'], 'D6 工作令钉版清单 ok');
    assertEqual(woViews[0]?.hasUpdate, false, 'D6 public 许可升级视图 hasUpdate=false（v3 超许可不数——不越级泄漏）');
    const woRestricted = await drawing.drawingsForWorkOrder(T1, RESTRICTED_VIEWER, [{ drawingId: 'dwg-mold-01', version: 2 }]);
    assertEqual(woRestricted[0]?.hasUpdate, true, 'D6 restricted 许可 hasUpdate=true（v3 在许可内，latestVersion=3）');

    // ---- drawing：租户收口 ----
    assertEqual((await drawing.revisionChain(T2, RESTRICTED_VIEWER, 'dwg-mold-01')).length, 0, 'D7 租户收口：t2 修订链 0 行');
    assertEqual((await drawing.notices(T2, 'dwg-mold-01')).length, 0, 'D7 租户收口：t2 通知 0 行');
    let crossTenant404 = false;
    try {
      await drawing.viewRevision(T2, RESTRICTED_VIEWER, 'dwg-mold-01', 1);
    } catch (error) {
      crossTenant404 = error?.name === 'DrawingNotFoundError';
    }
    assert(crossTenant404, 'D7 租户收口：t2 查看同图纸 → 同形 404');

    // ---- PG 重启存活（持久化事实源；断连后重建句柄） ----
    await maintenanceHandle.disconnect();
    await drawingHandle.disconnect();
    const restart = run('docker', ['restart', CONTAINER], { capture: true });
    assert(restart.status === 0, 'R1 docker restart 容器');
    await waitForPostgres();
    const maintHandle2 = connectMaintenanceStore({ datasourceUrl: DATABASE_URL });
    const maintenance2 = new MaintenanceService(maintHandle2.stores);
    const drawHandle2 = connectDrawingStore({ datasourceUrl: DATABASE_URL });
    const drawing2 = new DrawingService(drawHandle2.stores);
    const survivedPlans = await maintenance2.planVersions(T1, 'lathe-daily-check');
    assertEqual(survivedPlans.map((row) => row.objectVersion), [3, 2, 1], 'R1 重启存活：计划版本链 [v3,v2,v1]（当前版在前）完整读回');
    assertEqual((await maintenance2.resourceHistory(T1, { resourceRef: 'res-lathe-01' })).length, 3, 'R1 重启存活：三态记录 3 行读回');
    const survivedChain = await drawing2.revisionChain(T1, RESTRICTED_VIEWER, 'dwg-mold-01');
    assertEqual(survivedChain.map((row) => row.version), [1, 2, 3], 'R1 重启存活：图纸修订链 [v1,v2,v3] 读回');
    assertEqual((await drawing2.notices(T1, 'dwg-mold-01')).length, 3, 'R1 重启存活：变更通知 3 行读回');
    await maintHandle2.disconnect();
    await drawHandle2.disconnect();
  } finally {
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    console.log(`[e2e-pro3] 容器 ${CONTAINER} 已清理`);
  }

  console.log(`[e2e-pro3] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('[e2e-pro3] 异常终止：', error);
  run('docker', ['rm', '-f', CONTAINER], { capture: true });
  process.exitCode = 1;
});
