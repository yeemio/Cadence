-- CreateTable
CREATE TABLE "work_order_records" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_order_id" UUID NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" UUID,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "work_order_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_records" (
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "provenance" JSONB,
    "payload" JSONB NOT NULL,

    CONSTRAINT "event_records_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "outbox_records" (
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_records_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "work_order_records_tenant_id_work_order_id_idx" ON "work_order_records"("tenant_id", "work_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_records_id_tenant_id_key" ON "work_order_records"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_records_tenant_id_supersedes_key" ON "work_order_records"("tenant_id", "supersedes");

-- CreateIndex
CREATE INDEX "event_records_tenant_id_occurred_at_idx" ON "event_records"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_records_tenant_id_aggregate_id_aggregate_revision_idx" ON "event_records"("tenant_id", "aggregate_id", "aggregate_revision");

-- CreateIndex
CREATE INDEX "outbox_records_delivered_at_next_attempt_at_idx" ON "outbox_records"("delivered_at", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "work_order_records" ADD CONSTRAINT "work_order_records_supersedes_tenant_id_fkey" FOREIGN KEY ("supersedes", "tenant_id") REFERENCES "work_order_records"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_records" ADD CONSTRAINT "outbox_records_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event_records"("event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 以下为手写增补（Prisma schema 无法表达的部分；与 schema.prisma 注释及包 README 的取舍说明对应）
-- 合同级约束：object_version / aggregate_revision >= 1（evidence-columns.v1 / smes.command.v1）
ALTER TABLE "work_order_records" ADD CONSTRAINT "work_order_records_object_version_check" CHECK ("object_version" >= 1);
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_aggregate_revision_check" CHECK ("aggregate_revision" >= 1);

-- 投递器待投递扫描（部分索引；delivered_at IS NULL 才是热点集）
CREATE INDEX "outbox_records_pending_idx" ON "outbox_records"("next_attempt_at") WHERE "delivered_at" IS NULL;

-- append-only 护栏（DB 级防线）：事实表与事件表禁 UPDATE/DELETE。
-- Outbox 豁免：投递记账必须可 UPDATE（attempts / delivered_at）。
CREATE OR REPLACE FUNCTION "business_store_forbid_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % blocked: % is not allowed (use supersedes chain)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "work_order_records_append_only_guard"
  BEFORE UPDATE OR DELETE ON "work_order_records"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "event_records_append_only_guard"
  BEFORE UPDATE OR DELETE ON "event_records"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
