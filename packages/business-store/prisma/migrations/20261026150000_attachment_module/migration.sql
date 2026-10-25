-- U3 attachment 附件中心单表（A13 文件管理：统一附件元数据 mes_biz_file 重述；
-- 字节/对象键在 ObjectStoragePort 适配器侧（内存/本地文件，MinIO/S3 接入归
-- 部署期换装），本表零对象存储依赖）。
--
-- 表形态（运营元数据取舍，schema.prisma attachment 节同文）：
--   attachments          附件元数据行（追加 + 逻辑删除 deleted_at 置位，不删
--                        物理对象；存储引用三字段 storage_kind/target/object_key
--                        = 端口对象引用（文档方案 B），仅签发短时只读引用时读，
--                        列表 VO 不下发）。
--
-- 词汇重述（ADR-0010）：biz_module 字典 → biz_type 通用类型码（单段小写，取值
-- 由消费方定义）；storage_type 字典 → storage_kind 适配器自述串；bucket_name →
-- target；is_deleted → deleted_at；status 框架占位不落。排序合同：created_at
-- DESC + id ASC（索引前导租户）。不套证据公共列、不设 append-only 触发器
-- （运营单据非不可变事实）。索引仅普通索引，禁止 UNIQUE（文档 §1.3/书写注意：
-- 同 biz_id 允许多条追加，业务规则本期不要求唯一性）。
-- RLS 同批补登：src/rls/tables.ts 一行 + 全量重放迁移 20261026150100。

-- CreateTable：附件元数据
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT,
    "storage_kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_url" TEXT,
    "biz_type" TEXT NOT NULL,
    "biz_id" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：按业务主键列表查询（租户前导；created_at DESC 服务排序合同）
CREATE INDEX "attachments_tenant_id_biz_id_created_at_idx" ON "attachments"("tenant_id", "biz_id", "created_at" DESC);
