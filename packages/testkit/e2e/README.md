# 浏览器级 e2e（Playwright，桌面核心页真实渲染走查）

T2 线产物：真实浏览器（Chromium headless）走查 Cadence web 双入口 MPA——
登录流程、桌面主壳核心页导航、真实写操作、移动壳。

## 形态

- **栈**（`scripts/global-setup.ts`，playwright globalSetup 编排）：
  一次性 docker `postgres:16`（端口 55514）→ prisma migrate + 种子
  （admin / demo-password）→ 15 模块 server（3599，真实认证）→
  `vite preview`（4280）serve `apps/web/dist`，API 一级前缀经 vite 原生
  proxy 反代到 server（同源相对路径形态，零 CORS、零改 apps/web）；
  `/m` 未命中路径回落主壳 index.html（部署层 /m 路由规则的 preview 等价物）。
- **spec**（`specs/`）：
  - `auth-setup.spec.ts`（setup project）：UI 登录一次 → storageState 落盘
    （localStorage 键 `cadence.session.v2`）。
  - `desktop-core-pages.spec.ts`（serial）：工作台 / 工作令列表 / 建令 /
    行详情 / 标准报表真实求值 / 物品页建物品 / 派工 / 实时库存 / 报工单 /
    用户与角色（种子数据读回）。导航一律侧栏菜单点击（MPA 无 history
    fallback，深链 /reports 等与 API 前缀同名是部署层真实语义）。
  - `mobile-shell.spec.ts`：390×844 viewport，/m 底部四标签 + 工作台 +
    报工标签切换。
- **断言**：元素可见性（role/text locator），非像素比对；每页截图存
  `artifacts/`（`01-login.png` … `13-mobile-report.png`）。

## 运行

```bash
# 门禁内运行（RUN_E2E=1；需要 docker 与 playwright 浏览器二进制）
RUN_E2E=1 pnpm --filter @smes/testkit exec playwright test -c e2e/playwright.config.ts

# 缺省（pnpm test / playwright test 不带 env）：全部 skip，不起栈不碰 docker
```

首次启用浏览器二进制（本机已装则跳过）：

```bash
cd packages/testkit && npx playwright install chromium
```

依赖：`@playwright/test@1.64.1`（Apache-2.0，ADR-0007 D13 复用白名单——
平台件全复用清单含 Playwright）+ `vite@7`（preview 编排）。

## 相关取舍记录

- 放 `packages/testkit/e2e/`：testkit 是"测试工具不受铁律限制"的既有泳道
  （.dep-cruiser.cjs 注释）；新顶层 `e2e/` 需改 pnpm-workspace.yaml 才能
  装依赖，影响面更大。
- testkit 的 `pnpm test`（vitest）以 `--exclude e2e/**` 排除本目录，spec
  交给 playwright runner；另有 `typecheck:e2e` 独立 tsc（tsconfig 见本目录）。
- 端口与既有 vitest e2e 错开：scan-report 55512/3597、module-chain
  55513/3598、本目录 55514/3599/4280——三套栈可并存。
