-- fix-wave-6 6b-1（B3 / RREQ-IV-002，PRD 15 册 §4.1）货架与货架库位主数据
-- 两表：仓库四类主数据的第三/四类（源《仓库基础信息模块》§2.3-2.4/§3.3-3.4）。
--   goods_shelves   货架（属仓；(tenant, 仓, code) 唯一——PRD"编码仓内唯一"；
--                   启停受下属库位正结存保护；有下属锁码——应用侧校验）；
--   shelf_locations 货架库位（挂货架；编码以货架编码开头——应用侧收口；
--                   (tenant, code) 表内唯一；停删受正结存与出入库流水引用
--                   保护——应用侧校验；收发存落位的可选三级锚点）。
--
-- 运营主数据表（同 warehouses/warehouse_locations 取舍：不套证据公共列、
-- 不设触发器）；object_version 承载命令信封 expectedRevision 乐观锁
-- （update/set-status/remove 条件更新 +1，零行命中 = 版本竞态拒绝）。
-- warehouse_id 以货架主数据为准反写（源 §3.4.3）；无外键（跨表引用一致
-- 性由应用层租户收口校验——同 warehouse_locations 对 warehouses 的既定
-- 取舍）。与 S9（20261026220000 items 加列）写入面互斥无冲突。
--
-- RLS：两表带 tenant_id，须进 src/rls/tables.ts 清单——全量重放见下一迁移
-- 20261026220600_rls_tenant_isolation_replay（本迁移不混入 RLS 语句）。

-- CreateTable：货架主数据
CREATE TABLE "goods_shelves" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goods_shelves_pkey" PRIMARY KEY ("id")
);

-- CreateTable：货架库位主数据
CREATE TABLE "shelf_locations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "goods_shelf_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "remark" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shelf_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goods_shelves_tenant_id_warehouse_id_code_key" ON "goods_shelves"("tenant_id", "warehouse_id", "code");

CREATE INDEX "goods_shelves_tenant_id_warehouse_id_idx" ON "goods_shelves"("tenant_id", "warehouse_id");

CREATE UNIQUE INDEX "shelf_locations_tenant_id_code_key" ON "shelf_locations"("tenant_id", "code");

CREATE INDEX "shelf_locations_tenant_id_goods_shelf_id_idx" ON "shelf_locations"("tenant_id", "goods_shelf_id");

CREATE INDEX "shelf_locations_tenant_id_warehouse_id_idx" ON "shelf_locations"("tenant_id", "warehouse_id");
