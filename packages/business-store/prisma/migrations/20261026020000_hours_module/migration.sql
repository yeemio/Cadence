-- hours 模块三表（M2-W6，08-hours.md v1.0）。
--
-- 表形态分工（账本域，ADR-0010：无状态机；与 workorder/listing/inventory
-- 同一取舍，见 business-store schema.prisma 注释纪律）：
--   labor_entries         工时账目（append-only 事实，证据七公共列 TEXT 口径；
--                         (tenant_id, source_key) 唯一 = 报工联动幂等锚点；
--                         撤销/修正追加 reverse 条目（reverses 指回原条目），
--                         不改进原行；seq bigserial 插入序）；
--   labor_ledger_months   月度归集快照（人×月×工种一版一行；supersedes 自引用
--                         链——重算变更追加新版本行，重算幂等 = 值未变不追加；
--                         (tenant, worker, month, trade, version) 与
--                         (tenant, supersedes) 唯一 = 链线性不变量）；
--   hours_operations      命令幂等记账（smes.command.v1 不变量 3；运营表，
--                         不套证据公共列；联动派生 operationId 同走本表）。
--
-- 域事件（BusinessEvent + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建；hours 域事件端口 HoursDomainEventStore 的 PG
-- 适配即映射该两表——src/hours/pg-hours-stores.ts）。
--
-- 合流待办（application/src/hours 线已立）：schema.prisma 已增补三个 model
-- （同迁移）+ business-store `./hours` 子路径 PG 适配 + package.json exports；
-- app-registry 接线归总控（不改注册表纪律）。

-- CreateTable：工时账目（append-only 事实）
CREATE TABLE "labor_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "worker_id" TEXT NOT NULL,
    "work_date" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "process_code" TEXT,
    "hours" DOUBLE PRECISION NOT NULL,
    "output_qty" DOUBLE PRECISION,
    "direction" TEXT NOT NULL,
    "source_report_id" TEXT NOT NULL,
    "reverses" TEXT,
    "work_order_id" TEXT,
    "drawing_no" TEXT,
    "dispatch_id" TEXT,
    "source_key" TEXT NOT NULL,
    "remark" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "labor_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable：月度归集快照（可重算，supersedes 链）
CREATE TABLE "labor_ledger_months" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "total_hours" DOUBLE PRECISION NOT NULL,
    "output_qty" DOUBLE PRECISION NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "first_work_date" TEXT,
    "last_work_date" TEXT,
    "rebuilt_by" TEXT NOT NULL,
    "rebuilt_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labor_ledger_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "hours_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "hours_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "labor_entries_tenant_id_source_key_key" ON "labor_entries"("tenant_id", "source_key");

CREATE INDEX "labor_entries_tenant_id_worker_id_work_date_idx" ON "labor_entries"("tenant_id", "worker_id", "work_date");

CREATE INDEX "labor_entries_tenant_id_work_order_id_idx" ON "labor_entries"("tenant_id", "work_order_id");

CREATE INDEX "labor_entries_tenant_id_source_report_id_idx" ON "labor_entries"("tenant_id", "source_report_id");

CREATE UNIQUE INDEX "labor_ledger_months_tenant_id_worker_id_month_trade_object_version_key" ON "labor_ledger_months"("tenant_id", "worker_id", "month", "trade", "object_version");

CREATE UNIQUE INDEX "labor_ledger_months_tenant_id_supersedes_key" ON "labor_ledger_months"("tenant_id", "supersedes");

CREATE INDEX "labor_ledger_months_tenant_id_worker_id_month_idx" ON "labor_ledger_months"("tenant_id", "worker_id", "month");

CREATE UNIQUE INDEX "hours_operations_tenant_id_operation_id_key" ON "hours_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 inventory 迁移口径）：
--   工时条目与月度快照禁 UPDATE/DELETE（修正/重算走追加新行）；幂等记账
--   运营表豁免（写后不改，无修正语义）。
CREATE TRIGGER "labor_entries_append_only_guard"
  BEFORE UPDATE OR DELETE ON "labor_entries"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "labor_ledger_months_append_only_guard"
  BEFORE UPDATE OR DELETE ON "labor_ledger_months"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
