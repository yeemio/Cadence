-- fix-wave-6 6b-1（PRD 11 册 RREQ-MD-020 / S9）物品初始价格列：items 追加
-- initial_price_minor（可空整数分，≥0 应用侧收口；存量行 null = 未维护）。
-- 选填维护、清空保存（置 null）即取消——成本取价兜底联动归 costing 对账
-- 口径，本批不做（U9 中止教训：不扩盘）。
--
-- 纯加列：无新表 → RLS 表清单（src/rls/tables.ts）与全量重放快照
-- （20261026200100）零变更；本迁移不混入 RLS 语句（同
-- 20261026210000_outsourcing_line_cancel_columns 先例）。
-- 价格台账（RREQ-MD-019）不建自有表：数据源 = listing 采购订单明细
-- （purchase_orders.lines）只读消费，见 src/masterdata/pg-masterdata-stores.ts
-- 的 PgItemPriceLedgerStore。

-- AlterTable：初始价格（含税单价，分；可空 = 未维护/已取消）
ALTER TABLE "items" ADD COLUMN "initial_price_minor" INTEGER;
