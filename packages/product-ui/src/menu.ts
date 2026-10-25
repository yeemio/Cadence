/**
 * 菜单树形状与 RBAC 过滤纯函数（ADR-0009 参照语义，代码从零写）。
 *
 * 四条语义：
 * 1. 精确权限码匹配——node.permission 必须被权限集合精确持有；无码即全员可见。
 * 2. admin bypass——持有 ADMIN_PERMISSION（'*'）时全部可见，不做逐项判定。
 * 3. 空壳隐藏——声明过子菜单但权限过滤后全部不可见的父级整体隐藏。
 * 4. hideInMenu——不进侧栏但路由保留（守卫仍生效）；隐藏父级的可见子级保序提升。
 *
 * 三个投影各司其职：
 * - filterMenuByPermissions：权限过滤树（含 hideInMenu 项）
 * - toSidebarMenu：侧栏树（权限过滤 + hideInMenu 投影 + 空分组剔除）
 * - flattenRoutes：全量路由清单（不过滤权限——守卫在路由层判定；含 hideInMenu 项）
 */
import { isAdminPermissions, permissionSetOf } from './permissions.js';
import type { PermissionCode } from './permissions.js';
import type { AppModuleManifest } from './manifest.js';

/** 菜单树节点：manifest 注册表的菜单投影。 */
export interface MenuNode {
  readonly code: string;
  readonly title: string;
  readonly routePath?: string;
  readonly icon?: string;
  readonly permission?: PermissionCode;
  readonly hideInMenu?: boolean;
  readonly children?: readonly MenuNode[];
}

/** 路由清单条目：守卫用 permission 自行判定，flattenRoutes 不做权限过滤。 */
export interface MenuRoute {
  readonly code: string;
  readonly routePath: string;
  readonly permission?: PermissionCode;
}

/** manifest 注册表 → 菜单树（保序 1:1 投影；entryPoint/isPro/marketCategory 不参与可见性）。 */
export function buildMenuTree(manifests: readonly AppModuleManifest[]): MenuNode[] {
  return manifests.map(manifestToNode);
}

function manifestToNode(manifest: AppModuleManifest): MenuNode {
  const config = manifest.menuConfig;
  return {
    code: manifest.code,
    title: config.title,
    ...(manifest.routePath !== undefined ? { routePath: manifest.routePath } : {}),
    ...(config.icon !== undefined ? { icon: config.icon } : {}),
    ...(config.permission !== undefined ? { permission: config.permission } : {}),
    ...(config.hideInMenu === true ? { hideInMenu: true } : {}),
    ...(manifest.children !== undefined
      ? { children: manifest.children.map(manifestToNode) }
      : {}),
  };
}

/**
 * 权限过滤树：精确码匹配 + admin bypass + 空壳隐藏。
 * hideInMenu 不影响本函数（那是侧栏投影的事）。
 */
export function filterMenuByPermissions(
  nodes: readonly MenuNode[],
  permissions: readonly PermissionCode[],
): MenuNode[] {
  if (isAdminPermissions(permissions)) {
    return [...nodes]; // admin bypass：原样可见
  }
  return filterNodes(nodes, permissionSetOf(permissions));
}

function filterNodes(nodes: readonly MenuNode[], visible: ReadonlySet<PermissionCode>): MenuNode[] {
  const out: MenuNode[] = [];
  for (const node of nodes) {
    if (node.permission !== undefined && !visible.has(node.permission)) continue;
    if (node.children !== undefined) {
      const children = filterNodes(node.children, visible);
      if (children.length === 0) continue; // 空壳隐藏：声明过子菜单但全不可见
      out.push(withChildren(node, children));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** 侧栏树：权限过滤之上再剔 hideInMenu；隐藏父级的可见子级提升；侧栏空分组剔除。 */
export function toSidebarMenu(
  nodes: readonly MenuNode[],
  permissions: readonly PermissionCode[],
): MenuNode[] {
  return projectHidden(filterMenuByPermissions(nodes, permissions));
}

function projectHidden(nodes: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const node of nodes) {
    const children = node.children === undefined ? undefined : projectHidden(node.children);
    if (node.hideInMenu === true) {
      if (children !== undefined) out.push(...children); // 隐藏父级：子级保序提升
      continue;
    }
    if (children !== undefined && children.length === 0 && node.routePath === undefined) {
      continue; // 子项全部 hideInMenu 且自身无路由 → 侧栏空分组剔除
    }
    out.push(children === undefined ? node : withChildren(node, children));
  }
  return out;
}

/** 全量路由清单（含 hideInMenu 项；权限守卫由装配层按 permission 码执行）。 */
export function flattenRoutes(nodes: readonly MenuNode[]): MenuRoute[] {
  const out: MenuRoute[] = [];
  const walk = (list: readonly MenuNode[]): void => {
    for (const node of list) {
      if (node.routePath !== undefined) {
        out.push({
          code: node.code,
          routePath: node.routePath,
          ...(node.permission !== undefined ? { permission: node.permission } : {}),
        });
      }
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function withChildren(node: MenuNode, children: readonly MenuNode[]): MenuNode {
  return { ...node, children };
}
