-- baseline P1（M2-W2）：工序库/设备台账/外协计价规则（版本化主数据，append-only
-- + supersedes 修正链）+ 物料校验运行（执行事实）+ 命令幂等账本（运营表）。
-- 事件与 Outbox 复用既有 event_records / outbox_records（本迁移不建）。

-- CreateTable
CREATE TABLE "process_defs" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_records" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsourcing_price_rules" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "process_code" TEXT NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "margin_permyriad" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outsourcing_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_validation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_command_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_command_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "process_defs_id_tenant_id_key" ON "process_defs"("id", "tenant_id");

CREATE UNIQUE INDEX "process_defs_tenant_id_supersedes_key" ON "process_defs"("tenant_id", "supersedes");

CREATE UNIQUE INDEX "process_defs_tenant_id_code_object_version_key" ON "process_defs"("tenant_id", "code", "object_version");

CREATE INDEX "process_defs_tenant_id_code_idx" ON "process_defs"("tenant_id", "code");

CREATE UNIQUE INDEX "equipment_records_id_tenant_id_key" ON "equipment_records"("id", "tenant_id");

CREATE UNIQUE INDEX "equipment_records_tenant_id_supersedes_key" ON "equipment_records"("tenant_id", "supersedes");

CREATE UNIQUE INDEX "equipment_records_tenant_id_code_object_version_key" ON "equipment_records"("tenant_id", "code", "object_version");

CREATE INDEX "equipment_records_tenant_id_code_idx" ON "equipment_records"("tenant_id", "code");

CREATE UNIQUE INDEX "outsourcing_price_rules_id_tenant_id_key" ON "outsourcing_price_rules"("id", "tenant_id");

CREATE UNIQUE INDEX "outsourcing_price_rules_tenant_id_supersedes_key" ON "outsourcing_price_rules"("tenant_id", "supersedes");

CREATE UNIQUE INDEX "outsourcing_price_rules_tenant_id_code_object_version_key" ON "outsourcing_price_rules"("tenant_id", "code", "object_version");

CREATE INDEX "outsourcing_price_rules_tenant_id_process_code_idx" ON "outsourcing_price_rules"("tenant_id", "process_code");

CREATE UNIQUE INDEX "material_validation_runs_id_tenant_id_key" ON "material_validation_runs"("id", "tenant_id");

CREATE INDEX "material_validation_runs_tenant_id_created_at_idx" ON "material_validation_runs"("tenant_id", "created_at");

CREATE UNIQUE INDEX "baseline_command_operations_tenant_id_operation_id_key" ON "baseline_command_operations"("tenant_id", "operation_id");

-- AddForeignKey（supersedes 修正链：同租户内自引用，防跨租户 supersedes）
ALTER TABLE "process_defs" ADD CONSTRAINT "process_defs_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "process_defs"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "equipment_records" ADD CONSTRAINT "equipment_records_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "equipment_records"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "outsourcing_price_rules" ADD CONSTRAINT "outsourcing_price_rules_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "outsourcing_price_rules"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- append-only 护栏（同 work_order_records 口径）：版本化主数据与校验事实禁 UPDATE/DELETE。
-- baseline_command_operations 豁免：幂等账本是运营表（同 outbox 取舍）。
CREATE TRIGGER "process_defs_append_only_guard"
  BEFORE UPDATE OR DELETE ON "process_defs"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "equipment_records_append_only_guard"
  BEFORE UPDATE OR DELETE ON "equipment_records"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "outsourcing_price_rules_append_only_guard"
  BEFORE UPDATE OR DELETE ON "outsourcing_price_rules"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "material_validation_runs_append_only_guard"
  BEFORE UPDATE OR DELETE ON "material_validation_runs"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
