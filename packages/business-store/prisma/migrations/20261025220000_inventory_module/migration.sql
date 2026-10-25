-- inventory 模块十一表（M2-W5，07-inventory.md v1.0）。
--
-- 表形态分工（与 workorder/listing 同一取舍，见 business-store schema.prisma 注释纪律）：
--   warehouses / warehouse_locations   主数据投影（R4：仓库与库位归本模块；
--                                      运营表，不套证据公共列、不设触发器）；
--   stock_accounts                     库存账投影（物料×仓库 现存量+预占——
--                                      可用量恒等式两输入；条件更新守卫）；
--   stock_location_balances            库位余额投影（库位分布；FIFO 扣减序）；
--   stock_reservations                 预占投影（reserve/release/consume）；
--   stocktakes / shipping_orders       状态机投影（盘点四态/发货三态；lines JSONB）；
--   stock_movements                    出入库流水（append-only 事实，证据七公共列；
--                                      (tenant_id, source_key) 唯一 = receiptKey/
--                                      issueKey 幂等锚点；seq bigserial 插入序）；
--   release_facts                      放行事实登记账（append-only 事实；
--                                      (tenant_id, inspection_id, phase) 幂等）；
--   inventory_events                   状态机事件账本（append-only；seq = 大单调
--                                      游标，映射 engine-flow ApprovalEventCursor；
--                                      (aggregate_id, aggregate_revision) 唯一 =
--                                      DB 级乐观锁；stocktake / shipping-order 共用）；
--   inventory_operations               命令幂等记账（smes.command.v1 不变量 3：
--                                      PK = 租户+operationId）。
--
-- 域事件（BusinessEvent 形状 + Outbox）不建新表：落既有通用 event_records /
-- outbox_records（M1 已建；inventory 域事件端口 InventoryDomainEventStore 的
-- PG 适配即映射该两表——src/inventory/pg-inventory-stores.ts）。
--
-- 合流待办（本迁移在 application/src/inventory 线先行立表，配套件随总控合流落位）：
-- schema.prisma 已增补十一个 model（同迁移）+ business-store `./inventory` 子路径
-- PG 适配 + package.json exports；app-registry 接线归总控（不改注册表纪律）。

-- CreateTable：仓库主数据
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_location_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable：库位主数据
CREATE TABLE "warehouse_locations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable：库存账投影（物料×仓库 现存量+预占）
CREATE TABLE "stock_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "qty_on_hand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable：库位余额投影（库位分布）
CREATE TABLE "stock_location_balances" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_location_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable：出入库流水（append-only 事实，证据七公共列 + seq 插入序）
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "location_id" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "source_ref_type" TEXT,
    "source_ref_id" TEXT,
    "source_key" TEXT,
    "transfer_id" TEXT,
    "work_order_id" TEXT,
    "remark" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable：预占投影（reserve/release/consume）
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reservation_key" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "remaining" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable：盘点投影（四态机；lines JSONB = 开单快照 + 实盘回填）
CREATE TABLE "stocktakes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "lines" JSONB NOT NULL,
    "opened_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable：发货任务投影（三态机；lines JSONB = 发货行）
CREATE TABLE "shipping_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" TEXT,
    "flow_config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "lines" JSONB NOT NULL,
    "carrier" TEXT,
    "tracking_no" TEXT,
    "executed_by" TEXT NOT NULL,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipping_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable：inventory 状态机事件账本（append-only；两类聚合共用）
CREATE TABLE "inventory_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable：命令幂等记账（租户内 operationId 唯一）
CREATE TABLE "inventory_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateTable：放行事实登记账（append-only 事实，证据七公共列）
CREATE TABLE "release_facts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "drawing_no" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "source_type" TEXT,
    "source_ref_id" TEXT,
    "released_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "release_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_code_key" ON "warehouses"("tenant_id", "code");

CREATE UNIQUE INDEX "warehouse_locations_tenant_id_warehouse_id_code_key" ON "warehouse_locations"("tenant_id", "warehouse_id", "code");

CREATE INDEX "warehouse_locations_tenant_id_warehouse_id_idx" ON "warehouse_locations"("tenant_id", "warehouse_id");

CREATE UNIQUE INDEX "stock_accounts_tenant_id_item_id_warehouse_id_key" ON "stock_accounts"("tenant_id", "item_id", "warehouse_id");

CREATE UNIQUE INDEX "stock_location_balances_tenant_id_warehouse_id_location_id_item_id_key" ON "stock_location_balances"("tenant_id", "warehouse_id", "location_id", "item_id");

CREATE INDEX "stock_location_balances_tenant_id_item_id_idx" ON "stock_location_balances"("tenant_id", "item_id");

CREATE UNIQUE INDEX "stock_movements_tenant_id_source_key_key" ON "stock_movements"("tenant_id", "source_key");

CREATE INDEX "stock_movements_tenant_id_occurred_at_seq_idx" ON "stock_movements"("tenant_id", "occurred_at" DESC, "seq" DESC);

CREATE INDEX "stock_movements_tenant_id_item_id_seq_idx" ON "stock_movements"("tenant_id", "item_id", "seq");

CREATE INDEX "stock_movements_tenant_id_warehouse_id_seq_idx" ON "stock_movements"("tenant_id", "warehouse_id", "seq");

CREATE UNIQUE INDEX "stock_reservations_tenant_id_reservation_key_key" ON "stock_reservations"("tenant_id", "reservation_key");

CREATE INDEX "stock_reservations_tenant_id_status_idx" ON "stock_reservations"("tenant_id", "status");

CREATE INDEX "stocktakes_tenant_id_state_idx" ON "stocktakes"("tenant_id", "state");

CREATE INDEX "stocktakes_tenant_id_warehouse_id_idx" ON "stocktakes"("tenant_id", "warehouse_id");

CREATE INDEX "shipping_orders_tenant_id_state_idx" ON "shipping_orders"("tenant_id", "state");

CREATE INDEX "shipping_orders_tenant_id_work_order_id_idx" ON "shipping_orders"("tenant_id", "work_order_id");

CREATE UNIQUE INDEX "inventory_events_event_id_key" ON "inventory_events"("event_id");

CREATE UNIQUE INDEX "inventory_events_aggregate_id_aggregate_revision_key" ON "inventory_events"("aggregate_id", "aggregate_revision");

CREATE INDEX "inventory_events_tenant_id_aggregate_id_seq_idx" ON "inventory_events"("tenant_id", "aggregate_id", "seq");

CREATE INDEX "inventory_operations_tenant_id_idx" ON "inventory_operations"("tenant_id");

CREATE UNIQUE INDEX "release_facts_tenant_id_inspection_id_phase_key" ON "release_facts"("tenant_id", "inspection_id", "phase");

CREATE INDEX "release_facts_tenant_id_inspection_id_idx" ON "release_facts"("tenant_id", "inspection_id");

-- append-only 护栏（同 listing 迁移口径）：
--   出入库流水与放行事实、事件账本禁 UPDATE/DELETE；
--   主数据/投影/余额/预占/盘点/发货/幂等记账表豁免（行级条件更新或写后不改）。
CREATE TRIGGER "stock_movements_append_only_guard"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "release_facts_append_only_guard"
  BEFORE UPDATE OR DELETE ON "release_facts"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "inventory_events_append_only_guard"
  BEFORE UPDATE OR DELETE ON "inventory_events"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
