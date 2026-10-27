# Cadence 标准角色包与岗位交接剧本（ROLE-PACKS）

版本：v1.0（2026-10-27）｜编写者：code-writer-pro（GLM-5.3，agentId 见交付回传）｜写入面：本文件（零代码）
用途：**grokbot 多角色测试**（七岗位账号按图索骥走查菜单与按钮）与**产品开通**（新租户/新客户按岗位包配权）双用。

## 0. 证据基线与使用口径

- **权限码实态**：全仓 `@RequirePermission('...')` 字面码 **115 个**（apps/server + packages 全量 grep，2026-10-27），另有前端专属菜单门控码 `scan:read`（product-ui `scan.ts:23`，后端无同码端点）。权限判定三级：精确码授权 → 角色投影 → admin 全量放行（PRD 10 §2.1 / RREQ-SYS-013）；**菜单可见性 = 接口可达性**（桌面菜单码与后端权限码同源，`apps/web/src/menu.ts` 头注）。
- **页面实态**：桌面菜单树 `apps/web/src/menu.ts`（48 路由条目，含 2 条 hideInMenu——会话审计与通知中心走顶栏入口；权限码全部取后端控制器实态 `:read` 码）；移动页注册 `apps/web/src/mobile.ts`（15 页，4 底部标签 + 11 子页）。本文件所有页面路径、按钮名均取自对应 Page 组件源码，无虚构。
- **PRD 口径**：01-总纲 §3 角色模型、§4 业务主流程链；分册 10/13/14/15/16/17/18 各 §2「角色与场景」节。
- **源文档部门语义**（对照源，词汇不进我方正文）：岗位按部门取义——操作工属生产现场（源派工模块「操作工」多选字段）、销售人员属销售口径、收货/仓管属仓储口径、审批人属管理口径；我方以权限码分权承载同等语义。
- **demo 先例**：product-ui `session.ts` 四演示身份（admin=全量 bypass、org-admin=15 精确码、operator=车间岗读码+现场写码、lead=核查/审批/判定/收发存全径单班长）。七岗位包是该口径的岗位化展开。
- **开通路径**（产品开通用）：管理员在「系统管理 → 角色与授权」页（`/system/roles`，`role:write`）建角色并按码**期望态一次提交**（服务端 diff 自动增授/回收，RREQ-SYS-012），再在「用户与角色」页（`/system/users`，`user:write`）绑定用户（RREQ-SYS-008）。
- **界面级口径**：页内操作按钮实态**不做码级隐藏**（防线在后端 403）；无码角色进入页面时列表可见、提交动作被后端拒绝——测试时以 `CommandOutcomeHint` 错误回显/403 为证据。

## 1. 七岗位标准角色包

**全员基线两码**（七包通用）：`workbench:read`（工作台/总览入口，GET /workbench/*）+ `notification:read`（顶栏铃铛通知中心，GET /notifications、unread-count）——PRD 10 §2.2「全员」行口径。以下各包码数=基线 2 + 岗位专码。

### 1.0 总表

| # | 岗位（建议角色名） | 码数 | 一句话职责 |
|---|---|---|---|
| 1 | 计划（planner） | 13 | 接单建令、展开四类清单、缺口核查利库、齐套刷新、配件申请发起 |
| 2 | 采购（purchaser） | 9 | 从缺口/手工发起采购申请，建单下单跟催，收货退货经办 |
| 3 | 生产（production） | 11 | 六类派工建单与调度，按单报工申报数量工时，执行中转单 |
| 4 | 质检（inspector） | 7 | 四类质检判定/复检/特采让步/判定撤销，不合格处置与闭环 |
| 5 | 仓管（storekeeper） | 17 | 收货入库、发料出库、调拨移库、盘点调账、发货执行、货架维护 |
| 6 | 审批（approver） | 8 | 采购订单审核、配件申请审批（三级链）、审批案件运行时决策 |
| 7 | 只读观察（observer） | 49 | 全业务面只读可见、零写码，全程观察不可操作 |

### 1.1 计划（planner）——13 码

**职责一句话**：从工作令下发起，管清单展开、库存缺口核查利库与齐套，是业务链的发起端与装配发料触发端。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 工作台 `/`、铃铛 | 全员基线 |
| `workorder:read` | 菜单「制造运营 → 工作令」`/workorders`（GET /workorder/work-orders） | 列表/详情/三类进度/齐套看板 |
| `workorder:write` | 创建/修改/挂附件（workorder.controllers.ts:67/85/124） | **建令核心码**；创建即发 WorkOrderCreated 事件联动四清单骨架（RREQ-WO-001） |
| `listing:read` | 菜单「清单」`/listings/sheets` | 四类清单查询 |
| `listing:import` | 清单骨架导入 / Excel 行导入（listing.controllers.ts） | 骨架导入按钮「骨架导入（建四类空清单）」走 importFromWorkOrder；Excel 端口同码 |
| `listing:write` | 行修订（ListingSheetsPage「修订行」按钮） | 图号/数量/需求日期修订与物料候选人工确认（RREQ-LP-006） |
| `gap:read` | 菜单「缺口核查」`/listings/gap-checks` | gap.check 写命令也只设 `gap:read`（读取型核查合同最小集，14 册 §5.9）——**利库核查核心码** |
| `kit:read` | 齐套看板（WorkOrdersPage 内嵌） | 三类清单×库存缺口下钻 |
| `kit:refresh` | 详情「刷新齐套检查」按钮（workorder.controllers.ts:137） | 齐套快照刷新与缺口催办 |
| `item:read` | 「基础数据 → 物品」`/masterdata/items` | 清单行物料三要素核对与候选裁定需物品台账查询 |
| `parts:read`、`parts:request` | 菜单「配件申请」`/workorders/parts` | 项目经理口径兼配件申请发起（13 册 §2「售后/现场、项目经理」）；`parts:request` 同时覆盖「发货（联动出库）」按钮（workorder.controllers.ts:242-243） |

**明确不授予**：`workorder:transition` / `workorder:close`（九态流转与关令是项目经理/管理岗终裁权，13 册 §2——计划只建不管流转）；`drawing:read`（图纸域归工艺/车间，控制菜单组证据面）；`purchase:*`（申请发起后的链路归采购岗）。

**典型日操作清单**：
1. 工作令页：建令（创建工作令表单，项目名必填）→ 查列表选行看详情/进度；
2. 清单页：粘贴工作令 id → 骨架导入/查询清单 → 选中行修订数量与需求日期；
3. 缺口核查页：粘贴工作令 id → 执行缺口核查 → 读最新快照看缺口行；
4. 工作令详情：刷新齐套检查 → 齐套看板看「齐套完成/缺口行」；
5. 配件申请页：新建配件申请（售后/缺料场景）、查申请状态。

### 1.2 采购（purchaser）——9 码

**职责一句话**：把缺口变成订单——申请、建单提交、跟进下发与收货、办理退货。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 基线 | 逾期催货待办经工作台接收（采购逾期→催货待办，14 册 §3.3） |
| `purchase:read` | 菜单「采购管理」组四页（申请/订单/退货/明细） | 查询面 |
| `purchase:request` | 采购申请页「提交采购申请」按钮 | 从缺口或手工发起三类申请（14 册 §2 申购人 3 码之一） |
| `purchase:order` | 订单页「建单并提交」 | 建单提交承接申请 + 下发/逾期扫描 |
| `purchase:receive` | 订单页「收货入库」按钮（行号/数量/收货单号） | 任务口径「采购（申请/订单/收货）」明确含收货；**与仓管岗共码**（仓管收货口径，见 1.5）——PRD 14 收货员为独立角色，两包共享此码属小厂双人经办实态 |
| `purchase:return` | 退货页 `/purchase/returns` | 建退货单/撤销退货 |
| `supplier:read` | 「基础数据 → 供应商」`/masterdata/suppliers` | 建单需供应商引用/名称（订单表单 supplierRef/supplierName） |
| `item:read` | 物品页 | 手工申请需物料 id 查询 |

**明确不授予**：`purchase:approve`（订单审核归审批岗——岗位分权核心证据）；`gap:read`（核查利库归计划，采购从申请单开始）；`supplier:write`（供应商主数据维护归管理员/主数据岗）。

**典型日操作清单**：
1. 采购申请页：状态过滤（draft/approved/converted）→ 手工发起申请（类别/物料/数量）；
2. 采购订单页：状态过滤（五态）→ 建单并提交（供应商/交期必填/行 1 物料数量）→ 下发订单；
3. 已下发订单：收货入库（录行号/数量/收货单号）；
4. 采购明细页按单核对；退货页对已收货订单建退货；
5. 工作台看逾期催货待办。

### 1.3 生产（production）——11 码

**职责一句话**：车间执行端——六类派工建单调度、按单报工申报数量工时、执行中转单换人。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 基线 | assign 产生执行人待办、开工/完工/撤销自动销账（16 册 §2） |
| `dispatch:read` | 菜单「派工」`/dispatches` | 六类列表筛选、按人任务视图 |
| `dispatch:write` | 创建派工单/开工/完工（dispatch.controllers.ts:81/158/171） | 建单（含齐套拦截）、四态操作主干 |
| `dispatch:assign` | 「派工到人」按钮 + **「转单（仅执行中）」按钮**（:145/:197 同码）+ 批量指派 | **任务口径点名码**：转单=executing 换执行人/工序，控制器与 assign 同码——生产岗拿 assign 即覆盖派工到人与转单 |
| `dispatch:cancel` | 「撤销（draft/assigned）」按钮 + 批量取消 | PRD 16 归生产主管；七岗位无独立调度主管，并入生产岗（取舍注明） |
| `report:submit` | 移动报工页 `/m/report`「提交」按钮（POST /reports） | **任务口径点名码**：申报人=命令签发人（RREQ-RQ-004），扫码定位派工单→草稿→提交 |
| `report:read` | 菜单「报工单」`/reports` + 移动 m.mine | 查我的报工与五类列表（桌面无提交表单，申报走移动端） |
| `scan:read` | 菜单「扫码」`/scan` | 前端菜单门控码（product-ui scan.ts）；扫码是报工的数据采集前置 |
| `hours:read` | 「成本与工时 → 工时统计」`/hours/stats` + 移动 m.hours | 工人查本人工时归集 |
| `fault:report` | 移动 m.fault（mobile.ts:121-125） | 现场故障上报动作码；不配 `fault:read` 则桌面「故障上报」页不可见（与 operator demo 先例一致，菜单过滤证据面） |

**明确不授予**：`report:verify` / `report:audit` / `report:revoke`（**任务口径点名反例**：报工核查链归核查员/核查主管，PRD 17 §2——申报与核查分权是工时归集可信的前提）；`inspection:judge`（质检判定归质检岗）；`stock:receive`（入库归仓管）。

**典型日操作清单**：
1. 派工页：创建派工单（选 kind、零件单填图号+工序+数量）→ 列表批操作批量派工下发；
2. 派工单详情与操作：派工到人（执行人 id）→ 开工 → 完工（完工数量）；
3. 执行中换人：详情页填转单新执行人/新工序 →「转单（仅执行中）」；
4. 移动端 /m/report：扫码或输单定位派工单 → 报工草稿（数量/工时分钟）→ 提交（离线自动入本地队列）；
5. 报工单页状态过滤查本人单；工时统计页看本人工时；移动端报故障（m.fault）。

### 1.4 质检（inspector）——7 码

**职责一句话**：四类质检单的判定/复检/特采让步/判定撤销与不合格处置闭环，是放行入库的闸门。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 基线 | 闭环超时点名给判定人推待办+IM（17 册 §2） |
| `inspection:read` | 菜单「质量管理 → 质检队列」`/inspections` | 四类队列/汇总（待检/合格率/未闭环） |
| `inspection:judge` | 「判定」「复检」按钮；**特采让步 POST :id/concession、判定撤销 POST :id/revocation、批量判定、超时点名同码**（inspection.controllers.ts:95/108/131/145/172/186 全挂 judge） | 任务口径「判定/特采/撤销」一码全覆盖——**注意**：concession/revocation 接口在役、桌面页暂未挂按钮（页面实态只有判定/复检/闭环超时点名/建质检单），测试特采/撤销走接口面 |
| `nonconform:read` | 菜单「不合格处置」`/inspections/nonconformities` | 不合格明细查看 |
| `nonconform:dispose` | 「执行处置」按钮（处置方式=返工/让步/报废，原因必填） | 让步=特采的处置面 |
| `nonconform:close` | 「闭环」按钮 | 全部明细闭环联动 |

**明确不授予**：`stock:receive`（放行后的入库执行归仓管——判定与入仓两岗分离，15 册场景 A 两路径）；`report:verify`（报工核查独立于质检判定，班长口径兼，不在本包）；`kit:refresh`（齐套刷新归计划）。

**典型日操作清单**：
1. 质检队列页：看汇总卡（待检/合格率/未闭环）→ 状态过滤选单；
2. 手工建质检单：选类别（四类）、送检数量、来源类型（report 末道报工/dispatch 外协回厂/receipt 采购收货/手工）+ 来源对象 id；
3. 选中单判定：合格数/不合格数 → 「判定」；不合格改判走「复检」；
4. 不合格处置页：选中明细 → 处置方式（返工/让步/报废）+ 原因 → 执行处置 → 闭环；
5. 质检队列页「闭环超时点名（IM 推送）」扫超时单。

### 1.5 仓管（storekeeper）——17 码

**职责一句话**：库存账的执行者——收货/质检放行/完工三类入库、发料与领用出库、调拨移库、盘点调账、发货执行、仓库货架维护。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 基线 | — |
| `warehouse:read` / `warehouse:write` | 菜单「仓储管理 → 仓库与库位」`/inventory/warehouses` | **货架**：建仓配库位、查目录 |
| `stock:read` | 「实时库存」`/inventory/stock` +「收发存操作」`/inventory/stock-operations` + 移动 m.stock | 现存量/库位分布/流水溯源 |
| `stock:receive` | 收发存操作页「入库」表单（来源=完工/质检放行/采购收货）+ 移动 m.receipt | 三类入仓 |
| `stock:issue` | 「出库」表单（目的=生产/配件/手工；预占键可选=直扣或核销）+ 配件发货联动出库 | 领用/发料出仓 |
| `stock:transfer` | 「调拨 / 移库」表单（源/目的仓库库位）+ 移动 m.transfer | 跨仓调拨、换位 |
| `stocktake:read` / `stocktake:record` / `stocktake:approve` | 「库存盘点」`/inventory/stocktakes` + 移动 m.stocktake | 「开盘点单」「录入实盘」（complete 提交差异）「审核调账」（理由必填）；PRD 15 分盘点员/库管主管两角，七岗位单仓管兼（与 demo lead 先例一致——lead 三码全持） |
| `shipping:read` / `shipping:execute` | 「发货任务」`/inventory/shipping-orders` | 「建发货任务并执行」（执行发货出库）+ 详情「确认」（承运/运单号）；确认后 ShippingConfirmed 联动工作令待发货→已发货 |
| `issue:read` / `issue:write` / `issue:revoke` | issue 域**接口面在役、无桌面页**（D-IS-01） | 发料任务查询/确认发料（预占核销）/整单撤销（issue.controllers.ts:66-188）；页面缺口下以实时库存页可用量变化佐证 |
| `purchase:receive` | 采购订单页「收货入库」按钮 | 任务链「仓管收货」口径；与采购岗共码（见 1.2），收货联动入库指令 |

**明确不授予**：`inspection:judge`（判定归质检，仓管只执行放行件入仓）；`stocktake` 之外无盘点独立开单码（开单进盘点归 `stocktake:record`，15 册 §2.1 注记）；`workorder:*`（工作令面只经库存联动，不直接操作）。

**典型日操作清单**：
1. 收发存操作页：入库表单（选来源/物料/仓库/数量；质检放行必填质检单 id、采购收货必填 receiptKey）→「执行入库」；
2. 出库表单（目的/预占键）→「执行出库」；调拨表单（源/目的仓库库位）→「执行调拨」；
3. 采购订单页：对已下发单点「收货入库」；
4. 实时库存页：查现存量/可用量、流水溯源到来源采购单；
5. 盘点页：「开盘点单」（仓库 id）→ 逐物料「录入实盘」→ 提交差异 →「审核调账」；
6. 发货任务页：「执行发货出库」（物料/数量/承运/运单号）→ 详情「确认发货」；
7. 移动端：m.receipt 入库、m.transfer 移库、m.stocktake 盘点、m.stock 查料。

### 1.6 审批（approver）——8 码

**职责一句话**：审批闸门——采购订单审核、配件申请三级审批、通用审批案件决策，经工作台接待办。

| 权限码 | 入口/守卫（实态） | 取舍说明 |
|---|---|---|
| `workbench:read`、`notification:read` | 基线 | 审批待办联动（10 册 §2.2 approver 种子同构：approval:read/write + workbench:read） |
| `approval:read` / `approval:write` | 审批案件 API：GET/POST /approval/cases、:id/decisions（approval.controllers.ts:28-54） | 通用审批运行时（发起/查询/决策）；桌面无独立审批箱页，案件经工作台待办联动 |
| `purchase:read` | 采购订单页可见 | 审批前提是订单列表可见（菜单码=接口码同源） |
| `purchase:approve` | 订单页「审批通过」按钮（决策理由必填） | 订单审核专码（14 册 §2 采购主管） |
| `parts:read` | 配件申请页可见 | 同上 |
| `parts:approve` | 配件申请页「批准」「驳回」按钮 + 移动 m.parts-approval（mobile.ts:107-111） | 配件审批专码；三级链实态：一级=项目经理（manager 回落 salesRep），二/三级=参数角色或签，待审批人实时按角色解析，**配置缺省一级**（18 册增补 #1，43/43 零回归） |

**明确不授予**：`purchase:order`（建单归采购——审批人不建单）；`parts:request`（申请与审批分权，申请人不批自己的单；发货联动出库按钮也归申请方）；`approval-config:read/write`（审批流配置是管理员能力，非审批人日常）。

**典型日操作清单**：
1. 工作台：看待办概览（source 计数）与我的待办（审批类）；
2. 采购订单页：过滤 submitted → 选中 → 填决策理由 → 「审批通过」；
3. 配件申请页：过滤 submitted → 粘贴目标申请 id → 决策理由 → 「批准」/「驳回」；
4. 移动端 m.parts-approval：待审列表逐单决策（同径）。

### 1.7 只读观察（observer）——49 码

**职责一句话**：全业务面只读观察者——所有列表与详情可见、零写码、任何提交动作后端 403。

| 码集 | 构成 | 取舍说明 |
|---|---|---|
| 服务端全部读码 48 个 | 47 个 `:read` 码 + `drawing:audit-read`（grep 实态：`grep -c ':read$'` = 47，另计 audit-read） | 覆盖业务+管理全部查询面：含 payroll/maintenance/metric-pack/drawing/audit/org 等六操作岗不触碰的域 |
| `scan:read` | 扫码页菜单码 | 前端码（后端无同码端点），补齐「全程可见」的页面矩阵 |

**与 PRD 种子 viewer 的关系**：种子 viewer 是零策略「全拒形态」（登录可、业务面全 403，演示权限拒绝证据）；本包取「全读形态」供测试全程观察。两种口径并存：拒绝形态用种子 viewer，观察形态用本包 observer。
**明确不授予**：全部写码/管理码（0 个非读码）——页内操作按钮实态可见但提交即 403（防线在后端门禁，§0 界面级口径）。

**典型日操作清单**：登录 → 左侧菜单全业务组展开（基础数据/制造运营/报工/采购/质量/仓储/成本/报表/图纸/工艺/系统）→ 逐页浏览列表与详情 → 任意页尝试提交 → 预期 CommandOutcomeHint 报错/403。

## 2. 岗位交接剧本（一条业务链的角色接力）

**链路**（PRD 01 §4 主流程链的岗位化走位）：计划建令展开清单 → 计划核查利库 → 采购申请/下单/审核 → 仓管收货 → 质检判定 → 生产派工报工 → 质检末道 → 仓管入库 → 计划发料 → 审批节点（配件三级/订单审核）→ 只读全程可见不可操作。

**前置条件**：
- 七个角色按 §1 开通并各绑一个测试用户（演示口令口径）；
- 主数据就绪：至少一个物品 id、一个仓库 id（或仓管先建仓）、一个供应商引用；
- 建议同时开两个浏览器画像：操作岗 + observer（observer 全程跟看）。

**步骤表**（20 主线步 + 2 增补步；「界面入口」= 菜单路径 `页面路由` + 卡片/按钮名，全部实态取证）：

| 步 | 角色 | 界面入口 | 动作 | 预期结果 | 交接去向 |
|---|---|---|---|---|---|
| 1 | 计划 | 菜单「制造运营 → 工作令」`/workorders` →「创建工作令」卡片 | 填项目名（必填，如 Proj-2026-01）+客户引用/计划交付 → 点「创建工作令」 | 建令成功：状态 not_started@v1，WorkOrderCreated 事件发四类清单骨架提示；列表出现新行 | 计划自接（同岗连续操作） |
| 2 | 计划 | 菜单「清单」`/listings/sheets` | 粘贴工作令 id → 「骨架导入（建四类空清单）」（若骨架未自动生成）→「查询清单」→ 选中行 → 下方表单改数量 → 「修订行」 | 四类清单（part/standard/electrical/equipment）可见；行修订成功，物料校验态按三要素变化重置 | 计划自接 |
| 3 | 计划 | 菜单「缺口核查」`/listings/gap-checks` | 粘贴工作令 id → 「执行缺口核查」→ 「读最新快照」 | 不可变快照追加：缺口行与四类汇总（利库后需求×可用量差额） | 交接采购（缺口行即采购输入） |
| 4 | 采购 | 菜单「采购管理 → 采购申请」`/purchase/requests` →「手工发起采购申请」 | 选申请类别、物料 id、数量（可挂工作令）→ 「提交采购申请」 | 申请单 draft 创建；列表可见 | 采购自接 |
| 5 | 采购 | 菜单「采购订单」`/purchase/orders` →「建单并提交采购订单」 | 填供应商引用/名称、交期（ISO 8601 必填）、行 1 物料+数量 → 「建单并提交」 | 订单 draft→submitted；申请随订单两步推进（审批通过→approved、下发→converted） | **交接审批**（订单进待审） |
| 6 | 审批 | 同页 `/purchase/orders` →「订单全流程视图与操作」 | 状态过滤 submitted → 点行选中 → 填「决策理由（审批必填）」→ 「审批通过」 | 订单 submitted→approved；理由留痕 | **交接采购**（回执行岗下发） |
| 7 | 采购 | 同页「订单全流程视图与操作」 | 选中 approved 单 → 「下发订单」 | 订单 approved→issued（下发给供应商） | 交接仓管（等到货收货） |
| 8 | 仓管 | 同页「订单全流程视图与操作」 | 选中 issued 单 → 填收货行号/收货数量/收货单号（receiptKey）→ 「收货入库」 | 订单 issued→received；收货事实联动库存入库指令（来料需检路径不入正式库，待质检） | **交接质检**（采购质检待检） |
| 9 | 质检 | 菜单「质量管理 → 质检队列」`/inspections` →「手工建质检单」（或队列中已有 receipt 来源单） | 类别=标准件采购（standard_purchase）/非标采购（nonstandard_purchase）、送检数量、来源类型=receipt + 来源对象 id → 「建质检单」→ 选中单填合格数/不合格数 → 「判定」 | 质检单 pending→passed（合格放行事实）；有不合格数则产出不合格明细 | 交接仓管（放行件入仓） |
| 10 | 仓管 | 菜单「仓储管理 → 收发存操作」`/inventory/stock-operations` →「入库」表单 | 入库来源=质检放行、物料 id、仓库 id、数量、**质检单 id（必填）**→「执行入库」 | 现存量+库位余额上升、StockReceived 事件 → 齐套与缺口核查重算；放行余量内可分批入仓 | 交接生产（料齐可开工） |
| 11 | 生产 | 菜单「派工」`/dispatches` →「创建派工单」 | kind=part、图号+工序（零件单必填）、数量 → 提交建单（draft） | 派工单 draft 创建；列表出现新行 | 生产自接 |
| 12 | 生产 | 同页「派工单详情与操作」 | 选中单 → 填「派工执行人」→ 「派工到人」；再点「开工」 | draft→assigned（执行人收 workbench 待办）→assigned→executing | 生产自接（报工） |
| 13 | 生产 | 移动端 `/m/report`（PWA，底部标签「报工」） | 「扫码定位派工单」扫码/输单 → 「报工草稿」填完工数量+工时分钟 → 「提交」 | 报工单 pending→reported；工艺三键（工作令/图号/工序）随单快照；**末道工序报工自动触发质检单（source=report）** | **交接质检**（末道待检） |
| 14 | 生产 | `/dispatches` →「派工单详情与操作」 | 选中 executing 单 → 填「转单新执行人」（或新工序）→ 「转单（仅执行中）」 | 执行人/工序切换成功，转单留痕（dispatch:assign 同码族） | 生产自接（续做完工） |
| 15 | 质检 | `/inspections` | 队列选末道触发单（来源=report）→ 填合格数/不合格数 → 「判定」 | 末道质检单 passed；不合格数>0 时同步去不合格处置页执行处置（返工/让步/报废）→「闭环」 | 交接仓管（完工件入仓） |
| 16 | 仓管 | `/inventory/stock-operations` →「入库」表单 | 来源=质检放行 + 末道质检单 id + 物料/仓库/数量 →「执行入库」 | 完工件入仓；工作令齐套口径更新 | **交接计划**（齐套复核与装配发料） |
| 17 | 计划 | `/workorders` → 选中工作令 →「刷新齐套检查」；再 `/dispatches` →「创建派工单」 | 刷新齐套看缺口收敛 → 建 kind=assembly 装配派工单（工序必填） | 齐套 fail-closed：缺料拦截拒绝/齐套放行建单；**装配派工成功自动生成发料任务 ISS-ASM-（系统钩子，无需人工建单）** | 交接仓管（确认发料） |
| 18 | 仓管 | issue 域**无桌面页**（D-IS-01 页面群未建）——确认发料走接口面（issue.confirm，issue:write） | 执行确认发料后回 `/inventory/stock` 实时库存页观察 | 预占核销：现存量与预占同减、可用量不变；发料记录落库（页面缺口以库存变化佐证） | 交接计划（配件申请） |
| 19 | 计划 | 菜单「配件申请」`/workorders/parts` →「新建配件申请」 | 填工作令 id、物料 id、数量 → 提交（建单即提交） | 申请 submitted；审批人收待办 | **交接审批** |
| 20 | 审批 | 同页列表区 + 移动端 `/m/parts-approval` | 粘贴目标申请 id + 决策理由 → 「批准」 | submitted→approved；**三级链实态**：缺省一级（项目经理），二/三级经参数角色配置（18 册增补 #1）——三级演练时先由管理员配链再走多节点审批 | 交接计划（发货） |
| 21 | 计划 | 同页 `/workorders/parts` | 选中 approved 单 → 「发货（联动出库）」（parts:request 同码） | approved→shipped；联动库存出库 | 交接只读观察（收官走查） |
| 22 | 只读观察 | 全站菜单 | observer 登录 → 逐组展开菜单 → 逐页浏览列表/详情 → 任意页尝试提交 | 全业务组与页面可见（读码全持）；提交动作后端 403 / CommandOutcomeHint 报错（零写码） | 链路闭环 |

**增补步**（岗位包日操作验证，不在主线链内）：

| 步 | 角色 | 界面入口 | 动作 | 预期结果 |
|---|---|---|---|---|
| A1 | 仓管 | `/inventory/stocktakes` | 「开盘点单」（仓库 id）→ 选中单「录入实盘」（物料/实盘数量，complete=提交差异）→ 「审核调账」（理由必填） | 盘点单 open→差异提交→reconciled 调账留痕 |
| A2 | 仓管 | `/inventory/shipping-orders` | 「建发货任务并执行」卡片（物料/数量/承运/运单号）→「执行发货出库」→ 详情「确认发货」（承运/运单号） | 发货执行出库；ShippingConfirmed 联动工作令待发货→已发货 |

**剧本边界注记**：
1. **报工核查（report:verify/audit/revoke）不在本链**——任务链为「派工报工→质检末道」直连；核查链归核查员/班长口径（PRD 17 §2），七岗位无此岗，需验证时用 demo lead 身份补走（`/reports`「核查通过」/「提交修正版」/「撤销冲销」按钮）。
2. **工作令九态流转（workorder:transition）/关令（workorder:close）不在本链**——归项目经理/管理岗；如需演练用 admin 身份在 `/workorders` 详情「执行流转」/「关闭工作令」。
3. 步 18 为**接口级步骤**（issue 域页面缺口 D-IS-01 实态），是全链唯一非页面步；grokbot 走查时按「接口调用 + 实时库存页观察」两段取证。
4. 末道质检触发依赖默认配置的末道 kind 集（engine-flow 默认配置层）；若配置裁剪，步 13→15 改为质检岗手工建单（来源=report）。

## 3. 覆盖统计与边界说明

**码数分布**（详见 §1.0 总表）：计划 13 / 采购 9 / 生产 11 / 质检 7 / 仓管 17 / 审批 8 / 只读观察 49。
**去重覆盖**（脚本实算核对）：六操作岗合计去重 **51 码**（50 服务端码 + 前端 scan:read）；加只读观察岗后全包并集 **77 码**（76 服务端 + scan:read）= 服务端 115 码的 66%。共码 2 处：`purchase:receive`（采购+仓管）、`item:read`（计划+采购）——均为小厂双人经办实态，已在取舍列注明。
**未入七包的 38 个服务端码**（comm 实算清单，按域归因；测试如需覆盖用 admin 或另立管理岗包）：
- 组织与系统管理写码（8）：user:write、role:write、department:write、position:write、menu:write、todo:write、notification:write、approval-config:write；
- 主数据写码（6）：item:write、customer:write、supplier:write、unit:write、resource:write、attachment:write；
- 工艺与设备维保域（9）：process:write、routing:write、standardtime:write、equipment:write、fault:resolve、maintenance:plan-write、maintenance:record、maintenance:task-arrange、outsourcing-rule:write；
- 工时成本薪酬指标域（7）：hours:rebuild、costing:rebuild、costing:model-manage、payroll:run、payroll:rule-manage、payroll:export、metric-pack:activate；
- 主管跨岗动作（6）：report:verify、report:audit、report:revoke、workorder:transition、workorder:close、outsourcing:price；
- 售后与图纸（2）：aftercare:claim、drawing:publish。

**剧本步数**：主线 22 步（含收官只读走查）+ 增补 2 步（均仓管）；角色出场：计划 6 步、采购 3 步、审批 2 步、仓管 4 步（另增补 2 步）、质检 2 步、生产 4 步（含转单）、只读 1 步收官（建议全程随行）。
**取证路径**（本文件全部实态锚点）：`apps/web/src/menu.ts`、`apps/web/src/mobile.ts`、`apps/web/src/pages/**`（各 Page 组件按钮）、`packages/application/src/*/​*.controllers.ts`（@RequirePermission 码）、`packages/product-ui/src/session.ts`（demo 先例）、`architecture/requirements/01-总纲.md` §3/§4 与分册 10/13/14/15/16/17/18 §2。
