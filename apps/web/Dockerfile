# Cadence web 镜像（M4 正式线：构建 → nginx 静态服务）。
#
# 取舍（写明）：
#   - 多阶段：builder 装全部依赖（vite/tailwind 是 devDeps）并拓扑构建
#     --filter @smes/web...（workspace 依赖 product-ui/integration-scan 及其
#     上游 application/business-core 的 dist 先行产出）；运行镜像仅 nginx + dist。
#   - 运行期 nginx 行为对齐 vite preview：MPA 双入口（无 SPA history fallback）、
#     /login 友好路径重写到 /login.html（vite.config loginPathRewrite 的服务端
#     对应物，query 原样保留）——见 apps/web/nginx.conf。
#   - 未命中静态文件的路径反代到 server（VITE_API_BASE_URL 缺省 ''=同源直连，
#     compose 栈内浏览器请求经此代理到达 server:3000）。
#
# 构建：docker build -f apps/web/Dockerfile -t cadence-web .（仓根 context）

FROM node:24-slim AS base
ENV npm_config_verify_deps_before_run=false
RUN npm install -g pnpm@11.28.5

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @smes/web...
RUN pnpm --filter @smes/web... run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
