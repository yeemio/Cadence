-- U7 项目成本六块三表（A5 项目成本报表：六块成本聚合 + 成本快照 + 录入价格；
-- 文档《项目成本报表》§1.3 七张结果表的 Cadence 合一重述——段事实 append-only +
-- 六块快照 supersedes 链 + 录入价格运营投影，口径差异登记对账）。
--
-- 表形态（账本域取舍，schema.prisma costing U7 节同文）：
--   cost_project_entries     段事实（append-only：证据七公共列 + seq；(tenant_id,
--                            source_key) 唯一 = 段幂等锚点；来源漂移追加 delta
--                            条目 delta_of 指回基准，净额 = Σ 同基准）；
--   cost_project_snapshots   六块快照（工作令×口径 supersedes 链；重算幂等 =
--                            值未变不追加新行；totals JSONB = 六块合计+块明细
--                            ——legacy 七表合一落点）；
--   cost_price_entries       录入价格（运营投影可 UPDATE：一行 = 一条发料明细行，
--                            重录覆盖；不套证据公共列——取舍同 issue_records；
--                            写回发料明细经端口单向通知，本表即成本口径唯一事实）。
-- 域事件复用既有 event_records / outbox_records；命令幂等复用 costing_operations。
-- RLS 同批补登：src/rls/tables.ts 三行 + 全量重放迁移 20261026170100（101 表快照）。

-- CreateTable：项目成本段事实（append-only）
CREATE TABLE "cost_project_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "segment" TEXT,
    "line_kind" TEXT,
    "amount_minor" INTEGER,
    "quantity" DOUBLE PRECISION,
    "trade" TEXT,
    "supplier_ref" TEXT,
    "equipment_ref" TEXT,
    "source_type" TEXT NOT NULL,
    "source_ref_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "delta_of" TEXT,
    "work_date" TEXT,
    "remark" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "cost_project_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable：项目成本六块快照（supersedes 链）
CREATE TABLE "cost_project_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "model_code" TEXT NOT NULL,
    "model_version" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,
    "rebuilt_by" TEXT NOT NULL,
    "rebuilt_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_project_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable：录入价格（运营投影 upsert）
CREATE TABLE "cost_price_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "task_line_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_line_id" TEXT,
    "reserved_qty" DOUBLE PRECISION NOT NULL,
    "unit_price_minor" INTEGER,
    "total_minor" INTEGER,
    "amount_manual" BOOLEAN NOT NULL DEFAULT false,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_price_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：段事实幂等锚点 + 热路径（租户前导 = RLS 索引前导断言同源）
CREATE UNIQUE INDEX "cost_project_entries_tenant_id_source_key_key" ON "cost_project_entries"("tenant_id", "source_key");
CREATE INDEX "cost_project_entries_tenant_id_work_order_id_idx" ON "cost_project_entries"("tenant_id", "work_order_id");
CREATE INDEX "cost_project_entries_tenant_id_block_idx" ON "cost_project_entries"("tenant_id", "block");

-- CreateIndex：六块快照链不变量 + 热路径
CREATE UNIQUE INDEX "cost_project_snapshots_tenant_id_work_order_id_model_code_model_version_object_v_key" ON "cost_project_snapshots"("tenant_id", "work_order_id", "model_code", "model_version", "object_version");
CREATE UNIQUE INDEX "cost_project_snapshots_tenant_id_supersedes_key" ON "cost_project_snapshots"("tenant_id", "supersedes");
CREATE INDEX "cost_project_snapshots_tenant_id_work_order_id_idx" ON "cost_project_snapshots"("tenant_id", "work_order_id");

-- CreateIndex：录入价格行锚唯一 + 工作令读面
CREATE UNIQUE INDEX "cost_price_entries_tenant_id_work_order_id_record_id_task_line_id_key" ON "cost_price_entries"("tenant_id", "work_order_id", "record_id", "task_line_id");
CREATE INDEX "cost_price_entries_tenant_id_work_order_id_idx" ON "cost_price_entries"("tenant_id", "work_order_id");
