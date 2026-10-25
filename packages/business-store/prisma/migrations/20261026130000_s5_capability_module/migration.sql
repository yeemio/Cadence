-- T 波 S5 能力子集三表（109 口径 #98/99 菜单管理 / #102 审批配置 / #101 通知中心）。
--
-- 表形态分工（配置数据/收件箱域，ADR-0010 通用词）：
--   menu_configs           菜单配置集（一行 = 一棵节点树 JSON 文档；节点形状与
--                          product-ui MenuNode 一一对应，树校验在 application
--                          输入解析层；软停用同 items 体例）；
--   approval_flow_configs  审批流配置（一行 = 一份 engine-flow
--                          ApprovalFlowConfig 全文 JSON；flow_id 即
--                          approval_cases.flow_config_id 引用的业务键，不可变；
--                          JSON 读出经 defineApprovalFlowConfig 固化复核）；
--   notifications          收件箱通知行（未读→已读单向标记 = UPDATE；通知的
--                          事实源是各业务域事件账本，本行只是面向人的投影视图；
--                          数据级过滤 (tenant, recipient) 双键，语义同 todos）。
--
-- 均不套证据公共列、不设 append-only 触发器（配置数据/轻量运营状态非业务
-- 事实，取舍见 schema.prisma 分节注释与 application 各 *-stores.ts 文件头）。
-- RLS 同批补登：src/rls/tables.ts 三行 + 全量重放迁移 20261026131000。

-- CreateTable：菜单配置集
CREATE TABLE "menu_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable：审批流配置（history = 版本快照数组，T1 接线 #102）
CREATE TABLE "approval_flow_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_flow_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable：收件箱通知
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "source" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "menu_configs_tenant_id_code_key" ON "menu_configs"("tenant_id", "code");

CREATE UNIQUE INDEX "approval_flow_configs_tenant_id_flow_id_key" ON "approval_flow_configs"("tenant_id", "flow_id");

CREATE INDEX "notifications_tenant_id_recipient_id_read_at_idx" ON "notifications"("tenant_id", "recipient_id", "read_at");

CREATE INDEX "notifications_tenant_id_recipient_id_created_at_idx" ON "notifications"("tenant_id", "recipient_id", "created_at" DESC);
