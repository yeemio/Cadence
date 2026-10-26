# Cadence 测试报告（grokbot，2026-10-26 北京时间）

- 仓库：https://github.com/yeemio/Cadence，commit **c80319f**（HEAD，含 TESTING-GUIDE.md；未改代码、未 push）
- 环境：Linux x64，8 核 / 15 GB；Node v24.22.1；pnpm 11.28.5；Docker 29.9.2（Compose v5.6.1，dockerd 后台启动）

## 总览
| 步骤 | 结果 | 关键数字 |
|---|---|---|
| 0 前置 + pnpm install --frozen-lockfile | 通过 | 8 秒，exit 0 |
| 1 pnpm verify（干净克隆直接跑） | **失败**（缺陷 #1） | exit 2，typecheck 阶段 TS2307 |
| 1 pnpm build 后再跑 pnpm verify | 通过 | exit 0，数字见下表 |
| 2 七套容器 e2e / 活库冒烟 | 全部通过 | 337 个 PASS，0 FAIL |
| 3 单机一键部署（27 个模块） | 通过（处理完环境问题后） | health ok，/modules=27，四个账号都能登录 |
| 3 SaaS 多租户（可选） | 未执行 | 为保持单机部署占着 3000/8080 运行而跳过 |

## 1. verify 各包数字（与基线对比）
application 549 ✔ / business-store 164 ✔ / engine-reporting 49 ✔ / server 65 ✔ / web 117+14skip ✔ / **product-ui 130（文档写 123，多出 7 个，全部通过；文档需更新）** / testkit 77 ✔；
其余：business-core 31、drawing 20、integration-im 32、engine-flow 59、integration-scan 60、payroll 22、metric-pack 29、maintenance 20、integration-print 47，全部通过。

## 2. 容器 e2e（apps/server）
| 套件 | PASS 数 | 文档期望 | 结果 |
|---|---|---|---|
| org:e2e | 35 | 35 | 全部通过 |
| approval:e2e | 31 | 31 | 全部通过 |
| mdwb:e2e | 49 | 49 | 全部通过 |
| auth:e2e | 42 | 42 | 全部通过 |
| backfill:e2e | 62 | — | 全部通过 |
| capability:e2e | 43 | — | 全部通过 |
| smoke:live-db | 75 行 PASS | 74 断言（含 teardown 那一行，计 75） | 全部通过 |

## 3. 部署检查
- `curl :3000/health` → `{"status":"ok","tenant":"default"}` ✔
- `/modules` → 27 个（core…demo，和 MODULES_ENABLED 加 core 一致）✔
- Web 桌面 http://localhost:8080 → 200；移动 /m → 200（SPA 入口；浏览器里的界面没有逐页走查）
- 登录：admin / demo-admin / approver / viewer 用 demo-password 都拿到 token ✔；错误口令 → 401 ✔；不带 token → 401 ✔
- 门禁抽查：admin 访问 /org/users、/audit/logs → 200；approver 和 viewer 访问这两个 → 403 ✔；/auth/me 四个账号都是 200
- 设计内行为确认：admin 访问 /listing/upload-stats → 409 ✔（不算缺陷）；/costing/project/x → 404 ✔（不算缺陷）
- PG：127.0.0.1:55432

## 缺陷
### #1 干净克隆后直接跑 `pnpm verify` 失败（严重度：中，影响 CI 和新接手的人）
- 命令：`git clone … && pnpm install --frozen-lockfile && pnpm verify`（commit c80319f）
- 摘录：`packages/integration-im typecheck: src/adapters/feishu.ts(8,35): error TS2307: Cannot find module '@smes/business-core' or its corresponding type declarations.` drawing、engine-reporting 也报同类错误，最后 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @smes/integration-im typecheck`，exit 2
- 原因：verify = typecheck && build …，但各包 types 指向 `dist/index.d.ts`。干净克隆时还没有 dist，所以 typecheck 先跑就失败。文档说的"基线 exit 0"依赖本地已有的 dist
- 复现：全新克隆后，不跑 build 直接 `pnpm verify`
- 规避：先跑 `pnpm build` 再跑 `pnpm verify` → exit 0
- 建议：verify 里把 build 放到 typecheck 前面，或者 typecheck 用 project references / paths 指向 src

### #2 文档数字过期（严重度：低）
product-ui 实际 130 个测试，TESTING-GUIDE 写的是 123。

## 环境问题（不算项目缺陷，已处理）
1. box 自带的 /usr/bin/pnpm（旧版 corepack）在 Node 24 下报 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING。改用 npm 全局装的 pnpm@11.28.5 解决。
2. 第一次 compose build 时 deb.debian.org 返回 500（镜像源临时故障），重试后成功。
3. box 上的 iptables-legacy FORWARD 默认策略是 DROP，compose 自建网桥上 migrate 连不到 pg:5432（P1001）。在 box 上加了 `iptables-legacy -I FORWARD -i/-o br-+ -j ACCEPT` 后部署成功。这是宿主机防火墙的问题，换到正常的 Docker 主机上不会出现。

## 当前运行状态
部署保持运行：API http://localhost:3000，Web http://localhost:8080（移动端 /m），PG 127.0.0.1:55432。这些都只在 box 本机上，外网访问不到。
