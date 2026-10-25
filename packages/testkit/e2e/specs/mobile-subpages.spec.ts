/**
 * 移动子页走查（V1 扩展，chromium project，viewport 390×844，storageState 会话注入）。
 *
 * 合同点（S3-d 抽验 5+）：m.verify / m.parts / m.inspection / m.fault /
 * m.stocktake。每页同一形态：/m 工作台快捷区真实导航（Link 点击——S3 子页
 * 入口合同，底部标签仍四项）→ URL 断言 → MobileLayout 壳（顶栏 + 底部标签）
 * + 页面卡标题 + 表单控件可见断言 → 截图留档。
 *
 * 可达性形态：/m* 未命中路径经 preview 回落主壳 index.html（部署层 /m 路由
 * 规则的 preview 等价物），本组仍从 /m 工作台走快捷区点击导航（真实用户路径；
 * 深链直达形态由 T2 mobile-shell 的 /m goto 先例覆盖）。
 *
 * 断言细节：移动子页表单是原生 input/textarea + placeholder（无 id 锚点），
 * 控件断言走 getByPlaceholder（页面唯一 placeholder 文案）。
 *
 * 触发：RUN_E2E=1（缺省 skip，不起栈）。
 */
import { expect, test, type Page } from '@playwright/test';
import { ARTEFACTS } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

test.describe.configure({ mode: 'serial' });

test.use({ viewport: { width: 390, height: 844 } });

/** 全页截图（命名规则：m-<移动页码去 m. 前缀>.png）。 */
async function shot(page: Page, code: string): Promise<void> {
  await page.screenshot({ path: `${ARTEFACTS}m-${code}.png`, fullPage: true });
}

/** 移动壳就绪（顶栏品牌 + 底部四标签）→ 快捷区入口点击 → 子页 URL 断言。 */
async function gotoSubpageViaQuickEntry(
  page: Page,
  entryTitle: string,
  urlPattern: RegExp,
): Promise<void> {
  await page.goto('/m');
  await expect(page.getByText('Cadence 车间')).toBeVisible();
  await page.getByRole('link', { name: entryTitle, exact: true }).click();
  await expect(page).toHaveURL(urlPattern);
  // MobileLayout 壳在子页恒在：底部标签导航可见（S3 冻结四标签）
  await expect(page.getByRole('navigation', { name: '移动端主导航' })).toBeVisible();
}

test('71 移动子页 m.verify：报工核查卡渲染（快捷区真实导航）', async ({ page }) => {
  await gotoSubpageViaQuickEntry(page, '报工核查', /\/m\/verify$/);
  const main = page.getByRole('main');
  await expect(main.getByText('报工核查', { exact: true })).toBeVisible();
  // 备注输入按队列行条件渲染（新栈队列为空）——恒在结构 = 队列卡描述 + 空态文案
  await expect(main.getByText('待核查队列（已报态按时间先进先核；五类报工同队列）。')).toBeVisible();
  await expect(main.getByText('队列为空——暂无待核查报工。')).toBeVisible();
  await shot(page, 'verify');
});

test('72 移动子页 m.parts：配件申请表单渲染', async ({ page }) => {
  await gotoSubpageViaQuickEntry(page, '配件申请', /\/m\/parts$/);
  await expect(page.getByRole('main').getByText('配件申请', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('wo-…（手填）')).toBeVisible();
  await expect(page.getByPlaceholder('itm-…（手填）')).toBeVisible();
  await shot(page, 'parts');
});

test('73 移动子页 m.inspection：质检卡 + 四类过滤标签渲染', async ({ page }) => {
  await gotoSubpageViaQuickEntry(page, '质检', /\/m\/inspection$/);
  const main = page.getByRole('main');
  await expect(main.getByText('质检', { exact: true })).toBeVisible();
  await expect(main.getByText('四类质检单（待检判定、不合格复检）；判定放行联动入库。')).toBeVisible();
  // 判定表单按队列行条件渲染（新栈无质检单）——恒在结构 = KIND_TABS 过滤标签
  for (const tab of ['全部', '自制外协', '非标件采购', '标准配件', '设备采购']) {
    await expect(main.getByRole('button', { name: tab, exact: true })).toBeVisible();
  }
  await shot(page, 'inspection');
});

test('74 移动子页 m.fault：故障上报表单渲染（设备/描述/维修人员三字段）', async ({ page }) => {
  await gotoSubpageViaQuickEntry(page, '故障上报', /\/m\/fault$/);
  await expect(page.getByRole('main').getByText('故障上报', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('设备 code（手填）')).toBeVisible();
  await expect(page.getByPlaceholder('现象/位置/影响（必填）')).toBeVisible();
  await expect(page.getByPlaceholder('用户 id（手填）')).toBeVisible();
  await shot(page, 'fault');
});

test('75 移动子页 m.stocktake：盘点开单表单渲染', async ({ page }) => {
  await gotoSubpageViaQuickEntry(page, '库存盘点', /\/m\/stocktake$/);
  const main = page.getByRole('main');
  await expect(main.getByText('库存盘点', { exact: true })).toBeVisible();
  await expect(main.getByText('开单 → 实盘录入（可多轮）→ 提交差异 → 审核调账。')).toBeVisible();
  // 实盘/审核输入按盘点单行条件渲染（新栈无盘点单）——恒在结构 = 开单表单
  await expect(page.getByPlaceholder('仓库 id（开单）')).toBeVisible();
  await expect(page.getByRole('button', { name: '开单盘点' })).toBeVisible();
  await shot(page, 'stocktake');
});
