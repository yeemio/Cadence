/**
 * 桌面核心页真实渲染走查（chromium project，storageState 会话注入）。
 *
 * 链路形态（合同）：docker PG + 15 模块 server（真实认证）+ vite preview
 * 反代 web → 真实 Chromium：核心页导航（侧栏菜单点击 → URL → 关键元素
 * 可见断言：卡片标题/表格/按钮）→ 真实操作（创建工作令→列表出现；创建
 * 物品→列表出现；标准报表真实求值）。
 *
 * 断言纪律：元素可见性（role/text locator），非像素比对；每页截图存
 * e2e/artifacts/（视觉证据）。
 *
 * 走查导航一律菜单点击（NavLink client-side）——MPA（appType 'mpa'）无
 * history fallback，深链 /reports、/standard-reports 与 API 前缀同名，直接
 * goto 会命中 API（部署层真实语义，非页面缺陷），故不做深链直达。
 *
 * 每测开头 goto('/')：MPA 整页加载主壳（会话在 localStorage，跨 context
 * 注入自 storageState）——每测独立干净起点，数据在共享 PG 栈内贯穿。
 *
 * 触发：RUN_E2E=1（缺省全 skip，不起栈）。
 */
import { expect, test, type Page } from '@playwright/test';
import { ARTEFACTS } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

test.describe.configure({ mode: 'serial' });

/** 全页截图（视觉证据；断言本体是元素可见性，截图仅留档）。 */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${ARTEFACTS}${name}.png`, fullPage: true });
}

/** 侧栏菜单点击导航 → URL 断言（client-side 路由，无整页往返）。 */
async function gotoViaMenu(page: Page, menuTitle: string, urlPattern: RegExp): Promise<void> {
  await page.getByRole('link', { name: menuTitle }).click();
  await expect(page).toHaveURL(urlPattern);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 主壳加载 + refine Authenticated 过（storageState 会话 → /auth/me 校验）
  await expect(page.getByText('离散制造运营平台', { exact: true })).toBeVisible();
});

test('02 工作台（登录落点）：待办概览卡 + 我的待办卡渲染', async ({ page }) => {
  await expect(page.getByText('待办概览')).toBeVisible();
  await expect(page.getByText('我的待办')).toBeVisible();
});

test('03 工作令列表页：菜单点击 → 列表/建令/齐套看板三卡可见', async ({ page }) => {
  await gotoViaMenu(page, '工作令', /\/workorders$/);
  await expect(page.getByText('工作令列表', { exact: true })).toBeVisible();
  // T1 修正：卡片标题与提交按钮同为"创建工作令"——getByText 双命中触发
  // strict mode 违例；按 role 钉提交按钮（标题由下一行 exact 断言覆盖不变）。
  await expect(page.getByRole('button', { name: '创建工作令' })).toBeVisible();
  await expect(page.getByText('齐套看板', { exact: true })).toBeVisible();
  await expect(page.locator('#wo-state-filter')).toBeVisible();
  await shot(page, '03-workorders');
});

test('04 真实操作：创建工作令 → 列表表格出现项目行', async ({ page }) => {
  const project = 'E2E-BRW-工作令-01';
  await gotoViaMenu(page, '工作令', /\/workorders$/);

  await page.fill('#wo-project', project);
  await page.getByRole('button', { name: '创建工作令' }).click();

  // 页面真实通道：workorder.create.v1 → PG → 列表 invalidate 重查 → 行渲染
  await expect(page.getByRole('cell', { name: project, exact: true })).toBeVisible();
  await shot(page, '04-workorder-created');
});

test('05 工作令详情：点列表行 → 详情与操作面板出现', async ({ page }) => {
  const project = 'E2E-BRW-工作令-01';
  await gotoViaMenu(page, '工作令', /\/workorders$/);

  await page.getByRole('row', { name: new RegExp(project) }).click();
  await expect(page.getByText('工作令详情与操作', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '流转' })).toBeVisible();
  await shot(page, '05-workorder-detail');
});

test('06 标准报表：菜单点击 → 口径四选一控件 + 真实求值出结果卡', async ({ page }) => {
  await gotoViaMenu(page, '标准报表', /\/standard-reports$/);
  await expect(page.getByText('标准报表', { exact: true })).toBeVisible();

  // 口径目录经 preview proxy → server → PG 求值源装配（catalog 非空才可求值）
  await expect(page.getByRole('button', { name: '求值报表' })).toBeEnabled();
  await page.getByRole('button', { name: '求值报表' }).click();
  await expect(page.getByText('求值结果', { exact: true })).toBeVisible();
  await shot(page, '06-standard-reports');
});

test('07 物品页 + 真实操作：创建物品 → 列表表格出现 code 行', async ({ page }) => {
  const code = 'MAT-E2E-BRW-01';
  await gotoViaMenu(page, '物品', /\/masterdata\/items$/);
  await expect(page.getByText('物品列表', { exact: true })).toBeVisible();
  // T1 修正：卡片标题与提交按钮同名（strict mode 双命中）——按 role 钉按钮
  await expect(page.getByRole('button', { name: '创建物品' })).toBeVisible();

  await page.fill('#item-code', code);
  await page.fill('#item-name', '浏览器走查物料');
  await page.getByRole('button', { name: '创建物品' }).click();

  // 页面真实通道：masterdata items POST → PG → 列表 invalidate 重查 → 行渲染
  await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  await shot(page, '07-item-created');
});

test('08 派工页：列表/创建/任务视图卡可见', async ({ page }) => {
  await gotoViaMenu(page, '派工', /\/dispatches$/);
  await expect(page.getByText('派工单列表', { exact: true })).toBeVisible();
  // T1 修正：同上（标题/按钮同名）——按 role 钉按钮
  await expect(page.getByRole('button', { name: '创建派工单' })).toBeVisible();
  await expect(page.getByText('任务视图', { exact: true })).toBeVisible();
  await shot(page, '08-dispatches');
});

test('09 实时库存页：库存/库位分布/流水卡可见', async ({ page }) => {
  await gotoViaMenu(page, '实时库存', /\/inventory\/stock$/);
  await expect(page.getByText('实时库存', { exact: true })).toBeVisible();
  await expect(page.getByText('库位分布', { exact: true })).toBeVisible();
  await expect(page.getByText('出入库流水', { exact: true })).toBeVisible();
  await shot(page, '09-inventory-stock');
});

test('10 报工单页：列表/进度/趋势卡可见', async ({ page }) => {
  await gotoViaMenu(page, '报工单', /\/reports$/);
  await expect(page.getByText('报工单列表', { exact: true })).toBeVisible();
  await expect(page.getByText('图号 × 工序进度', { exact: true })).toBeVisible();
  await expect(page.getByText('产出趋势（12 日窗口）', { exact: true })).toBeVisible();
  await shot(page, '10-reports');
});

test('11 用户与角色页：种子数据真实读回（种子管理员行可见）', async ({ page }) => {
  await gotoViaMenu(page, '用户与角色', /\/system\/users$/);
  await expect(page.getByText('用户列表', { exact: true })).toBeVisible();
  // T1 修正：同上（标题/按钮同名）——按 role 钉按钮
  await expect(page.getByRole('button', { name: '创建用户' })).toBeVisible();
  // PG 种子（prisma/seed.mjs）经 org API → 页面表格：admin 演示身份在列
  await expect(page.getByRole('cell', { name: 'admin', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '种子管理员', exact: true })).toBeVisible();
  await shot(page, '11-system-users');
});
