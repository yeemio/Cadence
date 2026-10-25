# 01 · baseline —— 技术准备环节模块

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 10,12,13,16,20,35,36,127｜流程拆解阶段 2（技术准备）｜裁决项 R3

## 1. 环节身份与边界

**身份**：图纸齐、工艺定的技术基线——工艺/工时/校验/设备台账的拥有者，向下游派工与成本供标准。
**In**：工序库、工艺路线、额定工时、物料校验规则执行、外协计价配置、设备台账与故障上报。
**Out**：通用主数据（物料/客户/供应商——core.masterdata 已有）；图纸电子化（M3 图纸包）；设备维保/点检（M3 维保包）；OEE/能耗（定制）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| ProcessId | 工序（ProcessDef） | 机加工序库，派工引用 |
| RoutingId | 工艺路线（Routing） | 零件×工序序列，图号维度 |
| StandardTimeId | 额定工时（StandardTime） | 工序/产品标准工时+预备工时额度（P3） |
| EquipmentId | 设备（EquipmentRecord） | 设备台账（P1） |
| FaultReportId | 故障单（FaultReport） | 异常/停机上报→推送维修（P2） |
| OutsourcingPriceRuleId | 外协计价规则 | 工序单价×利润率（P1，供 dispatch 外协派工计价） |

**状态机（engine-flow 配置形态，ADR-0010）**：
- FaultReport：`open → assigned → resolved`（+reject 回退）；IM 推送挂在 assigned 进入事件。
- 其余对象为版本化主数据（draft → active → superseded），无业务流转。

**分层标注（ADR-0010 三层）**：内核概念=状态集与迁移语义（FaultReport 流转规则，engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=状态机初版配置与推送节点（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令（CommandEnvelope，`baseline.*.v1`）：`process.define` / `routing.define` / `routing.revise`（新版本 supersedes 旧版）/ `standardtime.define` / `equipment.register` / `fault.report` / `fault.resolve` / `outsourcing.rule.set`。
查询：工艺路线按图号、额定工时按工序/产品、设备台账、故障单列表、外协计价规则表。

## 4. 端口

- **依赖（M1）**：engine-flow（故障单流转）；存储与 IM 走端口——StockRepo / NotifyChannel 由 business-store / integration-im 实现、apps/server 组合根接线（ADR-0011：application 不直接依赖 business-store / integration-*）；masterdata 物料库（core 模块间端口，校验比对基准）。
- **依赖（M2）**：workorder（附件图纸计数事实——下图统计数据源）。
- **被依赖**：listing（物料校验执行）、dispatch（工序/外协计价实时取价）、reporting（报工工序合法性）、hours（StandardTime 额定工时对标）、engine-reporting（下图统计事实源）。

## 5. 权限码（最小集）

`process:read|write`、`routing:read|write`、`standardtime:read|write`、`equipment:read|write`、`fault:read|report|resolve`、`outsourcing-rule:read|write`。

## 6. 事件（append-only + Outbox）

`ProcessDefined`、`RoutingRevised`、`StandardTimeDefined`、`EquipmentRegistered`、`FaultReported`（→待办+IM）、`FaultResolved`、`OutsourcingRuleSet`。

## 7. Done-when 与对账要点

- **Done-when**：工艺员能维护工序库与零件工艺路线并按图号查得；物料校验能对清单行给出匹配/疑似/未匹配判定；外协计价规则能被外协派工单实时取价；设备故障上报后维修人员收到 IM 待办并闭环。
- **对账**：同一零件清单经物料校验，输出匹配判定与活系统黑盒一致；同图号工艺路线的工序序列行为等价；外协单取价=工序单价×(1+利润率) 数值一致。

## 8. Open questions

- 物料校验的匹配算法口径（编码精确 + 规格模糊度阈值）需在对账阶段以行为反推校准（不抄原实现）。
- 图纸接收进度（下图统计报表 88，可选口径包）数据源=工作令附件图纸计数，本模块只出事实，口径归 engine-reporting。
