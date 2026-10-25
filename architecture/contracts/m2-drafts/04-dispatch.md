# 04 · dispatch —— 六类派工环节模块

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 38~43｜流程拆解阶段 4/5/6（外协/自制/装配）｜洞察 3（外协是半个车间）

## 1. 环节身份与边界

**身份**：任务派发——把工作令分解为到人到序（到供应商）的执行单，六类一体：零件/外协/装配/电气/售后/零工。
**In**：六类派工单创建与派发、外协供应商挂接与单价补录、齐套放行判断（装配派工前置）、派工单打印（外协加工单）。
**Out**：执行申报（reporting）；工序库与外协计价（baseline，只读取用）；齐套事实（workorder 的 KitCheck，只读消费）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| DispatchId | 派工单（DispatchOrder） | kind ∈ 零件/外协/装配/电气/售后/零工；零件单带图号×工序×工艺属性（尺寸/材料随单） |
| OutsourcingLineId | 外协明细 | 供应商、工序、单价（可事后补录）、交期 |

**状态机（engine-flow 配置）**：`draft → assigned(已派工) → executing(执行中) → done(完工)`；外协单另有回厂节点（done 联动 inspection 外协质检）。撤销：draft/assigned 可撤（发事件，reporting 侧禁止再报）。
**放行规则**：装配/电气派工创建时校验 workorder KitCheck 齐套通过（未齐套拒绝创建——流程拆解"齐套后才放装配派工"）。

**分层标注（ADR-0010 三层）**：内核概念=派工四态状态集与迁移语义（engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=齐套拦截规则与六类单初版配置（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`dispatch.create.v1`（含齐套校验）、`dispatch.assign`、`dispatch.start`、`dispatch.complete`、`dispatch.cancel`、`outsourcing.price.backfill`（补录单价）。
查询：六类派工单列表/详情（状态筛选器口径）、按人/按序任务视图、外协单（供应商维度）、派工单打印数据（PrintPort——外协加工单 TSPL/pdf）。

## 4. 端口

- **依赖（M1）**：engine-flow；存储与打印/IM 走端口——StockRepo / PrintPort / NotifyChannel 由 business-store / integration-print / integration-im 实现、apps/server 组合根接线（ADR-0011）。
- **依赖（M2）**：baseline（工序、外协计价规则实时取价）、workorder（KitCheck 齐套读；进度经事件发布、由 workorder 订阅上卷，dispatch 不直接写他域）、listing（外协工序来源）。
- **被依赖**：workorder（进度事件订阅方）、reporting（报工必须挂有效派工单）、inspection（外协单完工→回厂质检触发）、costing（外协价格归集）、engine-reporting（自制零件派工报工报表）。

## 5. 权限码

`dispatch:read|write|assign|cancel`、`outsourcing:read|price`。

## 6. 事件

`DispatchCreated/Assigned/Started/Completed/Cancelled`（→待办推送执行人）、`OutsourcingPriced`（→costing 重算信号）。

## 7. Done-when 与对账要点

- **Done-when**：计划员六类派工全走单据；零件派工单带工艺属性随单；外协批量派发到供应商并可打印加工单、事后补录单价；装配派工被齐套状态硬拦截；工人/供应商侧收到派工待办。
- **对账**：六类单的状态筛选器集合与迁移合法集和活系统一致；外协单计价=工序单价×(1+利润率) 口径一致；齐套拦截行为等价（未齐套创建装配派工被拒）。

## 8. Open questions

- 零工派工的"计划内/计划外"分类是否影响工时归集口径——与 hours 对账时定。
- 外协单交期逾期是否自动进入供应商月度评分计算（评分呈现属 engine-reporting 口径包）。
