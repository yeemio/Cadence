# Cadence SaaS 多租户测试报告（2026-10-26 北京时间，grokbot）

- commit **c80319f**；部署命令：`SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com SMES_TENANTS=default,tenant-a,tenant-b MODULES_ENABLED=<全部 27 个> docker compose --profile saas up -d --build`（deploy/）
- 环境：Node v24.22.1，Docker 29.9.2；所有请求经 proxy :80 加 Host 头；前端 :8080，Playwright 无头 Chromium，用 host-resolver 把 \*.smes.example.com 映射到本机
- 测试计划：/workspace/Cadence-saas-test-plan.md；截图：/workspace/saas-shots/
- 夹具（只改测试数据，未改代码）：系统没有租户开通流程，种子只写 default 租户，所以用 superuser SQL 把 default 的 admin/viewer 用户和策略复制到 tenant-a、tenant-b（id 加 -a/-b 后缀）

## 结论
- **库层 RLS 和请求级租户解析都很扎实**：在两个租户都能用的场景下，跨租户读、写、列表、改、删、附件、审计全部被拦截，没有发现数据泄露。
- **但有一个 P0 阻断缺陷**：权限引擎全进程只加载一次策略，而且是在第一个请求所属租户的 RLS 上下文里加载的。结果是 SaaS 形态下只有"重启后第一个访问的租户"能正常用，其余租户（包括 default）的管理员对所有受保护接口都是 403。SaaS 多租户实际上不可用。
- 平台层能力（开通、超管、停用、套餐、配额）代码里都没有，文档也写明属于 M4 后续。

## 用例结果
| ID | 用例 | 结果 | 证据 / 实际 |
|---|---|---|---|
| R1 | default / tenant-a / tenant-b 子域 /health | 通过 | 200，tenant 分别回显 |
| R2 | 域内未知子域 rogue | 通过（状态码和文档不符，见 D-5） | **404** unknown tenant（README 写 421） |
| R3 | 域外 evil.example.com | 通过 | 421 |
| R4 | 多级子域 a.b.smes.example.com | 通过 | 421 |
| R5 | IP 直连 127.0.0.1 | 通过 | 421 |
| R6 | 伪造 X-Forwarded-Host（经 proxy 和直连 3000） | 通过 | 租户仍按 Host 判定，XFH 不生效 |
| L1 | 三个租户各自 admin 登录 | 通过 | 都拿到 token |
| L2 | 只在 default 存在的账号（approver、demo-admin）登录 tenant-a/b | 通过 | 401 |
| L3 | 错误口令、无 token | 通过 | 401 |
| T1 | tenant-a 的 token 用在 tenant-b Host 上调 /auth/me | 通过 | 401 会话已失效 |
| T2 | tenant-a 的 token 用在 default Host 上调 /org/users | 通过 | 401 |
| T3 | token 在本租户内使用 | 通过 | 200，user.tenant=tenant-a |
| D1 | A 创建客户时 body 里塞 tenantId=tenant-b | 通过 | 落库为 tenant-a，body 里的 tenantId 被忽略 |
| D2 | B 列 customers / units / users / 附件 | 通过 | 都是空列表或只有 B 自己的数据 |
| D3 | B 用 A 的客户 id 发 PUT | 通过 | 404 "租户 tenant-b 内不存在客户"，库里数据没变 |
| D4 | B 停用 A 的用户 | 通过 | 404，A 用户仍是 active |
| D5 | B 对 A 的附件取 download-reference / 调 remove | 通过 | 404，remove 返回 removedIds=[]，附件仍在 |
| D6 | B 新建和 A 同 code 的客户（CA-001） | 通过 | 201，唯一键按租户划分 |
| D7 | 附件 storage 签名 URL 跨 Host 访问 | 有风险（见 D-4） | URL 是 HMAC 签名、约 60 秒有效，篡改 payload 后 404；但不需要登录、不绑租户，在任何租户 Host 下都能下载 |
| P1 | 各租户 viewer 访问 /org/users | 通过 | 403 |
| AU1 | 审计日志按租户隔离 | 通过 | A 只看到 tenant-a，B 只看到 tenant-b |
| C1 | 并发：A 并发创建 40 个客户，同时 A、B 各并发 40 次 /auth/me | 通过 | 40×201；120 个响应租户全部对得上，没有串上下文；库里 tenant-a 多出 40 行 |
| DB1 | app_user 不设 app.current_tenant 时查询 | 通过 | 0 行 |
| DB2 | app_user 上下文是 A 时插入 tenant-b 的行 | 通过 | RLS 拒绝 |
| DB3 | app_user 写 _prisma_migrations | 通过 | permission denied；app_user 没有 superuser，也没有 bypassrls |
| M1 | 迁移和种子 | 能力缺口 | 迁移是全局一次；种子只写 default，非 default 租户没有任何用户和策略（G-1） |
| RS1 | 重启 pg 和 server | 通过（附件内容除外） | 41 个客户还在，旧 token 仍有效（会话已持久化）；**附件内容丢失（见 D-3）** |
| UI1 | tenant-a admin 桌面端（A 是重启后第一个访问的租户） | 通过 | 全量菜单，0 个错误请求，截图 UI1 |
| UI2 | tenant-a admin 移动端 /m | 通过 | 四个标签和快捷入口正常，截图 UI2 |
| UI3 | tenant-a viewer 桌面端 | 门禁通过；有体验问题 D-6 | 菜单被裁剪；4 个 403 后页面一直显示"正在加载…"，截图 UI3 |
| UI4/UI5 | tenant-b admin、default admin 桌面端 | **失败（D-1）** | 管理员看到的是访客视图，4 个接口 403，截图 UI4/UI5 |
| UI6 | 别的租户的账号在 tenant-a 登录页登录 | 通过 | "用户名或口令不正确" |
| UI7 | rogue 子域打开前端 | 体验问题 D-5 | 静态登录页返回 200（API 侧会拒绝） |
| G1-G6 | 租户开通/注册、平台超管、停用/恢复/删除租户、套餐和按租户模块授权、配额 | N/A，未实现 | 没有相关接口；SMES_TENANTS 和 MODULES_ENABLED 都是全局静态配置 |
| G7 | 租户管理员给新建用户设置口令 | **能力缺口（D-2）** | POST /org/users 能建用户，但 password_hash 为空，也没有设口令的接口，新用户无法登录 |

## 缺陷
### D-1【P0】SaaS 形态下权限策略只加载"第一个访问的租户"，其他租户的管理员全部 403
- 位置：packages/application/src/core/auth/permission.service.ts。`ready()` 用 `??=` 缓存同一个 casbin enforcer，`loadPolicy` 只执行一次；policies 表开着 FORCE RLS，加载时只能读到当时请求所属租户的行。
- 复现：
  1. 按上面的命令以 saas 形态启动，并给 tenant-a/b 准备 admin（夹具 SQL 见文首）。
  2. `docker restart cadence-server-1`
  3. 先用 tenant-a 登录：`curl -H 'Host: tenant-a.smes.example.com' -XPOST :80/auth/login -d '{"username":"admin","password":"demo-password"}'`，再分别用 tenant-a/default/tenant-b 的 admin token 调 `GET /org/users`
- 期望：三个租户的 admin 都是 200。
- 实际：`first=A: A=200 default=403 B=403`。重启后如果先访问 B，就只有 B 是 200。default 的种子管理员在 SaaS 形态下完全不可用。报错原文：`租户 'tenant-b' 内用户 'user-seed-admin-b' 无权限码 'customer:read'`。
- 影响：SaaS 多租户基本不可用；重启后哪个租户能用取决于谁先访问。另外推断：运行时给其他租户新增的授权，在内存里和库里也可能不一致。
- 证据：saas-shots/UI4-tenantB-admin-desktop.png、UI5-default-admin-desktop.png
- 建议：按租户缓存 enforcer，或者在 RLS 之外按租户加载策略并带上 domain 过滤。

### D-2【P2】租户内新建的用户无法登录（没有设置口令的途径）
- 复现：用 tenant-a admin 调 `POST /org/users {"username":"alice-a","displayName":"Alice A","password":"demo-password"}` → 201；再用 alice-a 登录 → 401 用户名或口令不正确。库里 password_hash 为 NULL。
- 期望：建用户时能设口令，或者有重置口令的接口。
- 这对租户上线是阻断项，单机形态也一样受影响。

### D-3【P1】附件内容存在进程内存里，重启后丢失，元数据还留在库里
- 复现：上传附件 → `docker restart cadence-server-1` → 对该附件调 download-reference，返回 502：`对象存储内不存在目标 'memory' 的对象 'upload/2026/10/26/…-a.txt'`。
- 期望：部署形态配置持久化的对象存储，或者至少在启动时提示存储是内存型。

### D-4【P3】附件 storage 签名 URL 不绑定租户、不需要登录
- 现象：tenant-a 的附件 URL 在 tenant-b / default 的 Host 下、不带 token 都能下载到内容 TOP-SECRET-A。缓解因素：URL 有 HMAC 签名、约 60 秒过期，篡改 payload 会 404。
- 建议：在签名 payload 里加入 tenant，校验时和请求解析出的租户比对。

### D-5【P3】未知租户子域的表现和文档不一致
- API：域内未知子域返回 **404**（README 写的是 421），域外、多级子域、IP 直连都是 421。
- 前端：web 容器在 rogue 子域下直接返回静态登录页 200，只有调 API 时才失败。
- 建议：统一状态码并更新文档；前端也考虑按租户拒绝。

### D-6【P3】没有权限时，工作台卡片一直显示"正在加载…"
- 复现：用 viewer 登录桌面端，/workbench/summary 等接口返回 403，卡片不报错也不提示无权限（截图 UI3）。

## 能力缺口（N/A，文档已写明属于 M4 后续，不按缺陷评级）
租户开通、注册引导、平台超管、停用/恢复/删除租户（以及停用后对登录的影响）、套餐订阅、按租户的模块授权（MODULES_ENABLED 全局生效）、配额限制、非 default 租户的种子数据。这些都没有实现，也就无法测试。

## 当前运行状态
SaaS 栈保持运行：proxy :80（子域 Host 路由），server :3000，web :8080，PG 127.0.0.1:55432。tenant-a/b 的测试夹具和测试数据都留在库里。**由于 D-1，目前只有 tenant-a 能正常使用**（重启后谁先访问就是谁）。单机部署已停掉，pg 数据卷是同一个，继续沿用。
