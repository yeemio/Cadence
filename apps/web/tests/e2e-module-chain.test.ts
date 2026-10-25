/**
 * S3-b 九模块页面命令链真实后端 e2e（S2 遗留验证缺口）：建令 → 流转 →
 * 清单导入+缺口检查 → 齐套拦截/放行 → 派工（自制+外协）→ 报工+核查 →
 * 检验判定（合格/不合格/复检）→ 检验放行入库 → 库存收发。
 *
 * 形态取舍（写明）：与 e2e-scan-report.test.ts 同一套路——vitest 内一次性
 * docker postgres:16 + 15 模块 server（真实认证，不开 SMES_DEV_AUTH）+
 * prisma migrate/seed；证据链 = 页面真实数据通道（apps/web/src/data/*Api.ts
 * 的函数本体对真实 server，Bearer 经 product-ui 会话存储 stub 注入）。
 * web api 层未包的端点仅两处走裸 fetch（与 scan e2e 的 call() 同先例）：
 *   - POST /listing/imports source=excel（json-tables 源——页面装配层暂只
 *     挂 source=workorder 骨架导入，行导入属后端命令面）；
 *   - 匿名 401 门禁探测。
 *
 * 负行为（合同 ≥2）：
 *   1) 齐套拦截（S3-e 接线后完整语义）：缺口存在时齐套刷新 → complete=false
 *      快照（gapQty=10 缺口行）→ 装配派工 rejected（缺口驱动拦截）；步骤3
 *      补货 10 后再刷新 → complete=true → 装配放行。（S3-b 首轮曾钉住组合根
 *      缺口：workorder 注册未注 listing 需求行/库存可用量端口，齐套刷新按
 *      模块缺省"零行全齐套"，唯一生效形态是"无核查记录"——S3-e 已接线
 *      #25/#26，本测试升格为完整语义断言）；
 *   2) 权限门禁：viewer（种子无策略身份）经页面通道提交 → ApiError 403；
 *   （附）匿名无 Bearer → 401。
 *
 * 触发：RUN_E2E=1（缺省 describe.skip——`pnpm test` 不依赖 docker）：
 *   RUN_E2E=1 pnpm --filter @smes/web exec vitest run tests/e2e-module-chain.test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN_E2E = process.env['RUN_E2E'] === '1';
const d = RUN_E2E ? describe : describe.skip;

const ROOT = '/Users/yeemio/AI/gitrep/Cadence';
const CONTAINER = `cadence-e2e-modulechain-${process.pid}`;
const MODULES =
  'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,org,masterdata,workbench,approval,demo';

// 与 e2e-scan-report（55512/3597）错开端口——两文件可并行各起一套栈
const PG_PORT = 55513;
const PORT = 3598;
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;

function run(command: string, args: string[], options: { env?: Record<string, string>; capture?: boolean } = {}) {
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

function pgCount(sql: string): number {
  const result = run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'cadence', '-tAc', sql], {
    capture: true,
  });
  return result.status === 0 ? Number(result.stdout.trim()) : -1;
}

async function call(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: json as any };
}

interface ServerHandle {
  child: ReturnType<typeof spawn>;
  log: string[];
  exited: Promise<number | null>;
}

function startServer(): ServerHandle {
  const child = spawn(process.execPath, [`${ROOT}/apps/server/dist/main.js`], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL, MODULES_ENABLED: MODULES },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const collect = (chunk: Buffer) => log.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, log, exited };
}

async function waitHealthy(server: ServerHandle): Promise<boolean> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    if (server.child.exitCode !== null) return false;
    await delay(500);
  }
  return false;
}

async function stopServer(server: ServerHandle | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([server.exited, delay(8000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await server.exited.catch(() => {});
  }
}

// ---- 页面侧真实模块（vite 管道；stubEnv/stubGlobal 先于 import） ----
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key: string) => storageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void storageBacking.set(key, value),
  removeItem: (key: string) => void storageBacking.delete(key),
  clear: () => storageBacking.clear(),
  key: () => null,
  get length() {
    return storageBacking.size;
  },
};

/** 真实登录并把 token 写进页面会话存储 stub（apiClient Bearer 注入源）。 */
async function loginAndSeedSession(username: string): Promise<string> {
  const login = await call('POST', '/auth/login', { body: { username, password: 'demo-password' } });
  expect([200, 201], `登录 ${username} 应 2xx`).toContain(login.status);
  const { createBrowserTokenSessionStore, TOKEN_SESSION_STORAGE_KEY } = await import('@smes/product-ui');
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: login.body.user.id,
    tenantId: login.body.user.tenant,
    displayName: login.body.user.displayName,
    permissions: login.body.permissions,
    token: login.body.token,
    expiresAt: login.body.expiresAt,
  });
  return login.body.token as string;
}

/** 裸 fetch 命令信封（web api 层未覆盖的命令面——excel 行导入）。 */
let opCounter = 0;
function envelope(kind: string, payload: unknown, expectedRevision: unknown = 'initial') {
  opCounter += 1;
  return {
    operationId: `modulechain-e2e-${kind}-${opCounter}`,
    expectedRevision,
    command: { kind, payload },
  };
}

/** 列表行按字段定位（读回断言用；找不到抛错带全量行便于诊断）。 */
function rowWhere(
  rows: readonly Record<string, unknown>[],
  predicate: (row: Record<string, unknown>) => boolean,
  what: string,
): Record<string, unknown> {
  const row = rows.find(predicate);
  expect(row, `${what}：读回行缺失（rows=${JSON.stringify(rows)}）`).toBeTruthy();
  return row as Record<string, unknown>;
}

/** StockLevelView 可用总量（跨仓 Σ；页面同口径汇总）。 */
function totalAvailable(levels: readonly { readonly itemId: string; readonly availableQty: number }[]): number {
  return levels.reduce((sum, level) => sum + level.availableQty, 0);
}

// ---- 链路数据（describe 级贯穿九步） ----
const PROJECT_NAME = 'S3-b-e2e-九模块命令链';
const ITEM_CODE = 'MAT-E2E-CHAIN-01';
const DRAWING_NO = 'DWG-E2E-CHAIN-01';
const SUPPLIER_REF = 'SUP-E2E-CHAIN-01';
const WH_CODE = 'WH-E2E-CHAIN';

d('S3-b 九模块命令链真实后端 e2e（RUN_E2E=1 触发）', () => {
  let server: ServerHandle | null = null;
  let workorderApi: typeof import('../src/data/workorderApi.js');
  let listingApi: typeof import('../src/data/listingApi.js');
  let dispatchApi: typeof import('../src/data/dispatchApi.js');
  let reportingApi: typeof import('../src/data/reportingApi.js');
  let inspectionApi: typeof import('../src/data/inspectionApi.js');
  let inventoryApi: typeof import('../src/data/inventoryApi.js');
  let masterdataApi: typeof import('../src/data/masterdataApi.js');

  let adminToken = '';
  let itemId = '';
  let warehouseId = '';
  let workOrderId = '';
  let partDispatchId = '';

  beforeAll(async () => {
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
    expect(ready, 'postgres:16 容器就绪').toBe(true);

    // 2) 构建（server 及其依赖；对齐 e2e-scan-report 自包含模式）
    const buildOk = [
      run('pnpm', ['--filter', '@smes/application', 'build']),
      run('pnpm', ['--filter', '@smes/business-store', 'build']),
      run('pnpm', ['--filter', '@smes/server', 'build']),
    ].every((result) => result.status === 0);
    expect(buildOk, '三包构建（application / business-store / server）').toBe(true);

    // 3) 迁移 + 种子
    const migrate = run(
      'pnpm',
      ['--filter', '@smes/business-store', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { env: { DATABASE_URL } },
    );
    expect(migrate.status, 'prisma migrate deploy').toBe(0);
    const seed = run('node', [`${ROOT}/packages/business-store/prisma/seed.mjs`], {
      env: { DATABASE_URL },
      capture: true,
    });
    expect(seed.status === 0 && /seed 完成/.test(seed.stdout), `组织种子：${seed.stdout.trim()}`).toBe(true);

    // 4) 起 server（真实认证：不开 SMES_DEV_AUTH）
    server = startServer();
    if (!(await waitHealthy(server))) {
      throw new Error(`server 未就绪，日志尾部：\n${server.log.slice(-25).join('')}`);
    }

    // 5) 页面真实模块加载（stub 先行：API_BASE 指向真实 server；localStorage 供 Bearer 注入）
    vi.stubEnv('VITE_API_BASE_URL', BASE);
    vi.stubGlobal('window', {
      localStorage: localStorageStub,
      location: { pathname: '/', assign: () => {} },
    });
    workorderApi = await import('../src/data/workorderApi.js');
    listingApi = await import('../src/data/listingApi.js');
    dispatchApi = await import('../src/data/dispatchApi.js');
    reportingApi = await import('../src/data/reportingApi.js');
    inspectionApi = await import('../src/data/inspectionApi.js');
    inventoryApi = await import('../src/data/inventoryApi.js');
    masterdataApi = await import('../src/data/masterdataApi.js');
  }, 600_000);

  afterAll(async () => {
    await stopServer(server);
    run('docker', ['rm', '-f', CONTAINER], { capture: true });
    vi.unstubAllGlobals();
  }, 60_000);

  it('前置数据：建物料 + 建仓库（页面通道）→ 读回', async () => {
    adminToken = await loginAndSeedSession('demo-admin');

    const item = await masterdataApi.createItem({ code: ITEM_CODE, name: '端到端链物料' });
    expect(item.code).toBe(ITEM_CODE);
    const items = await masterdataApi.listItems();
    itemId = String(rowWhere(items as unknown as Record<string, unknown>[], (row) => row['code'] === ITEM_CODE, '物料读回')['id']);
    expect(itemId).toBe(item.id);

    const wh = await inventoryApi.defineWarehouse({
      code: WH_CODE,
      name: '端到端链仓库',
      locations: [{ code: 'LOC-A', name: '主库位' }],
    });
    expect(wh.committed, `建仓库：${wh.reason}`).toBe(true);
    const warehouses = await inventoryApi.listWarehouses();
    warehouseId = String(rowWhere(warehouses, (row) => row['code'] === WH_CODE, '仓库读回')['id']);
  });

  it('步骤1 建令+流转：create → not_started → transition → in_progress（每步状态读回）', async () => {
    const created = await workorderApi.createWorkOrder({ projectName: PROJECT_NAME });
    expect(created.committed, `工作令创建：${created.reason}`).toBe(true);

    const rows = await workorderApi.listWorkOrders();
    const row = rowWhere(rows, (entry) => entry['projectName'] === PROJECT_NAME, '工作令读回');
    workOrderId = String(row['id']);
    expect(row['state']).toBe('not_started');
    expect(typeof row['objectVersion']).toBe('number');

    const transitioned = await workorderApi.transitionWorkOrder(workOrderId, row, { targetState: 'in_progress' });
    expect(transitioned.committed, `工作令流转：${transitioned.reason}`).toBe(true);

    const detail = await workorderApi.getWorkOrderDetail(workOrderId);
    const order = detail['order'] as Record<string, unknown> | undefined;
    expect(order, `工作令详情形状：${JSON.stringify(detail)}`).toBeTruthy();
    expect(order!['state']).toBe('in_progress');
  });

  it('步骤2 清单导入+缺口检查：骨架四类 → excel 行导入（物料匹配）→ 缺口快照（缺口行）', async () => {
    // 2a 骨架导入（页面通道 importSkeleton）→ 四类清单
    const skeleton = await listingApi.importSkeleton(workOrderId);
    expect(skeleton.committed, `骨架导入：${skeleton.reason}`).toBe(true);
    const sheets = await listingApi.listSheets(workOrderId);
    const kinds = new Set(sheets.map((sheet) => String(sheet['kind'])));
    expect(kinds, `四类清单：${JSON.stringify(sheets)}`).toEqual(new Set(['part', 'standard', 'electrical', 'equipment']));

    // 2b excel 行导入（json-tables 源——后端命令面，web 层未包；裸 fetch 同 scan e2e 先例）
    const imported = await call('POST', '/listing/imports', {
      headers: { authorization: `Bearer ${adminToken}` },
      body: envelope('listing.import.v1', {
        source: 'excel',
        workOrderId,
        kind: 'part',
        excel: {
          kind: 'json-tables',
          sheets: [
            {
              name: '零件清单',
              header: ['图号', '物料编码', '物料名称', '需求数量', '需求日期'],
              rows: [[DRAWING_NO, ITEM_CODE, '端到端链物料', '10', '2026-11-30']],
            },
          ],
        },
      }),
    });
    expect(imported.status, `excel 导入：${JSON.stringify(imported.body)}`).toBe(201);
    expect(imported.body.status).toBe('committed');

    // 行读回：物料校验 matched → itemId 已解析 → 需求量 10
    const partSheet = rowWhere(sheets, (sheet) => sheet['kind'] === 'part', '零件清单行');
    const sheetDetail = await listingApi.getSheetDetail(String(partSheet['id']));
    const lines = sheetDetail['lines'] as readonly Record<string, unknown>[];
    const line = rowWhere(lines, (entry) => entry['code'] === ITEM_CODE, '清单行读回');
    expect(line['itemId']).toBe(itemId);
    expect(line['validationStatus']).toBe('matched');
    expect(line['requiredQty']).toBe(10);

    // 2c 缺口核查（页面通道；listing 侧 inventory 端口接线完好）→ 库存 0 → 缺口行 gapQty=10
    const gap = await listingApi.runGapCheck(workOrderId);
    expect(gap.committed, `缺口核查：${gap.reason}`).toBe(true);
    const gapCheck = await listingApi.getLatestGapCheck(workOrderId);
    expect(gapCheck['complete']).toBe(false);
    const gapLines = gapCheck['gapLines'] as readonly Record<string, unknown>[];
    const gapLine = rowWhere(gapLines, (entry) => entry['itemId'] === itemId, '缺口行读回');
    expect(gapLine['requiredQty']).toBe(10);
    expect(gapLine['availableQty']).toBe(0);
    expect(gapLine['gapQty']).toBe(10);
  });

  it('负行为1 齐套拦截（完整语义）：缺口刷新 complete=false → 装配派工被拒；缺口行证据', async () => {
    // 步骤2 已建缺口事实（part 行需 10 / 库存 0）。S3-e 接线后齐套刷新读真实
    // listing 需求行 × inventory 可用量：缺口存在 → complete=false（不再"零行
    // 全齐套"）——该快照即 dispatch 缺口驱动拦截的判据。
    const woRows = await workorderApi.listWorkOrders();
    const woRow = rowWhere(woRows, (entry) => entry['id'] === workOrderId, '工作令行（缺口刷新前）');
    const shortRefresh = await workorderApi.refreshKitCheck(workOrderId, woRow);
    expect(shortRefresh.committed, `缺口刷新：${shortRefresh.reason}`).toBe(true);

    const board = await workorderApi.getKitBoard();
    const snapshot = rowWhere(board, (entry) => entry['workOrderId'] === workOrderId, '齐套看板行（缺口）');
    expect(snapshot['complete']).toBe(false);
    const gapLines = snapshot['gapLines'] as readonly Record<string, unknown>[];
    const gapLine = rowWhere(gapLines, (entry) => entry['itemId'] === itemId, '齐套缺口行');
    expect(gapLine['requiredQty']).toBe(10);
    expect(gapLine['availableQty']).toBe(0);
    expect(gapLine['gapQty']).toBe(10);

    // 缺口快照上创建装配派工 → rejected（缺口驱动拦截：齐套未通过）
    const blocked = await dispatchApi.createDispatchOrder({
      kind: 'assembly',
      quantity: 2,
      workOrderId,
      operationCode: 'OP-ASSY-CHAIN',
    });
    expect(blocked.committed).toBe(false);
    expect(blocked.status).toBe('rejected');
    expect(blocked.reason, '齐套拦截语义（缺口驱动）').toMatch(/齐套未通过.*齐套拦截/);

    // PG 取证：complete=false 快照落账；拦截未落单
    const kitShort = pgCount(
      `select count(*) from kit_checks where work_order_id = '${workOrderId}' and complete = false`,
    );
    expect(kitShort).toBe(1);
    const assemblyCount = pgCount(
      `select count(*) from dispatch_orders where work_order_id = '${workOrderId}' and kind = 'assembly'`,
    );
    expect(assemblyCount).toBe(0);
  });

  it('步骤3 齐套→装配放行：生产入库 10 → 齐套刷新（complete 快照）→ 装配派工 committed', async () => {
    // 生产入库 10（页面通道）→ 实时库存读回 10
    const received = await inventoryApi.receiveStock({
      kind: 'production',
      itemId,
      warehouseId,
      quantity: 10,
      workOrderId,
    });
    expect(received.committed, `生产入库：${received.reason}`).toBe(true);
    const levels = await inventoryApi.fetchStockLevels(itemId);
    expect(totalAvailable(levels), `入库后库存：${JSON.stringify(levels)}`).toBe(10);

    // 齐套刷新（页面通道；expectedRevision = 工作令行 objectVersion）→ 快照落账。
    // S3-e 接线后：真实需求行（需 10）× 可用量（入库后 10）→ 缺口闭合 complete=true
    // （负行为1 的缺口快照已被本快照取代——dispatch 看板取最新）。
    const woRows = await workorderApi.listWorkOrders();
    const woRow = rowWhere(woRows, (entry) => entry['id'] === workOrderId, '工作令行（齐套刷新前）');
    const kitRefresh = await workorderApi.refreshKitCheck(workOrderId, woRow);
    expect(kitRefresh.committed, `齐套刷新：${kitRefresh.reason}`).toBe(true);
    const board = await workorderApi.getKitBoard();
    const snapshot = rowWhere(board, (entry) => entry['workOrderId'] === workOrderId, '齐套看板行');
    expect(snapshot['complete']).toBe(true);

    // 装配派工（同载荷新 operationId）→ committed（拦截解除证据）
    const assembly = await dispatchApi.createDispatchOrder({
      kind: 'assembly',
      quantity: 2,
      workOrderId,
      operationCode: 'OP-ASSY-CHAIN',
    });
    expect(assembly.committed, `装配派工（齐套刷新后）：${assembly.reason}`).toBe(true);

    // PG 取证：kit_checks 1 条 complete 快照；装配单落账
    const kitComplete = pgCount(
      `select count(*) from kit_checks where work_order_id = '${workOrderId}' and complete = true`,
    );
    expect(kitComplete).toBe(1);
    const assemblyCount = pgCount(
      `select count(*) from dispatch_orders where work_order_id = '${workOrderId}' and kind = 'assembly'`,
    );
    expect(assemblyCount).toBe(1);
  });

  it('步骤4 派工（自制+外协）：零件单建+指派 → assigned；外协单行集 → 价补录', async () => {
    // 4a 自制：零件派工（图号×工序随单）→ 指派 user-demo-admin → 状态读回
    const part = await dispatchApi.createDispatchOrder({
      kind: 'part',
      quantity: 20,
      workOrderId,
      drawingNo: DRAWING_NO,
      operationCode: 'OP-CHAIN-10',
    });
    expect(part.committed, `零件派工创建：${part.reason}`).toBe(true);
    let orders = await dispatchApi.listDispatchOrders({ workOrderId, kind: 'part' });
    let partRow = rowWhere(orders, (entry) => entry['drawingNo'] === DRAWING_NO, '零件派工读回');
    partDispatchId = String(partRow['id']);
    expect(partRow['state']).toBe('draft');

    const assigned = await dispatchApi.assignDispatchOrder(partDispatchId, partRow, { assignee: 'user-demo-admin' });
    expect(assigned.committed, `零件派工指派：${assigned.reason}`).toBe(true);
    orders = await dispatchApi.listDispatchOrders({ workOrderId, kind: 'part' });
    partRow = rowWhere(orders, (entry) => entry['id'] === partDispatchId, '零件派工指派后读回');
    expect(partRow['state']).toBe('assigned');

    // 4b 外协：外协派工（供应商×工序×数量行集）→ 行读回（未定价）→ 单价补录 → 供应商维度读回已定价
    const outsourcing = await dispatchApi.createDispatchOrder({
      kind: 'outsourcing',
      quantity: 5,
      workOrderId,
      lines: [{ processCode: 'OP-OUT-CHAIN', supplierRef: SUPPLIER_REF, supplierName: '端到端链供应商', quantity: 5 }],
    });
    expect(outsourcing.committed, `外协派工创建：${outsourcing.reason}`).toBe(true);
    const outOrders = await dispatchApi.listDispatchOrders({ workOrderId, kind: 'outsourcing' });
    const outRow = rowWhere(outOrders, (entry) => entry['state'] === 'draft', '外协派工读回');
    const outDetail = await dispatchApi.getDispatchDetail(String(outRow['id']));
    const outLines = outDetail['outsourcingLines'] as readonly Record<string, unknown>[];
    expect(outLines, `外协明细行：${JSON.stringify(outDetail)}`).toHaveLength(1);
    expect(outLines[0]!['supplierRef']).toBe(SUPPLIER_REF);
    expect(outLines[0]!['unitPriceMinor']).toBeNull(); // 无规则落未定价——补录锚点

    let supplierLines = await dispatchApi.listOutsourcingLines(SUPPLIER_REF);
    const lineRow = rowWhere(supplierLines, (entry) => entry['supplierRef'] === SUPPLIER_REF, '外协行（供应商维度）');
    const backfilled = await dispatchApi.backfillOutsourcingPrice(String(lineRow['lineId']), lineRow, {
      unitPriceMinor: 12_500,
      promisedAt: '2026-11-15T00:00:00.000Z',
    });
    expect(backfilled.committed, `外协价补录：${backfilled.reason}`).toBe(true);
    supplierLines = await dispatchApi.listOutsourcingLines(SUPPLIER_REF);
    const priced = rowWhere(supplierLines, (entry) => entry['supplierRef'] === SUPPLIER_REF, '外协行（补录后）');
    expect(priced['unitPriceMinor']).toBe(12_500);

    // PG 取证：dispatch_orders 3 单（装配+零件+外协）挂本工作令
    const dispatchCount = pgCount(`select count(*) from dispatch_orders where work_order_id = '${workOrderId}'`);
    expect(dispatchCount).toBe(3);
  });

  it('步骤5 报工+核查：页面通道提交 → reported → 核查 → verified（状态读回 + PG 取证）', async () => {
    // 5a 页面提交通道（submitReportDraft——扫码头/移动报工页同函数）
    await expect(
      reportingApi.submitReportDraft({
        key: 'rpt-e2e-modulechain-0001',
        ref: partDispatchId,
        quantity: 8,
        laborMinutes: 90,
        note: 'S3-b 命令链报工',
        submittedAt: '2026-10-25T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    let reports = await reportingApi.listReports({ dispatchId: partDispatchId });
    let reportRow = rowWhere(reports, (entry) => entry['dispatchId'] === partDispatchId, '报工单读回');
    const reportId = String(reportRow['id']);
    expect(reportRow['state']).toBe('reported');
    expect(reportRow['doneQty']).toBe(8);
    expect(reportRow['reporter']).toBe('user-demo-admin');

    // 5b 核查（页面通道；expectedRevision = 报工行 objectVersion）
    const verified = await reportingApi.verifyReport(reportId, reportRow, 'S3-b 命令链核查通过');
    expect(verified.committed, `报工核查：${verified.reason}`).toBe(true);
    reports = await reportingApi.listReports({ dispatchId: partDispatchId });
    reportRow = rowWhere(reports, (entry) => entry['id'] === reportId, '报工单核查后读回');
    expect(reportRow['state']).toBe('verified');

    // PG 取证
    const inDb = pgCount(`select count(*) from work_reports where dispatch_id = '${partDispatchId}'`);
    expect(inDb).toBe(1);
  });

  it('步骤6 检验判定：建检 → 判 7/1 → failed + 不合格明细 → 返工处置 → 复检 8/0 → passed', async () => {
    // 6a 手工建检（self_outsourced 外协回厂口径；页面通道）
    const created = await inspectionApi.createInspectionOrder({
      kind: 'self_outsourced',
      quantity: 8,
      itemId,
      drawingNo: DRAWING_NO,
    });
    expect(created.committed, `建检：${created.reason}`).toBe(true);
    let orders = await inspectionApi.listInspectionOrders({ kind: 'self_outsourced' });
    let inspectionRow = rowWhere(orders, (entry) => entry['itemId'] === itemId, '质检单读回');
    const inspectionId = String(inspectionRow['id']);
    expect(inspectionRow['state']).toBe('pending');

    // 6b 判定 7/1 → failed；不合格明细 open 自动建
    const judged = await inspectionApi.judgeInspectionOrder(inspectionId, inspectionRow, {
      passedQty: 7,
      failedQty: 1,
      remark: 'S3-b 判定：7 合格 1 不合格',
    });
    expect(judged.committed, `质检判定：${judged.reason}`).toBe(true);
    orders = await inspectionApi.listInspectionOrders({ kind: 'self_outsourced' });
    inspectionRow = rowWhere(orders, (entry) => entry['id'] === inspectionId, '质检单判定后读回');
    expect(inspectionRow['state']).toBe('failed');

    let nonconforms = await inspectionApi.listNonconformities({ inspectionId });
    const nonconformRow = rowWhere(nonconforms, (entry) => entry['inspectionId'] === inspectionId, '不合格明细读回');
    const nonconformId = String(nonconformRow['id']);
    expect(nonconformRow['state']).toBe('open');
    expect(nonconformRow['quantity']).toBe(1);

    // 6c 返工处置 → 复检 8/0 → passed（放行事实在复检合格分支登记）
    const disposed = await inspectionApi.disposeNonconformity(nonconformId, nonconformRow, {
      disposal: 'rework',
      reason: 'S3-b 返工处置',
    });
    expect(disposed.committed, `不合格处置：${disposed.reason}`).toBe(true);

    orders = await inspectionApi.listInspectionOrders({ kind: 'self_outsourced' });
    inspectionRow = rowWhere(orders, (entry) => entry['id'] === inspectionId, '质检单复检前行');
    const rechecked = await inspectionApi.recheckInspectionOrder(inspectionId, inspectionRow, {
      passedQty: 8,
      failedQty: 0,
      remark: 'S3-b 复检合格',
    });
    expect(rechecked.committed, `复检：${rechecked.reason}`).toBe(true);
    orders = await inspectionApi.listInspectionOrders({ kind: 'self_outsourced' });
    inspectionRow = rowWhere(orders, (entry) => entry['id'] === inspectionId, '质检单复检后读回');
    expect(inspectionRow['state']).toBe('passed');

    // 放行事实 PG 取证（放行余量 = 检验放行入库的咬合前提）
    const released = pgCount(`select coalesce(sum(quantity), 0) from release_facts where inspection_id = '${inspectionId}'`);
    expect(released).toBe(8);

    // 登记处置后不合格明细读回（rework 已处置、待复检闭环）
    nonconforms = await inspectionApi.listNonconformities({ inspectionId });
    const disposedRow = rowWhere(nonconforms, (entry) => entry['id'] === nonconformId, '不合格明细处置后读回');
    expect(disposedRow['state']).toBe('disposed');
  });

  it('步骤7 库存收发：检验放行入库 8 → 18；出库 3 → 15；流水读回', async () => {
    // 7a 检验放行入库（页面通道；inspectionId 锚放行咬合）
    const inspectionOrders = await inspectionApi.listInspectionOrders({ kind: 'self_outsourced' });
    const inspectionRow = rowWhere(inspectionOrders, (entry) => entry['itemId'] === itemId, '质检单（入库锚点）');
    const received = await inventoryApi.receiveStock({
      kind: 'inspection',
      itemId,
      warehouseId,
      quantity: 8,
      inspectionId: String(inspectionRow['id']),
    });
    expect(received.committed, `检验放行入库：${received.reason}`).toBe(true);
    let levels = await inventoryApi.fetchStockLevels(itemId);
    expect(totalAvailable(levels), `检验入库后库存：${JSON.stringify(levels)}`).toBe(18);

    // 7b 生产领用出库 3 → 15
    const issued = await inventoryApi.issueStock({
      itemId,
      warehouseId,
      quantity: 3,
      purpose: 'production',
      workOrderId,
    });
    expect(issued.committed, `生产出库：${issued.reason}`).toBe(true);
    levels = await inventoryApi.fetchStockLevels(itemId);
    expect(totalAvailable(levels), `出库后库存：${JSON.stringify(levels)}`).toBe(15);

    // 7c 出入库流水读回（生产入 + 检验入 + 生产出 ≥ 3 行）
    const movements = await inventoryApi.fetchMovements({ itemId });
    expect(movements.length, `库存流水：${JSON.stringify(movements)}`).toBeGreaterThanOrEqual(3);

    // PG 取证
    const movementCount = pgCount(
      `select count(*) from stock_movements where item_id = '${itemId}'`,
    );
    expect(movementCount).toBeGreaterThanOrEqual(3);
  });

  it('负行为2 权限门禁：匿名 401；viewer（无策略）经页面通道 → 403', async () => {
    // 匿名（无 Bearer）裸探测
    const anonymous = await call('POST', '/workorder/work-orders', {
      body: envelope('workorder.create.v1', { projectName: '应被 401 拒绝' }),
    });
    expect(anonymous.status).toBe(401);

    // viewer 登录换会话 → 页面通道建令 → ApiError 403（无策略身份）
    await loginAndSeedSession('viewer');
    await expect(workorderApi.createWorkOrder({ projectName: 'viewer-应-403' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(dispatchApi.createDispatchOrder({ kind: 'assembly', quantity: 1, operationCode: 'OP-X' })).rejects.toMatchObject({
      status: 403,
    });

    // PG 取证：被拒两单均未落投影（work_orders 为状态机投影表）
    const woCount = pgCount(
      `select count(*) from work_orders where project_name in ('应被 401 拒绝', 'viewer-应-403')`,
    );
    expect(woCount).toBe(0);

    // 会话还原为 admin（后续如有断言继续走管理员通道）
    adminToken = await loginAndSeedSession('demo-admin');
  });
});
