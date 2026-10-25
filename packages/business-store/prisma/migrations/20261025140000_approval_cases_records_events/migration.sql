-- 审批三表（M1 收尾波-①）：案件行（投影）+ 决策记录账本 + 迁移事件账本。
-- (aggregate_id, aggregate_revision) 唯一 = DB 级乐观锁（并发同版本迁移必拒其一）。

-- CreateTable
CREATE TABLE "approval_cases" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "submitter_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "object_version" INTEGER NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "approval_events_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "approval_cases_tenant_id_state_idx" ON "approval_cases"("tenant_id", "state");

CREATE INDEX "approval_cases_tenant_id_created_at_idx" ON "approval_cases"("tenant_id", "created_at");

CREATE INDEX "approval_records_tenant_id_aggregate_id_idx" ON "approval_records"("tenant_id", "aggregate_id");

CREATE UNIQUE INDEX "approval_events_event_id_key" ON "approval_events"("event_id");

CREATE UNIQUE INDEX "approval_events_aggregate_id_aggregate_revision_key" ON "approval_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "approval_events_tenant_id_aggregate_id_seq_idx" ON "approval_events"("tenant_id", "aggregate_id", "seq");

-- append-only 护栏（同 event_records 口径）：审批记录/事件账本禁 UPDATE/DELETE。
-- approval_cases 豁免：案件行是投影（state/object_version 随迁移推进 UPDATE）。
CREATE TRIGGER "approval_records_append_only_guard"
  BEFORE UPDATE OR DELETE ON "approval_records"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "approval_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "approval_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
