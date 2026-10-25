# Cadence server 镜像（M4 正式线：多阶段构建，运行镜像零 dev 工具）。
#
# 分层取舍（写明）：
#   base       —— node:24-slim（debian/openssl-3，与本地 Node 24 对齐；alpine 的
#                 musl 引擎兼容性靠 debian 版规避）。pnpm 钉 packageManager 版本。
#   build      —— 全量 install（--ignore-scripts：与仓内 pnpm-workspace.yaml 的
#                 构建脚本豁免清单一致；prisma 客户端由 business-store 的 build
#                 脚本显式 prisma generate 生成，不依赖 postinstall）+
#                 --filter @smes/server... 收敛依赖子图 + 拓扑序构建。
#   migrate    —— compose 迁移一次性服务用的 target：superuser 侧执行
#                 prisma migrate deploy（合同：迁移不走 app_user），含 prisma CLI
#                 （dev 工具，仅此 target 存在，运行镜像不含）。
#   prod-deps  —— 独立 --prod install：运行依赖树零 dev 工具（tsc/vitest/prisma CLI）。
#   runtime    —— prod 树 + build 的 dist 覆盖 + 生成客户端覆盖；NODE_ENV=production。
#
# 生成客户端覆盖取舍（写明）：prisma generate 产物落在 .pnpm store 的
# @prisma+client 条目内（含自包含引擎 .so.node）；prod install 的同名条目因 peer
# 解析差异目录名可能不同，故按 realpath 定位 prod 树的真实条目逐文件覆盖，
# 不依赖 .pnpm 目录名。
#
# dist 覆盖取舍（写明）：依赖闭包 12+ workspace 包且随 M2/M3 增长，逐包 COPY
# 脆；build 阶段每包 node_modules 仅是指向根 .pnpm 的符号链接（体量可忽略），
# 故整树拷 /tmp 再按 dist 目录循环落位，免维护包清单。
#
# 构建：docker build -f apps/server/Dockerfile -t cadence-server .（仓根 context）

FROM node:24-slim AS base
ENV npm_config_verify_deps_before_run=false
# openssl CLI：prisma 引擎平台检测依赖（缺省时 prisma 误判 openssl-1.1.x，
# 生成错误引擎变体，运行时 libssl3 下加载失败）。schema 的 binaryTargets 是
# P3 领地不动，镜像侧补检测输入即可选中 debian-openssl-3.0.x。
RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.28.5

# ---- 构建阶段：install（含 dev）+ 拓扑构建 ----
FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @smes/server...
# 拓扑序构建：business-core → application → engine-flow → business-store（含
# prisma generate，linux 引擎随生成落 .prisma/client）→ 专业包 → server dist
RUN pnpm --filter @smes/server... run build
# 快照生成客户端条目（供 runtime 覆盖；目录名含 peer 后缀，构建期解析一次）
RUN gen_entry="$(ls -d /repo/node_modules/.pnpm/@prisma+client@* | head -1)" \
  && cp -R "$gen_entry" /generated-prisma-client

# ---- 迁移 target：superuser 侧 migrate deploy（compose migrate 服务用）----
FROM build AS migrate
# 入口由 compose command 提供完整迁移序列（migrate deploy + _prisma_migrations 只读收口）

# ---- 运行依赖阶段：--prod 收敛（零 dev 工具）----
FROM base AS prod-deps
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @smes/server...

# ---- 运行镜像 ----
FROM node:24-slim AS runtime
# openssl CLI：prisma 运行时按其检测结果挑选引擎变体（生成期与运行期检测
# 必须一致，否则找不到镜像内已生成的 openssl-3.0.x 引擎）——运行时平台库，
# 非 dev 工具。
RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    npm_config_verify_deps_before_run=false
WORKDIR /repo
COPY --from=prod-deps /repo ./
COPY --from=build /generated-prisma-client /tmp/generated-prisma-client
COPY --from=build /repo/packages /tmp/built-packages
COPY --from=build /repo/apps/server/dist /repo/apps/server/dist
RUN set -eux \
  && for pkg_dir in /tmp/built-packages/*; do \
       if [ -d "$pkg_dir/dist" ]; then \
         name="$(basename "$pkg_dir")"; \
         rm -rf "/repo/packages/$name/dist"; \
         cp -R "$pkg_dir/dist" "/repo/packages/$name/dist"; \
       fi; \
     done \
  && rm -rf /tmp/built-packages \
  # 生成客户端覆盖：按 realpath 定位 prod 树的 @prisma/client 真实条目；
  # .prisma 落条目的 node_modules/ 层（@prisma 的父层，default.js 逐级向上
  # 解析 .prisma/client/default）；tarball 无 stub，rm 防御嵌套。
  && client_dir="$(realpath /repo/packages/business-store/node_modules/@prisma/client)" \
  && entry_node_modules="$(dirname "$(dirname "$client_dir")")" \
  && rm -rf "$entry_node_modules/.prisma" \
  && cp -R /tmp/generated-prisma-client/node_modules/.prisma "$entry_node_modules/" \
  && cp -R /tmp/generated-prisma-client/node_modules/@prisma/client/. "$client_dir/" \
  && rm -rf /tmp/generated-prisma-client \
  # peer 注入（取舍写明）：application 声明 @nestjs/common 为 peerDependency
  # （零框架纪律：框架由组合根提供；本地经 devDep 链接满足）。prod 子图不装
  # devDeps，故在根 node_modules 注入符号链接——等价 pnpm deploy 的 peer 解析，
  # 不改任何 package.json（application 为并发线领地）。仅此一个 peer 面
  # （全仓 packages 只有 application import @nestjs/common）。
  && mkdir -p /repo/node_modules/@nestjs \
  && ln -sfn "$(ls -d /repo/node_modules/.pnpm/@nestjs+common@*/node_modules/@nestjs/common | head -1)" /repo/node_modules/@nestjs/common \
  # 构建期自证：生成客户端在 prod 树内可解析（引擎 + index 就位）；
  # application dist 经注入 peer 可整树 import（装饰器需 reflect-metadata 先行）
  && cd /repo/packages/business-store \
  && node --input-type=module -e "import('@prisma/client').then((m)=>{ if (typeof m.PrismaClient!=='function') process.exit(1); })" \
  && cd /repo/apps/server \
  && node --input-type=module -e "import('reflect-metadata').then(()=>import('/repo/packages/application/dist/index.js')).catch((e)=>{ console.error(e); process.exit(1); })"

EXPOSE 3000
# healthcheck Host 取舍（写明）：saas 形态（SMES_TENANTS 非空）fail-closed 对域外
# Host 一律 500——liveness 探针不得依赖租户路由，故探针 Host = 首个已知租户 +
# SMES_DOMAIN；单机回落 127.0.0.1（与既有行为相同）。node http 而非 fetch：
# fetch 规范禁改 Host 头（静默忽略，探针会误报）。compose 级同名定义覆盖此处。
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["node", "-e", "const http=require('http');const t=(process.env.SMES_TENANTS||'').split(',').map(s=>s.trim()).filter(Boolean)[0];const h=t?t+'.'+(process.env.SMES_DOMAIN||''):'127.0.0.1';http.get({host:'127.0.0.1',port:3000,path:'/health',headers:{Host:h}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "apps/server/dist/main.js"]
