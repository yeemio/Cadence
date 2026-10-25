-- payroll 模块四表（M3，m3-drafts/01-payroll.md v1.0）。
--
-- 表形态分工（账本域，ADR-0010：无状态机）：
--   payroll_rules     计薪规则版本（版本化主数据，形态同 costing_models：
--                     (tenant, rule_id, object_version) 与 (tenant, supersedes)
--                     唯一；rule_id = kebab 业务身份跨版本稳定；scope JSONB =
--                     personId/laborKind/projectId 适用面——86 人员时薪主场景；
--                     量纲 rate_minor=分/小时整数、coefficient 缺省 1）；
--   pay_runs          核算批次快照（人×月一版一行，supersedes 链线性不变量；
--                     rule_versions JSONB = 本批次规则版本集，历史按当时版本
--                     可复算；重算幂等 = 同规则版本集合同事实不追加新行）；
--   earnings_records  薪酬记录（append-only 核算产出事实，证据七公共列 TEXT
--                     口径；(tenant, source_key) 唯一 = 核算行幂等锚点；重算
--                     逐条重写新行不改原行；source_refs JSONB = 来源工时账目
--                     id 集，下钻 hours LaborEntry）；
--   payroll_operations 命令幂等记账（运营表，不套证据公共列）。
--
-- 域事件不建新表：落既有通用 event_records / outbox_records（PG 适配见
-- src/payroll/pg-payroll-stores.ts）。合流待办同 hours/costing 迁移头注。

-- CreateTable：计薪规则版本（版本化主数据）
CREATE TABLE "payroll_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "name" TEXT,
    "basis" TEXT NOT NULL DEFAULT 'hours',
    "rate_minor" INTEGER NOT NULL,
    "coefficient" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scope" JSONB NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable：核算批次快照（可重算，supersedes 链）
CREATE TABLE "pay_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "period_kind" TEXT NOT NULL DEFAULT 'month',
    "rule_versions" JSONB NOT NULL,
    "total_quantity" DOUBLE PRECISION NOT NULL,
    "total_amount_minor" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "computed_by" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable：薪酬记录（append-only 核算产出事实）
CREATE TABLE "earnings_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "person_id" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "labor_kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "rate_minor" INTEGER NOT NULL,
    "coefficient" DOUBLE PRECISION NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "pay_run_id" TEXT NOT NULL,
    "source_refs" JSONB NOT NULL,
    "source_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "earnings_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "payroll_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "payroll_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_rules_tenant_id_rule_id_object_version_key" ON "payroll_rules"("tenant_id", "rule_id", "object_version");

CREATE UNIQUE INDEX "payroll_rules_tenant_id_supersedes_key" ON "payroll_rules"("tenant_id", "supersedes");

CREATE INDEX "payroll_rules_tenant_id_rule_id_idx" ON "payroll_rules"("tenant_id", "rule_id");

CREATE UNIQUE INDEX "pay_runs_tenant_id_period_key_person_id_object_version_key" ON "pay_runs"("tenant_id", "period_key", "person_id", "object_version");

CREATE UNIQUE INDEX "pay_runs_tenant_id_supersedes_key" ON "pay_runs"("tenant_id", "supersedes");

CREATE INDEX "pay_runs_tenant_id_period_key_idx" ON "pay_runs"("tenant_id", "period_key");

CREATE INDEX "pay_runs_tenant_id_person_id_idx" ON "pay_runs"("tenant_id", "person_id");

CREATE UNIQUE INDEX "earnings_records_tenant_id_source_key_key" ON "earnings_records"("tenant_id", "source_key");

CREATE INDEX "earnings_records_tenant_id_period_key_person_id_idx" ON "earnings_records"("tenant_id", "period_key", "person_id");

CREATE INDEX "earnings_records_tenant_id_pay_run_id_idx" ON "earnings_records"("tenant_id", "pay_run_id");

CREATE UNIQUE INDEX "payroll_operations_tenant_id_operation_id_key" ON "payroll_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 hours/costing 迁移口径）：规则版本/批次快照/薪酬记录禁
-- UPDATE/DELETE（改价/重算走追加新行）；幂等记账运营表豁免。
CREATE TRIGGER "payroll_rules_append_only_guard"
  BEFORE UPDATE OR DELETE ON "payroll_rules"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "pay_runs_append_only_guard"
  BEFORE UPDATE OR DELETE ON "pay_runs"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "earnings_records_append_only_guard"
  BEFORE UPDATE OR DELETE ON "earnings_records"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
