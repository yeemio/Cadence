-- workorder 模块六表（M2-W1，02-workorder.md v1.0）。
--
-- 表形态分工（与 approval 三表同取舍，见 business-store schema.prisma 注释纪律）：
--   work_orders / parts_requests   投影行（运营状态，state 随迁移 UPDATE，
--                                  advance 走 object_version 条件更新）——不套
--                                  证据公共列、不设 append-only 触发器；
--   workorder_events               状态机事件账本（append-only；seq = 大单调游标，
--                                  映射 engine-flow ApprovalEventCursor；(aggregate_id,
--                                  aggregate_revision) 唯一 = DB 级乐观锁——并发对同一
--                                  版本提交两个迁移必拒其一；work-order 与 parts-request
--                                  两类聚合共用本表，aggregate_type 区分）；
--   work_order_attachments / kit_checks  业务事实（append-only 不可变，证据七公共列
--                                  齐备：id/object_version/audit_status/provenance/
--                                  supersedes/business_time/available_time）；
--   workorder_operations           命令幂等记账（smes.command.v1 不变量 3：同一
--                                  operationId 只允许落账一次；PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建，本迁移头注留档——workorder 域事件端口
-- WorkOrderDomainEventStore 的 PG 适配即映射该两表）。
--
-- 合流待办（本迁移在 application/src/workorder 线先行立表，业务仓侧配套件随总控
-- 合流落位）：schema.prisma 增补六个 model + business-store `./workorder` 子路径
-- PG 适配（PgWorkOrderStore / PgPartsRequestStore / PgWorkOrderAttachmentStore /
-- PgKitCheckStore / PgWorkOrderOperationStore / PgWorkOrderDomainEventStore /
-- PgWorkOrderMachineEventStore——参照 ./approval 体例）+ package.json exports。

-- CreateTable：工作令投影行
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "customer_ref" TEXT,
    "project_name" TEXT NOT NULL,
    "sales_rep" TEXT,
    "manager" TEXT,
    "planned_delivery_at" TIMESTAMPTZ(6),
    "packaging_arrival_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable：配件申请投影行
CREATE TABLE "parts_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 2,
    "item_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "requester" TEXT NOT NULL,
    "remark" TEXT,
    "shipment_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parts_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable：状态机事件账本（append-only）
CREATE TABLE "workorder_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "workorder_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：附件事实（证据公共列 + 领域键）
CREATE TABLE "work_order_attachments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "attached_by" TEXT NOT NULL,
    "attached_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "work_order_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable：齐套检查快照（不可变，证据公共列 + 判定载荷）
-- seq = 刷新序游标：latest 口径 = (refreshed_at DESC, seq DESC)——同毫秒并列
-- 时毫秒时钟与 uuidv7 随机位都不可靠，插入序（bigserial）是唯一确定决胜。
CREATE TABLE "kit_checks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kinds" JSONB NOT NULL,
    "gap_lines" JSONB NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "refreshed_by" TEXT NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "kit_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "workorder_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workorder_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE INDEX "work_orders_tenant_id_state_idx" ON "work_orders"("tenant_id", "state");

CREATE INDEX "work_orders_tenant_id_created_at_idx" ON "work_orders"("tenant_id", "created_at");

CREATE INDEX "work_orders_manager_idx" ON "work_orders"("tenant_id", "manager");

CREATE INDEX "parts_requests_tenant_id_state_idx" ON "parts_requests"("tenant_id", "state");

CREATE INDEX "parts_requests_tenant_id_work_order_id_idx" ON "parts_requests"("tenant_id", "work_order_id");

CREATE UNIQUE INDEX "workorder_events_event_id_key" ON "workorder_events"("event_id");

CREATE UNIQUE INDEX "workorder_events_aggregate_id_aggregate_revision_key" ON "workorder_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "workorder_events_tenant_id_aggregate_id_seq_idx" ON "workorder_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "work_order_attachments_tenant_id_work_order_id_idx" ON "work_order_attachments"("tenant_id", "work_order_id");

CREATE INDEX "kit_checks_tenant_id_work_order_id_refreshed_at_idx" ON "kit_checks"("tenant_id", "work_order_id", "refreshed_at" DESC, "seq" DESC);

CREATE INDEX "workorder_operations_tenant_id_idx" ON "workorder_operations"("tenant_id");

-- append-only 护栏（同 approval_events / event_records 口径）：
--   事实表（附件/齐套快照）与事件账本禁 UPDATE/DELETE；
--   work_orders / parts_requests 豁免（投影行随迁移推进 UPDATE）；
--   workorder_operations 豁免（幂等记账无修正语义，写后不改）。
CREATE TRIGGER "workorder_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "workorder_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "work_order_attachments_append_only_guard"
  BEFORE UPDATE OR DELETE ON "work_order_attachments"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "kit_checks_append_only_guard"
  BEFORE UPDATE OR DELETE ON "kit_checks"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
