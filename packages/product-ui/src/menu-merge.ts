/**
 * 菜单配置合并（T1 能力子集 #98/99"前端启动合并"最小形态）：持久化配置树
 * 叠加到装配态静态菜单树，产出渲染用 MenuNode[]。
 *
 * 取舍（关键，与全动态方案对照）：menu.ts 静态注册表仍是路由/页面装配的
 * 单一事实源（PAGE_BY_CODE 绑定、module-pages 漂移测试都不动）；配置集只
 * 叠加**呈现面**——可见性（哪些节点出现）、顺序（config 序即渲染序）、
 * title/icon/hideInMenu 覆盖。permission 与 routePath 不接受配置覆盖：
 * 菜单可见性 = 接口可达性（权限码与后端端点同码的既有纪律）、路由地址 =
 * 装配绑定（改 routePath 会让配置项指向无页面绑定的路径，形成死链接——
 * 配置中的 routePath 仅存档展示）。全动态（路由也从配置生成）改造风险大，
 * 留后续增量。
 *
 * 合并规则（fail-open：配置不可用/空 = 静态树原样）：
 *  - 同层取交集：config 节点按序匹配 static 同层子节点（按 code）；
 *  - static 子节点不在 config → 隐藏（配置集控制可见性——这是本功能的目的）；
 *  - config 节点 code 无 static 匹配 → 跳过（未知页面码无装配绑定）；
 *  - config 对叶子节点声明 children → 按叶子处理（static 无子层即无子层）；
 *  - 空配置集（nodes=[]）或停用 = 不参与合并（后端 store 头注"占位配置集"
 *    语义）；前端在配置面读到空集时对用户展示提示，不静默清空导航。
 */
import type { MenuNode } from './menu.js';

/**
 * 服务端持久化菜单配置节点（与 application MenuConfigNode 一一对应的视图
 * 侧形状——product-ui 不依赖 application，两端一致性由各自测试锚定）。
 * 响应解析与坏形状拒绝在 apps/web 装配层（menuConfigApi）。
 */
export interface MenuConfigNodeView {
  readonly code: string;
  readonly title: string;
  readonly routePath?: string;
  readonly icon?: string;
  readonly permission?: string;
  readonly hideInMenu?: boolean;
  readonly children?: readonly MenuConfigNodeView[];
}

/** 服务端菜单配置集行（GET /menu-config/configs 响应行形状）。 */
export interface MenuConfigSetView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nodes: readonly MenuConfigNodeView[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 选中参与合并的配置集节点树：active 且 code 匹配且 nodes 非空才参与；
 * 其余（缺失/停用/空集）返回 null（调用方回落静态树——fail-open）。
 */
export function selectMenuConfigNodes(
  configs: readonly MenuConfigSetView[],
  code: string,
): readonly MenuConfigNodeView[] | null {
  const found = configs.find((config) => config.code === code && config.active);
  if (found === undefined || found.nodes.length === 0) return null;
  return found.nodes;
}

/**
 * 配置树叠加静态树（纯函数）。只叠呈现字段：title/icon/hideInMenu 覆盖；
 * permission/routePath 以静态节点为准（见文件头取舍）。static 为空 = 返回
 * 空（配置集不能无中生有——没有装配绑定就没有页面）。
 */
export function mergeMenuConfig(
  staticNodes: readonly MenuNode[],
  configNodes: readonly MenuConfigNodeView[],
): MenuNode[] {
  const out: MenuNode[] = [];
  for (const configNode of configNodes) {
    const staticNode = staticNodes.find((node) => node.code === configNode.code);
    if (staticNode === undefined) continue; // 未知页面码：无装配绑定，跳过
    out.push(mergeNode(staticNode, configNode));
  }
  return out;
}

function mergeNode(staticNode: MenuNode, configNode: MenuConfigNodeView): MenuNode {
  const children =
    staticNode.children === undefined || configNode.children === undefined
      ? undefined
      : mergeMenuConfig(staticNode.children, configNode.children);
  return {
    ...staticNode,
    title: configNode.title,
    ...(configNode.icon !== undefined ? { icon: configNode.icon } : {}),
    ...(configNode.hideInMenu === true ? { hideInMenu: true } : {}),
    ...(children === undefined ? {} : { children }),
  };
}
