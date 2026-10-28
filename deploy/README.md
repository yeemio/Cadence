# deploy —— 双形态部署栈（ADR-0005：M4 预研骨架 → M4 正式线）

同一代码，两种形态、两份定价（ADR-0005）：单机买断（私有化）↔ SaaS 订阅（托管）。
M4 正式线已接通：RLS session 变量接线（org / masterdata / workbench / approval
四域连接工厂；rls-session 模块已上提 src/ 包顶层——跨环节通用基础设施，领域中立）
+ server/web 真实镜像 + compose 真实栈（migrate 一次性服务）+ SaaS profile 起栈
实测（proxy 子域透传，Host 头路由验证，见下）+ **hostBased 租户解析接线**
（server 侧 main.ts 消费 SMES_TENANT_MODE/SMES_DOMAIN/SMES_TENANTS，双形态
实证见下）+ 生产要素初版（healthcheck/restart/pg-data 卷）+ 根 script
`pnpm verify:rls`（RLS 容器三面实证，退出码 0/1）。**未竟**：租户管理流程、
数据迁移与切流、非默认租户的开通/种子流程（hostBased 已接线，但 SMES_TENANTS
是静态清单）。

> **威胁模型限定**：RLS 防的是应用层串租户缺陷（错误租户上下文/漏加过滤的查询），
> **不防持有 app_user 凭据者**——其可自行 `SET app.current_tenant` 选任意租户。
> 凭据保管与网络边界是部署层责任。

---

# 部署操作手册（安装者视角）

本节面向未参与开发的安装/运维人员，事实快照日 **2026-10-27**，与下方历史实现注记独立维护；两者冲突时以 compose/代码实态为准。安装验收是独立环节，本节**如实给步骤与已知的坑**，不预称「一键安装成功」。配套材料：用户手册入口 `docs/user-manual/README.md`、演示交接 `docs/user-manual/demo-handover.md`。

## D1. 版本与依赖要求

| 项 | 要求 | 来源 |
| --- | --- | --- |
| 宿主 Node（宿主直跑脚本/造厂时才需要） | ≥ 22（engines 字段） | `package.json` `engines.node` |
| pnpm（同上） | 11.x（锁定 `pnpm@11.28.5`） | `package.json` `packageManager` |
| Docker / compose | v2 语法（`docker compose` 子命令）；镜像构建依赖 BuildKit 语义（per-Dockerfile `.dockerignore`） | `deploy/compose.yaml`、`apps/server/Dockerfile.dockerignore` 头注 |
| 数据库 | 镜像 `postgres:16`（compose 拉起，无需宿主安装） | `deploy/compose.yaml` pg 服务 |
| 服务器/容器基线 | `node:24-slim`（构建与运行镜像）；镜像内需安装 `openssl`（prisma 引擎检测，Dockerfile 已含） | `apps/server/Dockerfile` |

## D2. 标准安装步骤

**单机（买断/私有化）**：

```bash
cd deploy
MODULES_ENABLED="core,org,masterdata,workbench,approval,baseline,workorder,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack,audit,standardreports,menu-config,approval-config,notifications,issue,attachment,aftercare-claim,ai-query,demo" \
  docker compose up -d --build
```

`MODULES_ENABLED` 缺省只起基础六模块（core,org,masterdata,workbench,approval,demo）——全功能部署须显式传全清单（键名见 `packages/application` 注册表 `MODULE_DEFINITIONS`，core 恒必装）。服务顺序 pg → migrate（迁移+种子）→ server → web，healthcheck 门控。

**SaaS（订阅/托管）**：在单机基础上叠加租户解析 env 与 saas profile（`SMES_TENANT_MODE=saas SMES_DOMAIN=<基域> SMES_TENANTS=<逗号分隔租户清单> docker compose --profile saas up -d --build`）。机制、fail-closed 行为与验证口径见下方「SaaS profile 起栈」节。**注意：SaaS 目前只有 default 租户有种子数据；非默认租户的开通/种子流程未实现**（SMES_TENANTS 是静态清单，新租户内登录 401 属预期）——见本 README「未竟」段。

**公网部署前必改**：compose 缺省口令是开发值（`POSTGRES_PASSWORD` 缺省 `cadenceSingleNodeDev`、`POSTGRES_APP_PASSWORD` 缺省 `app_user_dev_change_me`），公网/客户环境必须显式覆盖——建议在 `deploy/.env` 文件中配置（compose 自动读取；`.env` 已被镜像构建裁剪，口令不进镜像）。

## D3. 环境变量清单（server/compose 消费面）

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `cadenceSingleNodeDev` | PG superuser 口令（开发缺省值，生产必改） |
| `POSTGRES_APP_PASSWORD` | `app_user_dev_change_me` | 受限 app_user 口令（生产必改） |
| `PG_PORT` | `55432` | 宿主侧 PG 端口（仅绑 127.0.0.1，迁移排障/psql 用） |
| `SERVER_PORT` / `WEB_PORT` / `PROXY_PORT` | `3000` / `8080` / `80` | 三类入口端口 |
| `MODULES_ENABLED` | 基础六模块 | 模块启停清单（逗号分隔） |
| `SMES_TENANT_MODE` | `single-node` | `saas` 时启用 hostBased 租户解析（fail-fast） |
| `SMES_DOMAIN` | 空 | SaaS 基域；saas 模式缺省即拒启动 |
| `SMES_TENANTS` | 空 | 已知租户静态清单（逗号分隔）；同时透传 migrate 服务供种子按租户建 MAIN 仓 |
| `SMES_RLS_SESSION` | compose 固定 `"on"` | RLS 会话接线开关（`DATABASE_URL` 恒用受限 app_user；一般不改） |
| `SMES_DEFAULT_WAREHOUSE_CODE` | `MAIN` | 收货未显式指定仓库时的落位仓（按租户按 code 解析；空串=无默认仓） |
| `SMES_PARTS_APPROVAL_LEVELS` | 空（=1 单级） | 配件审批链级数 1\|2\|3；>1 须配 LEVEL2_ROLE（=3 另须 LEVEL3_ROLE，org 角色码单段小写），配错启动即炸 |
| `SMES_LOGIN_MAX_FAILURES` / `SMES_LOGIN_WINDOW_SECONDS` / `SMES_LOGIN_LOCK_SECONDS` | `5` / `900` / `900` | 登录限流参数（来源：`apps/server/src/main.ts` L117-119；`packages/application/src/auth/login-attempt-stores.ts` L49-51；演示需短窗时调小） |
| `SMES_PASSWORD_MIN_LENGTH` | `8` | 口令最小长度（仅建号/重置两端点校验） |
| `SMES_PASSWORD_REQUIRE_CLASSES` | `off` | 口令字符类要求开关（`on`\|`off`，其他值拒启动） |
| `SMES_ATTACHMENT_REF_SECRET` / `SMES_DRAWING_REF_SECRET` | 空 | 附件/图纸两域签名密钥（base64/hex、解码恰 32 字节）。**多实例/跨重启部署必须设置**；未设 = 实例内随机 + 启动 warn（重启后旧引用失效属设计内）；格式非法拒启动。机制详见下方「两域签名密钥 env（M2 安全批 SP-3）」条目 |

**登记说明（2026-10-27）**：SP-3 两密钥与 CM-1 安全响应头均已随**本轮未提交增量**在工作区落盘并随当前交付候选分发——**仅 clone 旧 HEAD 不含这两项**，安装前确认取得含本轮增量的工作区/候选。CM-1 双拓扑已覆盖：web nginx 是静态/HTML 承载层的权威层（`apps/web/nginx.conf` CM-1 段），server 直连拓扑（SaaS 子域 / `IP:3000`）由 `apps/server/src/main.ts` 全局中间件同值补头。三条运维注意（来源：`apps/web/nginx.conf` CM-1 注释）：① API 改跨源（`VITE_API_BASE_URL` 指向他源）须同步扩 nginx CSP `connect-src`，否则浏览器拦截 API 请求；② 升级 vite-plugin-pwa 或改 SW 路径/scope 须重算 CSP 内联脚本哈希，失配症状 = SW 注册被拦截（控制台报错，应用功能不受影响）；③ `X-Frame-Options: DENY`——页面不能被 iframe 内嵌。另：`deploy/.env.example` 模板被仓内 `.gitignore`（`.env.*`）忽略、不随 clone 分发——安装者按本表自建 `deploy/.env` 即可（compose 自动读取同目录 `.env`）。

## D4. 初始化与岗位开通

初始化随 `up` 自动完成：migrate 一次性服务以 superuser 跑 `prisma migrate deploy` + 基础种子（`db:seed`）+ 迁移台账对 app_user 只读收口。基础种子提供账号 `admin`（种子管理员）/ `demo-admin` / `approver` / `viewer`，并按 `SMES_TENANTS` 每租户幂等建 code=`MAIN` 默认仓（来源：`deploy/compose.yaml` migrate 服务段；`packages/business-store/prisma/seed.mjs`）。

岗位开通两条路径：

1. **页面开通（正式环境）**：以 admin 登录 →「系统管理 → 角色与授权」（`/system/roles`）按目标岗位权限码期望态一次建角色（服务端 diff 自动增授/回收）→「用户与角色」（`/system/users`）建用户并绑角色。七岗位标准码集见 `architecture/ROLE-PACKS.md` §1；操作说明见 `docs/user-manual/roles/admin.md`。
2. **工厂种子（演示/测试环境）**：显式运行 `SMES_FACTORY_SEED=on` 的 `db:seed-factory`（compose migrate 服务**不会**自动跑它），一键得到六岗账号（plan01/purch01/prod01/qc01/wh01/appr01，口令统一 `demo-password`）+ 主数据 + 五张在制单。两条运行方式与造厂产物清单见 `docs/user-manual/demo-handover.md` §3。

## D5. 健康检查

| 对象 | 方式 | 预期 |
| --- | --- | --- |
| server | `curl http://localhost:3000/health` | 200 `{"status":"ok","tenant":"default"}` |
| 模块面 | `curl http://localhost:3000/modules` | 已启用模块清单（全清单 28 个） |
| web | `curl http://localhost:8080/` | HTML 200（nginx 静态入口自证；compose 级 healthcheck 同此） |
| pg | compose healthcheck `pg_isready` | healthy |
| SaaS 探针 Host 取舍 | 镜像级 server healthcheck 在 saas 形态用「首个已知租户+SMES_DOMAIN」作 Host（租户解析 fail-closed 不参与 liveness）；单机回落 127.0.0.1 | 见下方「生产要素初版」段与 `apps/server/src/healthcheck-probe.ts` |

web 容器 `depends_on` server 镜像级 healthcheck 门控：server 未健康 web 不起。

## D6. 日志定位

```bash
cd deploy
docker compose logs -f server        # 应用日志（业务错误/租户解析/启动 fail-fast 原因）
docker compose logs migrate          # 一次性服务：迁移+种子输出（up 时刷出；完成后容器退出属正常）
docker compose logs pg web proxy     # 其余服务
```

- 启动失败先看 server 日志的 fail-fast 行（如 saas 缺 `SMES_DOMAIN`、配件审批链配错角色码、口令策略 env 拼写错误——均拒绝启动并给原因）。
- 数据库直连排障：`psql` 走宿主映射 `127.0.0.1:55432`（`PG_PORT` 可改）；凭据为上文两个口令变量。
- 客户侧报障请附：页面、账号、时间、完整报错文案（含错误体 `code` 字段，如 `auth.rate_limited`）。

## D7. 更新路径

```bash
# 获取新版本源码后（工作区/仓库以交付基线为准）：
cd deploy
docker compose up -d --build     # 全量重建：server/web 镜像 + migrate 一次性镜像
```

- 迁移自动推进：migrate 服务每次 up 重跑 `prisma migrate deploy`（幂等）；种子幂等重跑零新增。
- **已知的坑**：不要只重建 server 镜像而跳过 migrate 服务镜像——迁移/种子会跑旧版代码（历史收口坑登记，见 `architecture/status.md` D-20 段）。用 `docker compose up -d --build` 全量重建即可同时覆盖。
- **无自动降级路径**：`prisma migrate deploy` 只进不退；回滚 = 恢复更新前的数据备份 + 回退到旧版本源码（见 D8）。更新前先备份。

## D8. 数据保留与备份

- 全部业务数据在具名卷 `pg-data`（`deploy/compose.yaml` volumes 段）。`docker compose down` **保留**数据；`down -v` **删除**数据——演示环境可随意 `down -v` 重置，客户环境禁用。
- 备份建议：`pg_dump` 经宿主映射 `127.0.0.1:55432` 导出（更新前、定期）；恢复用对应 `pg_restore`/`psql` 导回同名库。
- 证据面说明：命令幂等账本、域事件与 outbox 双写落库（PG 适配同事务双写），是业务可追溯性的一部分——备份须整库一致时点快照，不要只挑表。
- 自动清理/归档策略当前未实现（以系统实态为准）；数据保留周期、完整备份恢复运营演练属 M3/M4 后续范围，本版本不含。

## D9. 公网部署建议（登记条目）

- **IP 维度限流**：应用内登录限流按 (租户，用户名) 计数；IP 维度限流按安全合同登记归部署层反向代理实现——公网部署建议在反代层为登录端点配 IP 速率限制（来源：`architecture/contracts/m2-security/CONTRACT.md` SP-1「不做（登记）」段）。
- **TLS 与 DNS**：SaaS 形态的子域名路由在本栈以 Host 头透传验证；真实 DNS 解析与 TLS 证书属部署期事项，不在本栈验证面（来源：下方「SaaS profile 起栈」验证口径段）。
- **凭据**：见 D2「公网部署前必改」；数据库端口映射仅绑 127.0.0.1，如需放开由部署方自担网络边界责任（威胁模型限定见本文件顶部）。

---

## 双形态差异表

| 维度 | 单机（默认形态） | SaaS（saas profile 叠加） |
| --- | --- | --- |
| 启动 | `docker compose -f deploy/compose.yaml up` | `SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com docker compose -f deploy/compose.yaml --profile saas up` |
| 定价对应（ADR-0005） | 买断 246k，私有化部署 | 订阅 54k/年，托管 |
| 租户解析 | `singleTenantResolver()` 恒 `'default'`（缺省不触碰解析器，零行为变化） | `hostBasedTenantResolver({domain, lookup})` 子域名 → 租户（**已接线**：`SMES_TENANT_MODE=saas` + `SMES_DOMAIN` + `SMES_TENANTS` 静态清单，fail-closed：域内未知租户 404、域外/缺/多级 Host 421） |
| 入口 | web:8080 / server:3000 直连 | 叠加 proxy:80（nginx 透传 Host，子域 = 租户） |
| DB 连接 | app_user（受限 DML，无 BYPASSRLS）+ `SMES_RLS_SESSION=on` | 同左 |
| 行级隔离 | RLS 由 DB 强制（纵深防御；单机无第二租户） | RLS 是安全边界：未设变量 → 0 行/拒写；设变量 → 仅本租户 |
| SMES_TENANT_MODE | `single-node`（缺省） | `saas` |

## RLS session 接线（M4 正式线，机制与取舍见 src/rls-session.ts 头注——M4 正式线上提包顶层，领域中立）

- **机制**：`connectBusinessStore`（business-store/src/org）在 `SMES_RLS_SESSION=on`
  时给 PrismaClient 装 `$extends` 查询扩展——每个 org 存储操作包进交互式事务，
  先 `SELECT set_config('app.current_tenant', <tenant>, true)`（**事务级**：随事务
  还原，池化连接复用不串租户；会话级 `false` 无连接建立钩子可用、会跨请求泄漏，
  不取），再在同一事务句柄上重派原操作。各 PgXxxStore 零改动（装配面不变）。
- **租户来源**：store 侧自持 `TenantContext`（@smes/application 的 ALS 基座）；
  无上下文回落固定默认租户 `'default'`（单机形态恒正确；fail-visible 非 leak——
  跨租户读写均被 RLS 谓词收口）。**SaaS 请求级租户已接线（M4 正式线）**：server
  的 TenantContext 是 Nest DI 实例、ALS 跨实例不可见——main.ts 中间件在 saas
  形态下把每请求解析出的租户经 `runWithRlsTenant` 同点包进 store 侧 RLS 会话
  上下文（同一异步链），`withRlsTenantSession` 的操作事务内 SET 读到的即请求
  租户。后台任务仍需显式 `runWithRlsTenant` 包裹（不经 HTTP 中间件）。
- **接线覆盖（ESCALATION-2 收尾：18/18 全接线）**：PrismaClient 构造权分散在
  18 个 `connect*` 工厂（各自 `new PrismaClient()`）——先例四家 org /
  masterdata / workbench / approval（ESCALATION-1 裁定）+ M4 收尾波其余十四家
  （各领域 pg-*-stores，含 metric-pack 六源 bundle）全部接线；装配一致性由
  `packages/business-store/tests/rls-session-wiring.test.ts`（18 工厂 ×
  on/off/缺省三态）锚定。已知边界（raw 入口不经钩子 / =on 时外层事务原子性
  丢失）见 business-store `src/rls-session.ts` 已知边界节。实证：
  `deploy/scripts/rls-session-proof.mjs` 的接线探针（workbench / masterdata /
  baseline 写端点 201 = SET 贯通；baseline 为 14 家新接线代表）。
- **实证**：`node deploy/scripts/rls-session-proof.mjs` —— 双对照：
  ① 不接线（缺省）+ app_user：/health 200 但 org 全端点 403（RLS fail-closed，
  策略读 0 行 → 无权限身份）——app_user 全拒；baseline 写端点同 403（双对照
  前提：实验组的 201 才可归因 SET 贯通）；
  ② 接线（SMES_RLS_SESSION=on）+ app_user：org 用户/角色 CRUD + 策略授予全过、
  workbench / masterdata / baseline 接线探针 201、重启存活；最强证据 = 真实登录流（会话 `findByTokenDigest` 查询本身无租户条件，
  仅当 SET 生效时 RLS 谓词放行——compose 栈内 Bearer 读回 200）。
  superuser 形态两环境 e2e 回归均绿（缺省零回归；接线开启对 superuser 无害）。

## compose 真实栈（M4 正式线）—— build → up → 实证一条龙

```bash
# ① 镜像实 build（上下文裁剪 = 各 Dockerfile.dockerignore，per-Dockerfile 形态）
docker build -f apps/server/Dockerfile -t cadence-server .   # 退出码 0
docker build -f apps/web/Dockerfile    -t cadence-web .      # 退出码 0
# ② 起栈（pg → migrate 一次性 → server → web，healthcheck 门控）
docker compose -f deploy/compose.yaml up -d --build
# ③ 实证读回
curl http://127.0.0.1:3000/health    # {"status":"ok","tenant":"default"}  HTTP 200
curl http://127.0.0.1:8080/          # web HTML（nginx，MPA 双入口）HTTP 200
curl http://127.0.0.1:8080/health    # 经 web 反代同体读回（@server 透传）
# ④ RLS 容器三面实证（根 script；一次性 pg 容器自管自清，退出码 0=三面全过）
pnpm verify:rls
# ⑤ 收栈
docker compose -f deploy/compose.yaml down -v --remove-orphans
```

- **server / web 镜像**：`apps/server/Dockerfile`（多阶段：pnpm install
  `--filter @smes/server...` 收敛依赖子图 → 拓扑构建 → `--prod` 依赖树运行镜像，
  零 dev 工具；prisma 生成客户端自 build 阶段覆盖，内嵌 linux 引擎自包含；
  `openssl` 需在构建与运行镜像均安装——prisma 引擎变体检测依赖，缺省误判
  openssl-1.1.x）与 `apps/web/Dockerfile`（构建 → nginx:alpine 静态，
  `apps/web/nginx.conf` 对齐 vite preview：MPA 无 SPA fallback、`/login` 重写
  `/login.html`、未命中静态反代 server:3000——VITE_API_BASE_URL 缺省同源）。
- **构建上下文裁剪**（M4 正式线）：两镜像共享仓根 context，BuildKit 语义取
  `<Dockerfile>.dockerignore`（`apps/server/Dockerfile.dockerignore` /
  `apps/web/Dockerfile.dockerignore`，存在即整体替换根 `.dockerignore`）——
  普通的 `apps/*/.dockerignore` 在仓根 context 下不生效，故取 per-Dockerfile
  形态；裁剪 = 依赖产物（镜像内生成）+ `.git`/`deploy`/`architecture`/`scripts`
  + `.env`（口令不进镜像）+ 姊妹应用源码（`package.json` 保留：pnpm 工作区图
  与 `--frozen-lockfile` 校验需要全清单）。
- **生产要素初版**（M4 正式线；M4 收尾波探针单份化）：server healthcheck =
  `/health` 200，探针逻辑**单份**在 `apps/server/src/healthcheck-probe.ts`
  （随 dist 构建，镜像 `HEALTHCHECK` 引 `apps/server/dist/healthcheck-probe.js`；
  compose 侧 server 服务不定义 healthcheck，缺省继承镜像定义——同一份，无
  双写）；web 的 `depends_on: service_healthy` 据此门控（实测 server 未健康
  web 不起）；web healthcheck = 静态入口自证（不探 `/health`：反代路径会把
  server 故障混入 web 自身判定）；`restart: unless-stopped`（pg/server/web/
  proxy；migrate 一次性恒 `no`）；pg-data 具名卷（`down -v` 才删）。
  healthcheck Host 取舍（写明）：saas 形态 fail-closed 对域内未知租户 Host
  404、域外/缺/多级 Host 421（M4 收尾波：租户解析失败从 500 收敛为 421
  Misdirected Request；M5 收尾波：域内未知租户分叉 404，见下 SaaS profile
  节），liveness 探针不得依赖租户路由——saas
  （SMES_TENANTS 非空）时探针 Host = 首个已知租户 + SMES_DOMAIN，单机回落
  127.0.0.1；用 node http 而非 fetch（fetch 规范禁改 Host 头，静默忽略会误报）。
- **migrate 一次性服务**：superuser 侧 `prisma migrate deploy` + 迁移完成后
  `REVOKE INSERT, UPDATE, DELETE ON _prisma_migrations FROM app_user`（运行时
  凭据对迁移台账只读；迁移恒走 superuser——pg-init 时序：业务表晚于 initdb 由
  迁移创建，default privileges 已对 app_user 授权 DML）。server
  `depends_on: migrate: service_completed_successfully`。
- **默认收货仓 env（D-15 → D-16 改 code 语义）**：
  `SMES_DEFAULT_WAREHOUSE_CODE`（compose 缺省 `MAIN`）透传给 server——
  inventory 服务选项 `defaultWarehouseCode`，采购收货（`purchase.order.receive`）
  载荷未显式指定 `warehouseId` 时，**命令期在租户内按 (tenant, code) 解析**
  落位仓（全局单值 id 只对一个租户有效，D-16 已废 `SMES_DEFAULT_WAREHOUSE_ID`）。
  seed 按 `SMES_TENANTS`（migrate 服务同源透传）每租户幂等建 `MAIN` 仓
  （default 固定 `wh-seed-main`，其余 `wh-seed-main-<tenant>`），缺省 `MAIN`
  开箱即回落各租户自己的 MAIN；未种 MAIN 的租户须先 `warehouse.define`
  建 code=`MAIN` 仓（或显式传仓）。空串/未配 = 无默认仓，收货载荷须显式
  传仓（显式仓优先于 env 默认仓）。
- **配件审批链 env（D-25）**：`SMES_PARTS_APPROVAL_LEVELS`（1|2|3，缺省/空
  =1 单级零回归）透传 server → `definePartsApprovalChain` 构造 workorder
  `partsApprovalChain`；>1 须配 `SMES_PARTS_LEVEL2_ROLE`（levels=3 另须
  `SMES_PARTS_LEVEL3_ROLE`，org 角色码单段小写）——配错启动即炸不静默回落。
- **两域签名密钥 env（M2 安全批 SP-3）**：`SMES_ATTACHMENT_REF_SECRET` /
  `SMES_DRAWING_REF_SECRET`（base64 或 hex 编码、解码后恰 32 字节，直接作
  HMAC-SHA256 key；生成 `openssl rand -hex 32` 或 `openssl rand -base64 32`）
  透传 server——附件下载引用/图纸只读引用的签发密钥。**多实例/跨重启部署必须
  设置**：设了 → 重启后既有引用仍可兑现；未设/留空 → 实例内随机（单机演示
  可用，重启后旧引用失效属设计内，启动日志有 warn 一行）；格式非法 → 拒绝
  启动（fail-fast）。两域各用独立值。不改 TTL（附件 60s 级/图纸 ≤600s）与
  「token 即唯一凭证」语义；真实对象存储接入后由 SDK 预签名取代（INT-007）。
  冒烟脚本：`node deploy/scripts/sp3-signing-key-smoke.mjs`（需 docker，一次性
  PG 容器自管自清）。
- **PG 端口**（低危清偿）：`127.0.0.1:${PG_PORT:-55432}:5432`——栈内走 compose
  内网，宿主仅本机可达（迁移排障/psql 连查）；不选纯 `expose`：单机买断形态
  运维需要本机直连。
- **pg-init 口令**（低危清偿）：`psql -v app_password="$POSTGRES_APP_PASSWORD"`
  绑定 + SQL 内 `:'app_password'` 引用——口令不进 heredoc 拼接（注入面清零）。
- **RLS 容器三面实证**：根 script `pnpm verify:rls`（=
  `node deploy/scripts/rls-proof.mjs`；一次性 postgres 容器自管自清，退出码
  0 = 三面全过 / 1 = 有失败项——CI 可用）。

### SaaS profile 起栈（M4 正式线，hostBased 已接线 + 实测）

```bash
SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com SMES_TENANTS=tenant-a \
  docker compose -f deploy/compose.yaml --profile saas up -d --build
# pg + migrate + server + web + proxy（proxy 仅 saas profile 起验）
```

- **租户解析实证（M4 正式线直连实测；M4 收尾波：解析失败从 500 收敛为
  4xx；M5 收尾波：域内未知租户分叉 404，其余仍 421——以下为 M5 口径）**：

```bash
$ curl -H "Host: tenant-a.smes.example.com" .../health
{"status":"ok","tenant":"tenant-a"} HTTP:200      # 子域 → 租户，请求级读回
$ curl -H "Host: rogue.smes.example.com" .../health   # 域内未知租户
HTTP:404  # fail-closed（不回落 default）；message: unknown tenant "rogue"
          #（M5 收尾波：Host 属本域但租户不存在，通配 DNS 下等价 NXDOMAIN）
$ curl -H "Host: evil.example.com" .../health     # 域外 Host
HTTP:421  # message: host "evil.example.com" outside domain "smes.example.com"
$ curl .../health                                 # 缺省 Host（127.0.0.1）
HTTP:421  # 空值/缺省 Host 同落域外判定（node:http 直发实测；curl -H 'Host:'
          # 的语义是删头，删头后 HTTP/1.1 缺 Host 属 400 协议层响应）
$ curl -H "Host: a.b.smes.example.com" .../health # 多级子域
HTTP:421  # message: ...is not a single subdomain of "smes.example.com"
```

- **接线机制（main.ts 形态开关段）**：`SMES_TENANT_MODE` 缺省 `single-node`
  ——不触碰解析器，与本接线前行为逐位相同；`saas` —— DI 单例 TenantContext
  `.useResolver(hostBasedTenantResolver({domain, lookup}))`（与
  `CoreModule.register({tenantResolver})` 的 useValue 供给同一实例同一接入点，
  免改 app-registry 结构），中间件同点 `runWithRlsTenant` 把请求租户包进
  store 侧 RLS 会话上下文（见上 RLS session 节）。`SMES_DOMAIN` /
  `SMES_TENANTS` 缺省或 `SMES_TENANT_MODE` 拼写错误 → 拒绝启动（fail-fast，
  对齐 parseModulesEnabled 语义）。`hostBasedTenantResolver` 自
  business-core 包根出口消费（M4 正式线补的出口行，预研 tenant/index.ts
  头注预留动作）。
- **验证口径（如实）**：Host 头是子域名路由的**代理验证**——proxy 容器内读回
  渲染配置 `server_name ~^.+\.smes.example.com;` + Host / X-Forwarded-Host
  透传头；server 侧解析行为以上面直连探针为准。真实 DNS 解析与 TLS 证书属
  部署期事项，不在本栈验证面。
- **已知行为（写明）**：server 侧 fail-closed 已激活——域内未知租户 Host
  在 server 侧 **404**（M5 收尾波有意语义：Host 属本域但租户不存在，通配
  DNS 下等价 NXDOMAIN），域外/缺/多级子域 Host **421** Misdirected Request
  （客户端走错 origin）。两层机制：main.ts 租户中间件内联窄捕
  `TenantResolutionError`、按 reason（unknown-tenant / off-domain /
  missing-host / invalid-subdomain）分叉 404/421——生产主路径，语义与取舍
  注释见 `apps/server/src/main.ts`；逃逸错误再由 Express 全局错误中间件
  `tenantResolutionErrorHandler` 兜底映射 421——机制与状态码取舍见
  `apps/server/src/tenant-resolution-error.handler.ts` 文件头；上表实测。
  web 容器不在收口面：web/nginx 不感知租户清单，任意子域（含未知租户）
  都返回静态登录页 200——租户校验在 server 侧 fail-closed。单 server 块
  nginx 配置对未匹配 `server_name` 的 Host 落默认 server 透传，proxy 层
  有意保持哑透传（compose 注释口径），域收口点在 server 侧。
- **接缝（M4 后续）**：非默认租户的开通/种子流程（SMES_TENANTS 是静态清单；
  tenant-a 无种子用户 → 该租户下登录 401 属预期——数据面端到端待租户开通
  流程）。~~TenantResolutionError → 500 的状态码映射~~（**M4 收尾波已闭合**：
  Express 错误中间件映射 421；**M5 收尾波进一步分叉**——生产主路径改内联
  中间件按 reason 映射 404/421（见上已知行为节），兜底错误中间件维持全
  421；e2e 覆盖未知/域外/空/多级四形 + 非 TenantResolutionError 原样放行
  ——e2e 装配即兜底错误中间件层，其断言 421 在该层为真）。
- **单机复验**：无 profile、无 env 直接 `up -d` 不回归——缺省插值
  `SMES_TENANT_MODE=single-node`、`SMES_DOMAIN` 空、proxy 服务不起，
  /health 与 web 均 200，`down -v` 零残留。

## 形态切换取舍（写明）

compose 单文件内 profile 不能改同一服务的 env，故：租户模式走 **env 插值**
（`SMES_TENANT_MODE`，缺省 single-node，直接 up 即单机）；`saas` **profile 承载
SaaS 独有结构**（子域反向代理 = DOMAIN 配置入口的实体落点）。两者叠加 = SaaS
形态。若需"一个开关全切"，可上 compose override 文件或把模式注入收进
proxy/entrypoint。

`DATABASE_URL` 统一用受限 app_user + `SMES_RLS_SESSION=on`：RLS 就位后这是
SaaS 的安全边界；单机形态同形状纵深防御（org / masterdata / workbench /
approval 四家已接线，其余工厂接线属泳道裁定后续——见上"接线覆盖"）。
