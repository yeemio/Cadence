-- inspection 模块四表（M2-W4，06-inspection.md v1.0）。
--
-- 表形态分工（体例照抄 workorder_module 迁移，取舍见 schema.prisma inspection 节注）：
--   inspections / nonconformities   投影行（运营状态，state 随判定/处置/闭环迁移
--                                   UPDATE，advance 走 object_version 条件更新）
--                                   ——不套证据公共列、不设 append-only 触发器；
--   inspection_events               状态机事件账本（append-only；seq = 大单调游标，
--                                   映射 engine-flow ApprovalEventCursor；(aggregate_id,
--                                   aggregate_revision) 唯一 = DB 级乐观锁——并发对同一
--                                   版本提交两个迁移必拒其一；inspection-order 与
--                                   nonconform 两类聚合共用本表，aggregate_type 区分；
--                                   判定迁移的决策记录随 payload 留痕 = 检验记录事实）；
--   inspection_operations           命令幂等记账（smes.command.v1 不变量 3：同一
--                                   operationId 只允许落账一次；PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建，本迁移头注留档——inspection 域事件端口
-- InspectionDomainEventStore 的 PG 适配即映射该两表）。
-- (tenant_id, source_type, source_ref_id) 唯一 = 来源幂等 DB 级防线（NULL 不去重：
-- 手工建单多行合法）。
--
-- 合流待办（本迁移在 application/src/inspection 线先行立表，配套件随总控合流落位）：
-- schema.prisma 四个 model（本迁移同内容）+ business-store `./inspection` 子路径
-- PG 适配（PgInspectionOrderStore / PgNonconformStore / PgInspectionOperationStore /
-- PgInspectionDomainEventStore / PgInspectionMachineEventStore——参照 ./workorder
-- 体例）+ package.json exports。

-- CreateTable：质检单投影行
CREATE TABLE "inspections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "source_type" TEXT,
    "source_ref_id" TEXT,
    "item_id" TEXT,
    "drawing_no" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "passed_qty" DOUBLE PRECISION,
    "failed_qty" DOUBLE PRECISION,
    "judge_remark" TEXT,
    "judged_by" TEXT,
    "judged_at" TIMESTAMPTZ(6),
    "close_due_at" TIMESTAMPTZ(6),
    "overdue_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable：不合格处置投影行
CREATE TABLE "nonconformities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "item_id" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "disposal" TEXT,
    "dispose_remark" TEXT,
    "disposed_by" TEXT,
    "disposed_at" TIMESTAMPTZ(6),
    "close_remark" TEXT,
    "closed_by" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nonconformities_pkey" PRIMARY KEY ("id")
);

-- CreateTable：状态机事件账本（append-only）
CREATE TABLE "inspection_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "inspection_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "inspection_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inspection_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "inspections_tenant_id_source_type_source_ref_id_key" ON "inspections"("tenant_id", "source_type", "source_ref_id");

CREATE INDEX "inspections_tenant_id_kind_state_idx" ON "inspections"("tenant_id", "kind", "state");

CREATE INDEX "inspections_tenant_id_state_idx" ON "inspections"("tenant_id", "state");

CREATE INDEX "inspections_tenant_id_created_at_idx" ON "inspections"("tenant_id", "created_at");

CREATE INDEX "nonconformities_tenant_id_state_idx" ON "nonconformities"("tenant_id", "state");

CREATE INDEX "nonconformities_tenant_id_inspection_id_idx" ON "nonconformities"("tenant_id", "inspection_id");

CREATE UNIQUE INDEX "inspection_events_event_id_key" ON "inspection_events"("event_id");

CREATE UNIQUE INDEX "inspection_events_aggregate_id_aggregate_revision_key" ON "inspection_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "inspection_events_tenant_id_aggregate_id_seq_idx" ON "inspection_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "inspection_operations_tenant_id_idx" ON "inspection_operations"("tenant_id");

-- append-only 护栏（同 approval_events / workorder_events 口径）：
--   事件账本禁 UPDATE/DELETE；inspections / nonconformities 豁免（投影行随判定/
--   处置/闭环迁移 UPDATE，含 updateJudgment 与点名标记）；inspection_operations
--   豁免（幂等记账无修正语义，写后不改）。
CREATE TRIGGER "inspection_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "inspection_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
