/**
 * 主壳入口：refine 无头模式（ADR-0006——只接 authProvider/routerProvider，
 * 不引入任何 UI 组件库预设）+ react-router 路由绑定 + TanStack Query
 * （组织管理页的直连数据层，M1 增量 3-D）。
 *
 * M5 首波：移动路由组 /m/*（MobileLayout 底部标签导航壳）与桌面壳
 * ShellLayout 并列——同一 SPA 内两个导航面，路由按路径前缀分流。
 *
 * S2 批次：页面装配表（PAGE_BY_CODE/MOBILE_PAGE_BY_CODE）抽提至
 * pages/assembly.ts（装配测试直接对注册表断言，本文件只消费）。
 *
 * i18n 波 1（ADR-0012）：主壳入口挂 common+menu 两 namespace（页面模块
 * namespace 波 2 再挂）；init 完成后再渲染（内联资源就绪，无 key 闪烁）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { BrowserRouter, Route, Routes } from 'react-router';
import { createAuthProvider, browserTokenSessionStore } from './auth';
import { authTransport } from './data/authApi';
import { authInFlightCount } from './data/apiClient';
import { setInFlightProvider, startSessionKeepalive } from './session-keepalive';
import { menuRoutes } from './menu';
import { mobileRoutes } from './mobile';
import { MOBILE_PAGE_BY_CODE, PAGE_BY_CODE } from './pages/assembly';
import { DigitalOperationScreenPage } from './pages/screen/DigitalOperationScreenPage';
import {
  SCREEN_SCENE_DIGITAL_OPERATION,
  screenPageRoute,
} from './pages/screen/screenRoutes';
import { ModulePagePlaceholder } from './pages/ModulePagePlaceholder';
import { NotFoundPage } from './pages/NotFoundPage';
import { ShellLayout } from './shell/ShellLayout';
import { MobileLayout } from './shell/MobileLayout';
import { initI18n } from './i18n';
import './index.css';

// i18n：主壳装 common+menu+波 2 五个高频模块 namespace（页面 namespace 波 2 挂载，
// proposal §8；登录入口仍只装 login+common——见 login/main.tsx）。
await initI18n([
  'common',
  'menu',
  'workorder',
  'dispatch',
  'inspection',
  'inventory',
  'reporting',
]);

const authProvider = createAuthProvider();

// 会话保活（收尾波-③，三规则见 session-keepalive.ts 文件头）：主壳入口挂载，
// 登录 bundle 不加载本模块。会话终结 = 清存储 + MPA 整页跳登录。
setInFlightProvider(authInFlightCount);
startSessionKeepalive({
  store: browserTokenSessionStore,
  transport: authTransport,
  onSessionEnd: () => {
    browserTokenSessionStore.clear();
    window.location.assign('/login');
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* T1 白屏修复：BrowserRouter 必须在 Refine 外层——@refinedev/react-router
          的 routerProvider.parse 渲染即调 useLocation()，Refine 在 Router context
          之外会整树崩（生产构建登录后白屏；登录 bundle 不加载本模块故 preview
          curl 一直看不出）。E2E 证据：testkit e2e-browser 主壳走查。 */}
      <BrowserRouter>
        <Refine
          authProvider={authProvider}
          routerProvider={routerProvider}
          options={{ syncWithLocation: true, disableTelemetry: true }}
        >
          <Routes>
            <Route element={<ShellLayout />}>
              {menuRoutes.map((route) => {
                const Page = PAGE_BY_CODE[route.code];
                return (
                  <Route
                    key={route.code}
                    path={route.routePath}
                    element={Page !== undefined ? <Page /> : <ModulePagePlaceholder route={route} />}
                  />
                );
              })}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
            {/* 移动路由组（M5 首波）：底部标签导航壳；/m 未匹配子路径回落桌面 404 */}
            <Route element={<MobileLayout />}>
              {mobileRoutes.map((route) => {
                const Page = MOBILE_PAGE_BY_CODE[route.code];
                if (Page === undefined) return null;
                return <Route key={route.code} path={route.routePath} element={<Page />} />;
              })}
            </Route>
            {/* 数字运营大屏（A8 首波，6a-3 裁决 3；O-1 修复）：独立全屏路由——
                1920x1080 等比缩放的墙挂展示页，不进 ShellLayout 业务壳（取舍见
                页面文件头注），同 /m/* 先例：与桌面/移动两导航面并列的第三呈现面。
                路由前缀 /bigscreen（O-1：旧 /screen/digital-operation 与 API
                同路径，直接打开/刷新被 nginx 反代打到后端 401 JSON——前缀取舍
                见 pages/screen/screenRoutes.ts 文件头）。 */}
            <Route
              path={screenPageRoute(SCREEN_SCENE_DIGITAL_OPERATION)}
              element={<DigitalOperationScreenPage />}
            />
          </Routes>
        </Refine>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
