/**
 * Vite 双入口 MPA 配置（ADR-0009：登录独立入口、不加载主应用）。
 *
 * - appType: 'mpa' —— 关闭 SPA history fallback，两个入口各自独立
 * - rollupOptions.input —— 主壳 index.html + 登录 login.html，构建出两套互不重叠的 bundle
 * - loginPathRewrite —— dev/preview 都把 '/login' 友好路径映射到 '/login.html'
 * - mobileRouteFallback —— dev/preview 把 '/m' 与 '/m/*'（纯客户端移动路由，
 *   manifest start_url 直达依赖）窄域回落主壳 index.html；其余深链语义不变
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
 * 移动路由组 /m* 的文档回落（M5 收尾波）：appType 'mpa' 关闭 SPA history
 * fallback——桌面深链未命中 404 是有意语义（nginx.conf 同形，未命中静态文件
 * 反代 server）。但 /m 命名空间是纯客户端移动路由（无同名静态文件、无同名
 * API 路径），manifest start_url='/m'（安装态直达移动工作台）依赖文档可达。
 * 窄域把 '/m' 与 '/m/*' 服务端重写为主壳 index.html——浏览器 URL 不变
 * （BrowserRouter 按 location 渲染对应移动页），query 原样保留；其余深链
 * 行为不变（仍 404/反代）。nginx.conf 有同形 location 对应物。
 */
function mobileRouteFallback(): Plugin {
  const rewrite = (req: { url?: string | undefined }): void => {
    if (req.url === undefined) return;
    const qIndex = req.url.indexOf('?');
    const path = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
    const query = qIndex === -1 ? '' : req.url.slice(qIndex);
    if (path === '/m' || path.startsWith('/m/')) {
      req.url = `/index.html${query}`;
    }
  };
  return {
    name: 'mobile-route-fallback',
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
  // precache 单路化（M5 收尾波低危清理）：此前 globPatterns 含 webmanifest、
  // includeAssets 含 offline.html/icon.svg——三者与"插件自动注入 manifest/
  // glob 的 html/svg 匹配"叠加产生双路重复条目（离线壳/图标/清单各出现两次）。
  // workbox addToCacheList 对重复 URL：同 cacheKey 静默去重（良性），异
  // cacheKey 抛 conflicting-entries 使 SW 安装失败（潜在地雷）。源头去重：
  //   - webmanifest 从 glob 移除——vite-plugin-pwa 恒自动注入 manifest.webmanifest
  //   - offline.html / icon.svg 从 includeAssets 移除——glob 的 **/*.html 与
  //     **/*.svg 已覆盖；includeAssets 只留 glob 不覆盖的 PNG 图标
  //   - includeManifestIcons: false（核查补漏）：插件缺省 true 会把 manifest.icons
  //     各 src 再并入 publicDir glob（additionalManifestEntries）——icon.svg 因此
  //     与 dist glob 双路重复收录（同 revision 良性，但违背单路不变量）。关闭后
  //     manifest 图标不自动进 precache，覆盖责任显式归 includeAssets/globPatterns
  //     （当前清单：PNG×5 由 includeAssets、icon.svg 由 glob，全部单路在册）。
  //     注意：该开关是 VitePWA 顶层选项（非 workbox 子项——放错层会被
  //     workbox-build 校验拒绝）。单路不变量由 verify-pwa.mjs 的 precache
  //     重复 URL 断言锚定。
  globPatterns: ['**/*.{js,css,html,svg}'],
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
    mobileRouteFallback(),
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
    // - 图标已实化（M5 收尾波）：PNG 192/512 any + maskable 双尺寸 + iOS
    //   apple-touch-icon，由 scripts/generate-icons.mjs 零依赖生成；icon.svg
    //   保留作小尺寸/favicon。
    VitePWA({
      registerType: 'autoUpdate',
      // manifest 图标不自动并入 precache（单路化收口，依据见 workboxConfig 注释）
      includeManifestIcons: false,
      injectRegister: 'inline',
      // 图标实化（M5 收尾波）：PNG 192/512 由 scripts/generate-icons.mjs 零依赖
      // 生成（品牌几何=节拍圆环+斜杠，与 public/icons/icon.svg 同参）；maskable
      // 双尺寸全出血（图形居 80% 安全区，像素级校验 164.7 ≤ 204.8）；SVG 保留
      // 作小尺寸/favicon。installable 门槛 = 192+512 位图（Chrome 安装横幅要求）。
      // includeAssets 只列 glob（js/css/html/svg）不覆盖的 PNG；html/svg 已由
      // globPatterns 单路收编（见 workboxConfig 注释——双路重复条目已清）。
      includeAssets: [
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-192.png',
        'icons/icon-maskable-512.png',
        'icons/apple-touch-icon.png',
      ],
      manifest: {
        name: 'Cadence',
        short_name: 'Cadence',
        description: 'Cadence 制造运营（PWA 预研形态）',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'portrait-primary',
        // 移动端专用形态（M5）：安装直达 /m 移动四页（工作台首页），桌面壳经
        // 浏览器访问。scope 保持 '/'——同一 SPA，start_url 只是入口选择。
        start_url: '/m',
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
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
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
