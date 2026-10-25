/**
 * 应用注册表 manifest 形状——"动态菜单"的数据源。
 *
 * 字段集参照 ADR-0009 spike 结论（照抄形状、零代码复用）：
 * code / entry_point / route_path / menu_config / is_pro / market_category。
 * 装配交互（四层应用契约）在 apps/web 组合层；本包只定义数据形状与纯投影。
 */
import type { PermissionCode } from './permissions.js';

/**
 * 应用分层（ADR-0004 插件装配 + 行业包）：
 * base=基础层必装；process=九循环环节模块（按需启停）；
 * professional=专业包；industry=行业包（未来，出现第二行业前不立项）。
 */
export type MarketCategory = 'base' | 'process' | 'professional' | 'industry';

/** 单个模块在侧栏的展示配置（menu_config 对应物）。 */
export interface MenuConfig {
  /** 侧栏展示名 */
  readonly title: string;
  /** 图标占位名：视图模型不绑定图标库，装配层自行解释 */
  readonly icon?: string;
  /** 精确权限码：缺省表示对所有已登录用户可见 */
  readonly permission?: PermissionCode;
  /** 侧栏隐藏但保留路由（路由守卫仍生效） */
  readonly hideInMenu?: boolean;
}

/** 应用注册表条目（模块 = 注册表条目 = 菜单节点）。 */
export interface AppModuleManifest {
  /** 模块代码（ADR-0004 模块边界 = 运营循环环节边界） */
  readonly code: string;
  /** 模块根路由；纯分组（侧栏分组容器）可缺省 */
  readonly routePath?: string;
  /** 懒加载/微入口占位：骨架阶段仅保留形状，不参与装配 */
  readonly entryPoint?: string;
  readonly menuConfig: MenuConfig;
  /** 专业包标记：无权限时的占位降级展示为后续增量，骨架阶段不实现其过滤语义 */
  readonly isPro?: boolean;
  readonly marketCategory: MarketCategory;
  /** 子模块（嵌套菜单由此表达，而非菜单内部另立树） */
  readonly children?: readonly AppModuleManifest[];
}
