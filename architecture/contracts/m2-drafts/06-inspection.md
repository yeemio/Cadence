# 06 · inspection —— 四类质检环节模块

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 63~66,119~122｜流程拆解阶段 5/3（末道自制、外协回厂、三类到货）/洞察（88 未闭环点名）

## 1. 环节身份与边界

**身份**：质量门禁——四类质检单（自制外协/非标件采购/标准配件采购/设备采购），合格放行入库，不合格进闭环。
**In**：四类质检单创建（来源：报工末道/外协回厂/采购收货）、检验记录（合格/不合格数量）、不合格闭环（处置+复检）。
**Out**：入库放行（inventory 消费放行事实）；深度 QMS（自检互检/巡检/检验项/量检具——定制，不在九模块）；进货检标准定义（定制检验项管理）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| InspectionId | 质检单（InspectionOrder） | kind 四类；来源对象引用（报工单/外协单/收货单）；合格数/不合格数 |
| NonconformId | 不合格处置（Nonconform） | 不合格明细：原因/处置（返工/让步/报废）/闭环状态 |

**状态机（engine-flow 配置）**：`pending(待检) → passed(合格) / failed(不合格)`；failed → `closed(闭环)`（处置+必要复检）；闭环超时进入待办点名（88 未闭环场景）。
**放行规则**：passed 发放行事实 → inventory 才可入库（质检→入库放行咬合）。

**分层标注（ADR-0010 三层）**：内核概念=质检状态集与不合格闭环迁移语义（engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=闭环超时阈值与处置枚举初版（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`inspection.create.v1`（多由来源事件自动生成）、`inspection.judge.v1`（合格/不合格数量+备注）、`nonconform.dispose.v1`、`nonconform.close.v1`、`inspection.recheck.v1`。
查询：四类质检队列（状态筛选）、质检汇总事实（合格率/待检数/未闭环数——供工作台 KPI 与报表）、不合格明细与闭环追踪。

## 4. 端口

- **依赖（M1）**：engine-flow；存储与 IM 走端口——StockRepo / NotifyChannel 由 business-store / integration-im 实现、apps/server 组合根接线（ADR-0011）。
- **依赖（M2）**：reporting（末道报工触发）、dispatch（外协回厂触发）、listing（收货触发）。
- **被依赖**：inventory（放行事实）、engine-reporting（质检概况报表）、core 工作台（质检概况 KPI 卡——待检/合格率/未闭环）。

## 5. 权限码

`inspection:read|judge`、`nonconform:read|dispose|close`。

## 6. 事件

`InspectionCreated/Judged`（→放行或闭环分支）、`NonconformDisposed/Closed`、`InspectionOverdue`（→待办）。

## 7. Done-when 与对账要点

- **Done-when**：四类来源自动生成待检单；检验记录合格/不合格数量；不合格处置闭环可追踪且超时点名；passed 后库存方可入库。
- **对账**：同待检集合的合格率/待检/未闭环三项计数与活系统口径一致；"末道工序才触发自制质检"的触发边界行为等价；放行-入库顺序约束一致。

## 8. Open questions

- 让步接收（不合格但放行）是否存在独立处置码——对账阶段确认，配置进 Nonconform 处置枚举。
- 设备采购质检是否需要安装调试验收环节（与"验收中"工作令态衔接）——与 workorder 对账时定。
