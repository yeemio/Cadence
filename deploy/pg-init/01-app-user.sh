#!/bin/bash
# 受限 app 用户初始化（RLS 生效前提——ADR-0005 SaaS 形态）。
#
# docker-entrypoint-initdb.d 钩子：initdb 后、容器首启时以 superuser 运行。
# 语义：app_user 仅 CONNECT + public schema USAGE + 表/序列 DML 权限；
# 无 BYPASSRLS、非表 owner、非 superuser → PG 行级安全策略对其生效。
#
# 时序取舍（写明）：业务表晚于 initdb 由 prisma migrate（以 postgres）创建，
# 故除当场 GRANT 外必须登记 ALTER DEFAULT PRIVILEGES FOR ROLE postgres——
# 否则迁移建出的表 app_user 一张都摸不到。迁移以 superuser 跑、运行时连接
# 用 app_user，是单机/SaaS 双形态共同的形状（RLS 对后者才是安全边界）。
set -euo pipefail

# 低危清偿：口令不进 heredoc 字符串拼接（SQL 注入面），经 psql -v 绑定为
# :'app_password' 引用字面量——psql 变量引用自带安全引号语义。
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$POSTGRES_APP_PASSWORD" <<-EOSQL
  CREATE ROLE app_user LOGIN PASSWORD :'app_password';
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO app_user;
  GRANT USAGE ON SCHEMA public TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE "${POSTGRES_USER}" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE "${POSTGRES_USER}" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
EOSQL

echo "[pg-init] app_user 就绪（受限 DML，无 BYPASSRLS）"
