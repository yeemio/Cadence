# 07 · inventory —— 库存环节模块（收发存）

v1.0（2026-10-25 冻结，R1~R6 已裁定）｜依据：功能项 14,71,72,77~83,128~133｜流程拆解阶段 7（交付）+ 库存账/洞察 2（齐套数据源）｜裁决项 R4

## 1. 环节身份与边界

**身份**：实物账——入库（质检/收货放行驱动）、出库（发料/配件发货）、调拨移库、盘点调账、实时库存（可用量=总量−预占）。
**In**：仓库与库位主数据、三类入库（非标件/标准配件/设备）、出库与发货执行（生产发料/配件发料）、调拨/移库台账、盘点与盘盈亏调账、实时库存与预占。
**Out**：清单缺口计算（listing 消费可用量）；齐套判定（workorder 消费）；货架/立库（定制）；库存报表呈现（engine-reporting）。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| WarehouseId / LocationId | 仓库/库位 | 主数据（裁决 R4） |
| StockAccountId | 库存账（StockAccount） | 物料×仓库 维度的现存量与预占 |
| StockMovementId | 出入库流水（StockMovement） | append-only；来源单据引用（入库单/出库单/调拨/盘点/发货） |
| StocktakeId | 盘点（Stocktake） | 盘点单→实盘→差异→审核调账 |
| TransferId | 调拨/移库 | 跨仓调拨台账 + 仓内移库换位 |
| ShippingOrderId | 发货任务/记录 | 生产发料与配件发料执行、物流信息 |

**状态机（engine-flow 配置）**：Stocktake `draft → counting → reconciled(审核) → adjusted`；ShippingOrder `draft → executing → shipped`。入库/出库单本身为凭证（证据列承载，非状态机）。**预占规则**：派工/发料创建即预占，完工入库/出库核销。

**分层标注（ADR-0010 三层）**：内核概念=盘点/发货状态集与迁移语义、可用量=总量−预占恒等式（engine-flow 内核与领域内核承载）；模块 schema=上表实体/命令/事件（本模块版本化）；默认配置=预占粒度与负库存策略初版（实施时按客户口径调整，不属内核）。

## 3. 命令与查询

命令：`stock.receive.v1`（校验放行事实）、`stock.issue.v1`、`stock.transfer.v1`、`stocktake.open/record/approve-adjust.v1`、`shipping.execute/confirm.v1`、`warehouse.define.v1`。
查询：实时库存（可用量口径）、库位分布、出入库流水、盘点台账、发货记录、移动端库存查询/盘点录入。

## 4. 端口

- **依赖（M1）**：engine-flow（盘点/发货流转）、casbin 鉴权执行（core 中间件）；存储与扫码走端口——StockRepo / ScanPort 由 business-store / integration-scan 实现、apps/server 组合根接线（ADR-0011）。
- **依赖（M2）**：inspection（放行事实）、listing（收货单）、workorder（发料任务/配件发货指令）。
- **被依赖**：workorder 齐套（可用量）、listing 缺口核查（可用量）、costing（材料成本归集——含采购入库金额）、engine-reporting（库存报表/入库日报）。

## 5. 权限码

`warehouse:read|write`、`stock:read|receive|issue|transfer`、`stocktake:read|record|approve`、`shipping:read|execute`。

## 6. 事件

`StockReceived/Issued`（→齐套与缺口重算信号）、`StockTransferred`、`StocktakeAdjusted`（审计留痕）、`ShippingConfirmed`（→workorder 待发货→已发货联动）。

## 7. Done-when 与对账要点

- **Done-when**：三类入库需质检放行才可执行；出库核销预占且可用量实时正确；盘点走实盘-审核-调账且调账留痕；发货确认联动工作令状态；移动端可查库存、可盘点。
- **对账**：同业务序列后的"可用量=总量−预占"逐物料一致；盘点差异调账后的台账与活系统一致；发货→工作令"已发货"联动行为等价。

## 8. Open questions

- 预占的粒度（按清单行/按派工单/按发料任务）——对账阶段以活系统行为反推后定，影响齐套口径。
- 负库存策略（允许账面负数暂存 vs 硬拒绝）——实施配置化，默认硬拒绝。
