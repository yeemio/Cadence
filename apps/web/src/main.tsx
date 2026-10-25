/**
 * 主壳入口：refine 无头模式（ADR-0006——只接 authProvider/routerProvider，
 * 不引入任何 UI 组件库预设）+ react-router 路由绑定 + TanStack Query
 * （组织管理页的直连数据层，M1 增量 3-D）。
 *
 * M5 首波：移动路由组 /m/*（MobileLayout 底部标签导航壳）与桌面壳
 * ShellLayout 并列——同一 SPA 内两个导航面，路由按路径前缀分流。
 */
import { StrictMode, type ComponentType } from 'react';
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
import { ModulePagePlaceholder } from './pages/ModulePagePlaceholder';
import { NotFoundPage } from './pages/NotFoundPage';
import { ItemsPage } from './pages/masterdata/ItemsPage';
import { ResourcesPage } from './pages/masterdata/ResourcesPage';
import { WorkbenchPage } from './pages/workbench/WorkbenchPage';
import { OrgRolesPage } from './pages/org/OrgRolesPage';
import { OrgUsersPage } from './pages/org/OrgUsersPage';
import { ScanPage } from './pages/scan/ScanPage';
import { MobileWorkbenchPage } from './pages/m/WorkbenchPage';
import { MobileReportPage } from './pages/m/ReportPage';
import { MobileHoursPage } from './pages/m/HoursPage';
import { MobileStockPage } from './pages/m/StockPage';
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

/** 桌面模块代码 -> 页面装配（占位页之外的已实现页面在此挂接）。 */
const PAGE_BY_CODE: Record<string, ComponentType> = {
  workbench: WorkbenchPage,
  'masterdata-item': ItemsPage,
  'masterdata-resource': ResourcesPage,
  scan: ScanPage,
  'system-user': OrgUsersPage,
  'system-role': OrgRolesPage,
};

/** 移动页面码 -> 页面装配（注册表见 mobile.ts；预研 scan-report 已升级为 m.report）。 */
const MOBILE_PAGE_BY_CODE: Record<string, ComponentType> = {
  'm.workbench': MobileWorkbenchPage,
  'm.report': MobileReportPage,
  'm.hours': MobileHoursPage,
  'm.stock': MobileStockPage,
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Refine
        authProvider={authProvider}
        routerProvider={routerProvider}
        options={{ syncWithLocation: true, disableTelemetry: true }}
      >
        <BrowserRouter>
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
        </BrowserRouter>
      </Refine>
    </QueryClientProvider>
  </StrictMode>,
);
