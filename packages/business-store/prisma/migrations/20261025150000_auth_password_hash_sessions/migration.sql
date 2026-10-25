-- M1 收尾波-③ 真实认证：
--   1) users 增 password_hash（可空：组织端点创建的用户默认未设口令，不能登录；
--      种子为演示身份设默认口令 demo-password，见 prisma/seed.mjs）；
--   2) sessions 会话表（token 摘要存储——明文 token 不落库；撤销 = 软撤销
--      revoked_at 置时；轻量运营状态，不设 append-only 触发器）。

ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_digest_key" ON "sessions"("token_digest");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "sessions"("tenant_id", "user_id");
