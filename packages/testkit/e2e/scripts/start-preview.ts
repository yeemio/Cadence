/**
 * vite preview 反代编排（浏览器 e2e 专用，packages/testkit 泳道——不碰 apps/web）。
 *
 * 形态取舍（写明）：
 * - web 产物构建时不注入 VITE_API_BASE_URL → apiClient 的 API_BASE 为空串
 *   （同源相对路径，apps/web/src/data/apiClient.ts 缺省语义）。server 未开
 *   CORS（NestFactory.create 缺省），跨源直连会被浏览器拦——故在 preview 层
 *   用 vite 原生 proxy 把全部 API 一级前缀反代到 server 端口，浏览器只见
 *   单一 origin，零 CORS、零改 apps/web。
 * - API 前缀清单 = apps/server + packages/application 全部 @Controller 一级
 *   路径（编排时点手工汇总）；静态产物（index/login/offline/sw/manifest/
 *   assets/icons）与之前缀无同名冲突。
 * - 已知路径交叠：SPA 客户端路由 /reports、/standard-reports、/inventory/*
 *   与 API 前缀同名——MPA（appType 'mpa'，ADR-0009）本就无 history fallback，
 *   深链刷新命中 API 属部署层真实语义；e2e 走查一律经菜单点击导航，不做深链
 *   直接 goto。
 * - /m 移动壳：主壳 bundle 内含移动路由组（main.tsx 双导航面），但 dist 无
 *   /m 静态文件——生产部署需把 /m 指到主壳 index.html。此处经 plugin 的
 *   configurePreviewServer post 钩子（vite 内部中间件之后，404 终结前）对
 *   /m* 未命中路径回 serve index.html，即模拟该部署规则（真实文档加载，
 *   非 mock）。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Plugin, PreviewServer } from 'vite';
import { preview } from 'vite';
import { API_BASE, APPS_WEB, WEB_PORT } from './env.ts';

/** API 一级前缀（server + application 全部 @Controller 汇总）。 */
const API_PREFIXES = [
  '/auth',
  '/health',
  '/modules',
  '/workbench',
  '/workorder',
  '/listing',
  '/inspection',
  '/inventory',
  '/dispatch',
  '/reporting',
  '/reports',
  '/standard-reports',
  '/hours',
  '/costing',
  '/org',
  '/masterdata',
  '/audit',
  '/approval',
  '/purchase',
  '/outsourcing',
  '/baseline',
  '/demo',
  '/notifications',
  '/menu-config',
  '/drawing',
  '/maintenance',
  '/payroll',
  '/metric-pack',
  '/dev',
] as const;

/** /m* 静态未命中 → 主壳 index.html（部署层 /m 路由规则的 preview 等价物）。 */
function mobileShellFallback(dist: string): Plugin {
  return {
    name: 'e2e-mobile-shell-fallback',
    configurePreviewServer(server) {
      return () => {
        server.middlewares.use((req, res, next) => {
          const path = req.url ?? '';
          if (!path.startsWith('/m')) {
            next();
            return;
          }
          readFile(`${dist}/index.html`).then(
            (body) => {
              res.statusCode = 200;
              res.setHeader('content-type', 'text/html');
              res.end(body);
            },
            (error: unknown) => {
              next(error);
            },
          );
        });
      };
    },
  };
}

export async function startPreview(): Promise<PreviewServer> {
  const dist = `${APPS_WEB}/dist`;
  if (!existsSync(dist)) {
    throw new Error(`${dist} 不存在——先 pnpm --filter @smes/web build`);
  }

  const server = await preview({
    root: APPS_WEB,
    plugins: [mobileShellFallback(dist)],
    preview: {
      // 显式钉 IPv4：vite 7 缺省监听 ::1（IPv6 localhost），127.0.0.1 探活/
      // baseURL 一律被拒——走查栈统一 IPv4 回环。
      host: '127.0.0.1',
      port: WEB_PORT,
      strictPort: true,
      proxy: Object.fromEntries(
        API_PREFIXES.map((prefix) => [prefix, { target: API_BASE }]),
      ),
    },
  });

  return server;
}
