# 05 · reporting —— 报工与核查环节模块

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 44~53,107~116,135,136｜流程拆解阶段 5（自制加工）/洞察 5（工时直通工资）

## 1. 环节身份与边界

**身份**：执行申报——工人把"做了多少"实时记成事实：五类报工（零件/装配/电气/售后/零工）+ 按权限核查。移动端报工是同 API 的 PWA 镜像（M5 呈现，A 批扫码并入裁决 R8）。
**In**：五类报工单（数量+工时，挂派工单）、批量报工、报工核查（编辑/审核/撤销，按权限）、图号工序进度事实输出。
**Out**：派工单本身（dispatch）；工时账归集（hours）；工资核算（M3 薪酬包）；报工进度上卷视图（workorder 只读）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| WorkReportId | 报工单（WorkReport） | kind 五类；挂 DispatchId；完工数量+工时+申报人；工艺属性随单快照 |
| ReportAuditId | 核查记录 | 编辑/审核/撤销的动作留痕（谁、何时、改了什么） |

**状态机（engine-flow 配置）**：`pending(待报) → reported(已报) → verified(已核查)`；`revoked(撤销)` 为终态旁支（仅核查权限可触发；已核查撤销需重报）。核查编辑不改原单——生成修正版（supersedes 链，证据列纪律）。

**分层标注（ADR-0010 三层）**：内核概念=报工状态集与核查/撤销迁移语义（engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=核查权限矩阵初版与批量上限（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`report.submit.v1`（单人单工序）、`report.submit-batch.v1`（批量）、`report.audit-edit.v1`（修正版+原因）、`report.verify.v1`、`report.revoke.v1`。
查询：五类报工列表/详情、按人报工（我的报工）、图号×工序进度查询、待核查队列、产出趋势事实（日产出/12 日均/峰值，供工作台与报表）。

## 4. 端口

- **依赖（M1）**：engine-flow、casbin 鉴权执行（core RBAC 中间件）；存储与扫码/IM 走端口——StockRepo / ScanPort / NotifyChannel 由 business-store / integration-scan / integration-im 实现、apps/server 组合根接线（ADR-0011）。
- **依赖（M2）**：dispatch（有效派工单校验）、baseline（工序合法性）。
- **被依赖**：inspection（末道报工触发待检单）、hours（verified 工时直通工时账，事件链携带工作令维度）、workorder（进度上卷订阅方）、engine-reporting（自制零件派工报工报表、产出趋势）。

## 5. 权限码

`report:read|submit|audit|verify|revoke`（submit 按本人；audit/verify 按角色）。

## 6. 事件

`ReportSubmitted/BatchSubmitted`、`ReportCorrected`（修正版）、`ReportVerified`（→hours 归集信号）、`ReportRevoked`（→hours 冲销信号）。

## 7. Done-when 与对账要点

- **Done-when**：工人按图号工序实时申报数量与工时（Web/移动同 API），支持批量；核查员可按权限编辑/审核/撤销且全程留痕；verified 工时实时进入工时账；图号工序进度可查。
- **对账**：同报工集合的"已核查工时×数量"汇总与活系统一致；撤销后重报的净额口径一致；修正版链的最终态读取行为等价；"仅本人完成"类数据权限边界（M1 增量 4 已有 Todo 双键先例）行为一致。

## 8. Open questions

- 报工数量与派工量的超报容忍口径（允许超派工量申报？）——对账阶段以活系统行为反推。
- 批量报工的上限与分片（移动端弱网）——M5 性能验收时定，不影响本合同。
