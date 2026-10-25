-- listing 模块八表（M2-W3，03-listing.md v1.0）。
--
-- 表形态分工（与 workorder 六表同一取舍，见 business-store schema.prisma 注释纪律）：
--   listing_sheets / listing_lines / purchase_requests / purchase_orders /
--   purchase_returns   投影行（运营状态，行级 object_version 条件更新）——不套
--                      证据公共列、不设 append-only 触发器；清单行为版本化数据
--                      （校验状态字段 + object_version，非状态机，03-listing §2）；
--   gap_checks         缺口核查不可变快照（append-only，证据七公共列齐备：
--                      id/object_version/audit_status/provenance/supersedes/
--                      business_time/available_time；seq bigserial 插入序决胜）；
--   listing_events     状态机事件账本（append-only；seq = 大单调游标，映射
--                      engine-flow ApprovalEventCursor；(aggregate_id,
--                      aggregate_revision) 唯一 = DB 级乐观锁；purchase-request /
--                      purchase-order / purchase-return 三类聚合共用）；
--   listing_operations 命令幂等记账（smes.command.v1 不变量 3：同一 operationId
--                      只允许落账一次；PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建；listing 域事件端口 ListingDomainEventStore 的 PG
-- 适配即映射该两表——src/listing/pg-listing-stores.ts）。
--
-- 合流待办（本迁移在 application/src/listing 线先行立表，配套件随总控合流落位）：
-- schema.prisma 已增补八个 model（同迁移）+ business-store `./listing` 子路径
-- PG 适配 + package.json exports；app-registry 接线归总控（不改注册表纪律）。

-- CreateTable：清单单据头投影行
CREATE TABLE "listing_sheets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable：清单行投影行（行级乐观版本 + 校验状态字段）
CREATE TABLE "listing_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sheet_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "drawing_no" TEXT,
    "code" TEXT,
    "name" TEXT,
    "spec" TEXT,
    "item_id" TEXT,
    "required_qty" DOUBLE PRECISION NOT NULL,
    "needed_by" TIMESTAMPTZ(6),
    "validation_status" TEXT NOT NULL,
    "candidate_item_id" TEXT,
    "candidate_item_code" TEXT,
    "similarity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "basis" TEXT,
    "source" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable：缺口核查快照（不可变，证据公共列 + 判定载荷）
-- seq = 核查序游标：latest 口径 = (checked_at DESC, seq DESC)——同毫秒并列时
-- 插入序（bigserial）是唯一确定决胜（同 kit_checks 取舍）。
CREATE TABLE "gap_checks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kinds" JSONB NOT NULL,
    "gap_lines" JSONB NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "checked_by" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "gap_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable：采购申请投影行
CREATE TABLE "purchase_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT,
    "kind" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "item_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "requester" TEXT NOT NULL,
    "remark" TEXT,
    "source_type" TEXT NOT NULL,
    "source_gap_check_id" TEXT,
    "source_listing_line_id" TEXT,
    "purchase_order_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable：采购订单投影行（lines / request_ids 为 JSONB 载荷）
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 2,
    "supplier_ref" TEXT,
    "supplier_name" TEXT,
    "promised_at" TIMESTAMPTZ(6) NOT NULL,
    "lines" JSONB NOT NULL,
    "request_ids" JSONB NOT NULL,
    "buyer" TEXT,
    "remark" TEXT,
    "receipt_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable：退货单投影行
CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "lines" JSONB NOT NULL,
    "returned_by" TEXT NOT NULL,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable：状态机事件账本（append-only）
CREATE TABLE "listing_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "listing_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "listing_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "listing_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "listing_sheets_tenant_id_work_order_id_kind_key" ON "listing_sheets"("tenant_id", "work_order_id", "kind");

CREATE INDEX "listing_sheets_tenant_id_work_order_id_idx" ON "listing_sheets"("tenant_id", "work_order_id");

CREATE UNIQUE INDEX "listing_lines_tenant_id_sheet_id_line_no_key" ON "listing_lines"("tenant_id", "sheet_id", "line_no");

CREATE INDEX "listing_lines_tenant_id_work_order_id_idx" ON "listing_lines"("tenant_id", "work_order_id");

CREATE INDEX "listing_lines_tenant_id_sheet_id_idx" ON "listing_lines"("tenant_id", "sheet_id");

CREATE INDEX "gap_checks_tenant_id_work_order_id_checked_at_idx" ON "gap_checks"("tenant_id", "work_order_id", "checked_at" DESC, "seq" DESC);

CREATE INDEX "purchase_requests_tenant_id_state_idx" ON "purchase_requests"("tenant_id", "state");

CREATE INDEX "purchase_requests_tenant_id_work_order_id_idx" ON "purchase_requests"("tenant_id", "work_order_id");

CREATE INDEX "purchase_requests_tenant_id_purchase_order_id_idx" ON "purchase_requests"("tenant_id", "purchase_order_id");

CREATE INDEX "purchase_orders_tenant_id_state_idx" ON "purchase_orders"("tenant_id", "state");

CREATE INDEX "purchase_orders_tenant_id_work_order_id_idx" ON "purchase_orders"("tenant_id", "work_order_id");

CREATE INDEX "purchase_returns_tenant_id_purchase_order_id_idx" ON "purchase_returns"("tenant_id", "purchase_order_id");

CREATE UNIQUE INDEX "listing_events_event_id_key" ON "listing_events"("event_id");

CREATE UNIQUE INDEX "listing_events_aggregate_id_aggregate_revision_key" ON "listing_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "listing_events_tenant_id_aggregate_id_seq_idx" ON "listing_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "listing_operations_tenant_id_idx" ON "listing_operations"("tenant_id");

-- append-only 护栏（同 workorder 迁移口径）：
--   缺口快照与事件账本禁 UPDATE/DELETE；
--   五投影表豁免（行级 object_version 条件更新）；
--   listing_operations 豁免（幂等记账无修正语义，写后不改）。
CREATE TRIGGER "gap_checks_append_only_guard"
  BEFORE UPDATE OR DELETE ON "gap_checks"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "listing_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "listing_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
