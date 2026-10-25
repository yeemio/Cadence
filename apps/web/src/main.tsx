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
import { ModulePagePlaceholder } from './pages/ModulePagePlaceholder';
import { NotFoundPage } from './pages/NotFoundPage';
import { ShellLayout } from './shell/ShellLayout';
import { MobileLayout } from './shell/MobileLayout';
import './index.css';

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
          </Routes>
        </Refine>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
