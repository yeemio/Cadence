/**
 * 移动壳走查（chromium project，viewport 390×844，storageState 会话注入）。
 *
 * 合同点：移动壳一页。/m 移动路由组与桌面壳同 bundle（main.tsx 双导航面，
 * M5 首波）；dist 无 /m 静态文件——preview 层把 /m* 回 serve 主壳
 * index.html（生产部署同规则，见 scripts/start-preview.ts 文件头）。
 *
 * 断言：MobileLayout 顶栏（Cadence 车间）+ 底部标签导航四标签
 * （admin bypass 全可见）+ m.workbench 页面内容渲染；截图留档。
 *
 * 触发：RUN_E2E=1（缺省 skip，不起栈）。
 */
import { expect, test } from '@playwright/test';
import { ARTEFACTS } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

test.use({ viewport: { width: 390, height: 844 } });

test('12 移动壳：/m 底部标签导航 + 车间工作台渲染', async ({ page }) => {
  await page.goto('/m');

  // 顶栏：车间壳品牌
  await expect(page.getByText('Cadence 车间')).toBeVisible();

  // 底部标签导航（nav[aria-label]）：工作台/报工/工时/库存（admin 全可见）
  const tabs = page.getByRole('navigation', { name: '移动端主导航' });
  await expect(tabs).toBeVisible();
  for (const title of ['工作台', '报工', '工时', '库存']) {
    await expect(tabs.getByRole('link', { name: title })).toBeVisible();
  }

  // m.workbench 页面内容：快捷入口 + 我的待办（m 版工作台，卡片列表替表格）
  await expect(page.getByText('快捷入口', { exact: true })).toBeVisible();
  await expect(page.getByText('我的待办', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${ARTEFACTS}12-mobile-workbench.png`, fullPage: true });

  // 标签切换真实导航：报工标签 → URL /m/report → 扫码定位卡渲染
  await tabs.getByRole('link', { name: '报工' }).click();
  await expect(page).toHaveURL(/\/m\/report$/);
  await expect(page.getByText('扫码定位派工单', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${ARTEFACTS}13-mobile-report.png`, fullPage: true });
});
