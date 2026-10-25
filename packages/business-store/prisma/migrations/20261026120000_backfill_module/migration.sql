-- S1 backfill 六表（0920 清单 #3 机构/#7 岗位/#8 客户/#9 供应商/#100 计量单位/#103 操作日志）。
--
-- 表形态分工（配置数据/运维日志域，ADR-0010 通用词）：
--   departments  机构/部门节点（parent_id 自引用树；层级/成环守卫在 OrgService
--                用例层，表不设外键——父节点可停用/换挂，引用完整性由服务端守卫）；
--   positions    岗位主数据（department_ref 可空引用 departments.id，同上不设外键）；
--   customers    客户主数据（工作令 customerRef 文本引用的主数据面）；
--   suppliers    供应商主数据（外协 supplierRef/采购引用的主数据面）；
--   units        计量单位字典（纯字典无 active——改错=直接改名）；
--   audit_logs   操作日志（append-only 只插入；summary 截断不打载荷全文；
--                (tenant_id, occurred_at DESC) 前导索引即查询热路径）。
--
-- 均不套证据公共列、不设 append-only 触发器（配置数据/运维日志非业务事实，
-- 取舍见 schema.prisma 分节注释与 application 各 *-stores.ts 文件头）。
-- RLS 同批补登：src/rls/tables.ts 六行 + 全量重放迁移 20261026121000。

-- CreateTable：机构/部门节点
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable：岗位主数据
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_ref" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable：客户主数据
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable：供应商主数据
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable：计量单位字典
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable：操作日志（append-only）
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "departments"("tenant_id", "code");

CREATE INDEX "departments_tenant_id_parent_id_idx" ON "departments"("tenant_id", "parent_id");

CREATE UNIQUE INDEX "positions_tenant_id_code_key" ON "positions"("tenant_id", "code");

CREATE INDEX "positions_tenant_id_department_ref_idx" ON "positions"("tenant_id", "department_ref");

CREATE UNIQUE INDEX "customers_tenant_id_code_key" ON "customers"("tenant_id", "code");

CREATE UNIQUE INDEX "suppliers_tenant_id_code_key" ON "suppliers"("tenant_id", "code");

CREATE UNIQUE INDEX "units_tenant_id_code_key" ON "units"("tenant_id", "code");

CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id" DESC, "occurred_at" DESC);

CREATE INDEX "audit_logs_tenant_id_user_id_occurred_at_idx" ON "audit_logs"("tenant_id", "user_id", "occurred_at" DESC);
