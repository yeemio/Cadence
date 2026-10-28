/**
 * 主壳布局：refine `Authenticated` 守卫（无头第一范式——check 失败经
 * routerProvider 重定向登录页）+ 动态菜单侧栏（toSidebarMenu 按权限投影）+ 顶栏。
 * 视觉：shadcn/ui 令牌体系（侧栏 bg-sidebar / 内容区 bg-muted/40 / 卡片 bg-card）。
 *
 * 响应式（M5 正式）：侧栏 <768px（md 断点以下）收起为抽屉。取舍——抽屉而非
 * 底部导航：菜单树两级分组（制造运营/系统管理多入口）塞不进底部标签栏，
 * 抽屉保留完整菜单结构与权限投影语义，改动收敛在本文件（MenuNav 不动）。
 * 桌面（≥md）侧栏恒显，与既有布局零变化。移动端顶栏 hamburger（≥44px 触摸
 * 目标）开抽屉；遮罩点击 / 导航链接点击（事件委托 closest('a')）自动收起。
 *
 * i18n 波 1（ADR-0012）：固定 chrome 文案走 common namespace t()；顶栏挂
 * 语言切换器（localStorage `smes.locale` 持久化，html lang 同步）。
 * UX-PLAN-13/AP-06/VW-02：顶栏显示名经 presentDisplayName 呈现净化（剥夹具
 * 括注/权限码拼接、「种子」→「演示」；见 shell/displayName.ts，不碰菜单注册）。
 */
import { useState } from 'react';
import {
  Authenticated,
  useGetIdentity,
  useLogout,
  usePermissions,
} from '@refinedev/core';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Outlet } from 'react-router';
import { AudioWaveform, Bell, Building2, LoaderCircle, LogOut, Menu, X } from 'lucide-react';
import { permissionCode, sessionHasPermission, toPermissionCodes, toSidebarMenu } from '@smes/product-ui';
import { menuTree } from '../menu';
import { fetchUnreadCount } from '../data/notificationsApi';
import { useMergedMenu } from './useMenuConfig';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MenuNav } from './MenuNav';
import { presentDisplayName } from './displayName';
import { LanguageSwitch } from '../i18n/LanguageSwitch';

export function ShellLayout() {
  return (
    <Authenticated key="shell" redirectOnFail="/login" loading={<ShellLoading />}>
      <ShellBody />
    </Authenticated>
  );
}

function ShellLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-muted/40 text-sm text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
      {t('common:state.sessionChecking')}
    </div>
  );
}

interface ShellIdentity {
  readonly displayName?: unknown;
  readonly tenantId?: unknown;
}

/** 未读计数读取门禁码（与后端 GET /notifications/unread-count 门禁同码）。 */
const NOTIFICATION_READ = permissionCode('notification:read');

/**
 * D-12 投影判定（唯一决策点，unreadQuery 的 enabled 即本函数返回值）：
 * 未就绪或无 notification:read → false（不发起 unread-count 请求，不渲染
 * 铃铛——fail-open 语义不变，无新增报错 UI）；admin 通配 bypass 内含。
 */
export function canPollUnreadCount(permissionData: unknown): boolean {
  return (
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), NOTIFICATION_READ)
  );
}

function ShellBody() {
  const { t } = useTranslation();
  const { data: permissionData } = usePermissions({});
  const permissions = toPermissionCodes(permissionData);
  // T1 #98：持久化菜单配置（code='default'）启动合并——fail-open，配置不可用
  // 即静态树原样（取舍见 shell/useMenuConfig.ts 与 product-ui menu-merge.ts）。
  const mergedTree = useMergedMenu(menuTree, 'default');
  const sidebarNodes = toSidebarMenu(mergedTree, permissions);

  // T1 #101：顶栏铃铛——notification:read 门禁的未读计数（30s 轮询；无权限/
  // 失败 = 不渲染，fail-open 不占位）。入口页 = /notifications（通知中心页）。
  // fix-wave-2 D-12（总控裁定追加）：无权限/未就绪即不发起请求（此前 403 后
  // 才回落不渲染）。
  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
    retry: false,
    enabled: canPollUnreadCount(permissionData),
  });
  const showBell = unreadQuery.data !== undefined;
  const unreadCount = unreadQuery.data ?? 0;

  const { data: identityData } = useGetIdentity();
  const identity =
    typeof identityData === 'object' && identityData !== null
      ? (identityData as ShellIdentity)
      : null;
  const displayName =
    typeof identity?.displayName === 'string' && identity.displayName.length > 0
      ? presentDisplayName(identity.displayName)
      : t('common:user.fallbackName');
  const tenantId =
    typeof identity?.tenantId === 'string' && identity.tenantId.length > 0
      ? identity.tenantId
      : t('common:user.fallbackTenant');
  /** 品牌圈占位：显示名首字符。 */
  const initial = displayName.slice(0, 1).toUpperCase();

  const { mutate: logout } = useLogout();

  // 移动端抽屉开关（桌面侧栏恒显不受影响）
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-dvh bg-background">
      {/* 窄屏遮罩（仅抽屉开时渲染；点击收起） */}
      {drawerOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        // <md：fixed 抽屉（关闭时移出视口）；≥md：恢复静态侧栏（md:static +
        // md:translate-x-0 盖过开合 transform）。导航链接点击（事件委托）收起。
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a')) {
            setDrawerOpen(false);
          }
        }}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 md:static md:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <AudioWaveform className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Cadence</div>
            <div className="text-[11px] text-muted-foreground">{t('common:brand.subtitle')}</div>
          </div>
          {/* 抽屉内关闭钮（窄屏才有意义；桌面侧栏恒显时隐藏） */}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-11 md:hidden"
            aria-label={t('common:action.closeMenu')}
            onClick={() => setDrawerOpen(false)}
          >
            <X />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <MenuNav nodes={sidebarNodes} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-3 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {/* 窄屏 hamburger 开抽屉（≥44px 触摸目标；桌面隐藏） */}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 md:hidden"
              aria-label={t('common:action.openMenu')}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu />
            </Button>
            {/* 租户 chip：窄屏藏（顶栏空间让位导航），≥sm 显示并截断 */}
            <div className="hidden h-7 min-w-0 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-xs text-muted-foreground sm:flex">
              <Building2 className="size-3.5 shrink-0" />
              <span className="truncate">{tenantId}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            {/* 语言切换器（i18n 波 1）：localStorage 持久化，双入口共享 */}
            <LanguageSwitch />
            {showBell && (
              <Button
                variant="ghost"
                size="icon"
                className="relative size-11"
                aria-label={
                  unreadCount > 0
                    ? t('common:notification.unreadAria', { n: unreadCount })
                    : t('common:notification.center')
                }
                asChild
              >
                <Link to="/notifications">
                  <Bell />
                  {unreadCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>
              </Button>
            )}
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full',
                  'bg-primary/10 text-xs font-medium text-primary',
                )}
              >
                {initial}
              </div>
              <span className="hidden text-sm sm:inline">{displayName}</span>
            </div>
            <Button variant="ghost" size="sm" className="h-11" onClick={() => logout({})}>
              <LogOut />
              {t('common:action.signOut')}
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
