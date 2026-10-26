# Cadence SaaS 多租户功能性测试报告

- 被测版本：yeemio/Cadence `c80319f`（main）
- 环境：box 上 docker compose `--profile saas`（pg/server/web/proxy），SMES_DOMAIN=smes.example.com，租户 default / tenant-a / tenant-b，27 个模块全开
- 执行时间：2026-10-26 11:30–12:10（Asia/Shanghai）
- 主测租户：**tenant-a**。原因：P0 缺陷 D-1（权限缓存只服务重启后第一个租户）。规避方式是重启 server 后先访问 tenant-a。default/tenant-b 的隔离已在前一份 SaaS 报告中覆盖
- 方法：按角色组织（admin / approver / viewer / demo-admin=提交人）。包括端到端业务链 API、跨角色交接、Playwright 4 角色 × 2 端并行巡检，以及全路由权限矩阵
- 约束：未改代码、未推送，只用测试数据（前缀 qa）。报告中不含密码

## 1. 总览

| 维度 | 用例数 | PASS | FAIL | BLOCKED | N/A |
|---|---|---|---|---|---|
| 业务链 API | 115 | 93 | 7 | 8 | 7 |
| 角色场景/跨角色 | 49 | 48 | 1 | 0 | 0 |
| UI 巡检（页次） | 127 | 127 | 0 | 0 | 0 |
| 权限矩阵（路由） | 268 | 263 | 5 | 0 | 0 |

权限矩阵有 5 条路由被判"异常"：1 条是真缺陷，`GET /baseline/material-validations/:id` 传入非 UUID 返回 500（D-7）；另外 4 条本来就无权限守卫，属于公开端点（auth/login、auth/me、attachment/storage/:token、demo/ping），不算缺陷。auth/refresh 会吊销令牌，所以没有纳入矩阵。

### 1.1 按模块

| 模块 | 业务链 PASS | FAIL | BLOCKED | N/A | 矩阵路由 OK/异常 |
|---|---|---|---|---|---|
| masterdata | 10 | 0 | 0 | 0 | 15/0 |
| workorder | 6 | 2 | 2 | 0 | 18/0 |
| listing | 3 | 0 | 2 | 0 | 26/0 |
| purchase(listing) | 6 | 1 | 0 | 0 | —/— |
| dispatch | 7 | 1 | 0 | 1 | 18/0 |
| reporting | 2 | 2 | 1 | 0 | 11/0 |
| hours | 4 | 0 | 0 | 0 | 10/0 |
| payroll | 5 | 0 | 0 | 0 | 12/0 |
| costing | 5 | 0 | 1 | 0 | 17/0 |
| maintenance | 5 | 0 | 0 | 2 | 17/0 |
| drawing | 4 | 0 | 0 | 1 | 7/0 |
| inspection | 3 | 0 | 2 | 0 | 11/0 |
| metric-pack | 2 | 0 | 0 | 0 | 6/0 |
| standardreports | 3 | 0 | 0 | 0 | 2/0 |
| workbench | 3 | 0 | 0 | 1 | 4/0 |
| notifications | 3 | 0 | 0 | 1 | 5/0 |
| inventory | 3 | 0 | 0 | 1 | 18/0 |
| issue | 2 | 0 | 0 | 0 | 10/0 |
| aftercare-claim | 1 | 0 | 0 | 0 | —/— |
| attachment | 5 | 0 | 0 | 0 | 6/1 |
| menu-config | 2 | 0 | 0 | 0 | 5/0 |
| approval-config | 2 | 0 | 0 | 0 | 6/0 |
| audit | 1 | 0 | 0 | 0 | 1/0 |
| demo | 2 | 0 | 0 | 0 | 1/1 |
| baseline | 2 | 1 | 0 | 0 | 20/1 |
| org | 1 | 0 | 0 | 0 | 13/0 |
| core | 1 | 0 | 0 | 0 | —/— |

UI 巡检按页面分组：baseline 14/14，costing 2/2，dispatches 2/2，home 4/4，hours 2/2，inspections 4/4，inventory 10/10，listings 4/4，m- 4/4，m-fault 2/2，m-hours 2/2，m-inspection 2/2，m-mine 2/2，m-op-progress 2/2，m-parts 2/2，m-parts-approval 2/2，m-progress 2/2，m-receipt 2/2，m-report 2/2，m-stock 2/2，m-stocktake 2/2，m-transfer 2/2，m-verify 2/2，masterdata 10/10，notifications 2/2，outsourcing 2/2，overview 3/3，purchase 8/8，reports 4/4，scan 4/4，standard-reports 2/2，system 14/14，workorders 4/4

### 1.2 按角色

| 角色 | 场景用例 PASS/FAIL | 业务链 PASS/FAIL/BLOCKED | UI 桌面页 | UI 移动页 | 结论 |
|---|---|---|---|---|---|
| admin | 18/0 | 85/7/8 | 45/45 | 16/16 | 配置/主数据/全模块页面可用；写入型业务命令受 D-8 阻断 |
| approver | 12/0 | 3/0/0 | 2/2 | 1/1 | 只能进入审批/工作台；批准、驳回、版本冲突、重复决策都符合预期；首页出现多余 403（D-12） |
| viewer | 9/0 | 3/0/0 | 1/1 | 1/1 | 所有受守卫路由都是 403，符合矩阵；首页卡片一直"正在加载…"（D-6） |
| demo-admin | 4/1 | 0/0/0 | 45/45 | 16/16 | 提交审批 → 审批人可见 → 决策回流链路通过；接受不存在的审批人（D-11） |
| 跨角色交接 | 5/0 | — | — | — | PX-01..05：提交 → 审批人待办 → 批准/驳回 → 提交人与 admin 读回状态一致；viewer 不可见 |

## 2. 缺陷清单

### 本轮新发现

**D-8（P0）SaaS/RLS 形态下，核心业务写命令全部返回 500：工作令创建、采购下单、报工提交、外协派工**
- 复现：以 admin 登录 tenant-a，发送 `POST /workorder/work-orders`，请求体为 `{operationId:新值, expectedRevision:"initial", command:{kind:"workorder.create.v1", payload:{projectName:"x"}}}`。连续 10 次都返回 500；采购下单连续 5 次也都返回 500
- 期望：201 committed。实际：500 Internal server error
- 日志：`prisma.outboxRecord.create()` 报 P2003，违反外键约束 `outbox_records_event_id_fkey`
- 根因：`packages/business-store/src/rls-session.ts` 的 `withRlsTenantSession` 会把每个模型操作重派进它自己新开的交互式事务。于是 `PgWorkOrderDomainEventStore.append` 等方法里的数组 `$transaction([event.create, outbox.create])` 被拆成两个独立事务，outbox 插入时看不到尚未提交的 event 行，外键失败。代码注释已经登记了"原子性丢失"这一缺口，但没有登记它会让写路径直接 500
- 后果：event_records 留下孤儿行（tenant-a 有 15 条 event，只有 7 条 outbox）。工作令→清单→成本、外协→质检等下游链路随之被阻断（共 8 条 BLOCKED）
- 证据：/tmp/chain.json、`docker logs cadence-server-1`。提交：c80319f

**D-7（P2）`GET /baseline/material-validations/:id` 传入非 UUID 时返回 500**
- 复现：`GET /baseline/material-validations/abc`。期望 400/404，实际 500（Prisma P2023 Error creating UUID）。证据：/tmp/matrix.json、/tmp/chain.json BL-02

**D-9（P2，待确认）报工数量可以超过派工数量**
- 复现：派工数量 10，提交报工数量 11（RP-02）。期望 400/409/422，实际 201 committed
- 注：前置用例 RP-01 受 D-8 影响失败，建议 D-8 修复后复测这条

**D-11（P2）发起审批时可指定不存在的审批人**
- 复现：demo-admin 发送 `POST /approval/cases`，approvers 为 `['no-such-user']`。期望 400，实际 201。这会产生永远无人处理的审批单。证据：/tmp/persona.json PS-04

**D-12（P3）approver/viewer 登录首页时请求无权限的接口**
- 首页会请求 menu-config/configs、notifications/unread-count、workbench/*、workorder/delivery-situation 并得到 403，控制台报错
- 期望：前端按权限投影，不发起这些请求。证据：saas-func-shots/home/approver-*、viewer-*

**D-13（P3）成本页口径版本的"发布时刻"直接显示 UTC ISO 字符串**
- 页面显示 `2026-10-26T03:49:26.749Z` 这样的原始值，没有按本地时区格式化。证据：saas-func-shots/costing/admin-desktop-_costing.png

### 沿用的前期缺陷（SaaS 报告 / 部署报告）

| 编号 | 级别 | 描述 |
|---|---|---|
| D-1 | P0 | PermissionService 单例 enforcer 在第一个请求的 RLS 上下文中加载策略，重启后只能服务第一个访问的租户，其他租户全部 403 |
| D-2 | P2 | `POST /org/users` 创建的用户没有密码，无法登录，也没有设置密码的 API |
| D-3 | P1 | 附件内容存放在内存 store，重启后丢失，download-reference 返回 502 |
| D-4 | P3 | 签名存储 URL 未绑定租户且无需认证（HMAC，约 60s TTL） |
| D-5 | P3 | 未知租户返回 404，与 README 写的 421 不一致；web 容器对未知租户仍提供登录页 |
| D-6 | P3 | viewer 遇到 403 后，工作台卡片一直停在"正在加载…" |
| B-1 | P3 | 干净克隆后 `pnpm verify` 报 TS2307（typecheck 早于 build） |
| B-2 | P3 | product-ui 测试实际 130 个，文档写 123 个 |

## 3. 符合设计、未计为缺陷的行为

- upload-stats 返回 409、costing 无快照返回 404、重复 operationId 返回 409（测试指南明确为设计行为）
- 移动端 4 个 tab；桌面菜单按权限投影（approver 只看到首页/概览，viewer 只看到首页）
- **深链与刷新**：在桌面直接打开 `/workorders`、`/masterdata/items` 等路由，会落到 server，返回 404/401 JSON。web nginx 注释写明这是 MPA 设计，不做 history fallback，只有 `/m/*` 会回落。所以 UI 巡检改用应用内点击导航。不过这对用户刷新页面不友好，建议产品层面再评估
- 命令信封业务拒绝（如 expectedRevision 非数字）返回 HTTP 201 + `status:"rejected"`，属于信封语义
- 待办"完成"只允许本人操作，他人操作返回 404
- SaaS proxy :80 只反代 server，前端 UI 从 web :8080 访问

## 4. 未实现 / 覆盖缺口

- 用例参数与契约不符、需修正后复测（7 条 N/A）：MT-04 维护任务 id 未取到（前置用例返回体字段名与脚本不符）；MT-05 同 MT-04；DW-03 查询需带 clearance 参数（接口契约，脚本未带）；DP-09 需 supplierRef 查询参数（接口契约）；NT-01 通知 source 码需小写单段（校验生效，脚本参数错）；IV-01 command.kind 名与契约不符（校验生效）；WB-04 待办属于他人，404 符合"仅本人"设计
- 因 D-8 阻断未能验证：清单 xlsx 导入、成本重建、质检判定、报工核查的完整链路
- 因 D-1 只能深测 tenant-a；没有密码设置 API（D-2），新建用户的登录流程无法验证
- approver 没有独立的审批页面入口，审批动作靠工作台待办和 API 完成

## 5. 证据与产物

- 用例全集：/workspace/Cadence-functional-test-cases.md
- 截图：/workspace/saas-func-shots/<模块>/（127 张）
- 原始结果：/tmp/chain.json、/tmp/persona.json、/tmp/matrix.json、/tmp/crawl.json
- SaaS 栈保持运行：cadence-{pg,server,web,proxy}-1
