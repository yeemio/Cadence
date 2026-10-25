-- U5 aftercare claim 售后报销两表（A12：售后派工单审批通过后财务填报四类费用
-- 食宿/交通/加班/其他；文档《售后派工》§2.4 的 Cadence 重述，本波只落数据面，
-- 成本计算接线归后续波）。
--
-- 表形态（版本化运营数据取舍，schema.prisma dispatch 节同文）：
--   aftercare_claims        报销单投影（挂售后派工单一单一报销：(tenant_id,
--                           dispatch_id) 唯一 = 「该派工单已存在报销记录，请直接
--                           编辑」的 DB 兜底；object_version 乐观推进 = updateFees +1）；
--   aftercare_claim_lines   报销明细行（行 = 一条审批通过报工：report_id 单内
--                           唯一 = 明细键；行身份快照 report_date/worker/
--                           approved_by/approved_minutes 创建即冻结；四类费用
--                           整数分 NOT NULL DEFAULT 0——未填默认 0 落库；小计/
--                           合计读面计算不落冗余列）。
-- 不套证据公共列、不设 append-only 触发器（投影取舍同 outsourcing_lines）；域事件
-- 复用既有 event_records/outbox_records，命令幂等复用既有 dispatch_operations。
-- RLS 同批补登：src/rls/tables.ts 两行 + 全量重放迁移 20261026161000（U4 兄弟线
-- 160100 重放不含本两表——本建表槽位 160500 晚于其 160000，重放取最新序守恒）。

-- CreateTable：售后报销单（一单一报销）
CREATE TABLE "aftercare_claims" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dispatch_id" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aftercare_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable：售后报销明细行（明细键 = report_id 单内唯一）
CREATE TABLE "aftercare_claim_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "report_id" TEXT NOT NULL,
    "report_date" TIMESTAMPTZ(6) NOT NULL,
    "worker" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_minutes" INTEGER NOT NULL,
    "lodging_minor" INTEGER NOT NULL DEFAULT 0,
    "traffic_minor" INTEGER NOT NULL DEFAULT 0,
    "overtime_minor" INTEGER NOT NULL DEFAULT 0,
    "other_minor" INTEGER NOT NULL DEFAULT 0,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aftercare_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：一单一报销（租户前导 = RLS 索引前导断言同源）
CREATE UNIQUE INDEX "aftercare_claims_tenant_id_dispatch_id_key" ON "aftercare_claims"("tenant_id", "dispatch_id");

-- CreateIndex：明细行热路径（报销单内行集读取 + 行号/明细键唯一）
CREATE UNIQUE INDEX "aftercare_claim_lines_tenant_id_claim_id_line_no_key" ON "aftercare_claim_lines"("tenant_id", "claim_id", "line_no");
CREATE UNIQUE INDEX "aftercare_claim_lines_tenant_id_claim_id_report_id_key" ON "aftercare_claim_lines"("tenant_id", "claim_id", "report_id");
CREATE INDEX "aftercare_claim_lines_tenant_id_claim_id_idx" ON "aftercare_claim_lines"("tenant_id", "claim_id");
