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
 * 无权限终态（D-6）：与桌面 NoAccessHint 同形态的移动版。UX-AP-02 收口：
 * 不再向用户裸露权限码——文案给中文说明 + 指引（联系管理员开通）；权限码只
 * 保留在 data-permission-code 属性里供排查（不出现在可见文案）。可选 subject
 * 给出数据域中文名，让提示指名缺的是哪类数据的查看权限。
 */
export function MobileNoAccessHint({
  code,
  subject,
}: {
  readonly code: PermissionCode;
  /** 数据域中文名（可选；如「配件审批列表」）。 */
  readonly subject?: string;
}) {
  const reason =
    subject === undefined
      ? '当前账号缺少查看此类数据的权限，内容无法加载。'
      : `当前账号缺少查看「${subject}」数据的权限，内容无法加载。`;
  return (
    <p className="text-sm text-muted-foreground" data-permission-code={code}>
      {reason}请联系管理员为账号开通相应权限，开通后刷新页面即可使用。
    </p>
  );
}
