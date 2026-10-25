# 02 · workorder —— 工作令全生命周期环节模块

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 24~30,117,118,134｜流程拆解阶段 1/6/7/8（立项/齐套/交付/售后）｜裁决项 R2,R5

## 1. 环节身份与边界

**身份**：单件流 ETO 的项目档案中心——订单-清单-图纸同源挂接，九态状态机驱动全厂交付节奏（洞察 1：每台设备一个工作令）。
**In**：工作令主单据与九态流转、四类清单导入触发、图纸附件挂接、齐套编排、配件申请、三类进度视图。
**Out**：清单内容维护（listing）；库存事实（inventory）；进度明细数据（reporting/dispatch 事实的上卷视图，本模块只读聚合）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| WorkOrderId | 工作令（WorkOrder） | 主单据：客户/项目/销售/项目经理/计划交付/包材到货日期 |
| WorkOrderAttachmentId | 附件 | 图纸等文件挂接 |
| PartsRequestId | 配件申请（PartsRequest） | 售后配件申请→审批→发货闭环（P1） |
| KitCheckId | 齐套检查（KitCheck） | 按工作令×三类清单的齐套事实与缺口（P2） |

**状态机（engine-flow 配置）**：
- WorkOrder 九态：`未开始 → 进行中 → 待发货 → 已发货 → 验收中 → 维保中 → 售后中 → 已完成 → 已关闭`；流转含回退与跳态规则（配置分离，对账阶段校准跳态合法性）。
- PartsRequest：`draft → submitted → approved/rejected → shipped → received`（审批走 engine-flow 审批链）。
- KitCheck：每次刷新生成不可变快照（非状态机，证据列承载）。

**分层标注（ADR-0010 三层）**：内核概念=九态状态集与迁移语义（engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=九态初版配置与配件审批链默认层级（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`workorder.create.v1`（同时触发四类清单骨架创建，发 `WorkOrderCreated` 事件由 listing 消费）、`workorder.update`、`workorder.transition.v1`（目标态 + 证据）、`workorder.close`、`workorder.attach`、`parts.request` / `parts.approve` / `parts.ship`（联动 inventory 出库端口）/ `kit.refresh`。
查询：工作令详情/列表（状态筛选器）、项目进度（计划 vs 实际）、机加工进度（图号×工序上卷）、装配调试进度、齐套看板（缺口下钻）、交付态势（风险等级+倒计时，供工作台）。

## 4. 端口

- **依赖（M1）**：engine-flow（九态+审批配置）；存储与 IM 走端口（business-store / integration-im 实现，apps/server 组合根接线，ADR-0011）；masterdata（客户，core 模块间端口）。
- **依赖（M2 兄弟模块）**：listing 端口（清单需求行）、inventory 端口（可用量）、reporting/dispatch 事件流（进度事实，只读订阅）。
- **被依赖**：listing（WorkOrderCreated 导入）、baseline（附件图纸计数——下图统计源）、dispatch（KitCheck 齐套读）、inventory（发料/配件发货指令来源）、hours/costing（按工作令归集，经 reporting/dispatch 事件链间接）、engine-reporting（交付态势/交付报表数据源）、core 工作台（KPI 卡）。

## 5. 权限码

`workorder:read|write|transition|close`、`parts:read|request|approve`、`kit:read|refresh`。

## 6. 事件

`WorkOrderCreated`（→listing）、`WorkOrderTransitioned`（→待办/IM/报表）、`AttachmentAdded`、`PartsRequested/Approved/Shipped`、`KitCheckRefreshed`（→装配派工放行判断）。

## 7. Done-when 与对账要点

- **Done-when**：销售/项目经理能建工作令并一键导入四类清单；九态流转全走配置化状态机且可回溯；齐套缺口可见并可催办（缺口→待办）；配件申请审批后联动出库；工作台可见状态分布与交付倒计时。
- **对账**：同集合工作令的状态分布计数与活系统口径一致；九态合法迁移集合行为等价；齐套判定（三类清单×库存可用量）与活系统同输入同输出。

## 8. Open questions

- 九态跳态/回退的精确合法集：以流程拆解实测口径为初版，对账阶段以活系统行为反推校正后冻结为 engine-flow 配置。
- 维保中/售后中两态的进入条件（验收完成 vs 合同条款）——实施时按客户口径配置化。
