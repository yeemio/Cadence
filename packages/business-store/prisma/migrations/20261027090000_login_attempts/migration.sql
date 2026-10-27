-- M2 安全前置批线 A（SP-1 登录速率限制）：登录失败计数/锁定表。
-- LoginAttemptStore 端口（application/src/auth/login-attempt-stores.ts）的 PG
-- 持久化通道（pg-org-stores.ts PgLoginAttemptStore）。轻量运营状态——同
-- sessions 取舍：不套证据公共列、不设 append-only 触发器。
-- 计数键 = (tenant_id, username)（含不存在的用户——防候选用户名爆破；
-- username 不设外键，同 policies 通用字符串取舍）。计数自增走单语句原子
-- upsert（ON CONFLICT 目标即本表唯一键），成功登录清零 = 删行。
--
-- 租户收口：tenant_id 列 + RLS 谓词（同批补登 src/rls/tables.ts 一行 +
-- 全量重放迁移 20261027090100，谓词与全仓表集一致）。superuser 迁移建表经
-- deploy/pg-init ALTER DEFAULT PRIVILEGES 对 app_user 自动授权 DML，迁移内
-- 无需 GRANT。

-- CreateTable：登录失败计数行（窗口失败计数 + 锁定窗）
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "failure_count" INTEGER NOT NULL,
    "last_failure_at" TIMESTAMPTZ(6) NOT NULL,
    "locked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：计数键唯一（ON CONFLICT 原子自增目标；tenant 前导兼作
-- isLocked/clear 热路径索引与 RLS 索引前导断言面）
CREATE UNIQUE INDEX "login_attempts_tenant_id_username_key" ON "login_attempts"("tenant_id", "username");
