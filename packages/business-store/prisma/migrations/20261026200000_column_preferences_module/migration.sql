-- fix-wave-6 6b-3（A14 / PRD 22 册 RREQ-INT-032）用户表格列显隐偏好表：
-- ColumnPreferenceStore 的 PG 适配器（pg-column-preferences-stores.ts）持久化
-- 通道。三元组（user_id × page_key × table_key）一条有效记录，只存隐藏列
-- prop 集合（JSONB；空数组 = 用户显式全显示，与"从未保存"由行缺位区分）。
--
-- 与源文档差异（登记）：源《用户表格列显隐配置》§1.3 禁 UNIQUE、Service
-- 先查再插/更——并发下会双行；我方收口为库级 UNIQUE（tenant 前导）支撑
-- 幂等 upsert（Prisma upsert 唯一键 where）。
--
-- 租户收口：tenant_id 列 + RLS 谓词（同批补登 src/rls/tables.ts 一行 +
-- 全量重放迁移 20261026200100，谓词与全仓 103 表一致）。superuser 迁移建表
-- 经 deploy/pg-init ALTER DEFAULT PRIVILEGES 对 app_user 自动授权 DML，
-- 迁移内无需 GRANT。

-- CreateTable：列显隐偏好行（进页按页拉取，勾选后防抖 upsert）
CREATE TABLE "column_preferences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "page_key" TEXT NOT NULL,
    "table_key" TEXT NOT NULL,
    "hidden_props" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "column_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：三元组有效记录唯一（幂等 upsert 的库级收口；租户前导兼作
-- 按页拉取热路径（tenant+user+page 前缀查询）与 RLS 索引前导断言面）
CREATE UNIQUE INDEX "column_preferences_tenant_id_user_id_page_key_table_key_key" ON "column_preferences"("tenant_id", "user_id", "page_key", "table_key");
