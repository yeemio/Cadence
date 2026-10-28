/**
 * 登录流程（setup project）：UI 真实登录一次 → storageState 落盘。
 *
 * 合同点：填表单 → 提交 → MPA 整页跳主壳。登录页断言 + 主壳就绪断言都在
 * 本文件；storageState（localStorage 键 cadence.session.v2——product-ui
 * token-session 形状，与服务端 /auth/login 响应对齐）供 chromium project
 * 全部走查测试复用（context 隔离不破，免每测重复登录）。
 *
 * 触发：RUN_E2E=1（缺省 skip，不起栈）。
 */
import { expect, test } from '@playwright/test';
import { ARTEFACTS, DEMO_ADMIN } from '../scripts/env.ts';

const RUN_E2E = process.env['RUN_E2E'] === '1';
test.skip(!RUN_E2E, '浏览器 e2e 需 RUN_E2E=1（docker PG + 15 模块 server + vite preview）');

const STATE_FILE = `${ARTEFACTS}.auth/state.json`;

test('01 登录流程：填表单 → 提交 → MPA 整页跳主壳', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('离散制造运营平台 · 演示环境')).toBeVisible();
  await expect(page.getByText('使用账号进入主应用')).toBeVisible();

  await page.fill('#login-username', DEMO_ADMIN.username);
  await page.fill('#login-password', DEMO_ADMIN.password);
  await page.screenshot({ path: `${ARTEFACTS}01-login.png`, fullPage: true });

  await page.getByRole('button', { name: '登录' }).click();
  // MPA 整页跳转：登录 bundle 生命周期结束，主壳 index.html 全新加载
  await expect(page).toHaveURL((url) => url.pathname === '/');

  // 主壳就绪：侧栏品牌 + 顶栏演示管理员身份（displayName 来自 /auth 会话；
  // W8 批起顶栏经 presentDisplayName 净化夹具括注，种子「(Web 登录流)」不再呈现）
  await expect(page.getByText('离散制造运营平台', { exact: true })).toBeVisible();
  await expect(page.getByText('演示管理员', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${ARTEFACTS}02-desktop-workbench.png`, fullPage: true });

  await page.context().storageState({ path: STATE_FILE });
});
