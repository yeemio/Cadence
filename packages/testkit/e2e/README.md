# 浏览器级 e2e（Playwright，桌面核心页真实渲染走查）

T2 线产物：真实浏览器（Chromium headless）走查 Cadence web 双入口 MPA——
登录流程、桌面主壳核心页导航、真实写操作、移动壳。

V1 扩展（质量纵深域，2026-10-25）：走查面从 13 测扩到 61 测（58 过 + 3 页
fixme 模块未进栈）——桌面全模块页（S2 九循环 23 页 + S3-a 8 页 + T1 能力
2 页）、真实操作链浏览器版（建物品 → 建工作令 → 流转 → 清单 → 缺口 →
入库 → 齐套闭合 → 总览读数）、移动子页 5 页抽验。全量绿一轮输出存
`artifacts/run-20261025-v1-run7.log`（3 skipped = fixme 三页）。

## 形态

- **栈**（`scripts/global-setup.ts`，playwright globalSetup 编排）：
  一次性 docker `postgres:16`（端口 55514）→ prisma migrate + 种子
  （admin / demo-password）→ 15 模块 server（3599，真实认证）→
  `vite preview`（4280）serve `apps/web/dist`，API 一级前缀经 vite 原生
  proxy 反代到 server（同源相对路径形态，零 CORS、零改 apps/web）；
  `/m` 未命中路径回落主壳 index.html（部署层 /m 路由规则的 preview 等价物）。
- **spec**（`specs/`）：
  - `auth-setup.spec.ts`（setup project）：UI 登录一次 → storageState 落盘
    （localStorage 键 `cadence.session.v2`）；后续全部测试免登录复用。
  - `desktop-core-pages.spec.ts`（serial，T2 基线）：工作台 / 工作令列表 /
    建令 / 行详情 / 标准报表真实求值 / 物品页建物品 / 派工 / 实时库存 /
    报工单 / 用户与角色（种子数据读回）。导航一律侧栏菜单点击（MPA 无
    history fallback，深链 /reports 等与 API 前缀同名是部署层真实语义）。
  - `desktop-all-modules.spec.ts`（V1）：S2/S3-a 全模块页走查 31 页 + 3 页
    fixme（模块未进栈，见下）——每页菜单点击 → URL → 内容区元素可见断言
    （卡片标题/表单控件/过滤件，scope `getByRole('main')` 防侧栏同名 strict
    违例）→ 截图。
  - `desktop-real-chain.spec.ts`（V1）：真实操作链浏览器版（e2e-module-chain 的 API
    版语义在浏览器复现）——UI：建物品/建仓库/建工作令/流转/骨架导入/缺口
    核查/生产入库/齐套刷新/看板与总览读数；API 预置仅两处（excel 行导入=
    web 层未包命令面、物品 id 读回=呈现面无 id 列），经 preview proxy 同源
    + 真实会话 Bearer。断言钉幂等终态（retry 安全，见 config 注释）。
  - `mobile-shell.spec.ts`（T2）：390×844 viewport，/m 底部四标签 + 工作台
    + 报工标签切换。
  - `mobile-subpages.spec.ts`（V1）：390×844 下 S3-d 移动子页抽验 5 页
    （m.verify / m.parts / m.inspection / m.fault / m.stocktake）——/m
    工作台快捷区真实导航 → MobileLayout 壳 + 表单控件断言。
- **断言**：元素可见性（role/text/placeholder locator），非像素比对；截图
  存 `artifacts/`。

## 截图与工件命名规则

- T2 基线：`01-login.png` … `13-mobile-report.png`（序号+名）。
- V1 扩展：`desktop-<页面码>.png`（页面码 = assembly.ts `PAGE_BY_CODE` 键，
  如 `desktop-baseline-processes.png`）；`chain-<步骤>.png`（如
  `chain-06-gap-check.png`）；`m-<子页码去 m. 前缀>.png`（如 `m-verify.png`）。
- 运行日志：`artifacts/run-<日期>-<轮次>.log`；失败 trace：playwright
  `trace: 'retain-on-failure'` 落 `artifacts/test-results/`（保留首轮失败
  trace，重试通过仍留档）。

## 模块未进栈的 3 页（fixme 隔离，不硬凑绿）

走查栈 `MODULES`（T2 基线形态）不含 `menu-config` / `approval-config` /
`notifications`，对应 3 页 fixme 并注明（`desktop-all-modules.spec.ts` 55-57）：
页面可达但数据面 404 属栈形态而非页面缺陷，扩栈属栈合同变更不在本任务泳道；
通知中心另有入口不可达事实（铃铛 fail-open 不渲染 + /notifications 深链命中
API 前缀）。断言体已写好，扩栈后删 `test.fixme` 行即放开。

## flaky 重试策略

`playwright.config.ts`：`retries: RUN_E2E ? 2 : 0`——门禁运行仅对失败用例
重跑 2 次（用例级）；走查断言（可见性）幂等，链路步骤断言钉幂等终态（列表
行状态/库存读数/看板 complete），重放命令撞唯一键（物品/仓库 code 409）时
终态断言仍成立。确定性红重跑两次仍红，不稀释信号。

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
- V1 扩展不改栈形态（MODULES/端口/门禁均不动）：扩覆盖只加 spec；模块未
  进栈页面以 fixme 隔离如实计数。
- 桌面走查断言 scope `getByRole('main')`：侧栏菜单链接文本与部分页面卡片
  标题同名（质检队列/发货任务/操作日志/扫码/运营总览……），main 限定避免
  strict mode 双命中。
