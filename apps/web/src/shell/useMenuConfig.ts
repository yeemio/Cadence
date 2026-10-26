/**
 * 菜单配置运行时合并 hook（T1 #98/99"前端启动合并"装配点）：拉取持久化配置集
 * → selectMenuConfigNodes 选中 → mergeMenuConfig 叠加静态树。桌面侧栏
 * （ShellLayout，code='default'）与移动导航（MobileLayout 标签 +
 * WorkbenchPage 快捷区，code='mobile'）共用。
 *
 * fail-open 合同：请求失败/未授权（403）/配置集缺失/停用/空集 = 静态树原样
 * （导航永不因配置面故障空白）；配置集缓存 5 分钟（staleTime——管理页保存后
 * 由 invalidateQueries(['menu-config']) 立即刷新本 hook）。
 *
 * fix-wave-2 D-12（总控裁定追加）：configsQuery 按 session 权限投影门禁
 * （menu:read，与后端 GET /menu-config/configs 的 @RequirePermission 同码；
 * 数据源与侧栏投影同款 usePermissions + toPermissionCodes）——无权限/权限
 * 未就绪即不发起请求，直接回落静态树（fail-open 语义不变，无新增报错 UI）。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import { mergeMenuConfig, permissionCode, selectMenuConfigNodes, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import type { MenuNode } from '@smes/product-ui';
import { fetchMenuConfigs } from '../data/menuConfigApi';

/** 菜单配置读取门禁码（与后端 GET /menu-config/configs 门禁同码）。 */
const MENU_READ = permissionCode('menu:read');

/**
 * D-12 投影判定（唯一决策点，configsQuery 的 enabled 即本函数返回值）：
 * 入参 = refine usePermissions 的原始 data（undefined=会话权限未就绪）。
 * 未就绪或无 menu:read → false（不发起 configs 请求，静态树原样）；
 * admin 通配 bypass 由 sessionHasPermission 内含。
 */
export function canFetchMenuConfigs(permissionData: unknown): boolean {
  return (
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), MENU_READ)
  );
}

export function useMergedMenu(staticNodes: readonly MenuNode[], configCode: string): MenuNode[] {
  const { data: permissionData } = usePermissions({});
  const configsQuery = useQuery({
    queryKey: ['menu-config', 'configs'],
    queryFn: fetchMenuConfigs,
    staleTime: 5 * 60 * 1000,
    retry: false, // 403/网络失败回落静态树，不重试轰炸
    enabled: canFetchMenuConfigs(permissionData),
  });
  const configNodes =
    configsQuery.data !== undefined ? selectMenuConfigNodes(configsQuery.data, configCode) : null;
  return useMemo(
    () => (configNodes === null ? [...staticNodes] : mergeMenuConfig(staticNodes, configNodes)),
    [staticNodes, configNodes],
  );
}
