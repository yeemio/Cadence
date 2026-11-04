# PR #1 — F1 / F8 修复候选

作者：本普通 Chat；总控另行核实接收。日期：2026-11-03。
审查基线 `5425feb93856772c728ffb482b18bced5eb88558`；修复父提交
`3b7c37d9600f0384238040d814da58e754057c15`。本交付所在提交即候选，实际 SHA 另附 PR Conversation。
与其它五个 PR 独立，不以其它未验证候选替代本 PR 验证。

**发布状态：BLOCKED_DELIVERY_PUBLICATION。** 实际调用 GitHub `create_tree`
（`POST /repos/yeemio/Cadence/git/trees`）返回 403：
`Resource not accessible by integration`。没有创建远端修复提交或移动分支；
远端仍为上述初始 TASK head。本地完整 commit/format-patch 交由总控在既有授权下
机械发布到原分支，不能将本地候选 SHA 称为远端 head。

## 具名机制与修复

- **F1**：制造看板的当前 drawing 来源、工程/绑定内嵌历史快照、首次命令结果和持久化幂等结果都可能带 `fileRef` / `file_ref`。在 HTTP 成功响应边界递归投影整个返回值，覆盖普通命令、质量对账分支和质量库存 evidence。内部来源、旧快照、事件、请求哈希、幂等凭证均保留原字节；正常图纸查看仍经 `viewRevision` 权限及审计路径取得内容引用。
- **F8**：浏览器 document navigation 的 Accept 会使既有通用 location 回到 SPA。在 web nginx 为 `/drawing/read-references/` 和 `/attachment/storage/` 增加精确资源前缀代理，保留 URI、query 和 Host；有效短签名仍允许匿名兑现，后端继续负责有效期、租户、验签和图纸查看留痕。

## Changed paths

- `packages/application/src/manufacturing/manufacturing.service.ts`：纯响应投影函数。
- `apps/server/src/manufacturing-http.ts`：三个公共响应入口应用投影。
- `apps/web/nginx.conf`：两条签名资源代理规则。
- `apps/server/tests/manufacturing-drawing-response.test.ts`：七职责、当前/历史/幂等响应与内部不可变回归。
- `apps/server/tests/signed-reference-navigation.e2e.test.ts`：实际 nginx + Nest 路由/服务/认证守卫，隔离内存样本的 HTTP 导航回归。
- 本目录 `TASK.md`、`DELIVERY.md`：登记 Owner 后续批次授权及本交付。

## 实际验证

Node `v24.22.1`。初装使用环境 pnpm `11.25.0`，后续精确版本命令使用
`npm exec --yes --package=pnpm@11.28.5 -- pnpm`；未修改依赖或 lockfile。
以下 `pnpm` 均可由上述精确版本前缀替换。

| 命令 | 退出码 | 读到的结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 安装完成，lockfile 不变 |
| `pnpm build` | 0 | 全 workspace 构建完成 |
| `pnpm typecheck` | 0 | 全 workspace 类型检查完成 |
| `pnpm --filter @smes/server exec vitest run tests/manufacturing-drawing-response.test.ts --reporter=verbose` | 0 | 11 passed |
| `pnpm --filter @smes/drawing exec vitest run tests/drawing-read-references.test.ts tests/drawing.service.test.ts --reporter=dot` | 0 | 34 passed |
| `pnpm --filter @smes/web exec vitest run tests/drawing-pages.test.ts --reporter=dot` | 0 | 26 passed |
| `CADENCE_NGINX_BIN=/absolute/path/to/nginx pnpm --filter @smes/server exec vitest run tests/signed-reference-navigation.e2e.test.ts --reporter=verbose` | 0 | 4 passed，真实 nginx HTTP 导航 |
| `CADENCE_NGINX_BIN=/absolute/path/to/nginx env -u DATABASE_URL -u DIRECT_URL -u SMES_ATTACHMENT_DIR pnpm verify` | **1** | build、typecheck、boundary、boundary:selftest 完成；test 在下述既有 i18n 断言失败并提前退出，不能称全仓测试通过 |
| `git diff --check` | 0 | 无空白错误 |

本环境实际 nginx 路径为 `/workspace/scratch/feb0b9dab353/pr1-tools/nginx/usr/sbin/nginx`，版本 Ubuntu nginx **1.24.0**。fixture 读取仓内配置，仅替换 listen、root、upstream，并在独立顶层配置中关闭 master、保留当前 uid。没有修改生产 nginx 顶层配置或部署服务。

工程门失败原件：

```text
FAIL apps/web/tests/i18n.test.ts:163
[i18n] missing key: menu:manufacturing-control
AssertionError: expected 'manufacturing-control' to be '制造控制台'
Expected: "制造控制台"
Received: "manufacturing-control"
apps/web: Test Files 1 failed | 24 passed | 2 skipped
Tests 1 failed | 250 passed | 14 skipped
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; exit 1
```

基线控制：在 PR #2 的独立 checkout 中，对 `apps/web`、`packages/product-ui`、`packages/business-core` 与其 TASK 初始提交 `ca17634be32454138726a6ed2bb03899e9c37822` 的 `git diff --exit-code` 为 0（这些产品字节与审查基线相同）。独立安装、构建 business-core 后，`pnpm --filter @smes/web exec vitest run tests/i18n.test.ts --reporter=dot` 同样退出 1，13 passed / 1 failed，失败位置和内容相同；未把其它 PR 的修改当作本 PR 的通过证据。本 PR 未改菜单或语言包，也未顺手修复此范围外失败。

fixture 调试中的失败也已保留其含义：最初 nginx 在隔离 uid namespace 下默认 nobody 的 chown 失败；修正的是测试顶层配置。最初 fetch 未按预期传 Host 导致测试域名拒绝，后改用 node:http 明确 Host；生产租户解析器未更改。最终上述 4 项通过，不将前面的失败计为通过。

## 未验边界与补测命令

- 未运行生产 Dockerfile 的 **nginx:1.27-alpine** 镜像、TLS/真实 DNS、真实登录浏览器或 IAB PDF 渲染。可在具备该 nginx 二进制的隔离环境重复上表 nginx 命令，预期 4/4；未设置 `CADENCE_NGINX_BIN` 时该文件明确跳过，不能把跳过计为通过。
- Playwright Chromium headless shell 下载失败，退出 1：`https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip`，错误 `End of central directory record signature not found`（ZIP 无效/截断）。没有浏览器视觉通过声明。
- F1 用真实 controller + ManufacturingService、可观察原对象的合成内存端口验证；未使用 PG、共享库、客户图纸或客户账号。
- 未重跑历史 19 项或客户业务全链。原 M2 ACCEPT、历史分布、真实样本 UNVERIFIED 保留。IAB 空白仍 NOT_ACCEPTED / 根因 UNKNOWN；本路由修复不证明其根因。SP-5 有效短签名无需登录不变，O5 真实身份许可工程未启动。

本候选覆盖 F1/F8 的上述静态缺陷机制与定向回归。仍保留工程总检查的既有失败及明确未验边界，等待总控核实和最终接收。
