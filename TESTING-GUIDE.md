# Cadence 测试指南（给自动化测试代理 / 新接手者）

仓库：https://github.com/yeemio/Cadence（私有；SSH `git@github.com:yeemio/Cadence.git`）
形态：pnpm monorepo（Node ≥24 + pnpm 11.x + Docker）。一切以本文件命令为准，逐条可复制执行。

## 0. 前置

```bash
# Node 24（nvm）；Docker（compose v2）；克隆后：
git clone git@github.com:yeemio/Cadence.git && cd Cadence
pnpm install --frozen-lockfile        # 实证零障碍（镜像构建每日跑同款）
```

## 1. 全仓验证链（一条命令，当前基线 exit 0）

```bash
pnpm verify
# = typecheck + build + boundary（依赖方向守卫）+ boundary:selftest + 全部包测试
# 当前基线数字：application 549 / business-store 164 / engine-reporting 49 /
# server 65 / web 117+14skip / product-ui 123 / testkit 77 及其余包
```

## 2. 容器 e2e（六套，均自带容器生命周期，可独立复跑）

```bash
cd apps/server
pnpm org:e2e          # 组织/权限/门禁 35 断言
pnpm approval:e2e     # 审批纵贯 31
pnpm mdwb:e2e         # 基础数据+工作台 49
pnpm auth:e2e         # 真实认证 42
pnpm backfill:e2e     # S1 后端补齐面
pnpm capability:e2e   # 能力子集五域
pnpm smoke:live-db    # 活库冒烟：随机端口容器全链（迁移→起服→14 模块 74 断言→teardown）
```

## 3. 部署拉起（单机形态，一键）

```bash
cd deploy
MODULES_ENABLED="core,org,masterdata,workbench,approval,baseline,workorder,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack,audit,standardreports,menu-config,approval-config,notifications,issue,attachment,aftercare-claim,demo" \
  docker compose up -d --build
```

起来后：

| 检查 | 地址 / 命令 |
|---|---|
| API 健康 | `curl http://localhost:3000/health` → `{"status":"ok","tenant":"default"}` |
| 模块清单 | `curl http://localhost:3000/modules` → 27 个 |
| Web 桌面 | http://localhost:8080 |
| Web 移动 | http://localhost:8080/m |
| PG（本机） | `127.0.0.1:55432`（postgres / cadenceSingleNodeDev，库 cadence） |

**登录账号（口令统一 `demo-password`）**：
- `admin` —— 管理员（种子管理员）
- `demo-admin` —— 演示管理员
- `approver` —— 精确授权（审批/工作台），走非 bypass 路径
- `viewer` —— 无任何策略，可验证 403 门禁

```bash
curl -X POST http://localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"demo-password"}'   # → token
```

SaaS 多租户形态（可选）：`SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com SMES_TENANTS=tenant-a,tenant-b docker compose --profile saas up -d --build`（子域 Host 路由 + RLS 租户隔离 + 未知租户 fail-closed）。

## 4. 已知设计内行为（勿报缺陷）

1. `GET /listing/upload-stats` → 409：下图统计 PG 计数面按合同归部署期接线，未接线显式拒绝（不静默回 0）。
2. `GET /costing/project/*` → 404：成本快照须先发 `costing.project.rebuild.v1` 命令（跑批命令化，无数据=无快照）。
3. 质检/审批等命令需走 `smes.command.v1` 信封（operationId 幂等 + expectedRevision 乐观锁）；重复 operationId → 409 幂等冲突是正确行为。
4. 移动端四标签（工作台/报工/工时/库存）+ 工作台快捷入口 11 子页；桌面菜单按权限投影（admin 全见、viewer 基本全隐）。

## 5. 测试分层地图（找东西用）

- 领域/单元：`packages/*/tests/`（vitest；如 application/tests/costing/project-cost.test.ts 有手算数值锚点）
- 视图模型：`packages/product-ui/tests/`
- 组合根接线：`apps/server/tests/`（boot.e2e / cross-module-wiring / u-wave-wiring / u7-cost-wiring）
- 前端：`apps/web/tests/`（menu/mobile/module-pages/e2e-module-chain 等）
- 浏览器 e2e：`packages/testkit/e2e/`（Playwright，走查主壳与关键流程）
- 行为对账场景包：`packages/testkit/fixtures/m2-scenarios/`（36 场景，reference 留空——对账已按 Owner 裁定取消，可用于自比对回归）
- 文档口径对照：`architecture/coverage/DOCS-INVENTORY-DIFF.md`（73 份开发文档 → 实现映射与差异登记；需求源文档在仓外 `/Users/yeemio/AI/project/sieracMes-AI/docs/开发文档/`）

## 6. 测试纪律（红线）

- 不 force push、不改 git config、不动 `origin/main`；发现问题出报告而不是直接改主干。
- 失败请附：命令原文 + 完整输出 + 复现环境（commit hash / Node / Docker 版本）。
- pnpm 输出中的 `[ERR_PNPM_IGNORED_BUILDS]` 噪音是既有已知现象，不影响 verify 链退出码。
- 本机 shell 若缺 node：`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`。
