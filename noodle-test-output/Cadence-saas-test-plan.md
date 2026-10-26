# Cadence SaaS 多租户测试计划

## 被测对象（读代码和文档后的理解）
- 租户模型：静态清单 `SMES_TENANTS`。按 Host 子域解析租户（`hostBasedTenantResolver`），未知或域外的 Host 一律拒绝，返回 421（fail-closed）。
- 数据隔离：PG RLS（106 张业务表 ENABLE+FORCE，谓词 `tenant_id = current_setting('app.current_tenant')`）；server 以 app_user 连库，`SMES_RLS_SESSION=on`。
- 代码里**没有**以下能力（deploy/README 写明属于"M4 后续"）：租户开通/注册流程、平台超管、停用/恢复/删除租户、套餐/订阅、按租户的模块授权、配额。这些用例记为"未实现（N/A）"，作为能力缺口登记，不算回归缺陷。
- 种子只写 default 租户。测试夹具：在测试库里用 superuser SQL 给 tenant-a/tenant-b 复制 admin/viewer 用户和策略，以此模拟"开通"。这只改测试数据，不改代码。

## 部署
`SMES_TENANT_MODE=saas SMES_DOMAIN=smes.example.com SMES_TENANTS=default,tenant-a,tenant-b docker compose --profile saas up -d --build`，所有请求经 proxy :80 加 Host 头。

## 用例
| ID | 类别 | 用例 | 期望 |
|---|---|---|---|
| R1-R6 | 租户解析 | 已知子域 / 未知子域 / 域外 / 多级子域 / IP 直连 / X-Forwarded-Host 伪造 | 已知租户返回 200 并回显该租户；其余 421；伪造的 XFH 不改变租户 |
| L1-L5 | 登录 | 各租户 admin 登录；tenant-b 的 viewer 在 tenant-a 登录；default 的 approver 在 tenant-a 登录 | 本租户成功；其他租户的账号 401 |
| T1-T3 | token 跨租户 | tenant-a 的 token 拿到 tenant-b Host / default Host 使用 | 401 或 403，绝不能返回 B 的数据 |
| D1-D8 | 数据隔离 | A 创建客户、单位、附件；B 执行 list/get/put/remove/download-reference；按 A 的 id 篡改请求；在 body 里塞 tenantId | B 看不到也改不了 A 的数据；body 里的 tenantId 被忽略 |
| P1-P2 | 门禁 | 各租户 viewer 访问受保护资源 | 403 |
| AU1-AU2 | 审计 | 两个租户各自的审计日志只含本租户的操作 | 隔离 |
| C1 | 并发 | 两个租户各并发 20 次创建并交叉列表 | 无串租户、无 5xx |
| DB1-DB2 | 库层 RLS | app_user 不设或设错 app.current_tenant 时查询 | 返回 0 行 |
| M1 | 迁移和种子 | 迁移只跑一次（全局 schema），种子只写 default | 属于设计；记录"非 default 租户无种子"这一缺口 |
| RS1 | 重启 | 重启 server 和 pg 后，各租户数据和登录仍在 | 持久化 |
| UI1-UI3 | 前端 | Playwright 无头浏览器：tenant-a 登录桌面端、移动端、viewer 菜单裁剪 | 截图存证 |
| G1-G6 | 平台能力 | 开通、注册、超管、停用/恢复/删除、套餐和模块授权、配额 | N/A，登记为缺口 |
