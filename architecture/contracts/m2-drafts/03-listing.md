# 03 · listing —— 清单与采购环节模块（物料主线前段）

v1.0（2026-10-25 冻结，R1 已裁定采纳）｜依据：功能项 31~34,54~56,59~62,73~76｜流程拆解阶段 3（采购准备）｜裁决项 R1

## 1. 环节身份与边界

**身份**：需求→获取——四类清单为需求源，驱动三类采购闭环到到货前段（数据流：清单→采购申请→订单→收货→(质检放行)→库存）。
**In**：四类清单（零件/标准件/电气件/设备采购）、清单导入与物料校验执行、缺口核查（清单×库存可用量）、三类采购申请、采购订单（提交/审核/下发/收货/退货）、采购明细查询、采购件逾期事实。
**Out**：到货质检（inspection）；入库（inventory，收货确认后放行）；物料库本身（masterdata）；询价/竞价（定制，SRM）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| ListingSheetId | 清单（ListingSheet） | kind ∈ 零件/标准件/电气件/设备采购；从 WorkOrderCreated 生成 |
| ListingLineId | 清单行 | 图号/物料/数量/需求日期；校验状态 |
| PurchaseRequestId | 采购申请 | kind ∈ 非标件/标准配件/设备；来源=清单缺口或手工 |
| PurchaseOrderId | 采购订单 | 明细行、供应商、交期；`draft → submitted → approved → issued → received`（+退货回退） |
| PurchaseReturnId | 退货单 | 收货异常撤回/退货 |

**状态机（engine-flow 配置）**：PurchaseOrder 五态（审核走 engine-flow 审批链）；PurchaseRequest `draft → approved → converted`；清单行为版本化数据（校验状态字段，非状态机）。

**分层标注（ADR-0010 三层）**：内核概念=订单/申请状态集与迁移语义（engine-flow 内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=审批链初版层级与逾期口径（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`listing.import.v1`（从工作令导入/Excel 导入，经物料校验端口）、`listing.line.update`、`gap.check.v1`（核查：需求 vs 可用量 → 缺口行）、`purchase.request.create`（可由缺口一键发起）、`purchase.order.submit/approve/issue/receive`、`purchase.return.create/revoke`。
查询：四类清单（按工作令）、缺口核查结果、订单全流程视图、采购明细（可导出，ExcelJS）、逾期未交明细（事实，呈现经 engine-reporting）。

## 4. 端口

- **依赖（M1）**：masterdata（物料库，core 模块间端口）、engine-flow（订单审批）；存储走端口（business-store 实现，apps/server 组合根接线，ADR-0011）；ExcelJS 导入导出（复刻表头别名校验行为）。
- **依赖（M2）**：baseline 物料校验端口、workorder（清单挂接与创建事件）、inventory 端口（可用量供缺口核查；收货后入库指令）。
- **被依赖**：workorder（齐套消费清单需求行）、inventory（收货单→入库指令来源）、dispatch（外协单工序/图号来源）、inspection（到货质检对象来源）、engine-reporting（采购件逾期/金额汇总报表；采购金额经 inventory 入库金额间接进 costing）。

## 5. 权限码

`listing:read|write|import`、`gap:read`、`purchase:read|request|order|approve|receive|return`。

## 6. 事件

`ListingImported`、`ListingLineValidated`、`GapChecked`、`PurchaseRequested`、`PurchaseOrderSubmitted/Approved/Issued/Received`（→库存入库指令）、`PurchaseReturned`、`PurchaseOverdue`（→待办催货）。

## 7. Done-when 与对账要点

- **Done-when**：工作令创建后四类清单可导入并完成物料校验；缺口核查给出可发起采购的缺口行并一键生成申请；采购订单走完 提交-审核-下发-收货 并驱动入库；逾期件进入待办催货。
- **对账**：同清单经物料校验与缺口计算，输出与活系统一致；订单收货数量×单价金额汇总口径一致；Excel 导入的表头别名与错误行提示行为等价（决策簿 D13 导入复刻口径）。

## 8. Open questions

- 三类采购申请的审批层级数按客户配置（engine-flow 配置化，不写死）。
- 设备采购（金额大、周期长）是否需要独立分期到货跟踪视图——对账阶段看活系统行为再定。
