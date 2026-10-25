-- metric-pack 模块两表（M3，m3-drafts/04-metric-pack.md v1.0）。
--
-- 表形态分工（配置装载域，ADR-0010：无状态机）：
--   metric_pack_activations  口径包装载记录（append-only 配置装载事实；
--                     (tenant, pack_id, pack_version) 与 (tenant, supersedes)
--                     唯一——装载链线性不变量；pack JSONB = 经引擎
--                     defineMetricPack 校验冻结的完整包定义快照，升级=新记录
--                     supersedes 前任，历史包按自身快照只读可复算（合同 §6）；
--                     metric_refs JSONB = 包内 metricId@version 清单位投影）；
--   metric_pack_operations   命令幂等记账（运营表，不套证据公共列）。
--
-- 域事件不建新表：落既有通用 event_records / outbox_records（PG 适配见
-- src/metric-pack/pg-metric-pack-stores.ts）。

-- CreateTable：口径包装载记录（append-only 配置装载事实）
CREATE TABLE "metric_pack_activations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "pack_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "pack" JSONB NOT NULL,
    "metric_refs" JSONB NOT NULL,
    "activated_by" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_pack_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "metric_pack_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "metric_pack_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metric_pack_activations_tenant_id_pack_id_pack_version_key" ON "metric_pack_activations"("tenant_id", "pack_id", "pack_version");

CREATE UNIQUE INDEX "metric_pack_activations_tenant_id_supersedes_key" ON "metric_pack_activations"("tenant_id", "supersedes");

CREATE INDEX "metric_pack_activations_tenant_id_pack_id_idx" ON "metric_pack_activations"("tenant_id", "pack_id");

CREATE UNIQUE INDEX "metric_pack_operations_tenant_id_operation_id_key" ON "metric_pack_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 payroll 迁移口径）：装载记录禁 UPDATE/DELETE（升级走
-- 追加新记录）；幂等记账运营表豁免。
CREATE TRIGGER "metric_pack_activations_append_only_guard"
  BEFORE UPDATE OR DELETE ON "metric_pack_activations"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
