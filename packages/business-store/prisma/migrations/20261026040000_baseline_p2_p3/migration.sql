-- baseline P2/P3 件（M2-W7，合同 01-baseline.md v1.0）四表。
--
-- 表形态分工（体例照抄 baseline P1 迁移 + inspection_module 迁移）：
--   routings / standard_times   版本化主数据（append-only 不可变 + supersedes 修正链
--                               + 完整证据公共列——同 process_defs 体例；
--                               routings 业务键 code = 图号，steps 为 JSONB 工序序列；
--                               standard_times 工时量纲秒整数）；
--   fault_reports               故障单投影行（运营状态，state 随 ASSIGN/RESOLVE/REJECT
--                               迁移 UPDATE，advance 走 object_version 条件更新——同
--                               inspections 体例：不套证据公共列、豁免 append-only）；
--   fault_events                故障状态机事件账本（append-only；(aggregate_id,
--                               aggregate_revision) 唯一 = DB 级乐观锁——同
--                               inspection_events；engine-flow ApprovalEventStore 的
--                               PG 持久化）。
-- 故障命令幂等复用既有 baseline_command_operations（同模块同一账本，不另建表）。
-- 域事件（FaultReported/FaultResolved）不建新表：落既有通用 event_records /
-- outbox_records（P1 已用，本迁移不重复建）。
-- RLS 策略不在本迁移：随 20261026041000_rls_tenant_isolation_replay 全量重放覆盖。

-- CreateTable：工艺路线版本行（业务键 = 图号）
CREATE TABLE "routings" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routings_pkey" PRIMARY KEY ("id")
);

-- CreateTable：额定工时版本行（秒整数）
CREATE TABLE "standard_times" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "target_code" TEXT NOT NULL,
    "standard_seconds" INTEGER NOT NULL,
    "preparation_seconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_times_pkey" PRIMARY KEY ("id")
);

-- CreateTable：故障单投影行
CREATE TABLE "fault_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "equipment_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reported_by" TEXT NOT NULL,
    "assignee" TEXT,
    "assigned_at" TIMESTAMPTZ(6),
    "resolution_remark" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fault_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable：故障状态机事件账本（append-only）
CREATE TABLE "fault_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "fault_events_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "routings_id_tenant_id_key" ON "routings"("id", "tenant_id");

CREATE UNIQUE INDEX "routings_tenant_id_supersedes_key" ON "routings"("tenant_id", "supersedes");

CREATE UNIQUE INDEX "routings_tenant_id_code_object_version_key" ON "routings"("tenant_id", "code", "object_version");

CREATE INDEX "routings_tenant_id_code_idx" ON "routings"("tenant_id", "code");

CREATE UNIQUE INDEX "standard_times_id_tenant_id_key" ON "standard_times"("id", "tenant_id");

CREATE UNIQUE INDEX "standard_times_tenant_id_supersedes_key" ON "standard_times"("tenant_id", "supersedes");

CREATE UNIQUE INDEX "standard_times_tenant_id_code_object_version_key" ON "standard_times"("tenant_id", "code", "object_version");

CREATE INDEX "standard_times_tenant_id_scope_target_code_idx" ON "standard_times"("tenant_id", "scope", "target_code");

CREATE INDEX "fault_reports_tenant_id_state_idx" ON "fault_reports"("tenant_id", "state");

CREATE INDEX "fault_reports_tenant_id_created_at_idx" ON "fault_reports"("tenant_id", "created_at");

CREATE UNIQUE INDEX "fault_events_event_id_key" ON "fault_events"("event_id");

CREATE UNIQUE INDEX "fault_events_aggregate_id_aggregate_revision_key" ON "fault_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "fault_events_tenant_id_aggregate_id_seq_idx" ON "fault_events"("tenant_id", "aggregate_id", "seq");

-- AddForeignKey（supersedes 修正链：同租户内自引用，防跨租户 supersedes）
ALTER TABLE "routings" ADD CONSTRAINT "routings_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "routings"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "standard_times" ADD CONSTRAINT "standard_times_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "standard_times"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- append-only 护栏（同 P1 主数据 + inspection_events 口径）：
--   版本化主数据与机器事件账本禁 UPDATE/DELETE；fault_reports 豁免（投影行随
--   ASSIGN/RESOLVE/REJECT 迁移 UPDATE）。
CREATE TRIGGER "routings_append_only_guard"
  BEFORE UPDATE OR DELETE ON "routings"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "standard_times_append_only_guard"
  BEFORE UPDATE OR DELETE ON "standard_times"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "fault_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "fault_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
