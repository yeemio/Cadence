/**
 * Playwright 配置（浏览器 e2e，packages/testkit/e2e）。
 *
 * 触发门禁（RUN_E2E，与仓内 vitest e2e 同约定）：
 *   RUN_E2E=1 pnpm --filter @smes/testkit exec playwright test -c e2e/playwright.config.ts
 * 缺省（不设 RUN_E2E）：spec 全 skip、globalSetup/storageState 均不引用——
 * 零 docker、零构建、零 state 文件依赖。
 *
 * 形态取舍（写明）：
 * - workers 1 + 单 chromium：一套共享栈（单 PG + 单 server），串行避免数据
 *   竞争与端口争用；走查目标是真实渲染链（React → DOM → 数据通道），多
 *   浏览器矩阵是后续增量，不在本轮合同。
 * - setup project（官方推荐形态）：UI 真实登录一次 → storageState 落盘
 *   （localStorage 键 cadence.session.v2，product-ui token-session 形状），
 *   chromium project 依赖之——每 test 免重复登录，context 隔离不破。
 * - timeout 60s / 单测：栈在本地，建令/建物品/求值含真实 PG 往返，留足余量。
 * - retries 策略（V1 扩展）：RUN_E2E 门禁运行 retries=2（仅失败用例级重跑，
 *   走查断言可见性幂等；链路步骤断言钉幂等终态——列表行状态/读数——重放
 *   命令撞唯一键 409 时终态仍成立，见 real-chain.spec.ts 文件头）；缺省
 *   （全 skip）retries=0。真实失败（确定性红）重跑两次仍红，不稀释信号。
 * - globalTimeout 30 分钟（V1 扩容）：走查面从 13 测扩到 50+ 测（含全模块
 *   页 + 真实操作链 + 移动子页），叠加栈启动构建（三包 build + migrate/seed）。
 */
import { defineConfig } from '@playwright/test';
import { ARTEFACTS, RUN_E2E, WEB_BASE } from './scripts/env.ts';

const STATE_FILE = `${ARTEFACTS}.auth/state.json`;

export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: RUN_E2E ? 2 : 0,
  reporter: [['list']],
  outputDir: './artifacts/test-results',
  globalTimeout: 30 * 60_000,
  // exactOptionalPropertyTypes：条件展开而非 `cond ? value : undefined`
  ...(RUN_E2E ? { globalSetup: './scripts/global-setup.ts' as const } : {}),
  use: {
    baseURL: WEB_BASE,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth-setup\.spec\.ts/,
    },
    {
      name: 'chromium',
      testMatch: /(desktop|mobile)-.+\.spec\.ts/,
      dependencies: [...(RUN_E2E ? ['setup' as const] : [])],
      use: {
        browserName: 'chromium',
        ...(RUN_E2E ? { storageState: STATE_FILE } : {}),
      },
    },
  ],
});
