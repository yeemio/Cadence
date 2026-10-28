# AI 问数首版（网页问数闭环）交付记录

日期：2026-10-28（Asia/Shanghai）｜控制会话：本线程（总控）｜合同：[architecture/contracts/ai-query/CONTRACT.md](../../architecture/contracts/ai-query/CONTRACT.md)｜方案源：[architecture/ai-query-dsh-proposal.md](../../architecture/ai-query-dsh-proposal.md)（交付顺序第 2 步「网页问数闭环」）

## 交付内容（Done-when 对照）

1. **三域问数闭环**：工作令进度 / 物料缺口 / 质量检验——`POST /ai-query/ask`（恒 200，@HttpCode 显式）→ 结构化 FactCard（指标/行表/时间口径/来源引用/完整性）＋口径注记（doneQty「口径暂按派工侧终态呈现，对账阶段校正」verbatim）＋网页「AI 问数」页五态分立渲染（answer/clarify/denied/unsupported/unavailable）＋详情跳转（前端路由表：`/workorders?wo=`、`/listings/gap-checks?wo=`、`/inspections`，按会话权限码门禁）。
2. **非答案终态分别可见**：歧义澄清（编号多匹配候选/时间窗四选项，selectedOptionId 回放续走）；缺域码 denied（200 回答通道明示 missingPermissions，逐码 casbin 复核非 403）；不支持（能力提示）；数据未就绪（无齐套核对记录→unavailable，不当零缺口）。
3. **组合与部署面**：MODULE_DEFINITIONS['ai-query']（opt-in，缺省六模块不动）；AiQueryErrorFilter（ai_query.invalid_input/not_found/conflict）；deploy/README 全量清单补行；compose 缺省不动。

## 实施者登记（据实——子代理独立会话身份，非主控）

| 波次 | 实施 | 代理 | 模型 | 子代理会话 |
| --- | --- | --- | --- | --- |
| WP-A application 模块（含一次返工：ask 补 @HttpCode(200)） | 三域能力＋意图路由＋会话＋输入解析＋35 测试 | code-writer-pro | GLM-5.3 | agent_56c50189-11f8-4657-8dee-cdd5e9e409be |
| WP-B server 组合（含一次返工：e2e 断言收紧） | 注册表行＋过滤器＋boot e2e 11 项＋deploy 清单＋permissionResolver 真实 casbin 接线 | code-writer-pro | GLM-5.3 | agent_d2a98a37-3137-4fc1-bb60-d10b23c0b830 |
| WP-C web | 问数页五态＋菜单/i18n/assembly＋api 封装＋硬断言同步 | code-writer-pro | GLM-5.3 | agent_61472112-07b8-45ca-b2b4-69af68a25335 |

披露：WP-A 派发早期两次遭账户 1302 限流中断，现场留下同任务在途半成品（未跟踪文件）；接管 writer 逐文件对照合同审校定稿、仅实质修复测试类型断言——属同一 WP-A 尝试的接管续作，未引入第二 writer。

## 证据

- application：`pnpm --filter @smes/application build && typecheck && test` → 48 文件/729 测试全过（含 tests/ai-query 35 项）；根 `pnpm boundary` → 1523 模块 5255 依赖零违规。
- server：`pnpm --filter @smes/server build && typecheck && test` → 26 文件/247 测试全过（含 ai-query-boot.e2e 11 项：401/403/200 三叉、/modules 清单、happy×2、双澄清回放、denied 双码、400/404 错误映射、跨用户会话 404）。
- web：`pnpm --filter @smes/web typecheck && test` → 236 过/14 跳过；`build` → ✓ 1.65s；三硬断言（menu/i18n/module-pages）同步实测绿。
- e2e ask 状态码断言收紧为严格 200（返工后）。
- 全仓 `pnpm verify`：**exit 0（2026-10-28 11:57，总控亲跑；build→typecheck→boundary→boundary:selftest→test 全链）**——尾部证据：application 729 / server 247（含 ai-query e2e 11）/ business-store 221 / testkit 77 / web 236+14skip。

## 总控裁定记录

1. 错误码前缀 `ai_query.*`（下划线）——沿仓内错误码正则不变量（既有 metric_pack/column_preference 先例），合同原文连字符按 URL 前缀惯用语理解；已回写合同。
2. ask 恒 200（含非答案态）；denied/unsupported/unavailable 携带 sessionId 超集字段——已回写合同。
3. permissionResolver 取「每次判定新起 PermissionService 读共享 store 快照」——依合同「服务端每次查询重新验证」＋ D-1 教训（第二常驻 enforcer 缓存会与写面分叉）。

## 已知边界与后续事项（不在本波）

- DSH 真实运行服务接入（版本固定＋Profile＋模型凭据 Owner 具名后开波；届时 IntentRouter 换 DSH 编排，能力合同不变）；企微/飞书真实双向（验签/解密/票据补齐）；群披露目的地规则；按租户模型预算/并发限额；审计用量记账细化；per-tenant 模块授权裁决点。
- v1 无 totalKnown:false 运行时触发点（内存全量 list 总量恒已知，守恒约束）；中文数字时间词（「最近七天」）不解析、回落时间澄清。
- e2e 环境进度上卷为 EMPTY_PROGRESS_PORT（真实进度链需 workorder+dispatch 齐装，属全装形态）；PG 形态判定链同构未起真实 PG（零 DB 合同先例）。
- 共享 policyStore 裁决连带语义：零 DB 形态下 workorder 多级链审批人目录从恒空变为可解析（语义更真，全套件绿）。
- web 无浏览器级渲染走查（五态真实观感属 reviewer/后续 e2e 波次验收面）；en 侧页面文案未接 namespace（菜单标题已双语）；deploy/README 既有缺项（column-preferences/screen）非本波引入未代修。
- M2-R1 在途脏改全程未触碰；本波全部未 commit/push（待 Owner）。

## 验收（code-reviewer · GLM-5.3 · 12:03 亲跑核验）

**ACCEPT——零返工项**。验收者：agent_8f64c2a4-820c-46bd-9682-d999deca9b2b（同族声明：GLM-5.3 出具，合同未要求跨家族独立验收）。

- 六裁决面全过：Wire 符合性（四路由/五态/FactCard 逐字段/恒 200/跨用户 404）；安全红线（permissionResolver 真实 casbin fail-closed、denied 先于澄清不泄漏交互面、无业务写路径、无敏感域条目）；完整性纪律（口径 verbatim、unavailable≠零缺口两分支分钉、截断如实、summary 纯事实模板）；测试真实性（三包亲跑 729/247/236 全绿，e2e 真实起服＋逐码授予非 admin bypass）；边界纪律（boundary 亲跑 0 违规 1529 模块、diff 纯增量 M2-R1 hunks 完好、HEAD 仍 061db58 无 commit）；无假文案无静默吞错。
- **低危观察（登记不返工）**：意图路由为合同规则超集——仅领域词（无工作令标识）也进 workorder-progress，空 token 回落全量候选→clarify/单候选直答/零候选「查询有效、无记录」，良性且有单测钉住（rule-intent-router.ts:53-67）。
- 未验证边界（如实）：浏览器级渲染观感未走查（后续浏览器 e2e 波次）；他人 hunks 作者归属只能按内容标注判断；跨租户对抗未起真实 PG+RLS（沿零 DB 合同先例，跨租户 session 404 单测锁定）；admin bypass e2e 未单独走（逐码授予路径已更强实证）。
