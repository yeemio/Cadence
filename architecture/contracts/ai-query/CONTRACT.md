# AI 问数首版实施合同（CONTRACT v1 · 2026-10-28）

Owner 授权：2026-10-28 会话指令「按照这个目标，多代理开满 GLM-5.3，全速推进」。
方案源：[ai-query-dsh-proposal.md](../../ai-query-dsh-proposal.md)——本合同是其交付顺序中「网页问数闭环」波次的工程冻结。

## Goal / Done-when

- **Goal**：Cadence 网页端 AI 问数首版闭环——工作令进度、物料缺口、质量检验三域自然语言问数，返回可追溯的结构化结果卡片。
- **Done-when（用户可观察）**：
  1. 登录用户在网页「AI 问数」页提问三域问题，得到与业务页面口径一致的结果卡片（数字＋口径注记＋来源＋完整性＋详情跳转）；
  2. 歧义（澄清选项）、无权限（缺码明示）、不支持（能力提示）、数据源未就绪（如实说明）四种非答案终态分别可见；
  3. 全仓 `pnpm verify` exit 0；code-reviewer 验收 ACCEPT。
- **非目标**：DSH 真实模型接入（无凭据不接付费模型，proposal §8）；企微/飞书真实双向消息（后续波次）；任何生产写能力（首版限定只读，proposal §7）；薪酬/成本/图纸受限内容（不注册为能力，proposal §5）；不改动 reporting/大屏/其他既有模块行为。

## 三域能力与权限

| capabilityId | 输入 | 数据来源（复用现有读面，不新开 SQL） | 域权限码（叠加在 ai-query:read 之上） |
| --- | --- | --- | --- |
| workorder-progress | 工作令标识（编号/模糊） | WorkOrderStore.find/list + ProgressFact→rollup（workorder-progress.ts 纯函数）+ 未完成任务清单 | workorder:read |
| material-gap | 工作令标识 | GapCheckStore.latestByWorkOrder（requiredQty/availableQty/gapQty/neededBy/kind）+ 采购单/请购关联（listing 域 stores） | listing:read |
| quality-inspection | 时间范围（今日/本周/最近N天） | InspectionOrderStore（state=failed 且 judgedAt 落窗）+ NonconformStore 处置状态 | inspection:read |

- 端点统一 `@RequirePermission('ai-query:read')`；能力执行前经 PermissionResolver 逐码复核域权限（服务端每次查询重新验证，proposal §5-3）。
- 用户有 ai-query:read 但缺域码 → 响应 `kind:'denied'`（HTTP 200，回答通道内明示 missingPermissions），不是 403 硬抛；缺 ai-query:read 由 AuthGuard 403（既有行为）。
- ADMIN 角色凭 `*` bypass 自动覆盖新码；非 admin 需租户策略授予（部署事项，不阻塞验收；e2e 测试内自种策略，先例 screen-boot.e2e.test.ts）。

## Wire 合同（HTTP · JSON）

错误经 AiQueryErrorFilter → `{statusCode, code:'ai_query.xxx', message}`（400/404/409，先例 report-error.filter.ts）。**裁定（WP-B 实施时确认）**：code 段用下划线 `ai_query.*`——既有测试不变量 `/^[a-z0-9_]+(\.[a-z0-9_]+)+$/` 不含连字符（metric_pack/column_preference 先例），合同原文「ai-query.xxx」按 URL 前缀惯用语理解。

1. `GET /ai-query/capabilities` → 200 `{items:[{capabilityId, version, title, description, subjectKind:'workorder'|'material'|'inspection', requiredPermissions:string[], status:'ready'}]}`
2. `POST /ai-query/ask` body `{sessionId?:string, question:string(1..500), selectedOptionId?:string}` → 200 AskResponse（discriminated `kind`）。**裁定（WP-B 验收发现后冻结）**：ask 恒 200（控制器 @HttpCode(200) 显式声明，含 denied/clarify 等非答案态）；denied/unsupported/unavailable 三态额外携带 `sessionId`（加法超集字段，WP-C 可依赖）。
   - `{kind:'answer', sessionId, answerId, capabilityId, summary, caliberNotes:string[], factCards:FactCard[], createdAt}`——零行是合法 answer（summary 明示「查询有效、无记录」；零值只能由有效查询产生）
   - `{kind:'clarify', sessionId, prompt, options:[{id,label,description}]}`——pending 澄清存 session，selectedOptionId 回传续走
   - `{kind:'denied', reason:'no_permission', missingPermissions:string[], hint}`
   - `{kind:'unsupported', hint, capabilityHints:string[]}`
   - `{kind:'unavailable', reason:'data_source_not_ready', detail}`
   - FactCard：`{subject:{kind:'workorder'|'material'|'inspection', id, label}, title, metrics:[{key,label,value:number|string, unit?}], rows?:{columns:[{key,label}], values:readonly (string|number|null)[][]}, timeBasis:{kind:'point'|'range', label, from?, to?}, sourceRefs:[{ref, queryMoment}], completeness:{status:'complete'|'truncated', rowCount:number, totalKnown:boolean, note?}}`
3. `GET /ai-query/sessions?limit=50` → `{items:[{sessionId, lastActivityAt, turnCount}]}`
4. `GET /ai-query/sessions/:id` → `{sessionId, createdAt, lastActivityAt, turns:[{question, answerId?, kind, response:AskResponse}]}`——session 归属 tenant+userId，跨用户读 → 404。

## 意图路由（v1 确定性 · AI 接缝）

- IntentRouter 端口 + RuleIntentRouter 默认实现（v1 无模型；页面明示「规则引擎模式·未接入 AI 模型」）。DSH 真实运行服务接入时替换此层，能力执行与权限留在 Cadence。
- 规则（首版最小集）：工作令标识（编号形态或「工作令/单号」词）＋「进度/做到/完成/剩」→ workorder-progress；＋「缺料/齐套/物料/材料」→ material-gap；「检验/质量/不合格/返工/特采」＋时间词 → quality-inspection。
- 歧义 → clarify：编号多匹配（列候选单选项）；quality 无时间词（选项：今日/本周/最近7天/最近30天）。
- 未命中 → unsupported（带能力提示）。

## 完整性与口径纪律（proposal §5-4 / L100）

- doneQty 口径注记原样携带（「口径暂按派工侧终态呈现，对账阶段校正」类，来源 workorder-progress/standard-reports-pack 注释），不得静默吞掉。
- 目标工作令无齐套核对记录 → unavailable（数据源未就绪），不得按零缺口回答。
- 截断/分页如实：completeness.totalKnown=false 时 summary 不得总结为全量。
- summary 仅由结构化事实生成（v1 模板拼接）；v1 不产出推测性结论——事实与推测分离的首版形态就是「无推测」。

## 组合（apps/server · WP-B）

- `MODULE_DEFINITIONS['ai-query']` 一行；`DEFAULT_MODULES_ENABLED` 不变（opt-in 模块）。
- AiQueryErrorFilter 进 main.ts 过滤器列；域错误类在 application 包 ai-query.errors.ts。
- deploy/README.md 全量模块清单补行；compose 缺省不动。

## Web（WP-C）

- menu.ts 顶层条目 code `ai-query`、routePath `/ai-query`、`permission: pc('ai-query:read')`；zh-CN/en-US menu.json 同步（i18n/menu/module-pages 三处硬断言测试同步）。
- 页面：提问输入、会话线程、结果卡片（指标＋行表＋口径注记＋完整性徽标）、澄清选项 chips、denied/unsupported/unavailable 三态明示、「规则引擎模式·未接入 AI 模型」横幅。
- 详情跳转由前端路由表负责（服务端只回 subject，不拼前端 URL）：workorder→`/workorders?wo=`、material gap→`/listings/gap-checks?wo=`、inspection→`/inspections`。

## Writer 边界

- **WP-A（application）**：`packages/application/src/ai-query/**` ＋ 包 index.ts 导出 ＋ 包内测试。禁止触碰 apps/**、engine、business-store、其他模块目录。
- **WP-B（server 组合）**：`apps/server/src/{app-registry.ts, main.ts, ai-query-error.filter.ts}` ＋ apps/server/tests/{app-registry.test.ts 增行, ai-query-boot.e2e.test.ts 新建, error-code-mapping.test.ts 增行} ＋ deploy/README.md。WP-A 完成后派发。
- **WP-C（web）**：`apps/web/src/{menu.ts, pages/ai-query/**, pages/assembly.ts, data/aiQueryApi.ts, i18n/locales/{zh-CN,en-US}/menu.json}` ＋ apps/web/tests 硬断言同步。禁止触碰 server/application。
- 三 writer 均不 commit/push；保留工作区既有脏改（M2-R1 在途，勿动勿修，verify 若因其在途改动失败且与 ai-query 无关→如实登记不代修）。

## 验收与交付

- 各 writer 包内测试绿；WP-B 合流后全仓 `pnpm verify` exit 0。
- code-reviewer（GLM-5.3）只读验收 vs 本合同 ＋ 原始证据（不采信转述）。
- DELIVERY：`output/ai-query-delivery-20261028/DELIVERY.md`——实施者身份据实登记（代理名＋GLM-5.3＋子代理会话 ID）。

## 后续事项登记（不在本波）

1. DSH 真实运行服务接入（版本固定＋Profile＋模型凭据，Owner 具名绑定后开波；届时 IntentRouter 换 DSH 编排，能力合同不变）。
2. 企微/飞书真实双向消息（验签/解密/票据留白补齐，integration-im 既有端口承接）。
3. 群披露目的地规则、按租户模型预算/并发限额、审计用量记账细化、per-tenant 模块授权裁决点。
