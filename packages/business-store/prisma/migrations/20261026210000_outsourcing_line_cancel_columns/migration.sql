-- fix-wave-6 6a-1（RREQ-DP-031）外协明细行取消两列：outsourcing_lines 追加
-- cancelled_at / cancel_reason（可空，存量行 null = 未取消）。行是版本化数据
-- （非状态机）：cancel 落取消事实（原因 + 时刻）并按 object_version 条件更新
-- +1 版本，与单价补录（backfillPrice）同一乐观口径——写入面见
-- src/dispatch/pg-dispatch-stores.ts 的 PgOutsourcingLineStore.cancel。
--
-- 纯加列：无新表 → RLS 表清单（src/rls/tables.ts）与全量重放快照
-- （20261026200100）零变更；本迁移不混入 RLS 语句。

-- AlterTable：行取消事实两列（取消时刻 + 原因）
ALTER TABLE "outsourcing_lines" ADD COLUMN "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "outsourcing_lines" ADD COLUMN "cancel_reason" TEXT;
