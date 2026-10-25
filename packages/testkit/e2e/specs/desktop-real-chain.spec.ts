/**
 * 真实操作链浏览器版（V1 核心扩展）：建物品 → 建仓库 → 建工作令 → 流转 →
 * 清单（骨架+行导入）→ 缺口核查 → 生产入库 → 齐套刷新（缺口闭合）→ 齐套
 * 看板读数 → 运营总览读数。
 *
 * 与 apps/web/tests/e2e-module-chain.test.ts（API 版）的语义对照——同一条
 * 命令链（create → not_started → transition → in_progress → 缺口 10/库存 0
 * → 入库 10 → 齐套 complete），证据链从"页面数据通道函数"升格为"真实浏览器
 * 页面 UI 点击/填表"。
 *
 * UI / API 取舍（合同要求写明）：
 * - 走 UI（页面真实点击/填表 → DOM 断言）：建物品、建仓库、建工作令、流转、
 *   清单骨架导入、缺口核查（执行+快照读回）、生产入库、齐套刷新、齐套看板
 *   读数、实时库存读数、运营总览读数。
 * - 走 API 预置（页内 fetch 经 preview proxy 同源 + 真实会话 Bearer——仍是
 *   真实 server 通道，非 mock）仅两处：
 *   1) excel 行导入（POST /listing/imports，listing.import.v1 source=excel）——
 *      web 页面装配层只挂骨架导入，行导入属后端命令面（与 module-chain 裸
 *      fetch 同一先例：web api 层未包该端点）；
 *   2) 物品 id 读回（GET /masterdata/items）——物品页表格呈现面无 id 列
 *      （code/名称/规格/单位/分类/启用），id 是入库表单的必填输入但不可从
 *      UI 读到；清单页/仓库页/工作令页的 id 首列均在 UI 读回不走 API。
 *
 * 重试安全设计（playwright serial 重放语义——失败后整链从头重放，共享 PG
 * 状态贯穿，见 config retries 注释）：
 * - 每次尝试（含 retry 重放）用唯一项目名（runSeed 后缀）——重放建新令，
 *   骨架导入/看板行/总览行定位不再歧义（首轮曾因 .first() 抓到旧令、骨架
 *   导入被"清单已齐"拒绝而红）。
 * - 表级 scope：工作令页两表（列表：列头"状态"；齐套看板：列头"齐套完成"）
 *   同含项目名/工作令 id 文本——按列头过滤钉表，不做页面级 .first()。
 * - 幂等终态断言 + 动态语义：缺口快照自洽校验（gapQty = max(0, 需求-可用)，
 *   complete 与之互斥一致）；库存读数断言 delta（收货前 A → 收货后 A+10），
 *   重放（前次已入库）不破。建物品/建仓库重放撞唯一键 409，行可见断言幂等。
 *
 * 触发：RUN_E2E=1（缺省 skip，不起栈）。serial：链路状态在共享 PG 内贯穿。
 * 文件名须匹配 chromium project testMatch /(desktop|mobile)-.+\.spec\.ts/
 * ——桌面视口链路挂 desktop- 前缀（否则不进 storageState project，首轮曾漏跑）。
 */
import { expect, test, type Page } from '@playwright/test';
import { ARTEFACTS } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

test.describe.configure({ mode: 'serial' });

// ---- 链路数据（describe 级贯穿；projectName 每次尝试唯一——见文件头重试安全） ----
const ITEM_CODE = 'MAT-E2E-UI-01';
const ITEM_NAME = '浏览器链路物料';
const WH_CODE = 'WH-E2E-UI-01';
const PROJECT_BASE = 'E2E-UI-链路';
const DRAWING_NO = 'DWG-E2E-UI-01';

let runSeed = 0;
let projectName = '';
let itemId = '';
let warehouseId = '';
let workOrderId = '';

/** 全页截图（命名规则：chain-<步骤>.png）。 */
async function shot(page: Page, step: string): Promise<void> {
  await page.screenshot({ path: `${ARTEFACTS}chain-${step}.png`, fullPage: true });
}

/** 侧栏菜单点击导航 → URL 断言。 */
async function gotoViaMenu(page: Page, menuTitle: string, urlPattern: RegExp): Promise<void> {
  await page.getByRole('link', { name: menuTitle, exact: true }).click();
  await expect(page).toHaveURL(urlPattern);
}

/** 真实会话 Bearer（storageState 注入的 cadence.session.v2；API 预置步骤用）。 */
async function sessionToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('cadence.session.v2');
    if (raw === null) throw new Error('会话缺失：localStorage 无 cadence.session.v2');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
      throw new Error('会话形状异常：token 缺失');
    }
    return parsed.token;
  });
}

/** 工作令页"列表"表（列头 状态——与齐套看板表区分的表级锚点）。 */
function workOrderListTable(page: Page) {
  return page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '状态' }) });
}

/** 工作令页"齐套看板"表（列头 齐套完成）。 */
function kitBoardTable(page: Page) {
  return page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: '齐套完成' }) });
}

/** 实时库存页：按物料过滤读可用量（无行 = 0；列序 物料/仓库/在手/预占/可用）。 */
async function readAvailableQty(page: Page, id: string): Promise<number> {
  await page.fill('#stock-item-filter', id);
  const row = page.getByRole('row', { name: new RegExp(id) }).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 5_000 });
    return Number((await row.getByRole('cell').nth(4).innerText()).trim());
  } catch {
    return 0;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('离散制造运营平台', { exact: true })).toBeVisible();
});

test('61 链路步骤1（UI）：建物品 → 列表行出现；建仓库 → 列表行出现并读回仓库 id', async ({ page }) => {
  // 建物品：物品页表单 → masterdata items POST → invalidate 重查 → 行渲染
  // （重放撞 code 唯一键 409 → 行已在列，断言幂等）
  await gotoViaMenu(page, '物品', /\/masterdata\/items$/);
  await page.fill('#item-code', ITEM_CODE);
  await page.fill('#item-name', ITEM_NAME);
  await page.getByRole('button', { name: '创建物品' }).click();
  await expect(page.getByRole('cell', { name: ITEM_CODE, exact: true })).toBeVisible();
  await shot(page, '01-item');

  // 建仓库：仓库与库位页表单（单库位）→ inventory 仓库命令 → 行渲染
  await gotoViaMenu(page, '仓库与库位', /\/inventory\/warehouses$/);
  await page.fill('#wh-code', WH_CODE);
  await page.fill('#wh-name', '浏览器链路仓库');
  await page.fill('#wh-loc-code', 'LOC-A');
  await page.fill('#wh-loc-name', '主库位');
  await page.getByRole('button', { name: '建仓库' }).click();
  const whRow = page.getByRole('row', { name: new RegExp(WH_CODE) });
  await expect(whRow).toBeVisible();
  warehouseId = (await whRow.getByRole('cell').first().innerText()).trim();
  expect(warehouseId.length, '仓库 id 从列表行 UI 读回（id 首列）').toBeGreaterThan(0);
  await shot(page, '02-warehouse');

  // 物品 id 读回走 API（唯一取舍点：物品页呈现面无 id 列，见文件头）；
  // 响应为 { items: [...] } 信封（parseItemsResponse 同形状）
  const token = await sessionToken(page);
  const row = await page.evaluate(
    async ({ bearer, code }) => {
      const response = await fetch('/masterdata/items', {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!response.ok) throw new Error(`items 读回 ${String(response.status)}`);
      const body = (await response.json()) as { items?: Array<{ id: string; code: string }> };
      return body.items?.find((entry) => entry.code === code) ?? null;
    },
    { bearer: token, code: ITEM_CODE },
  );
  expect(row, `物品 id 读回（${ITEM_CODE}）`).toBeTruthy();
  itemId = row!.id;
});

test('62 链路步骤2（UI）：建工作令 not_started → 流转 in_progress（列表行状态读回）', async ({ page }) => {
  runSeed += 1;
  projectName = `${PROJECT_BASE}-${runSeed}`;

  await gotoViaMenu(page, '工作令', /\/workorders$/);
  await page.fill('#wo-project', projectName);
  await page.getByRole('button', { name: '创建工作令' }).click();

  // 表级 scope（列表表）+ 状态列过滤钉新令行（重放时旧令同前缀、态为
  // in_progress——新令是唯一 not_started 行）
  const listTable = workOrderListTable(page);
  const createdRow = listTable
    .getByRole('row', { name: new RegExp(projectName) })
    .filter({ has: page.getByRole('cell', { name: 'not_started', exact: true }) })
    .first();
  await expect(createdRow).toBeVisible({ timeout: 15_000 });
  // 列表列序：id / 项目名 / 状态 —— id 首列 UI 读回
  workOrderId = (await createdRow.getByRole('cell').first().innerText()).trim();
  await expect(createdRow.getByRole('cell').nth(2)).toHaveText('not_started');
  await shot(page, '03-workorder-created');

  // 行点击 → 详情面板 → 流转表单（原生 select）→ 执行流转
  await createdRow.click();
  await expect(page.getByText('工作令详情与操作', { exact: true })).toBeVisible();
  await page.selectOption('#wo-transition-target', 'in_progress');
  await page.getByRole('button', { name: '执行流转' }).click();

  // 幂等终态断言：invalidate 重查后按唯一 id 定位列表行 → 状态列 in_progress
  const rowById = listTable.getByRole('row', { name: new RegExp(workOrderId) });
  await expect(rowById.getByRole('cell').nth(2)).toHaveText('in_progress', { timeout: 15_000 });
  await shot(page, '04-workorder-transitioned');
});

test('63 链路步骤3：清单骨架导入（UI）+ excel 行导入（API 预置）→ 缺口核查（UI）出快照', async ({ page }) => {
  // 骨架导入（UI）：清单页 → listing.skeleton → 四类清单行渲染（重放新令无清单，可导入）
  await gotoViaMenu(page, '清单', /\/listings\/sheets$/);
  await page.fill('#sheets-wo', workOrderId);
  await page.getByRole('button', { name: '骨架导入（建四类空清单）' }).click();
  for (const kind of ['part', 'standard', 'electrical', 'equipment']) {
    await expect(page.getByRole('row', { name: new RegExp(kind) }).first()).toBeVisible({
      timeout: 15_000,
    });
  }
  await shot(page, '05-listing-skeleton');

  // excel 行导入（API 预置——web 层未包该命令面；module-chain 同载荷语义）
  const token = await sessionToken(page);
  const imported = await page.evaluate(
    async ({ bearer, woId, drawing, itemCode, itemName }) => {
      const response = await fetch('/listing/imports', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: `e2e-browser-chain-import-${Date.now()}`,
          expectedRevision: 'initial',
          command: {
            kind: 'listing.import.v1',
            payload: {
              source: 'excel',
              workOrderId: woId,
              kind: 'part',
              excel: {
                kind: 'json-tables',
                sheets: [
                  {
                    name: '零件清单',
                    header: ['图号', '物料编码', '物料名称', '需求数量', '需求日期'],
                    rows: [[drawing, itemCode, itemName, '10', '2026-11-30']],
                  },
                ],
              },
            },
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      return { status: response.status, body } as const;
    },
    { bearer: token, woId: workOrderId, drawing: DRAWING_NO, itemCode: ITEM_CODE, itemName: ITEM_NAME },
  );
  expect(imported.status, `excel 行导入：${JSON.stringify(imported.body)}`).toBe(201);

  // 缺口核查（UI）：需 10 × 可用 S → 快照自洽校验（gapQty = max(0, 10-S)，
  // complete 与缺口互斥一致）。新栈首轮 S=0 → 缺口 10 + complete=false
  // （module-chain 负行为1 的完整语义）；重放形态（前次尝试已入库 S≥10）→
  // gapLines 空 + complete=true，同样自洽。
  await gotoViaMenu(page, '缺口核查', /\/listings\/gap-checks$/);
  await page.fill('#gap-wo', workOrderId);
  await page.getByRole('button', { name: '执行缺口核查' }).click();

  const main = page.getByRole('main');
  await expect(main.getByText('最新核查快照', { exact: true })).toBeVisible({ timeout: 15_000 });
  const ddOf = (key: string) =>
    main.locator('dt', { hasText: new RegExp(`^${key}$`) }).locator('xpath=following-sibling::dd[1]');
  const complete = (await ddOf('complete').innerText()).trim();
  const gapLines = JSON.parse(await ddOf('gapLines').innerText()) as Array<{
    requiredQty: number;
    availableQty: number;
    gapQty: number;
  }>;
  if (gapLines.length === 0) {
    expect(complete, '重放形态（需求已满足）：complete=true 自洽').toBe('true');
  } else {
    const line = gapLines.find((entry) => entry.requiredQty === 10);
    expect(line, `缺口行读回（需求 10）：${JSON.stringify(gapLines)}`).toBeTruthy();
    expect(line!.gapQty).toBe(Math.max(0, 10 - line!.availableQty));
    expect(complete).toBe(line!.gapQty === 0 ? 'true' : 'false');
  }
  await shot(page, '06-gap-check');
});

test('64 链路步骤4（UI）：生产入库 10 → 实时库存可用读数 +10（读-改-读）', async ({ page }) => {
  // 读基线（无行 = 0）
  await gotoViaMenu(page, '实时库存', /\/inventory\/stock$/);
  const before = await readAvailableQty(page, itemId);

  await gotoViaMenu(page, '收发存操作', /\/inventory\/stock-operations$/);
  // 入库来源缺省 production（完工入库）——select 显式钉防缺省漂移
  await page.selectOption('#recv-kind', 'production');
  await page.fill('#recv-item', itemId);
  await page.fill('#recv-wh', warehouseId);
  await page.fill('#recv-qty', '10');
  await page.getByRole('button', { name: '执行入库' }).click();
  await expect(page.getByText('命令已提交（committed）。')).toBeVisible({ timeout: 15_000 });
  await shot(page, '07-stock-received');

  // 读回（UI）：可用量 = 基线 + 10（delta 断言——重放叠加入库不破）
  await gotoViaMenu(page, '实时库存', /\/inventory\/stock$/);
  await expect
    .poll(async () => readAvailableQty(page, itemId), { timeout: 15_000 })
    .toBe(before + 10);
  await shot(page, '08-stock-level');
});

test('65 链路步骤5（UI）：刷新齐套检查 → 齐套看板 complete=true（缺口闭合）', async ({ page }) => {
  await gotoViaMenu(page, '工作令', /\/workorders$/);
  // 列表表内唯一 id 行点击（齐套看板表同含 id 文本——表级 scope 防误点）
  await workOrderListTable(page).getByRole('row', { name: new RegExp(workOrderId) }).click();
  await expect(page.getByText('工作令详情与操作', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '刷新齐套检查' }).click();

  // 齐套看板表（列头 齐套完成）：本工作令行 complete 列 true
  // （入库后需求满足——首轮 = 缺口闭合证据；重放 = 维持满足）
  const boardRow = kitBoardTable(page).getByRole('row', { name: new RegExp(workOrderId) });
  // 列序：工作令/项目名/齐套完成/刷新时刻/缺口行 —— complete 第 3 列
  await expect(boardRow.getByRole('cell').nth(2)).toHaveText('true', { timeout: 15_000 });
  await shot(page, '09-kit-board-complete');
});

test('66 链路步骤6（UI）：运营总览读数——链路工作令计入非终态与 in_progress 分布', async ({ page }) => {
  await gotoViaMenu(page, '运营总览', /\/overview$/);
  const main = page.getByRole('main');
  await expect(main.getByText('运营总览', { exact: true })).toBeVisible();

  // 交付风险卡：非终态计数 ≥1（链路工作令 in_progress 计入）
  const delivery = main.getByText(/交付风险（非终态 (\d+) 单）/);
  await expect(delivery).toBeVisible();
  const activeOrders = Number((await delivery.innerText()).match(/非终态 (\d+) 单/)?.[1] ?? '0');
  expect(activeOrders, '非终态工作令 ≥1（链路建令+流转后）').toBeGreaterThanOrEqual(1);

  // 九态分布 chip：in_progress 计数 ≥1（零填充全量口径，chip 恒渲染）
  const chip = main.getByText(/^in_progress \d+$/);
  await expect(chip).toBeVisible();
  const inProgress = Number((await chip.innerText()).split(' ')[1] ?? '0');
  expect(inProgress, 'in_progress 分布 ≥1（流转终态经总览四源聚合读回）').toBeGreaterThanOrEqual(1);

  // 交付态势下钻：链路项目行可见（风险分组表格；项目名每尝试唯一）
  await expect(main.getByRole('row', { name: new RegExp(projectName) }).first()).toBeVisible();
  await shot(page, '10-overview-readout');
});

test('67 链路快照重读（UI）：缺口核查页最新快照可重读（结构自洽留档）', async ({ page }) => {
  // 不重跑核查（不追加新快照），只读最新——63 步落账的快照可持续读回。
  // 齐套刷新（65 步）翻的是 kit_checks 流，缺口快照流独立。
  await gotoViaMenu(page, '缺口核查', /\/listings\/gap-checks$/);
  await page.fill('#gap-wo', workOrderId);
  await page.getByRole('button', { name: '读最新快照' }).click();
  const main = page.getByRole('main');
  await expect(main.getByText('最新核查快照', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(main.locator('dt', { hasText: /^complete$/ })).toBeVisible();
  await expect(main.locator('dt', { hasText: /^gapLines$/ })).toBeVisible();
  await shot(page, '11-gap-snapshot-final');
});
