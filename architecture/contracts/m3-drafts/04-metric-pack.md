# 04 · metric-pack —— 报表口径专业包

v1.0（2026-10-26 冻结，审读 ACCEPT agent_4f276c04；Owner 保留推翻权）｜依据：功能项 88 下图统计、90 工作令交付、93 外协零件交货、94 采购件预期、95 采购件金额汇总、97 项目成本（均 Web·报表中心，六张口径报表）｜决策簿："口径定义即数据（可版本化可售卖）25 人日；口径包=商业资产，不做通用 BI"｜裁决项 R6（口径参数化售卖）

## 1. 包身份与边界

**身份**：口径售卖层——6 张口径报表的 MetricDefinition 形状化 + MetricPack（可售卖单元）的装载/版本化纪律；引擎（engine-reporting：defineMetricDefinition/defineMetricPack/evaluateMetric/MetricSource）**已由预热线产出并验收，本包不重造**，是引擎之上的应用层。
**In**：口径包激活与装载（激活价落地动作）、6 张口径定义（版本化数据）、求值查询与下钻、导出、事实源绑定（sourceKind→各模块事实）。
**Out（边界铁律）**：
- **core 4 张标准报表**（89 库存、91 工作令工时、92 自制零件派工报工、96 自制零件入库日报）= 标准 P3，归 M2 engine-reporting **基础层**内置定义（随标准版交付，不按激活价售）——同引擎、不同交付层：基础层=产品内置口径，本包=装载式售卖口径；
- **97 的归集域**在 M2 costing（CostEntry/CostingModel/CostSnapshot）——本包只做呈现口径（消费 costing 快照事实），归集与重算不属本包（R6）；
- 通用 BI（自由 SQL/查询语言/图表布局定义）禁入（决策簿"不做通用 BI"+引擎 ADR-0010 自证）；
- 口径包的市场/授权/分发机制（跨租户售卖系统）不进 M3——激活=运营侧装载动作（登记：§12 开放问题）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| MetricPackActivationId | 装载记录（MetricPackActivation） | 租户×packId@version 的激活事实；升级=新记录替代（历史包只读可复算） |
| （引用，不重复定义） | MetricDefinition / MetricPack / MetricQuery / MetricResult | engine-reporting 已有类型（预热已冻结：版本化纯数据、校验即深冻结、求值纯函数） |

**状态机**：无业务流转（配置装载域）；口径演进=定义 version+1 / 包 version+1（append-only，不改历史）。

**分层标注（ADR-0010 三层）**：内核概念=引擎的口径/维度/度量/过滤/聚合通用词与"定义即数据"纪律（engine-reporting 承载，已自证）；模块 schema=装载记录实体与本包命令/事件（本包版本化）；默认配置=机加垂直 6 张口径初版（行业口径集=数据，第二行业=另一份口径包，引擎零改动）。

## 3. 命令与查询

命令（CommandEnvelope，`metric-pack.*.v1`，G1 沿用）：
- `metric-pack.activate.v1`——装载/升级口径包（packId@version；经 defineMetricPack 逐条校验冻结后落装载记录；升级后旧版本只读可复算）
- `metric-pack.export.v1`——报表导出（ExcelJS，对齐"更新数据重算口径＋导出"行为：求值即重算，无缓存）

查询：口径求值（MetricQuery：metricId+version 钉死定义 + 时间窗/维度切片/查询过滤；结果携口径溯源）、装载包清单与版本、下钻（维度切片细化+查询过滤，明细口径=维度细化到单行粒度）。

## 4. 端口

- **依赖（合法面，本包唯一跨包 import）**：`@smes/engine-reporting`（`pro-pack-tier-edges` 明确允许 engine-*）；business-core（TenantContext/UserId）。
- **事实源绑定（不 import application）**：六种 `sourceKind` 的 `MetricSource` 适配器由 business-store 实现（读各模块事实表/事件表，只读）、apps/server 组合根绑定——本包与 M2 九模块零代码依赖（ADR-0011）。
- **事实行适配纪律**：行形状对齐 EvidenceColumns 三时间列+occurredAt+领域字段（引擎 source.ts 已锁）；**动态判定字段（是否逾期/是否准时/交付判定）由适配器物化为数据字段**，引擎谓词保持静态纯数据——对齐"正确性归属引擎、下推只是优化"。
- **被依赖**：报表中心 UI（ECharts 呈现，D13）经查询 API；无模块反向依赖本包。

## 5. 六张口径形状化（MetricDefinition 形状，机加垂直初版）

| 功能项 | metricId 建议 | sourceKind（事实源模块） | 维度 | 度量（量纲） | 时间口径 | 口径要点与对账锚 |
|---|---|---|---|---|---|---|
| 88 下图统计 | `drawing-intake-progress` | `workorder-attachment-facts`（workorder 附件事实） | 工作令×图号 | 已上图图号数 distinct-count、附件数 count | business | 未激活图纸包=附件计数口径（v1）；激活后可演进 v2 增修订维度（drawing 包事实）——口径版本化纪律的示例场景 |
| 90 工作令交付 | `workorder-delivery-comparison` | `workorder-delivery-facts`（workorder 九态/交付日期事实） | 期间(月/年)×交付判定 | 工作令数 count | business | 判定字段（按时交付/延期交付/未交付）由适配器按计划 vs 实际交付日期物化；对账：同月同批对照计数与活系统一致 |
| 93 外协零件交货 | `outsourcing-delivery-performance` | `outsourcing-delivery-facts`（dispatch 外协单+inspection 回厂事实） | 供应商×月 | 单数 count、准时率 avg(onTimeFlag)、图号数 distinct-count | business | 准时判定=回厂(质检)时点 vs 交期；下钻未按期图号明细=维度细化；供应商月度评分呈现归本口径，自动联动=开放（§12） |
| 94 采购件预期 | `purchase-overdue-outstanding` | `purchase-overdue-facts`（listing 订单行×inventory 入库净额） | 订单行（明细粒度） | 未入库数量 sum、明细行 count | business | "已逾期且仍有未入库数量"=根过滤 isOverdue∧outstanding>0（适配器物化字段）；对齐 listing 逾期催货事实口径 |
| 95 采购件金额汇总 | `purchase-amount-summary` | `purchase-amount-facts`（listing 订单行已定价×收货事实） | 工作令×零件类型 | 金额 sum（分）、订单数 distinct-count | business | 默认口径=已收货数量×单价（对齐 listing 对账要点）；下单口径=口径参数变体（同 metricId 新版本）；可下钻订单行 |
| 97 项目成本 | `project-cost-summary` | `costing-entry-facts`（costing CostEntry/快照事实） | 工作令×成本类别(材料/工时/外协) | 金额 sum（分） | business | "口径可按企业要求配置"=两层：CostingModel 版本（归集口径，M2 costing）×本定义版本（呈现口径）；对账：三分类总额=costing 同口径快照 |

六条定义组成建议包：`packId: smes-machining-calib`（v1）；engine 不变量已锁——包内 metricId 唯一、同 id 不同版本不并存于一个包（演进走包版本）。

## 6. 版本化与售卖纪律（口径=可售卖单元）

1. **定义=版本化纯数据**：metricId+version 钉死；演进=版本+1，历史定义不动——只读旧版即可复算旧报表（引擎已锁"跨版本不可变"）。
2. **包=售卖单元**：MetricPack 可整体序列化（packId+version+口径清单+元数据）；报价单"报表口径包"可选行 ↔ 模块开关 ↔ 装载记录三层同一（README 激活价对应表）。
3. **激活=装载动作**：`metric-pack.activate.v1` 落装载记录；升级=新版本替代、历史只读；未装载则报表中心不见六张口径报表（标准 4 张不受影响）。
4. **客户口径参数化**：客户差异=另一份口径定义/包版本（数据），不是代码分支——"换客户不写代码"的口径层实现。

## 7. 权限码（最小集）

`metric-pack:read`（金额敏感类口径对齐 costing 先例，默认厂长/财务角色）、`metric-pack:activate`（租户管理员）。

## 8. 事件（append-only + Outbox）

`MetricPackActivated`（packId@version+装载人；升级留痕）。求值/导出只读不发事件。

## 9. Done-when 与对账要点

- **Done-when**：激活后六张口径经 defineMetricPack 校验冻结装载；任一口径可按时间窗/切片求值并下钻、可导出；口径演进后历史版本报表可复算；未激活/未装载时六张不可见且标准 4 张照常；六种 sourceKind 适配器绑定生效。
- **对账**：同数据同口径版本下，六张报表数值与活系统黑盒一致（分/数量级）：90 对照计数、93 准时率、95 金额汇总、97 三分类总额=costing 同口径快照、94 逾期未入库明细集合；口径版本切换后新旧报表均留存可回算。

## 10. 与预热引擎的差异表（引擎非目标 → 本包收编边界）

| # | engine-reporting README 非目标（预热态） | 本包合同裁定 |
|---|---|---|
| 1 | server/NestJS 注册、报表 UI | **收编进 M3**：激活命令+求值查询 API+ECharts 呈现（呈现层与标准 4 张共用） |
| 2 | PG 适配器（MetricSource） | **收编进 M3**：六种 sourceKind 适配器（business-store 实现+组合根绑定，§4 纪律） |
| 3 | 口径包市场/授权/分发机制 | **不收编**：激活=运营装载动作；跨租户售卖系统属商业平台，另行立项（§12） |
| 4 | 钻取、同环比、物化与缓存 | 下钻**收编**（维度切片+明细粒度口径）；同环比/物化缓存不进 v1（对账阶段按性能需求定） |
| 5 | （引擎无具体口径） | 六张机加垂直口径初版=本包交付物（§5）；预热线未产出任何口径定义，零冲突 |

ADR-0011 合规结论：本包唯一跨包依赖=engine-*（规则明文允许）；对 M2 九模块只经 business-store 事实适配，**零违规**。新增包名需补 `pro-pack-tier-edges` 清单（R-M3-4，实施首波同步）。

## 11. 人日估算对照决策簿

建议 9 人日（M3 总盘 30 内）。对照：复用与自研"报表口径层 25 人日"含引擎本体——引擎已由预热线产出验收（status.md M3 预热线：35 测试 ACCEPT），抵扣其中引擎部分；本包 9 人日=装载机制+六张口径参数化+事实源适配+呈现；六张口径对活系统的数值校准挂对账阶段（超出 M3 盘，R-M3-1 待裁定）。

## 12. 开放问题

- 口径包跨租户分发/授权（售卖机制）——商业平台域，M3 不做，激活动作已覆盖单租户交付。
- 93 供应商月度评分与 dispatch 外协交期逾期的自动联动（dispatch 合同 open question）——口径定义承载评分呈现，自动计算链对账阶段定。
- 95 金额口径变体（收货口径 vs 下单口径）作为默认版的确认——对账阶段按活系统行为反推。
- 88 口径 v2（图纸包激活后的修订维度）是否随图纸包捆绑售卖——打包策略 Owner 定。
- 物化/缓存与大数据量求值性能（feed 全量扫描同源问题）——对账阶段与 M2 登记项一并。
