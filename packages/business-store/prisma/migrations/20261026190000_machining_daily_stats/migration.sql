-- A10 每日机加工进度统计日表（PRD 20 册 RREQ-RP-027）：报表域自持统计快照，
-- 运营投影形态（存在则更新否则插入——不套证据公共列，取舍同 cost_price_entries）。
-- 两指标列 nullable = 读面缺失登记不做（清单行加工类型/入库状态 + 工序机加/
-- 表处分类三读面缺失；公式冻结见 application machining-daily-stores.ts 头注）。
-- RLS 同批补登：src/rls/tables.ts + 全量重放迁移 20261026190100。

-- CreateTable
CREATE TABLE "machining_daily_stats" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statistics_date" TEXT NOT NULL,
    "surface_treatment_drawing_count" INTEGER,
    "pending_machining_count" INTEGER,
    "pending_reasons" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "computed_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machining_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machining_daily_stats_tenant_id_statistics_date_key" ON "machining_daily_stats"("tenant_id", "statistics_date");
