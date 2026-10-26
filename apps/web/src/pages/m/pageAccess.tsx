/**
 * 移动页数据请求权限门禁（fix-wave-2 D-12/D-6 移动收尾）：m/ 各页进页自动
 * 发起的数据查询按 session 权限投影门禁——与桌面 WorkbenchPage 的
 * canAccessWorkbench / useMenuConfig 的 canFetchMenuConfigs 同语义、同数据源
 * （refine usePermissions + toPermissionCodes；admin 通配 bypass 由
 * sessionHasPermission 内含）。无权限/权限未就绪即不发起请求，卡片直接呈现
 * 显式"无权限"终态（MobileNoAccessHint），不停在"正在加载…"。
 *
 * 门禁码合同：与各页自动查询命中的后端 GET 端点 @RequirePermission 同码，
 * 不是 mobile.ts 注册表的导航权限码——导航码挂动作/读码是入口可见性合同，
 * 数据请求可达性按端点实码（如 m.verify 导航挂 report:verify，而待核队列
 * GET /reports/pending-verification 的实码是 report:read）。
 *
 * 渲染纪律：TanStack v5 下 enabled:false 的查询 isPending 恒真——加载态必须
 * 与 !accessible 互斥渲染（先例=桌面 WorkbenchPage 的 SourceCountCards）。
 */
import { usePermissions } from '@refinedev/core';
import { sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import type { PermissionCode } from '@smes/product-ui';

/**
 * D-12 投影判定（唯一决策点，m/ 各页自动查询的 enabled 即本函数返回值）：
 * 入参 = refine usePermissions 的原始 data（undefined=会话权限未就绪）。
 * 未就绪或无对应端点权限码 → false（不发起请求）；admin 通配 bypass 内含。
 */
export function canAccessMobileData(permissionData: unknown, code: PermissionCode): boolean {
  return (
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), code)
  );
}

/** 页内便捷封装（页面无既有 usePermissions 数据源时用；有则直调纯函数复用）。 */
export function useMobileDataAccess(code: PermissionCode): boolean {
  const { data: permissionData } = usePermissions({});
  return canAccessMobileData(permissionData, code);
}

/**
 * 无权限终态（D-6）：与桌面 NoAccessHint 同形态的移动版（muted 行内文案，
 * 先例=本目录"当前身份无可用入口。"）。
 */
export function MobileNoAccessHint({ code }: { readonly code: PermissionCode }) {
  return (
    <p className="text-sm text-muted-foreground">
      当前身份无数据读取权限（{code}），不发起数据请求。
    </p>
  );
}
