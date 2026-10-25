/**
 * 菜单配置运行时合并 hook（T1 #98/99"前端启动合并"装配点）：拉取持久化配置集
 * → selectMenuConfigNodes 选中 → mergeMenuConfig 叠加静态树。桌面侧栏
 * （ShellLayout，code='default'）与移动导航（MobileLayout 标签 +
 * WorkbenchPage 快捷区，code='mobile'）共用。
 *
 * fail-open 合同：请求失败/未授权（403）/配置集缺失/停用/空集 = 静态树原样
 * （导航永不因配置面故障空白）；配置集缓存 5 分钟（staleTime——管理页保存后
 * 由 invalidateQueries(['menu-config']) 立即刷新本 hook）。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mergeMenuConfig, selectMenuConfigNodes } from '@smes/product-ui';
import type { MenuNode } from '@smes/product-ui';
import { fetchMenuConfigs } from '../data/menuConfigApi';

export function useMergedMenu(staticNodes: readonly MenuNode[], configCode: string): MenuNode[] {
  const configsQuery = useQuery({
    queryKey: ['menu-config', 'configs'],
    queryFn: fetchMenuConfigs,
    staleTime: 5 * 60 * 1000,
    retry: false, // 403/网络失败回落静态树，不重试轰炸
  });
  const configNodes =
    configsQuery.data !== undefined ? selectMenuConfigNodes(configsQuery.data, configCode) : null;
  return useMemo(
    () => (configNodes === null ? [...staticNodes] : mergeMenuConfig(staticNodes, configNodes)),
    [staticNodes, configNodes],
  );
}
