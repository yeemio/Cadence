# 01 · payroll —— 薪酬专业包

v1.0（2026-10-26 冻结，审读 ACCEPT agent_4f276c04；Owner 保留推翻权）｜依据：功能项 86 人员时薪、87 工资核算（均 Web·工时和绩效）｜流程拆解阶段 9（工时→工资）/洞察 5（数据即利益）｜决策簿：个案资产参数化按激活价售

## 1. 包身份与边界

**身份**：工时事实的金额化层——把 hours 的"已审核工时×人×月"事实按**版本化计薪规则**核算为薪酬事实；规则=数据（改价=发新版本，历史可复算）。
**In**：人员时薪维护（86：按人/按工种兜底的小时工资标准，即计薪规则的维护面）、月度工资核算与幂等重算（87）、核算结果查询与下钻、导出。
**Out**：工时事实本身（hours 域——本包只消费不生产）；工资单/奖金/津贴建模（口径差异大，v1 不做，见 §10）；考勤与班组班次（定制项 6）；成本口径的工时金额化（costing CostingModel / metric-pack 97 各是各的口径，见 §4）；个税社保代扣（财务域，非本包）。

激活语义：开关关闭时人员时薪与工资核算入口、权限码、事件消费全部不可见（见 README 激活价对应表）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| PayrollRuleId | 计薪规则（PayrollRule） | 版本化数据：ruleId+version；basis（hours/output）+rate+coefficient+scope（personId/laborKind/projectId）；=86 时薪维护的载体 |
| PayRunId | 核算批次（PayRun） | 人×周期的核算快照（幂等重算锚，沿用 M2 账本模式：hours LaborLedgerMonth / costing CostSnapshot 同款）；supersedes 留痕 |
| EarningsRecordId | 薪酬记录（EarningsRecord） | 核算产出 append-only 事实：人×周期×规则版本×量×金额+sourceRefs（下钻到工时账目） |

**状态机**：无业务流转（账本域）；PayRun 为可重算快照（口径/规则变更→新版本快照 supersedes，重算幂等零漂移——对齐 hours 月度归集语义）。

**分层标注（ADR-0010 三层）**：内核概念=账本不可变纪律、快照重算幂等语义、"金额=量×单价×系数"换算纪律（append-only 内核承载）；模块 schema=上表实体/命令/事件（本包版本化）；默认配置=计薪周期初版（month）、工种兜底规则与系数缺省 1（实施时按客户口径调整，不属内核）。

**量纲冻结**（沿用 m2 v1.1 纪律）：quantity=小时（hours 存储口径，不取整）；rate=分/小时（整数）；amount=分（整数，`quantity × rate × coefficient` 后 half-up 到分——对齐 baseline 外协计价 half-up 先例）；laborKind 值集=工种五词 part/assembly/electrical/aftermarket/oddjob。

## 3. 命令与查询

命令（CommandEnvelope，`payroll.*.v1`，G1 先解析校验后记账）：
- `payroll.rule.publish.v1`——发布/修订计薪规则（86 维护面：按人定价=scope.personId 规则；工种兜底=无 person 规则；演进=新版本，历史核算引用旧版本可复算）
- `payroll.run.month.v1`——月度核算/重算（幂等；重算=新 operationId 产生新 PayRun 版本，supersedes 旧快照，EarningsRecord 逐条重写、不改原行——对齐 costing"delta 条目永不改原行"先例）
- `payroll.export.v1`——工资核算结果导出（ExcelJS，走导出端口）

查询：工资核算结果（人×月，可下钻 sourceRefs 至 hours LaborEntry）、规则版本列表与对比、我的工资（本人已核算口径，数据权限）。

## 4. 端口

- **依赖（合法面）**：business-core（UserId/TenantContext）；存储与导出走端口（business-store / ExcelJS 适配，apps/server 组合根接线）。engine-* 允许但 v1 无需。
- **消费 hours（关键接线，R-M3-3）**：`PayrollSource.readVerifiedLabor(periodKey, personIds?) → VerifiedLaborFact[]`（人×周期键×工种×已审核净工时+来源账目 id——形状=预热草案 VerifiedLaborFact，与 08-hours §1 Out"已审核工时×人×月"、§7 对账口径"verified 报工净额（含撤销冲销）"一致）。**实现落组合根适配器**：适配器读 hours 月度归集/工时条目查询拼装该形状——hours（application）不 import 本包（`application-only-core` 禁止），本包不 import hours（`pro-pack-tier-edges` 禁止），两侧结构同形、组合根粘合。
- **被依赖**：engine-reporting / metric-pack（薪酬事实 `sourceKind: earnings-records` 作报表数据源——人员成本类口径）；无其他（costing 不依赖本包，见 §1 边界与 R-M3-5）。

## 5. 权限码（最小集）

`payroll:read`（数据权限：本人 vs 全部——"我的工资"）、`payroll:rule-manage`（时薪维护）、`payroll:run`（核算/重算）、`payroll:export`。薪酬金额=敏感权限，默认仅人事/财务/厂长角色（对齐 costing 金额可见性先例）。

## 6. 事件（append-only + Outbox）

`PayrollRulePublished`、`PayRunComputed`（携规则版本集与周期键，供对账与报表溯源）。

## 7. Done-when 与对账要点

- **Done-when**：人事可维护按人/按工种兜底的时薪且改价=发新规则版本；月度核算一键执行、幂等重算零漂移、历史 PayRun 按当时规则版本可复算；每笔金额可下钻到来源工时账目；可导出；开关关闭时全链路不可见。
- **对账**：同月同规则版本集合下，"人×工种金额 = Σ(已审核净工时 × 时薪 × 系数)"与活系统工资核算结果数值一致（分）；月度重算前后快照对比零漂移；规则匹配优先级（person 精确 > laborKind > 周期兜底）行为等价；量纲换算（小时×分/小时→分 half-up）一致。

## 8. 与预热端口草案的差异表（草案 → 合同定稿）

| # | 草案（packages/payroll/src/ports.ts） | 合同定稿 | 依据 |
|---|---|---|---|
| 1 | `PayrollRuleScope = { laborKind?, projectId? }`，无按人维度 | **新增 `scope.personId?: UserId`**（人员时薪=按人规则；匹配优先级 person > laborKind > 兜底） | 功能项 86"维护**人员**小时工资标准"——草案 scope 覆盖不到 86 的主场景 |
| 2 | ruleId/recordId 为 kebab 字符串 | 品牌化 `PayrollRuleId / PayRunId / EarningsRecordId`（Brand<T,Name>） | m2 通用纪律 5 |
| 3 | 仅 EarningsRecord 逐条事实，无核算批次 | **新增 PayRun 快照对象**（月度核算幂等重算锚） | 任务与 m2 账本模式（LaborLedgerMonth/CostSnapshot）；无批次锚则"重算幂等、版本留痕"无落点 |
| 4 | rate/amount 未定量纲 | 量纲冻结：rate=分/小时、amount=分、half-up 到分 | m2 v1.1 量纲纪律 + baseline 计价先例 |
| 5 | "由 hours 侧（或其对账源）在组合根实现 PayrollSource"方向含混 | **裁定：组合根适配器实现**，hours 不 import 本包、本包不 import hours | `application-only-core` + `pro-pack-tier-edges`（ADR-0011）；登记 R-M3-3 |
| 6 | `PayPeriodKind = month/week/custom` 三粒度 | v1 锁 **month**（86/87 均按月），week/custom 留形状不实现 | 功能项依据；防过早抽象（ADR-0010 时序纪律） |
| 7 | `EarningsBasis = hours | output` | v1 只接 **hours** 事实源（VerifiedLaborFact）；output（计件）数据源未定，见 §10 | 功能项 86/87 依据=工时×时薪；output 无既有事实源 |

ADR-0011 合规结论：草案 import 面仅 business-core，**字面零违规**；第 5 条为文字方向暗示的裁定收口。

## 9. 人日估算对照决策簿

建议 6 人日（M3 总盘 30 内，见 README 人日表）。范围=本合同全部命令/查询/端口适配/权限/导出与对账测试；个案资产参数化（决策簿拆解总览"已实现 8 项=个案定制资产"中的 86/87）指口径按行为重述产品化，非代码搬运（清洁室）。

## 10. 开放问题

- 工资单/奖金/津贴建模范围（草案 open question 原样保留）——客户口径差异大，v1.1 按客户行为需求重述再定，防过早抽象。
- `basis=output`（计件）的量事实源（报工数量×计件单价）——出现真实需求时接入 reporting 数量事实，形状已留。
- payroll 规则是否作为 costing/97 工时金额化价格源——R-M3-5（默认不同源：工资口径≠成本口径）。
- 周期跨月的工时归属（月末 verified 冲销跨月到达）——对账阶段以活系统行为反推，初版按"归集时点所在月"。
