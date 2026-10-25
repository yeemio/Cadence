-- costing 模块四表（M2-W6，09-costing.md v1.0）。
--
-- 表形态分工（账本域，ADR-0010：无状态机）：
--   cost_entries       成本条目（append-only 事实，证据七公共列 TEXT 口径；
--                      (tenant_id, source_key) 唯一 = 来源单据幂等锚点；来源
--                      重定价追加 delta 条目（delta_of 指回基准），净额 =
--                      Σ 同基准条目；工时类条目 amount_minor 恒 NULL——存工时
--                      量，金额化在口径层，R6 边界）；
--   costing_models     口径版本（版本化主数据，形态同 process_defs：
--                      (tenant, code, object_version) 与 (tenant, supersedes)
--                      唯一；definition JSONB = 类别映射/时薪表/分摊规则）；
--   cost_snapshots     成本快照（工作令×口径 的重算结果；supersedes 链——
--                      重算变更追加新版本行，口径变更不改历史快照）；
--   costing_operations 命令幂等记账（运营表，不套证据公共列）。
--
-- 域事件不建新表：落既有通用 event_records / outbox_records（PG 适配见
-- src/costing/pg-costing-stores.ts）。合流待办同 hours 迁移头注。

-- CreateTable：成本条目（append-only 事实）
CREATE TABLE "cost_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount_minor" INTEGER,
    "quantity" DOUBLE PRECISION,
    "trade" TEXT,
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

    CONSTRAINT "cost_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable：口径版本（版本化主数据）
CREATE TABLE "costing_models" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "definition" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "costing_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable：成本快照（可重算，supersedes 链）
CREATE TABLE "cost_snapshots" (
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

    CONSTRAINT "cost_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "costing_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "costing_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_entries_tenant_id_source_key_key" ON "cost_entries"("tenant_id", "source_key");

CREATE INDEX "cost_entries_tenant_id_work_order_id_idx" ON "cost_entries"("tenant_id", "work_order_id");

CREATE INDEX "cost_entries_tenant_id_category_idx" ON "cost_entries"("tenant_id", "category");

CREATE UNIQUE INDEX "costing_models_tenant_id_code_object_version_key" ON "costing_models"("tenant_id", "code", "object_version");

CREATE UNIQUE INDEX "costing_models_tenant_id_supersedes_key" ON "costing_models"("tenant_id", "supersedes");

CREATE INDEX "costing_models_tenant_id_code_idx" ON "costing_models"("tenant_id", "code");

CREATE UNIQUE INDEX "cost_snapshots_tenant_id_work_order_id_model_code_model_version_object_version_key" ON "cost_snapshots"("tenant_id", "work_order_id", "model_code", "model_version", "object_version");

CREATE UNIQUE INDEX "cost_snapshots_tenant_id_supersedes_key" ON "cost_snapshots"("tenant_id", "supersedes");

CREATE INDEX "cost_snapshots_tenant_id_work_order_id_idx" ON "cost_snapshots"("tenant_id", "work_order_id");

CREATE UNIQUE INDEX "costing_operations_tenant_id_operation_id_key" ON "costing_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 hours 迁移口径）：条目/口径版本/快照禁 UPDATE/DELETE
-- （修正/重定价/重算走追加新行）；幂等记账运营表豁免。
CREATE TRIGGER "cost_entries_append_only_guard"
  BEFORE UPDATE OR DELETE ON "cost_entries"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "costing_models_append_only_guard"
  BEFORE UPDATE OR DELETE ON "costing_models"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "cost_snapshots_append_only_guard"
  BEFORE UPDATE OR DELETE ON "cost_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
