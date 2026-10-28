/**
 * 移动端布局（M5 首波）：移动路由组 /m/* 的壳——refine Authenticated 守卫
 * （会话失效经 routerProvider 重定向登录页，与 ShellLayout 同语义）+ 精简
 * 顶栏 + 底部标签导航（车间工人拇指可达，≥44px 触摸目标）。
 *
 * 与 ShellLayout 的分工：桌面壳是"两级菜单树 + 侧栏"（全功能管理面），移动
 * 壳是"扁平四标签"（工人高频动作面：待办/报工/工时/库存）。导航可见性复用
 * product-ui filterMenuByPermissions（精确码匹配 + admin bypass）——权限不足
 * 的标签不进导航（页面级守卫与桌面同语义：数据边界由服务端 403 兜底）。
 * 图标为菜单代码 → lucide 图标的装配层视觉映射（与 MenuNav 同体例）。
 * i18n 波 1（ADR-0012）：chrome 文案走 common t()；标签标题经 menuNodeTitle
 * （key→t() 优先，回落 title 原文）。
 */
import { Authenticated, useGetIdentity, useLogout, usePermissions } from '@refinedev/core';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';
import { NavLink } from 'react-router';
import { AudioWaveform, Boxes, Circle, ClipboardPen, Clock3, LayoutGrid, LoaderCircle, LogOut } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { filterMenuByPermissions, toPermissionCodes } from '@smes/product-ui';
import { MOBILE_MENU, MOBILE_TITLE_KEYS } from '../mobile';
import { useMergedMenu } from './useMenuConfig';
import { menuNodeTitle } from './menuTitle';
// UX-PLAN-13/AP-06/VW-02：移动顶栏显示名同桌面壳走 presentDisplayName 呈现净化
// （剥夹具括注/权限码拼接、「种子」→「演示」；见 shell/displayName.ts）。
import { presentDisplayName } from './displayName';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 移动菜单代码 → 图标（装配层视觉映射；未知代码回退 Circle——与 MenuNav 同约定）。 */
const MOBILE_ICONS: Record<string, LucideIcon> = {
  'm.workbench': LayoutGrid,
  'm.report': ClipboardPen,
  'm.hours': Clock3,
  'm.stock': Boxes,
};

export function MobileLayout() {
  return (
    <Authenticated key="mobile" redirectOnFail="/login" loading={<MobileLoading />}>
      <MobileBody />
    </Authenticated>
  );
}

function MobileLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-muted/40 text-sm text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
      {t('common:state.sessionChecking')}
    </div>
  );
}

interface MobileIdentity {
  readonly displayName?: unknown;
}

function MobileBody() {
  const { t } = useTranslation();
  const { data: permissionData } = usePermissions({});
  // T1 #99：移动菜单配置（code='mobile'）启动合并——fail-open（取舍同桌面
  // 侧栏，见 shell/useMenuConfig.ts）。配置树未含的标签隐藏（移动导航可配）。
  const mergedTabs = useMergedMenu(MOBILE_MENU, 'mobile');
  const tabs = filterMenuByPermissions(mergedTabs, toPermissionCodes(permissionData));

  const { data: identityData } = useGetIdentity();
  const identity =
    typeof identityData === 'object' && identityData !== null
      ? (identityData as MobileIdentity)
      : null;
  const displayName =
    typeof identity?.displayName === 'string' && identity.displayName.length > 0
      ? presentDisplayName(identity.displayName)
      : t('common:user.fallbackName');

  const { mutate: logout } = useLogout();

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <AudioWaveform className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">{t('common:brand.mobile')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="max-w-32 truncate text-sm text-muted-foreground">{displayName}</span>
          <Button variant="ghost" size="icon" className="size-11" aria-label={t('common:action.signOutAria')} onClick={() => logout({})}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>
      {/* pb-20：给固定底部导航留出滚动净空；max-w-2xl：桌面浏览器打开时的可读宽度 */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <Outlet />
        </div>
      </main>
      <nav
        aria-label={t('common:nav.mobilePrimary')}
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div className="mx-auto flex max-w-2xl">
          {tabs.map((tab) => {
            const Icon = MOBILE_ICONS[tab.code] ?? Circle;
            return (
              <NavLink
                key={tab.code}
                to={tab.routePath ?? '/m'}
                end={tab.routePath === '/m'}
                className={({ isActive }) =>
                  cn(
                    'flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    isActive
                      ? 'font-medium text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                <Icon className="size-5 shrink-0" />
                {menuNodeTitle(tab, MOBILE_TITLE_KEYS, t)}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
