# M2 九模块合同（m2-drafts）

版本：v1.1（2026-10-26 增补登记；v1.0 正文 2026-10-25 冻结不动，增补见文末"v1.1 增补登记"节）｜状态：**v1.0 正文冻结 + v1.1 增补生效（R1~R6 裁定维持，Owner 保留推翻权；R7/R8 仍开放**
生成人：zcode-cadence-m2-spec 线（RunKit WI `wi-m2-spec-prep`）｜消费方：代码实施线（另一会话，`wi-m1-remaining` 收口后按此派发 M2）

## 规格源（清洁室合法输入，均已全量读取）

| 文档 | 位置 | 用途 |
|---|---|---|
| 交接文档 V1.0（§7/§9/§10） | `S-mes/HANDOFF-重构交接V1.0.md` | 九模块定义、里程碑、清洁室纪律 |
| 功能清单拆解 V2（137 项三值判定） | `03-产品用/机加工MES功能清单-标准定制拆解V1.0.xlsx` | 功能项 → 模块映射的唯一依据 |
| 工厂流程拆解（10 阶段/12 角色/8 状态机/6 洞察） | `04-交付用/机加工MES工厂业务流程与场景拆解V1.0.xlsx` | 环节边界、状态机、数据流咬合 |
| 技术选型决策簿 V1.0（D1~D14+ADR×7+270 人日） | `03-产品用/S-mes重构技术选型决策簿V1.0.xlsx` | 架构与模块化、复用与自研、人日 |

原文导出件：`/Users/yeemio/AI/gitrep/cadence-runkit/evidence/m2-spec/spec-sources-dump.txt`。
**禁用输入**：`AI/gitrep/sieracMes-AI/docs/开发文档/` 73 份雇主文档、现系统任何代码/SQL/模板（清洁室纪律 D11）。

## 模块文件索引

| 文件 | 模块 | 环节身份 | 建议 P 波次 |
|---|---|---|---|
| [01-baseline.md](01-baseline.md) | baseline | 技术准备（工艺/工时/校验/设备台账） | P1 部分+P2/P3 |
| [02-workorder.md](02-workorder.md) | workorder | 工作令全生命周期（含齐套编排、配件申请） | P1 |
| [03-listing.md](03-listing.md) | listing | 清单与采购（物料主线前段：需求→到货） | P1 |
| [04-dispatch.md](04-dispatch.md) | dispatch | 六类派工（含外协） | P2 |
| [05-reporting.md](05-reporting.md) | reporting | 报工与核查（五类） | P2 |
| [06-inspection.md](06-inspection.md) | inspection | 四类质检与不合格闭环 | P1 |
| [07-inventory.md](07-inventory.md) | inventory | 库存域（收发存/盘点/发货执行） | P1 |
| [08-hours.md](08-hours.md) | hours | 五类工时归集 | P3 |
| [09-costing.md](09-costing.md) | costing | 项目成本归集与重算 | P3 |

生成顺序建议（M2 内部，P1 优先）：**workorder → baseline（P1 件：工序/物料校验/外协计价/设备档案，供 listing/dispatch 依赖）→ listing → inspection → inventory → dispatch → reporting → baseline（P2/P3 件：工艺路线/额定工时/故障上报）→ hours → costing**。M2 总盘 115 人日（决策簿），九模块均按需启停（feature flag，D9）。

## 137 功能项 → 模块映射总表

标注：`序号.功能｜P波次`。移动端镜像项（105~137）逻辑归各模块 API、呈现归 M5 PWA，此处按逻辑归属登记。

- **core 基础层（M1 已建，不属 M2）**：1,2 工作台；3,4,5,7 组织权限；8,9,11 基础信息（客户/供应商/物料=masterdata）；98~103 系统管理；105,106 移动首页/待办
- **baseline**：10 工序管理｜P1；12 物料校验｜P1；13 外协计价配置｜P1；16 设备档案｜P1；20 故障上报｜P2；35 工艺路线｜P2；36 额定工时｜P3；127 故障上报(移)｜P2
- **workorder**：24,25 工作令信息/申请｜P1；26 配件申请｜P1；27,28,29 三类进度｜P1；30 物料齐套检查｜P2；117,118 配件申请/审批(移)｜P2；134 工作令进度查询(移)｜P2
- **listing**：31~34 四类清单｜P1；54~56 三类采购申请｜P1；59~62 采购订单/收货/退货/明细｜P1；73~76 四类缺口核查｜P1
- **dispatch**：38~43 六类派工（零件/外协/装配/电气/售后/零工）｜P2
- **reporting**：44~48 五类报工｜P2；49~53 五类报工核查｜P2；107~114 移动生产作业｜P2；115,116 售后报工/记录管理(移)｜P2；135 图号工序进度查询(移)｜P2；136 我的报工(移)｜P2
- **inspection**：63~66 四类质检｜P1；119~122 移动质检｜P2
- **inventory**：14 仓库与库位｜P1；71,72 发货任务/记录｜P1；77~80 三类入库+出库｜P1；81 实时库存｜P1；82 调拨移库｜P2；83 盘点｜P2；128~133 移动仓储｜P2
- **hours**：84 机加工时统计｜P3；85 工时汇总｜P3；137 我的工时统计(移)｜P2
- **costing**：97 项目成本（归集域部分，呈现见 engine-reporting）｜P3
- **engine-reporting（基础层组件，非九模块）**：89,91,92,96 标准 4 张报表｜P3；88,90,93,94,95,97 口径 6 张→M3 报表口径包
- **M3 专业包（非 M2）**：18,19,125,126 维保包；37 图纸包；86,87 薪酬包
- **定制（非 M2，签约后排期）**：6 班组；15 货架；17 备件；21~23 OEE/能耗；57,58 询价竞价；67~70,123,124 深度QMS；104 接口管理

## 通用合同纪律（九模块共同遵守，写各自合同时不重复）

1. **命令层**：一切写操作走 `smes.command.v1` CommandEnvelope（operationId + expectedRevision 乐观锁）；命令命名 `{module}.{verb}.v1`。
2. **证据列**：全部业务表带公共列（uuidv7/objectVersion/audit_status/provenance JSONB/supersedes/business_time/available_time）+ append-only 事件表 + Outbox，对齐 `architecture/contracts/evidence-columns.v1.md`。
3. **状态机**：各模块状态机以 engine-flow 配置形态定义（ADR-0010 状态集配置分离），不写死在代码；审批流走 engine-flow + DomainReview 形状。
4. **权限码**：`{domain}:{action}` 风格，登记进 casbin 策略；每合同列出最小权限码集。
5. **品牌化 ID**：每合同列出新增 Brand<T,Name>。
6. **依赖铁律**：business-core ← application(九模块) ← business-store/product-ui/integration-*；模块间只经端口（application 层接口）互调，禁止跨模块直写他表。
7. **多租户**：全程 TenantContext，单租户零开销（D7）。
8. **对账测试**：每模块 Done-when 附行为等价对账要点（同输入同输出黑盒比对活系统，清洁室纪律 3）。

## 裁决记录（v1.0 冻结依据，2026-10-25）

R1~R6 由总控（M2 拆解线）按推荐裁定采纳，依据：code-reviewer（GLM-5.3，agent_bc39fc52）只读审读 **映射忠实度/边界合理性/内部一致性/清洁室合规 四问通过**，7 项必改（依赖方向 ADR-0011 对齐、端口镜像、137 波次、依据行、生成顺序、措辞、ADR-0010 三层标注）已全部修复后冻结。**Owner 保留推翻权：任一裁定被推翻即升 v1.1 并同步代码线。**

| # | 事项 | 裁定 | 依据摘要 |
|---|---|---|---|
| R1 | 采购闭环归属 listing 模块（"清单与采购"物料主线前段） | **采纳** | 数据流"清单→采购申请→库存"；备选归属（inventory/单设采购模块）均劣 |
| R2 | 物料齐套检查归 workorder（跨 listing/inventory 编排点） | **采纳** | 功能项 30 一级菜单即工作令管理；"齐套后放装配派工"由 dispatch 硬拦截消费 |
| R3 | baseline=技术准备环节，masterdata 保通用主数据 | **采纳** | 流程阶段 2 页面（工艺路线/额定工时/物料校验）全归 baseline，接缝干净 |
| R4 | 仓库与库位主数据归 inventory | **采纳** | 实物账域骨架随域走 |
| R5 | 配件申请归 workorder（审批走 engine-flow、出库走 inventory） | **采纳** | 功能项 26 一级菜单即工作令管理；阶段 8 链路完整 |
| R6 | costing 管归集与重算域，口径参数化= M3 报表口径包 | **采纳** | 决策簿"口径定义即数据、可版本化可售卖" |
| R7 | live 比 0920 清单多 9 项，待 Owner 确认刷新 | **开放（不阻塞冻结）** | 确认后映射表增量升版 |
| R8 | A 批移动扫码报工 +12 人日是否并入 M2 | **开放（不阻塞冻结）** | 影响 M2 排期，不影响合同内容 |

## v1.1 增补登记（2026-10-26，总控依实施与验收事实增补；对 v1.0 正文生效，正文版面不动）

**通用纪律修订**：
- G1 幂等记账口径统一为"先解析校验后记账"（被拒命令不占用 operationId；inventory 例外序：sourceKey 去重最先，命中即回首次结果）
- G2 建单类命令落账顺序：先落初始投影（draft/pending/open@v1）再驱动首次迁移（PG 机器账本按投影行解析租户 fail-fast 的合同推论）

**命令面增补**（合同 §3 未列、实施必需，均已登记测试）：
- 03-listing：`purchase.overdue.scan.v1`（逾期催货触发面）、`listing.line.update.v1`（命名归一）
- 06-inspection：`inspection.overdue.scan.v1`（超时点名触发面，信封命令）
- 08-hours：`hours.ingest.v1`（reportFeed 消费触发面）

**权限码增补**：01-baseline `material-validation:read`（校验执行走端口、HTTP 只开读）

**词汇与量纲冻结**：
- 工种类五词 part/assembly/electrical/aftermarket/oddjob（reporting 与 hours 逐词一致；工种映射 machining/assembly/electrical/aftercare/misc）
- 工时量纲：reporting 载荷=整数分钟 (0,44640]，hours 存储=小时（minutesToHours，不取整）

**开放议题（v1.2 候选/对账阶段）**：
- 供应商直推派工待办（04-dispatch Done-when 有语、端口未定义——需供应商身份模型裁定）
- 01-baseline standardtime 无 revise 命令（误录不可修正）；fault REJECT 回退无命令面
- costing 材料金额口径初版：issue-out × listing PO 最新已定价单价，无价不归集，冲减面待采购退货链路
- reporting 修正链（audit-edit）的 hours 联动走 adjust-entry，组合态联动未自动化

**实施裁定口径登记**（对账阶段按活系统校正）：盘点双口径（调账 movement=实盘−当前账面；审计差异=实盘−开单快照）、混合判定整单进 failed、复检不重建明细、closed 无放行量、costing delta 条目永不改原行、hours reverse 取账本末轮值、listing listOrder=链尾口径、可报派工状态集 assigned|executing、批量上限 50

## 清洁室核查（本草案自身）

- 输入仅上表 4 份合法规格源 ✓；未引用 73 份雇主文档 ✓；未引用现系统代码/字段 ✓（所有字段口径为行为需求重述）。
- 涉及依赖均为已定案白名单件（refine/XState/casbin/ExcelJS/pdfmake/ECharts，D13）✓。
- 本草案位于 Cadence 仓 `architecture/contracts/m2-drafts/`，为 M2 代码线唯一生成输入；实施时如需字段级补充，走"行为重述+对账反推"，不得回抄原文档。
