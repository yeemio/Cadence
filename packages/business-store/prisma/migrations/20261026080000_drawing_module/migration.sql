-- drawing 模块四表（M3，m3-drafts/03-drawing.md v1.0）。
--
-- 表形态分工（版本化文档域，ADR-0010：无状态机）：
--   drawing_revisions       图纸修订链（append-only：一次修订=一行；(tenant,
--                     drawing_id, version) 与 (tenant, supersedes) 唯一；
--                     version=链尾+1；supersedes=前任行 id（证据列口径），
--                     supersedes_version=version−1 派生不落列；classification=
--                     保密等级数据值（两级公开/受限默认配置，R-M3-6）；发布
--                     v4 不改 v3——钉版引用不漂移（合同 §7 对账锚）；
--   drawing_change_notices  发布联动通知事实（from→to+change_note+发布时点，
--                     首发 from=0；(tenant, drawing_id, to_version) 唯一 =
--                     联动幂等锚点；消费方 sinceVersion 游标轮询/对账）；
--   drawing_view_trails     查看留痕（append-only 审计事实：每次查看一行——
--                     谁/何时/哪修订/当时等级快照；seq bigserial 游标；保密
--                     审计最低门槛，合同 §2 两不变量之"必留痕"）；
--   drawing_operations      命令幂等记账（运营表，不套证据公共列）。
--
-- 域事件不建新表：落既有通用 event_records / outbox_records（PG 适配见
-- src/drawing/pg-drawing-stores.ts）。

-- CreateTable：图纸修订链（append-only 版本化文档）
CREATE TABLE "drawing_revisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drawing_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "file_ref" TEXT NOT NULL,
    "change_note" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable：变更通知（发布联动事实）
CREATE TABLE "drawing_change_notices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drawing_id" TEXT NOT NULL,
    "from_version" INTEGER NOT NULL,
    "to_version" INTEGER NOT NULL,
    "change_note" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_change_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable：查看留痕（append-only 审计事实）
CREATE TABLE "drawing_view_trails" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "drawing_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "viewed_by" TEXT NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL,
    "classification" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_view_trails_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "drawing_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "drawing_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drawing_revisions_tenant_id_drawing_id_version_key" ON "drawing_revisions"("tenant_id", "drawing_id", "version");

CREATE UNIQUE INDEX "drawing_revisions_tenant_id_supersedes_key" ON "drawing_revisions"("tenant_id", "supersedes");

CREATE INDEX "drawing_revisions_tenant_id_drawing_id_idx" ON "drawing_revisions"("tenant_id", "drawing_id");

CREATE UNIQUE INDEX "drawing_change_notices_tenant_id_drawing_id_to_version_key" ON "drawing_change_notices"("tenant_id", "drawing_id", "to_version");

CREATE INDEX "drawing_change_notices_tenant_id_drawing_id_idx" ON "drawing_change_notices"("tenant_id", "drawing_id");

CREATE INDEX "drawing_view_trails_tenant_id_drawing_id_idx" ON "drawing_view_trails"("tenant_id", "drawing_id");

CREATE INDEX "drawing_view_trails_tenant_id_viewed_by_idx" ON "drawing_view_trails"("tenant_id", "viewed_by");

CREATE UNIQUE INDEX "drawing_operations_tenant_id_operation_id_key" ON "drawing_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 payroll/metric-pack 迁移口径）：修订链/通知/查看留痕禁
-- UPDATE/DELETE（修订链只追加；事后等级调整不追溯改写留痕）；幂等记账运营表豁免。
CREATE TRIGGER "drawing_revisions_append_only_guard"
  BEFORE UPDATE OR DELETE ON "drawing_revisions"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "drawing_change_notices_append_only_guard"
  BEFORE UPDATE OR DELETE ON "drawing_change_notices"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "drawing_view_trails_append_only_guard"
  BEFORE UPDATE OR DELETE ON "drawing_view_trails"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
