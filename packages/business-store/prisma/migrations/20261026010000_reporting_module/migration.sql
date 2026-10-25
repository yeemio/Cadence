-- reporting 模块四表（M2-W7，05-reporting.md v1.0）。
--
-- 表形态分工（与 workorder/listing/dispatch 同一取舍，见 business-store schema.prisma 注释纪律）：
--   work_reports          报工单状态机投影（行级 object_version 条件更新）——携带
--                         supersedes（修正版链：核查编辑不改原单，新行 supersedes
--                         锚定原单）与 business_time（事后补录报工）两列；不套完整
--                         证据七列、不设 append-only 触发器（投影取舍同 dispatch_orders）；
--   report_audits         核查留痕账（append-only：编辑/审核/撤销每次动作一行；
--                         触发器禁 UPDATE/DELETE——全程留痕纪律）；
--   reporting_events      状态机事件账本（append-only；seq = 大单调游标，映射
--                         engine-flow ApprovalEventCursor；(aggregate_id,
--                         aggregate_revision) 唯一 = DB 级乐观锁；work-report
--                         聚合专用）；
--   reporting_operations  命令幂等记账（smes.command.v1 不变量 3：同一 operationId
--                         只允许落账一次；PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建；reporting 域事件端口 ReportDomainEventStore 的 PG
-- 适配即映射该两表——src/reporting/pg-reporting-stores.ts）。
--
-- 合流待办（本迁移在 application/src/reporting 线先行立表，配套件随总控合流落位）：
-- schema.prisma 已增补四个 model（同迁移）+ business-store `./reporting` 子路径
-- PG 适配 + package.json exports；RLS 补登见 20261026010400_reporting_rls_replay；
-- app-registry 接线归总控（不改注册表纪律）。

-- CreateTable：报工单投影行（五类一体；挂派工单；工艺属性随单快照）
CREATE TABLE "work_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dispatch_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "done_qty" DOUBLE PRECISION NOT NULL,
    "labor_minutes" INTEGER NOT NULL,
    "reporter" TEXT NOT NULL,
    "work_order_id" TEXT,
    "drawing_no" TEXT,
    "operation_code" TEXT,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6) NOT NULL,
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable：核查留痕账（append-only：编辑/审核/撤销每次动作一行）
CREATE TABLE "report_audits" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "changes" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable：状态机事件账本（append-only）
CREATE TABLE "reporting_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "reporting_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "reporting_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reporting_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE INDEX "work_reports_tenant_id_state_idx" ON "work_reports"("tenant_id", "state");

CREATE INDEX "work_reports_tenant_id_kind_state_idx" ON "work_reports"("tenant_id", "kind", "state");

CREATE INDEX "work_reports_tenant_id_dispatch_id_idx" ON "work_reports"("tenant_id", "dispatch_id");

CREATE INDEX "work_reports_tenant_id_reporter_idx" ON "work_reports"("tenant_id", "reporter");

CREATE INDEX "work_reports_tenant_id_drawing_no_idx" ON "work_reports"("tenant_id", "drawing_no");

CREATE INDEX "work_reports_tenant_id_supersedes_idx" ON "work_reports"("tenant_id", "supersedes");

CREATE INDEX "report_audits_tenant_id_report_id_idx" ON "report_audits"("tenant_id", "report_id");

CREATE UNIQUE INDEX "reporting_events_event_id_key" ON "reporting_events"("event_id");

CREATE UNIQUE INDEX "reporting_events_aggregate_id_aggregate_revision_key" ON "reporting_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "reporting_events_tenant_id_aggregate_id_seq_idx" ON "reporting_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "reporting_operations_tenant_id_idx" ON "reporting_operations"("tenant_id");

-- append-only 护栏（同 dispatch 迁移口径）：
--   留痕账禁 UPDATE/DELETE（全程留痕纪律）；
--   事件账本禁 UPDATE/DELETE；
--   work_reports 投影豁免（行级 object_version 条件更新——verify/revoke 回填核查列）；
--   reporting_operations 豁免（幂等记账无修正语义，写后不改）。
CREATE TRIGGER "report_audits_append_only_guard"
  BEFORE UPDATE OR DELETE ON "report_audits"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "reporting_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "reporting_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
