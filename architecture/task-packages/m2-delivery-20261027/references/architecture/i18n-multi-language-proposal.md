# i18n 多语言方案 proposal（调研定稿版）

版本：v1.0（2026-10-27）｜编写者：调研子代理 code-writer-pro（GLM-5.3，总控派发，零代码纯文档）｜状态：**proposal——待 Owner 裁定后排期；裁定通过后按惯例立 ADR-0012 承接架构决定部分**
写入面：本文件（零代码）｜落位依据：architecture/ 根级工作文档先例（ROLE-PACKS.md / DECISIONS-QUEUE.md 同体例）；`decisions/` 仅收 accepted 状态 ADR，本方案未裁定前不入
验证：2026-10-27 续跑轮对全部载荷证据做了回读抽查（错误过滤器响应形态、dispatch 待办 title 模板、ApiErrorHint 拼接、NotificationsPage:97 直显、seed-factory 中文名、menu_configs 表、UserRecord 无 locale 列、e2e 中文断言:148、三处 html lang、vite 双入口+manifest lang:186、dep-cruiser 三规则行号、ROLE-PACKS:8 权限码 115、126 文件/628 行等量级统计）——全部与真实代码吻合；application 层中文 throw 复算 443 处（不同 grep 口径 ±3%，量级结论不变）

---

## 0. 结论摘要（一段话）

前端推荐 **react-i18next**（零编译步骤、namespace 与模块化装配同构、双入口 MPA 各自初始化互不拖累、资源可进 PWA precache）；后端推荐 **错误响应增加语义化 code 字段 + 前端按 code 映射文案**（组合根已有 25+ 异常过滤器按异常类型分类，只差 code 字段；后端无任何 locale 基础设施）；落库显示名**不需要 name/display 分离或复制表**——用户自建主数据名是客户语言输入的业务数据（业界不翻译），真正的风险点是**系统生成文案落库**（通知/待办 title、状态 label），策略是存储 key 化 + 渲染时翻译 + 存量回落原文。语言范围 zh-CN 完整 + en-US 骨架（M2 客户语言未知，ROADMAP 实证 M3 才点向首个客户）。分三波实施，波 1（基础设施+登录面）建议随 M2 收口前完成，波 2/3 待 Owner 裁定。

**一项对任务预设的关键澄清**：派发背景所述"体系化错误码（ROLE-PACKS 七岗 50+ 码 + M2 安全批新增码）"经查证为**权限码**（`@RequirePermission` 字面码，全仓 115 个，ROLE-PACKS.md:8），不是错误码。**仓内不存在错误码体系**：错误响应是 `{ statusCode, message }`，message 为业务包抛出的中文原文（见 §2）。因此不存在"错误码-文案映射归属"问题——它是要新建的东西，归属建议见 §4。

---

## 1. 现状盘点（全部带代码证据）

### 1.1 前端文案分布与量级

规模量级（grep CJK 字符，非注释行 = 排除 `//`、`*`、`/*` 行首）：

| 位置 | 含中文总行 | 非注释行（≈文案+字符串） | 说明 |
|---|---|---|---|
| apps/web/src（126 文件） | 3,160 | 1,932 | 其中 pages/ 占 1,694 |
| packages/product-ui/src（21 文件） | 628 | 约 60 | 绝大多数是注释；非注释中文主要是防御性解析错误的 what 参数（如 `masterdata.ts:69` `'物品对象'`）与 mock 身份 displayName（`session.ts:34` `'演示管理员'`） |
| packages/application/src | — | 1,925 | 错误消息 456 处 `throw new ...Error(中文)`、通知/待办 title、状态 label |
| apps/server/src | — | 131 | IM 卡片字段名、图纸发布 title、日志 |
| 专业包（drawing/metric-pack/payroll/maintenance） | — | 252 | 同类 |

前端文案形态（改造成本从低到高）：

1. **JSX 内联文本**：页面主体。例 `apps/web/src/pages/workorder/WorkOrdersPage.tsx:110`（CardTitle「工作令列表」）、`:112`（CardDescription 整句）。
2. **列定义常量**：`LIST_COLUMNS` 的 label（`WorkOrdersPage.tsx:47-55`，'项目名'/'状态' 等）——每页一份。
3. **菜单/路由标题**：静态树 `apps/web/src/menu.ts`（465 行，`menuConfig: { title: '运营总览', ... }` 约 48 条目）与移动页注册 `apps/web/src/mobile.ts:62-108`（15 页 title）。运行时与落库 menu-config 配置集叠加合并（`apps/web/src/shell/useMenuConfig.ts`，fail-open 回落静态树）——**菜单 title 有两处来源**（静态硬编码 + `menu_configs` 表 `nodes` Json，`schema.prisma:2397-2408`）。
4. **统一提示组件固定文案**：`ApiErrorHint.tsx`（403 前缀句+拼后端 message）、`ModuleTable.tsx:128`（'请求失败：'+message）、`:141-146`（CommandOutcomeHint '命令未生效'+reason）、`:109`（QueryState `empty = '暂无数据'` 默认值——组件 props 默认值形态）。**后端 message/reason 被直接拼进用户可见文案**，是前后端文案耦合的核心点。
5. **表单校验消息**：**前端无客户端校验文案**——表单校验全靠后端 400 message 回显（WorkOrdersPage 建令表单纯 submit，无本地校验）。
6. **日期/数字格式化**：全仓无 date-fns/dayjs/Intl.NumberFormat 依赖（package.json 实证）；仅大屏页两处 `toLocaleString('zh-CN')`（`DigitalOperationScreenPage.tsx:120,783`）与扫码/报工页 `toLocaleTimeString()` 无参调用（`ScanPage.tsx:184`、`ReportPage.tsx:411`）。金额全程分（minor）整数，未见 ¥ 格式化。**格式化面几乎为零，i18n 格式化负担极小**。
7. **静态资源**：三处 `<html lang="zh-CN">`（index.html:2 / login.html:3 / public/offline.html:2）、html title 中文（login/offline）、PWA manifest `lang: 'zh-CN'`（vite.config.ts:186）。
8. **登录 bundle**：独立入口（login.html → login/main.tsx 14 行 → LoginPage.tsx 112 行），文案少量（演示账号脚注、'登录失败，请稍后重试' 兜底 `LoginPage.tsx:53`）。

**前端目前无任何 i18n 库**（apps/web 与 product-ui 的 package.json 无 i18next/intl/lingui；源码 grep 零命中）。

### 1.2 后端消息与错误响应形态

- **响应结构**：全部异常过滤器统一输出 `{ statusCode, message }`，message 取异常原文（中文）。例：`apps/server/src/domain-error.filter.ts:52-55`、`workorder-error.filter.ts:52-56`、`auth-error.filter.ts:50-53`（同款 25+ 个 `*-error.filter.ts`，apps/server/src 目录实证）。**无 code 字段**。
- **中文 message 的源头在业务包**：packages/application 456 处 `throw new XxxError(中文)`（如 `reporting-input.ts:35` `` `${what}必须是对象` ``、`in-memory-reporting-stores.ts:92` `` `报工单 '${id}' 已存在` ``）。命令信封 rejected 的 `reason` 同为中文（`reporting.service.ts:572`），经 CommandOutcomeHint 直显。
- **测试钉死中文**：server e2e 7 处断言中文 message（如 `auth-rate-limit.e2e.test.ts:148` `toBe('用户名或口令不正确')`、`:154`）；packages 测试 458 处中文断言；apps/web 测试 70 处中文文案断言。**文案语义变更必然大面积触碰测试**。
- **locale 基础设施：零**。全后端无 Accept-Language 处理、无 locale 中间件/上下文（grep 实证；唯一 `localeCompare` 命中是字符串排序）。
- **IM/通知/审批推送文案生成位置**：
  - 待办/通知 title：**application 层服务内拼中文模板**（`dispatch.service.ts:527` `` `派工待办：${...}` ``、`workorder.service.ts:530/713/828`、`listing.service.ts:985/1632`、`inspection.service.ts:1482`、`baseline.service.ts:743`），随 TodoStore/NotificationStore 创建**落库**，前端直显 `row.title`（`NotificationsPage.tsx:97`）。
  - IM 卡片字段名：组合根 wiring 生成（`cross-module-wiring.ts:1270-1273` '正文'/'租户'/'业务类型'/'业务单据'）；integration-im 适配器常量（`feishu.ts:23` / `wecom.ts:24` `'详情'` 按钮）。
  - 图纸发布通知：组合根（`cross-module-wiring.ts:1368` 中文 title 模板）。
  - 后端下发的展示 label：报工状态 label 数组（`reporting-config.ts:71` `['待报','已报','已核查','已撤销']`）、成本分解 label（`project-cost.service.ts:803-808` '材料成本' 等）——**后端生成 UI 文案**的实证。

### 1.3 落库显示名（关键决策点实证）

分三类，结论不同：

**a) schema 层：干净。** schema.prisma 的 579 处中文全部是 `///` 文档注释；无 Prisma enum、无中文默认值、无字典表内置中文行（grep 实证）。

**b) 用户自建主数据：中文 name 落库，但属业务数据。** 物品/工序/仓库/库位/客户/供应商/角色等的 name 是用户（或种子）录入的（schema `name String` 常规列；`org-input.ts:97` 角色名用户提交）。种子证据：`seed-factory.mjs` 93 行非注释中文（`:129-131` 清单类型名、`:170-175` displayName '工厂演示·计划'、`:268-289` 客户/供应商/物品 name+unit+category、`:297-335` 工序名/工艺路线、`:350-395` 仓库/货架/库位名、`:788` projectName）。角色名本身是英文形状（`plan-role` 等，ROLE-PACKS.md:27-28 有"英文角色名为别名口径"登记）。
**判断**：这类名称是"客户用什么语言录入就显示什么语言"的业务数据，多语言系统不翻译用户数据（业界惯例）。**不需要 name/display 分离，不需要复制表**。演示种子若要 en 环境演示，另出 en 版种子脚本即可（开通面决策）。

**c) 系统生成文案落库：真正的问题面。** 通知/待办 title（§1.2 所列 10+ 处中文模板）与 menu-config 配置集 `nodes` 内 title 落库后直显；`users.displayName` 种子值为中文但属 b 类口径。这一类**必须 key 化**才能多语言（见 §5）。

### 1.4 依赖规则对方案的约束（dep-cruiser 实态）

- `ui-tier-edges`：product-ui 只能依赖 business-core / application（.dep-cruiser.cjs:36-37）——若翻译运行时放 product-ui 需评估规则面，但**实际不需要**（见 §3）。
- `web-via-ui`：apps/web 消费 product-ui + integration-*（:71-72）。翻译资源放 apps/web 侧零规则改动。
- `apps-compose-only`：server 不得触达前端视图层（:64-65）——与"错误码下发、前端映射"策略自洽（后端不出文案资源）。

---

## 2. 技术选型：推荐 react-i18next

| 维度 | react-i18next（**推荐**） | react-intl (FormatJS) | lingui |
|---|---|---|---|
| 接入方式 | 运行时 JSON 资源，零编译步骤 | 运行时 + 提取工具链 | 编译期提取（vite plugin + cli），多一步构建 |
| Vite MPA 双入口 | 每入口独立 `initReactI18next` 实例，共享资源模块；login bundle 只引需要 namespace | intl 实例 hoisting 在多入口/懒加载下管理繁琐 | 双入口各自配置 babel/vite 插件，配置面重 |
| namespace/按需加载 | 原生 namespace + 懒加载，与 ADR-0004 模块边界（菜单/权限码同构）天然对齐 | messages 打平管理，大应用拆分弱 | message catalogs 按文件拆，粒度可但依赖编译步骤 |
| refine 无头模式 | 不绑路由/数据层生命周期，独立 hook；refine 亦有 i18nProvider 可后续接 | 同样可独立 | 同样可独立 |
| PWA 离线 | 资源是静态 JSON：当前语言并入 workbox precache（vite.config.ts:166 起已有 precache 定制点）或随 bundle 打包，离线可用 | 同样可 precache | 编译产物同样可 precache |
| ICU 复数/性别 | 不内置（需配 intl-messageformat；本仓无复数刚需） | 一等公民 | 一等公民 |
| 维护/生态/迁移风险 | 社区最大、TS 类型方案成熟 | FormatJS 生态稳定但 API 偏旧 | 社区较小，工具链锁死 |

**推荐 react-i18next 的决定性理由（贴仓内实况）**：
1. **零编译步骤**——本仓文案是"中文原文已存在"的存量抽取（1,932 非注释行），不是从代码提取消息的新写作流；i18next 的"JSON 即资源"对存量迁移最直接，lingui 的编译提取对存量巨石迁移反而添工具链风险。
2. **双入口各自初始化**与 login bundle 最小化前提（LoginPage 头注"不加载 refine/router"）兼容：登录入口 init 只挂 `login` + `common` namespace。
3. **namespace 按模块拆分**与 MODULES_ENABLED 装配、菜单模块边界同构；页面懒加载时可并发拉语言包。
4. 无 ICU 刚需（中文/英文皆无复数屈折；数量文案可用插值）。

---

## 3. 资源组织与 key 命名

**放哪**：`apps/web/src/i18n/`（资源 JSON + init 模块）。理由：用户可见文案的实际分布证据——product-ui 非注释中文约 60 行且全部是开发者面向的防御错误/mock 数据（§1.1），**product-ui 不引入 i18n 运行时**（保持纯视图模型零 UI 依赖，ui-tier-edges 规则不动）；"web 与 product-ui 共享"的实际需求不存在翻译面。若未来 product-ui 出现用户可见文案，经 web 装配层传 key 映射（同菜单 title 形状由 web 侧填的现行体例）。

**结构**：

```
apps/web/src/i18n/
  index.ts          # initI18n(namespaces) —— 双入口共用（login 只传 login+common）
  locales/zh-CN/    # 源语言（zh-CN 为权威源，en-US 为骨架，缺 key 回落）
    common.json     # 动作（提交/保存/取消）、状态词、空态、错误兜底
    login.json
    menu.json       # 静态菜单树 title（menu.ts / mobile.ts 迁入）
    workorder.json  # 每模块一 namespace（与菜单 code 同名）
    dispatch.json …
  locales/en-US/    # 同 key 骨架
```

**key 约定**：`<namespace>:<域内路径>.<语义>`，全小写 kebab/dot。例：`workorder:list.title`、`workorder:list.col.projectName`、`common:action.submit`、`common:state.not_started`（九态等 enum 显示名集中 common 或各域 namespace 的 `state.*`）。**禁止把中文原文当 key**（回落机制依赖 key 稳定）。

**回落链**：`en-US 缺 key → zh-CN → key 本身`（dev 可开 console 警告）。

---

## 4. 后端策略：错误响应加语义化 code，前端映射文案（推荐）

**推荐：错误码语义化下发 + 前端翻译**，而非后端按 Accept-Language 出多语言。理由（全部基于实态）：

1. **分类结构已在**：组合根 25+ 过滤器已按异常类型分流 HTTP status（`@Catch` 按类型命中）——加 code 只是在 `response.json({ statusCode, message })` 处增补 `code: 'workorder.state_conflict'` 一类的字段，装配纪律（域错误类在 application、映射在组合根）不变。
2. **前端消费点已收敛**：后端 message 只经 ApiErrorHint / ModuleTable:128 / CommandOutcomeHint 三个提示组件出口（§1.1.4），映射层落点现成：`code → t()`，未知 code 回落原 message。
3. **后端出多语言的成本结构更差**：application 层 456 处中文 throw 要么后端维护双语文案表，要么 locale 上下文穿透所有不进 Nest 容器的业务包（AsyncLocalStorage 之外无干净通道）；且落库通知 title 仍翻译不了（生成时无读者语言）。错误码方案把"翻译"留在唯一有语言上下文的地方（渲染端）。
4. **测试迁移友好**：message 原文保留不动（zh 语义与断言不变），code 是增量字段——458+7 处中文断言零触碰。

**改造形态**（示意，非实施）：

```jsonc
// 现在：{ "statusCode": 409, "message": "报工单 'r-1' 已存在" }
// 之后：{ "statusCode": 409, "code": "report.conflict.duplicate", "message": "报工单 'r-1' 已存在" }
```

code 携带插值参数的做法（`{ "code": ..., "params": {...} }`）列为实施期裁量：骨架期可只对**新写/高频错误**带 code，存量未知 code 走 message 回落——渐进式，不炸存量。

**命令信封 rejected.reason** 同策略：reason 保留中文原文，`CommandOutcomeHint` 按 outcome 增设的结构化 code 映射，缺 code 回落 reason 文本。

---

## 5. 落库显示名处理策略（最大风险点，单独成节）

按 §1.3 三分类：

| 类别 | 实证 | 策略 |
|---|---|---|
| a. schema 字典/enum | 无此问题（schema 零中文字面值、无 enum） | 无需动作 |
| b. 用户自建主数据名 | 物品/工序/仓库/客户/供应商/角色 name；seed-factory 93 行 | **不翻译、不分列、不复制表**。多语言只覆盖"系统 chrome 文案"；用户数据按录入语言显示（业界惯例）。演示环境如需 en 演示，另跑 en 版种子（开通面，不进 i18n 主线） |
| c. 系统生成文案落库 | 通知/待办 title 10+ 处中文模板（§1.2）；menu-config `nodes` Json 内 title；reporting 状态 label / costing label 后端生成 | **存储 key 化 + 渲染时翻译 + 存量回落原文** |

**c 类具体方案**：
- 通知/待办：title 生成点（application 层服务）改为落 `titleCode` + `titleParams`（如 `code='notify.dispatch.assigned', params={title, qty}`），`title` 文本列保留为 zh-CN 冗余（回落+兼容旧读端）；前端 NotificationsPage/工作台渲染时 `t(code, params)`，无 code 的存量行回落 title 原文。**不改表结构亦可先做前端回落**（title 直显原文），表结构增列归波 3。
- menu-config 配置集：配置面（管理员）录入的 title 属 b 类口径（管理员语言），**默认不翻译、原样显示**；静态树 title 迁 `menu.json`。若未来要"配置集多语言"，为 nodes 节点增设 i18nKey 可选字段——列为后续项，本期不做。
- 后端生成的展示 label（reporting-config.ts:71、project-cost.service.ts:803-808）：改为下发 enum/key，label 映射移到前端 namespace——属波 3 长尾。

**明确否决的方案**：name/display_name 双列分离（波及全部主数据表+全部读写链，收益仅覆盖 b 类，而 b 类本不该翻译）；按语言复制字典表（同上更重）。

---

## 6. 语言范围建议：zh-CN 完整 + en-US 骨架（建议成立）

- ROADMAP 实证：M2 售卖就绪目标是"可交给客户环境跑起来"，**M3 才由 Owner 点向首个客户**（ROADMAP.md M2/M3 节）——当前目标客户语言未知，做第二语言全量翻译没有已知读者。
- 仓内零第二语言痕迹（无 i18n 库、无 locale、manifest lang 固定 zh-CN）——不存在"已承诺英文"的既成事实。
- 建议：**zh-CN 为权威源语言（key 抽取自现有文案，语义零变化）；en-US 做骨架**——覆盖 `common`/`login`/`menu` + 高频模块 namespace 的主要 key，其余缺 key 回落 zh-CN。i18n 真正的交付价值是**基础设施就位**：M3 点向客户后，目标语言（可能既非 en 也非 zh）变成"填一份资源 JSON"而不是架构改造。
- 不建议 en 全量：1,932 非注释行的机加域术语翻译质量在无读者验收下不可控，且会拖 M2 判据（安全批+交付物+一键起栈，ROADMAP M2 节）。

---

## 7. 语言切换与持久化

- **持久化：localStorage**（先做）。先例：token 会话即 localStorage（`apiClient.ts:23` `createBrowserTokenSessionStore(window.localStorage)`）。key 建议 `smes.locale`，缺省 `zh-CN`。同步三件事：`<html lang>`（三处 html 现值 zh-CN）、i18next 语言、（波 3）PWA manifest 描述性文案按语言选择。
- **登录 bundle 独立入口**：login.html 是独立 Vite 入口（vite.config.ts `rollupOptions.input` 双入口），有自己的 main.tsx——登录页**自带语言切换**（登录前无会话，localStorage 是唯一跨入口共享点；同 origin 双入口天然共享 localStorage，整页跳转主壳后语言延续）。两入口共用 `i18n/index.ts` 的 init 模块，login 只挂 `login`+`common` namespace，不破坏"登录 bundle 不加载主应用"前提（LoginPage 头注）。
- **用户级偏好字段（users 表加 locale 列）：不做（本期）**。理由：users 表现无 locale 列（schema.prisma:107-117 实证），加列涉及 schema 迁移 + 登录响应 + 双端穿透，而 M2 阶段无跨设备语言漫游的已知需求；localStorage 满足单设备切换。列为 M3 后续项（点向客户后按需）。
- **服务端不感知 locale**：与 §4 错误码策略自洽——不引入 Accept-Language 解析。

---

## 8. 实施波次（对齐 M2 节奏；波 2/3 排期待 Owner 裁定）

| 波 | 范围 | 可观察完成判据 | 量级 |
|---|---|---|---|
| **波 1：基础设施 + 登录面 + 壳** | i18next 接入双入口（共享 init 模块）；`common`/`login`/`menu` namespace 建 zh-CN 权威源；登录页、ShellLayout 顶栏（含语言切换器）、静态菜单树（menu.ts/mobile.ts title 迁 key）、QueryState/ApiErrorHint/CommandOutcomeHint 固定文案接 t()；localStorage 持久化 + html lang 同步 | ①登录页与主壳侧栏在 zh/en 切换后文案正确且刷新保持；②login bundle 体积不因 i18n 显著增长（无主壳 namespace）；③现有全部测试零回归（zh 语义与断言不变）；④menu.test 等断言中文的测试仍绿 | **M** |
| **波 2：主壳高频面 + 错误链路 code 化** | 高频模块 namespace（workorder/dispatch/inspection/inventory/reporting 的列表+表单+详情）；后端异常过滤器响应体统一增 code 字段（新建/改写错误先带码，存量渐近）；前端 ApiError 按 code 映射+未知回落 message | ①高频页 en 骨架走查：系统 chrome 文案无中文残留（用户数据除外）；②e2e 断言 message 原文的用例零改动仍绿；③带 code 的错误在 en 下显示英文文案、无 code 回落中文原文 | **L** |
| **波 3：长尾 + 落库文案 key 化** | 剩余页面 namespace 补齐；通知/待办 titleCode 化（表增列+application 层模板改写+前端渲染）；reporting/costing label 前端化；offline.html/manifest 描述；en 版演示种子（如裁定需要） | ①新建通知在 en 下渲染英文 title、存量行回落原文中文不乱码；②全路由 en 走查系统文案面无中文残留；③zh-CN 全量回归绿 | **L** |

依赖关系：波 1 → 波 2 → 波 3 串行（同一 writer 面：i18n 资源与提示组件）。波 1 可与 M2 安全批并行（互不触碰）；波 2/3 建议在 M2 交付物（用户手册按 zh 撰写）收口后再排，或依 Owner 对首个客户语言的判断提前。

---

## 9. 风险清单

| # | 风险 | 证据 | 缓解 |
|---|---|---|---|
| R1 | 测试钉死中文文案（packages 458 / web 70 / server e2e 7 处） | §1.2 | zh-CN 语义零变化原则：抽取 key 不改原文；测试断言不动；i18n 改造以渲染层过 t() 为主 |
| R2 | 落库通知 title 存量行无法翻译 | NotificationsPage.tsx:97 直显 | title 文本列保留为回落；新行才带 code |
| R3 | 双入口重复维护资源 | vite.config.ts 双入口 | 共享 `i18n/index.ts` + 资源模块，login 限 namespace 子集 |
| R4 | en 骨架翻译质量（机加域术语） | 无读者验收 | 骨架范围收缩到 common/login/menu+高频页；专业术语表随波 2 产出 |
| R5 | menu-config 落库配置集 title 为管理员录入中文 | §5 | 定性 b 类不翻译（原样显示）；文档明示 |
| R6 | bundle 体积增长 | — | namespace 懒加载随页面分包；zh/en 同 namespace 只加载当前语言 |
| R7 | grokbot/e2e 剧本按中文界面走 | ROLE-PACKS 剧本按中文页面编写 | 缺省语言保持 zh-CN 不变，语言切换为显式动作 |
| R8 | 后端 code 化渐近期"未知 code 回落中文"造成 en 界面中英混排 | §4 | 接受为骨架期已知形态；走查判据按"chrome 文案面"而非绝对零中文 |

## 10. 不做清单（本期明确不做）

- RTL（目标语言 zh/en 均LTR；出现阿语/希伯来语客户再立项）
- 时区切换（全链 ISO 8601 Timestamptz，显示层只做格式化，不做用户时区偏好）
- 后端按 Accept-Language 输出多语言 message（§4 已定方向：错误码+前端映射）
- 用户主数据名称的翻译/name-display 分离/按语言复制表（§5 已否决）
- 货币多币种与汇率（金额 minor 整数口径不动）
- 多语言 URL 路由（/en/ 前缀、SEO hreflang）——内部 MES 无 SEO 需求
- 翻译管理平台（TMS/Crowdin 等）接入与语言包热更新服务
- users 表 locale 列与跨设备语言漫游（M3 后按需）
- IM 通道（飞书/企微）推送卡片的多语言（卡片文案随租户 IM 生态语言，单一 zh 通道在用；integration-im 适配器常量不动）

---

## 附录：核心证据索引

| 断言 | 证据 |
|---|---|
| 前端零 i18n 库、文案量级 | apps/web/package.json；grep 统计 §1.1 表 |
| 菜单静态树中文 title | apps/web/src/menu.ts:28 起（约 48 条目）；apps/web/src/mobile.ts:62-108 |
| 菜单双层来源（静态+落库） | apps/web/src/shell/useMenuConfig.ts；schema.prisma:2397-2408（menu_configs） |
| 错误响应 { statusCode, message } 中文直下 | apps/server/src/domain-error.filter.ts:52-55（同款 25+ 过滤器） |
| 业务包中文 throw 规模 | packages/application/src 456 处（grep 计数） |
| e2e 钉死中文 message | apps/server/tests/auth-rate-limit.e2e.test.ts:148,154；全 server 7 处、packages 458 处 |
| 后端 message 拼进前端提示 | apps/web/src/components/ApiErrorHint.tsx:14-17；ModuleTable.tsx:127-129,144-146 |
| 无 Accept-Language/locale | apps/server + packages 全量 grep 零命中 |
| 通知 title 中文模板落库+直显 | dispatch.service.ts:527；workorder.service.ts:530,713,828；listing.service.ts:985,1632；NotificationsPage.tsx:97 |
| schema 零中文字面值/无 enum | packages/business-store/prisma/schema.prisma（中文全为 /// 注释） |
| 种子落库中文 93 行 | packages/business-store/prisma/seed-factory.mjs:129-395,788 |
| users 表无 locale 列 | schema.prisma:107-117 |
| 双入口 MPA + PWA | apps/web/vite.config.ts（appType 'mpa'、rollupOptions.input、VitePWA manifest lang:186） |
| html lang=zh-CN 三处 | index.html:2 / login.html:3 / public/offline.html:2 |
| 日期格式化仅大屏两处 zh-CN | DigitalOperationScreenPage.tsx:120,783 |
| 依赖规则约束 | .dep-cruiser.cjs:36-37（ui-tier-edges）,64-65（apps-compose-only）,71-72（web-via-ui） |
| ROLE-PACKS 码=权限码 115 个 | architecture/ROLE-PACKS.md:8 |
| 落位惯例 | architecture/README.md（decisions=ADR accepted 体例）；根级工作文档先例 ROLE-PACKS.md / DECISIONS-QUEUE.md |
