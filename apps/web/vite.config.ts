/**
 * Vite 双入口 MPA 配置（ADR-0009：登录独立入口、不加载主应用）。
 *
 * - appType: 'mpa' —— 关闭 SPA history fallback，两个入口各自独立
 * - rollupOptions.input —— 主壳 index.html + 登录 login.html，构建出两套互不重叠的 bundle
 * - loginPathRewrite —— dev/preview 都把 '/login' 友好路径映射到 '/login.html'
 * - VitePWA（M5 预研，ADR-0006 移动端"同代码 PWA"）：manifest + generateSW，
 *   取舍见下方 PWA 配置块注释
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function loginPathRewrite(): Plugin {
  const rewrite = (req: { url?: string | undefined }): void => {
    if (req.url === '/login') {
      req.url = '/login.html';
    } else if (req.url !== undefined && req.url.startsWith('/login?')) {
      req.url = `/login.html${req.url.slice('/login'.length)}`;
    }
  };
  return {
    name: 'login-path-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
  };
}

/**
 * workbox generateSW 选项。注意：vite-plugin-pwa 的 defaultWorkbox 自带
 * `navigateFallback: 'index.html'`，其 NavigationRoute（precache 直出）注册在
 * runtime 路由之前，会抢走全部导航请求——与"导航 NetworkFirst"语义冲突。
 * 此处显式置 null 关闭该默认值（generateSW 对 null/undefined 同判 falsy 不生成
 * NavigationRoute；Object.assign 下键存在才能覆盖默认值）。
 */
const workboxConfig: {
  globPatterns: string[];
  cleanupOutdatedCaches: boolean;
  navigateFallback?: string | null;
  runtimeCaching: [
    {
      urlPattern: (options: { request: { mode: string } }) => boolean;
      handler: 'NetworkFirst';
      options: {
        cacheName: string;
        networkTimeoutSeconds: number;
        precacheFallback: { fallbackURL: string };
      };
    },
  ];
} = {
  globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
  cleanupOutdatedCaches: true,
  navigateFallback: null,
  runtimeCaching: [
    {
      urlPattern: ({ request }) => request.mode === 'navigate',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'cadence-navigations-v1',
        networkTimeoutSeconds: 4,
        precacheFallback: { fallbackURL: '/offline.html' },
      },
    },
  ],
};

export default defineConfig({
  appType: 'mpa',
  plugins: [
    react(),
    tailwindcss(),
    loginPathRewrite(),
    // M5 预研 PWA 骨架（vite-plugin-pwa 2.0，MIT）。策略取舍（写明）：
    // - strategies generateSW：SW 由 workbox 声明式生成（dist/sw.js），不自写
    //   SW 源码——形状预研优先，复杂策略调优（BackgroundSync/推送）是 M5 正式线。
    // - 导航请求（request.mode === 'navigate'）走 NetworkFirst（4s 超时），
    //   失败回退 precache 的离线壳页 /offline.html（precacheFallback——
    //   Workbox PrecacheFallbackPlugin；offline.html 在 precache 清单内）。
    //   在线优先保证主壳 html 不滞留旧版本；访问过的页在运行时缓存中可离线打开。
    // - 静态资源（js/css/html/svg/webmanifest）precache（globPatterns）——
    //   哈希文件名自带版本语义，离线壳与懒块（如 html5-qrcode 分块）可离线加载。
    // - registerType autoUpdate：新版本 SW 激活后自动刷新（预研形态最省心；
    //   prompt 交互是 M5 正式线按需切换项）。
    // - injectRegister 'inline'：MPA 双入口各自内联一行注册脚本，不追加
    //   registerSW.js 请求；登录页也注册（SW scope '/' 全站一份，登录入口
    //   无独立 SW 的必要——两入口本就共享同一 origin 的离线缓存）。
    // - dev 模式禁用 SW（devOptions.enabled: false，亦是缺省值）：dev 下 SW
    //   缓存会掩盖最新改动、且 HMR 与 SW 语义打架；PWA 行为只对 build/preview
    //   验证。显式写 false 是为了让"dev 不出 SW"成为声明过的决定而非缺省巧合。
    // - 图标是 SVG 几何占位（public/icons/icon.svg，非品牌资源）；部分浏览器
    //   安装横幅要求 PNG 192/512 位图——M5 正式线补真实图标时一并处理。
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      includeAssets: ['offline.html', 'icons/icon.svg'],
      manifest: {
        name: 'Cadence',
        short_name: 'Cadence',
        description: 'Cadence 制造运营（PWA 预研形态）',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        theme_color: '#18181b', // 对齐 shadcn 中性主色 token（近黑）
        background_color: '#ffffff',
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: workboxConfig,
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: { '@': resolve(rootDir, 'src') },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        login: resolve(rootDir, 'login.html'),
      },
    },
  },
});
