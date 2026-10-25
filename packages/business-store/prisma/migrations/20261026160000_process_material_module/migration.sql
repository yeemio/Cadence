-- U4 listing 工序×原材料关联表单表（S10 / A5 前置之一：生产购置清单 §1.3.4
-- mes_purchase_part_process_material 重述，ADR-0010 词汇纪律）。本波只落
-- 数据面（关联 CRUD + 尺寸/单价快照录入值 + 数量）；成本计算与下单/派工
-- 接线归后续波。
--
-- 词汇重述：pruchase_part_id → listing_line_id（零件清单行）；purchase_part_process_id
-- → process_id（工序行 opaque 引用——listing 域工序面落库前由调用方约定，
-- 同租户内一个 process_id 只允许挂一个 listing_line_id，由 (tenant, process_id)
-- 组 UNIQUE 守恒）；raw_material_unit_price → unit_price_minor（录入值快照，
-- 分——合同裁定无取价源）；measure_type/cut_size_unit 由 cut_size_form 确定性
-- 派生存快照；quantity 为合同列明的数据面字段（原文表无此列）。
--
-- 表形态（运营投影取舍，schema.prisma listing 节同文）：不套证据公共列、
-- 无行级乐观版本——唯一写面是整表替换（事务内删旧插新；原文「整表覆盖写入
-- + 逻辑删除旧行」的 Cadence 重述：本模块投影无 is_deleted 面，改硬删）。
-- 原文「不得建 UNIQUE（同工序多行唯一性由业务层控制）」的动因是 Java 逻辑
-- 删除会让已删行撞唯一键；Cadence 硬删替换后 DB 级守恒与 listing_lines
-- (tenant, sheet, line_no) 唯一先例一致。
-- RLS 同批补登：src/rls/tables.ts 一行 + 全量重放迁移 20261026160100。

-- CreateTable：工序×原材料关联行（一工序 : N 原材料，sort_order 从 0 递增）
CREATE TABLE "process_material_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "listing_line_id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "raw_material_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" INTEGER,
    "measure_type" TEXT NOT NULL,
    "part_length" DOUBLE PRECISION NOT NULL,
    "part_width" DOUBLE PRECISION,
    "part_height" DOUBLE PRECISION,
    "cut_size_form" TEXT NOT NULL,
    "cut_size_unit" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "process_material_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：同工序行序唯一（整表替换事务内 0..N-1）+ 工序引用归属钉住
CREATE UNIQUE INDEX "process_material_links_tenant_id_process_id_sort_order_key" ON "process_material_links"("tenant_id", "process_id", "sort_order");
-- CreateIndex：同工序原材料不重复（原文业务唯一，Cadence 升 DB 级守恒）
CREATE UNIQUE INDEX "process_material_links_tenant_id_process_id_raw_material_id_key" ON "process_material_links"("tenant_id", "process_id", "raw_material_id");
-- CreateIndex：零件清单行全工序关联读（下单回填 / A5 项目成本取数面）
CREATE INDEX "process_material_links_tenant_id_listing_line_id_idx" ON "process_material_links"("tenant_id", "listing_line_id");
