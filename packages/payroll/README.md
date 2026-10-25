# @smes/payroll（薪酬专业包）

状态：**M3 已实施**（冻结合同 `architecture/contracts/m3-drafts/01-payroll.md`
v1.0）。工时事实的金额化层：版本化计薪规则（改价=发新版本，历史可复算）、
人×月核算批次（幂等重算零漂移，supersedes 版本链）、append-only 薪酬记录
（重算逐条重写新行不改原行）、导出端口化（json-tables 内建 / ExcelJS 组合根
适配）。零框架业务类（不 import @nestjs/*）——注册进组合根与激活开关接线归
总控（开关关闭 = 入口/权限码/事件消费全不可见，见 `src/index.ts` 文件头）。

实施版面（M3 首波，体例对齐 application/src/hours 与 costing）：

| 文件 | 职责 |
| --- | --- |
| `src/ports.ts` | hours 消费端口（VerifiedLaborFact / PayrollSource + 缺省空源；R-M3-3） |
| `src/payroll-config.ts` | 工种五词/量纲冻结（rate=分/小时、amount=分 half-up）/权限码/周期口径 |
| `src/payroll-ids.ts` | 品牌化 PayrollRuleId / PayRunId / EarningsRecordId（defineId 增补） |
| `src/payroll-errors.ts` | Input/NotFound/Conflict（含跨包结构同形防线 isPayrollConflict） |
| `src/payroll-events.ts` | PayrollRulePublished / PayRunComputed（携规则版本集与周期键） |
| `src/payroll-stores.ts` | 存储端口：规则版本行 / 批次快照行 / 薪酬记录行 / 事件 / 幂等账本 |
| `src/payroll-input.ts` | 命令面解析（payroll.rule.publish / run.month / export；G1 前置校验） |
| `src/payroll.service.ts` | 用例编排：匹配优先级（person>laborKind>兜底）/幂等重算/查询/导出 |
| `src/payroll-export.ts` | 导出端口（JsonTablesPayrollExportPort 内建；结构同形 ExcelSheet） |
| `src/in-memory-payroll-stores.ts` | 内存先行实现（零 DB boot）；PG 适配在 business-store `./payroll` |

以下预热草案记录保留作设计沿革（ADR-0010 三问表与依赖方向裁定仍然有效）。

## 领域概念与 ADR-0010 三问记录

| 概念 | 三问记录（1 单一行业？2 可重述为通用上位+配置？3 已有上位可挂靠？） | 落点 |
| --- | --- | --- |
| 计薪周期 | 2：通用周期粒度 month/week/custom + 周期键 | `PayPeriod` |
| 计时/计件 | 2：重述为"计量基础"（按工时量 / 按产出量） | `EarningsBasis = 'hours' \| 'output'` |
| 单价 / 系数 | 通用数值参数（夜班/加班倍率 = 规则版本的系数值，不是类型） | `PayrollRule.rate / coefficient` |
| 工种 | 3：挂靠 hours 模块口径键——值集由租户配置定义 | `scope.laborKind: string`（opaque 键） |
| 项目计薪 | 3：挂靠工作令/项目引用键 | `scope.projectId: string`（opaque 键） |
| 工资单/奖金/津贴 | **草案不建模**（客户口径差异大，M3 实施按"行为需求重述"定，防过早抽象） | Open question |
| 薪酬记录 | 通用"核算产出事实"：人×周期×规则版本×量×金额+来源引用 | `EarningsRecord` |

包身份词 payroll（薪酬）留在包级（专业包层），不进 business-core 内核词汇白名单。

## 依赖方向

```
@smes/payroll ──(仅类型)──▶ @smes/business-core（UserId 品牌化身份）
      │
      └─(端口形状消费，不 import 实现)─▶ hours 模块（M2）的产出事实
```

- **消费 hours 的方式 = 端口形状**：hours 模块（m2-drafts/08-hours）的 Out 承诺
  "本模块出『已审核工时×人×月』事实"。本包把该事实声明为 `VerifiedLaborFact`，
  由 hours 侧（或其对账源）在组合根实现 `PayrollSource`——payroll 不依赖
  application/hours 的任何代码（ADR-0004：专业包不被基础层反向依赖，反之亦不侵入）。
- 金额口径：`amount = quantity × rate × coefficient` 的换算与重算幂等属 M3 实施；
  本包只锁形状与溯源（`ruleId + ruleVersion` 钉死核算口径版本，历史可复算）。
- 数据方向出口：薪酬事实（金额化结果）可作为 engine-reporting 口径包的数据源
  （口径定义 `sourceKind` 指向薪酬事实），呈现走 M3 报表口径包。

## 端口清单

| 类型 | 形状 |
| --- | --- |
| `PayPeriod` | 周期键 + 粒度 + 起止（含端点） |
| `PayrollRule` | 规则 = 数据：ruleId + **version** + basis + rate + coefficient? + scope? |
| `EarningsRecord` | 人×周期×规则版本×quantity×amount + sourceRefs（下钻/对账锚点） |
| `VerifiedLaborFact` | hours 产出口径：人×周期键×工种×净工时（冲销后）+ 来源账目 id |
| `PayrollSource` | `readVerifiedLabor(request) → Promise<VerifiedLaborFact[]>`（组合根接线） |

## 非目标（本草案）

任何运行时逻辑（核算/重算/周期切分）、存储、NestJS 注册、UI、与 costing 的
成本口径合并（各是各的口径层，经 engine-reporting 呈现层汇合）。
