# M3 专业包合同（m3-drafts）

版本：v1.0（2026-10-26 冻结）｜状态：**已冻结——code-reviewer 审读 ACCEPT（agent_4f276c04，两处低危引文已修），Owner 保留推翻权；R-M3-1~R-M3-6 开放不阻塞（含实施排期待 Owner 编排）**
生成人：zcode-cadence-m2-spec 线（实施：code-writer-pro，GLM-5.3）｜消费方：M3 代码实施线（M2 九模块已全部验收收口后按此派发）

## 规格源（清洁室合法输入，均已全量读取）

| 文档 | 位置 | 用途 |
|---|---|---|
| 功能清单拆解 V2（137 项三值判定） | `S-mes/03-产品用/机加工MES功能清单-标准定制拆解V1.0.xlsx`（导出件 `cadence-runkit/evidence/m2-spec/spec-sources-dump.txt`） | 13 项可选功能 → 四包映射的唯一依据 |
| 技术选型决策簿 V1.0 | `S-mes/03-产品用/S-mes重构技术选型决策簿V1.0.xlsx`（同导出件） | M3=30 人日四包+口径引擎；复用与自研"口径层 25 人日/口径包=商业资产"；D9 插件装配 |
| 交接文档 V1.0 §7/§8 | `S-mes/HANDOFF-重构交接V1.0.md` | 专业包=可选 13 项、激活价、报价单可选行↔代码开关 |
| 他线预热成果（只读消费） | `packages/engine-reporting/src`（MetricDefinition/MetricPack/evaluateMetric/MetricSource——引擎已存在）；`packages/payroll/src`、`packages/maintenance/src`、`packages/drawing/src` 端口草案（含各自 README ADR-0010 三问表） | 端口形状基础；差异表对照物 |
| M2 合同体系（体例与消费依赖） | `architecture/contracts/m2-drafts/`（README + 九模块合同 + v1.1 增补节）、`smes.command.v1.md`、`evidence-columns.v1.md` | 章节骨架同体例；被消费端口面与术语 |
| 依赖约束 | `ADR-0010`（三层标注）、`ADR-0011`（引擎/边缘包方向）+ `.dep-cruiser.cjs` `pro-pack-tier-edges` 等边界规则 | 专业包→仅 core+engine-* |
| 状态快照 | `architecture/status.md` | M2 九模块 9/9 验收收口、M3 预热线已 ACCEPT（引擎真实化 + 三包草案） |

**禁用输入**：`AI/gitrep/sieracMes-AI/docs/开发文档/` 73 份雇主文档、现系统任何代码/SQL/模板（清洁室纪律 D11 / ADR-0002）。全部报表口径与字段为行为需求重述。

## 文件索引

| 文件 | 包 | 包身份 | 功能项 | 激活价语义 |
|---|---|---|---|---|
| [01-payroll.md](01-payroll.md) | payroll 薪酬包 | 工时事实→金额化：版本化计薪规则×月度核算 | 86,87 | 时薪+核算参数化，个案资产转产品 |
| [02-maintenance.md](02-maintenance.md) | maintenance 维保包 | 计划性维保执行域：任务/三态记录 | 18,19,125,126 | 需维修组织与保养制度 |
| [03-drawing.md](03-drawing.md) | drawing 图纸包 | 图纸域：版本化修订+钉版引用+查看保密 | 37 | 图纸电子化与保密制度门槛高 |
| [04-metric-pack.md](04-metric-pack.md) | metric-pack 报表口径包 | 口径定义即数据：6 张口径报表+售卖单元 | 88,90,93,94,95,97 | 口径参数化，可版本化可售卖 |

## 13 项可选功能 → 四包映射总表

标注：`序号.功能｜端｜实现状态`（实现状态=拆解 V2 对原系统个案资产的判定，非本仓状态）。四包全部**可选·激活价**，不进 P1/P2/P3 标准节奏（标准=109 项、定制=15 项均不属 M3）。

- **payroll**：86 人员时薪｜Web｜已实现（个案资产）→ 参数化；87 工资核算｜Web｜已实现（个案资产）→ 参数化
- **maintenance**：18 设备维修和保养｜Web｜暂无；19 设备检验｜Web｜暂无；125 设备维修和保养｜移动｜暂无（PWA 镜像，呈现归 M5）；126 设备检验｜移动｜暂无（同上）
- **drawing**：37 工艺图纸管理｜Web｜暂无（移动查看=同 API，呈现归 M5）
- **metric-pack**：88 下图统计报表｜Web｜已实现（个案口径）→ 参数化；90 工作令交付报表；93 外协零件交货报表；94 采购件预期报表；95 采购件金额汇总表；97 项目成本报表（呈现部分；归集域在 M2 costing）——六张均已实现（个案口径）→ 参数化
- **边界排除项（不在 M3）**：89 库存报表、91 工作令工时报表、92 自制零件派工报工报表、96 自制零件入库日报表——标准 P3，归 M2 engine-reporting 基础层（见 m2-drafts/README 映射）；17 备品备件、21 OEE、22/23 能耗——定制，签约后排期；6 班组（考勤制度）——定制，薪酬包不覆盖

## 激活价商业语义 → 技术开关

D9/D8/ADR-0004 已定案"插件装配：应用注册表 + NestJS 动态模块 + feature flag；报价单可选模块行 = 代码开关，商业技术同一张表"。M3 落地对应关系：

| 商业语义 | 技术载体 | 现状 |
|---|---|---|
| 报价单可选模块行（一行 = 一个专业包） | app-registry 模块注册行（M1/M2 已有按需启停先例：注册不入默认清单 + `MODULES_ENABLED` 开关） | 形态已有，四包各一行 |
| 客户激活（签约付款） | 部署级：`MODULES_ENABLED` 含该包名；SaaS 形态：租户级 flag 打开 | 部署级开关 M1 已实证（boot.e2e `MODULES_ENABLED=core`）；**租户级 flag 粒度未实现 → R-M3-2** |
| 报表口径包激活（第二层：包内还要装载口径） | `metric-pack.activate.v1` 装载 MetricPack（packId@version）——开关开 + 口径装载才可见报表 | 引擎形状已有（MetricPack 可序列化），装载机制属 M3 实施 |
| 未激活 = 不可见 | 模块不注册 → 路由/权限码/待办/事件消费全不出现（M1 模块开关先例行为） | 已有先例 |

## 通用合同纪律（直接沿用 m2-drafts，写各包合同时不重复）

1. m2-drafts/README §通用合同纪律 8 条全部适用：CommandEnvelope（`{module}.{verb}.v1`）、证据列公共列+append-only+Outbox、状态机走 engine-flow 配置、权限码 `{domain}:{action}` 登记进 casbin、品牌化 ID、模块间只经端口、TenantContext、对账测试。
2. **G1 幂等记账口径**（m2 v1.1）：先解析校验后记账，被拒命令不占用 operationId。
3. **G2 建单类命令落账顺序**（m2 v1.1）：先落初始投影（draft/pending/scheduled@v1）再驱动首次迁移。
4. **词汇与量纲冻结**（m2 v1.1 沿用）：工种五词 part/assembly/electrical/aftermarket/oddjob；工时 hours 存储=小时（不取整）；金额=整数分（half-up 到分，baseline 计价先例）。
5. **专业包依赖铁律**（`pro-pack-tier-edges`）：专业包只依赖 business-core + engine-*；跨 M2 模块数据一律经端口/事实源在组合根接线，不直依 application（各包差异表逐项核对了预热草案的合规性）。

## 人日估算对照决策簿

| 包 | 建议人日 | 决策簿依据 |
|---|---|---|
| payroll | 6 | M3 总盘 30 人日内 |
| maintenance | 8 | 同上 |
| drawing | 7 | 同上 |
| metric-pack | 9 | 复用与自研"报表口径层 25 人日"（引擎本体已由预热线产出并验收，抵扣其中引擎部分；剩余口径参数化+呈现+事实源适配跨 M3 与对账阶段） |
| 合计 | 30 | 决策簿里程碑"M3 专业包+报表口径层 = 30 人日（第 14~18 周）" |

决策簿两处口径（M3 总盘 30 vs 复用与自研口径层 25）粒度不同未对齐，且引擎已预支——**R-M3-1 待 Owner 裁定**；上表为合同建议拆分，冻结时核定。

## 开放裁决项（R-M3）

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| R-M3-1 | 人日对账：M3 总盘 30 vs 口径层 25 vs 引擎预热已预支 | 排期与里程碑 | 按上表拆分核定，口径层剩余工作挂对账阶段 |
| R-M3-2 | 租户级 feature flag 形态（当前仅部署级 `MODULES_ENABLED`） | SaaS 形态激活价落地 | M4 SaaS 线一并定（TenantContext 内 flag 表） |
| R-M3-3 | 专业包↔application 接线方向：PayrollSource 等端口实现落组合根适配器（hours 不 import payroll），或按 .dep-cruiser.cjs pro-pack-tier-edges 规则注释"M3 正式实施按实际挂载方向经 ADR 放宽"另立 ADR | 依赖铁律与实施成本 | 组合根适配器（零 ADR 改动，本合同按此写） |
| R-M3-4 | `pro-pack-tier-edges` 规则清单补入 metric-pack 新包名 | CI 门禁 | M3 实施首波随包创建同步改 `.dep-cruiser.cjs` |
| R-M3-5 | payroll 计薪规则是否作为 costing/97 报表工时金额化价格源（工资口径 vs 成本口径是否同源） | 两套金额口径边界 | 默认不同源（工资≠成本），需要时经 metric-pack 口径定义引用 |
| R-M3-6 | 图纸保密等级值集与管控强度（水印/下载控制/查看留痕范围） | 图纸包激活价价值主张 | 值集=租户配置；管控初版=查看留痕+权限，水印/签名 URL 归实施层 |

## 自检清单（本草案自身，核验结果）

1. **映射完整性**：13 项可选逐项归属——86,87→payroll；18,19,125,126→maintenance；37→drawing；88,90,93,94,95,97→metric-pack；无遗漏无重复（对照拆解 V2 明细行 37/86/87/88/90/93/94/95/97/18/19/125/126）✓；边界排除项（P3 标准 4 张、定制项）均已显式登记 ✓。
2. **端口对称**：四包消费的每个端口/事实源，在 M2 合同"被依赖"节均有对应声明——payroll←08-hours §4"被依赖：M3 薪酬包"✓；maintenance←01-baseline §1 Out"设备维保/点检（M3 维保包）"+设备台账/FaultReport 对象 ✓；drawing←01-baseline §1 Out"图纸电子化（M3 图纸包）"+02-workorder 附件事实 ✓；metric-pack←09-costing §4"被依赖：engine-reporting/M3 口径包"+04-dispatch（外协评分呈现属口径包 open question）+03-listing §4 被依赖 ✓；反向：本草案不新增 M2 模块未声明的被依赖 ✓。
3. **术语一致**：工种五词与 hours/reporting 逐词一致（payroll scope.laborKind 值集、metric-pack 口径维度）✓；工时量纲=小时（hours 口径）、金额=分（payroll rate/amount、95/97 度量）✓；幂等口径 G1/G2 沿用 ✓；命令命名 `{module}.{verb}.v1` ✓。
4. **ADR-0011 合规**：三预热草案 import 面均为零（仅 business-core UserId）——字面合规 ✓；README 文字中的方向暗示（"由 hours 侧实现"）已在各差异表裁定为组合根适配器 ✓；metric-pack 新包名待补规则（R-M3-4）已登记 ✓。
5. **清洁室**：输入仅上表合法规格源；未引用 73 份雇主文档与现系统代码/字段（全部口径为行为重述）✓。
