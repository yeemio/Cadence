-- dispatch 模块四表（M2-W6，04-dispatch.md v1.0）。
--
-- 表形态分工（与 workorder/listing 同一取舍，见 business-store schema.prisma 注释纪律）：
--   dispatch_orders / outsourcing_lines  投影行（运营状态，行级 object_version
--                                        条件更新）——不套证据公共列、不设
--                                        append-only 触发器；外协行为版本化数据
--                                        （单价补录 + object_version，非状态机）；
--   dispatch_events                      状态机事件账本（append-only；seq = 大单调
--                                        游标，映射 engine-flow ApprovalEventCursor；
--                                        (aggregate_id, aggregate_revision) 唯一 =
--                                        DB 级乐观锁；dispatch-order 聚合专用）；
--   dispatch_operations                  命令幂等记账（smes.command.v1 不变量 3：
--                                        同一 operationId 只允许落账一次；
--                                        PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建；dispatch 域事件端口 DispatchDomainEventStore 的 PG
-- 适配即映射该两表——src/dispatch/pg-dispatch-stores.ts）。本模块无独立不可变
-- 快照事实表（齐套事实在 workorder 侧、缺口事实在 listing 侧，只读消费）。
--
-- 合流待办（本迁移在 application/src/dispatch 线先行立表，配套件随总控合流落位）：
-- schema.prisma 已增补四个 model（同迁移）+ business-store `./dispatch` 子路径
-- PG 适配 + package.json exports；app-registry 接线归总控（不改注册表纪律）。

-- CreateTable：派工单投影行（六类一体；零件单带图号×工序×工艺属性快照）
CREATE TABLE "dispatch_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT,
    "kind" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "drawing_no" TEXT,
    "operation_code" TEXT,
    "material" TEXT,
    "size_spec" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "done_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "assignee" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable：外协明细投影行（供应商×工序×单价×交期；单价可事后补录）
CREATE TABLE "outsourcing_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dispatch_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "process_code" TEXT NOT NULL,
    "drawing_no" TEXT,
    "supplier_ref" TEXT NOT NULL,
    "supplier_name" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit_price_minor" INTEGER,
    "price_source" TEXT,
    "margin_permyriad" INTEGER,
    "promised_at" TIMESTAMPTZ(6),
    "source_listing_line_id" TEXT,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outsourcing_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable：状态机事件账本（append-only）
CREATE TABLE "dispatch_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "dispatch_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "dispatch_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispatch_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE INDEX "dispatch_orders_tenant_id_state_idx" ON "dispatch_orders"("tenant_id", "state");

CREATE INDEX "dispatch_orders_tenant_id_kind_state_idx" ON "dispatch_orders"("tenant_id", "kind", "state");

CREATE INDEX "dispatch_orders_tenant_id_work_order_id_idx" ON "dispatch_orders"("tenant_id", "work_order_id");

CREATE INDEX "dispatch_orders_tenant_id_assignee_idx" ON "dispatch_orders"("tenant_id", "assignee");

CREATE UNIQUE INDEX "outsourcing_lines_tenant_id_dispatch_id_line_no_key" ON "outsourcing_lines"("tenant_id", "dispatch_id", "line_no");

CREATE INDEX "outsourcing_lines_tenant_id_dispatch_id_idx" ON "outsourcing_lines"("tenant_id", "dispatch_id");

CREATE INDEX "outsourcing_lines_tenant_id_supplier_ref_idx" ON "outsourcing_lines"("tenant_id", "supplier_ref");

CREATE UNIQUE INDEX "dispatch_events_event_id_key" ON "dispatch_events"("event_id");

CREATE UNIQUE INDEX "dispatch_events_aggregate_id_aggregate_revision_key" ON "dispatch_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "dispatch_events_tenant_id_aggregate_id_seq_idx" ON "dispatch_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "dispatch_operations_tenant_id_idx" ON "dispatch_operations"("tenant_id");

-- append-only 护栏（同 workorder/listing 迁移口径）：
--   事件账本禁 UPDATE/DELETE；
--   两投影表豁免（行级 object_version 条件更新——外协行含单价补录）；
--   dispatch_operations 豁免（幂等记账无修正语义，写后不改）。
CREATE TRIGGER "dispatch_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "dispatch_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
