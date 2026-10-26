-- fix-wave-4 W4-2（D-3）附件对象字节表：ObjectStoragePort 的 PG 适配器
-- （pg-object-storage.ts）持久化通道。附件字节存 PG bytea（TOAST 行外，
-- 32MiB 护栏内），重启随 pg-data 卷存活——修复内存适配器重启即丢
-- （download-reference 502）。attachments 元数据表零变更（列表/详情查询
-- 永不触碰字节列，独立新表而非加列的取舍见预研 §2 方案 A）。
--
-- 租户收口：tenant_id 列 + RLS 谓词（同批补登 src/rls/tables.ts 一行 +
-- 全量重放迁移 20261026180100，谓词与全仓 101 表一致）。object_key
-- 库内唯一（uuid 体例，put 恒新生成——bytea 形态下键退化为库内唯一标识，
-- 租户隔离由 tenant_id 行承载，MinIO/S3 前缀欠账不被本形态触发）。
-- 索引：租户前导复合（查取热路径）+ object_key 唯一（库内唯一标识）。
-- superuser 迁移建表经 deploy/pg-init ALTER DEFAULT PRIVILEGES 对
-- app_user 自动授权 DML，迁移内无需 GRANT。

-- CreateTable：附件对象字节行（put 追加，无更新/删除面）
CREATE TABLE "attachment_objects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "content_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：对象键库内唯一（put 生成 uuid 体例键，冲突即 bug 显形）
CREATE UNIQUE INDEX "attachment_objects_object_key_key" ON "attachment_objects"("object_key");

-- CreateIndex：租户前导查取热路径（存在性验证/兑现按 tenant+object_key）
CREATE INDEX "attachment_objects_tenant_id_object_key_idx" ON "attachment_objects"("tenant_id", "object_key");
