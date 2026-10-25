/**
 * MenuConfigStore —— 菜单配置存储端口（T 波 #98/99 菜单管理）。
 *
 * 与 ItemStore 同一模式：端口在本包定义（业务形状），内存实现先行，PG adapter
 * 由 business-store 按 `./menu-config` 子路径接入（子路径导出登记归合流）。
 *
 * 定位（装配期投影 → 运行期配置）：现状菜单树是装配期从 AppModuleManifest
 * 注册表投影的只读形状（product-ui buildMenuTree）；#98/99 把它升级为**可管理
 * 的租户级配置数据**——节点树整体作为 JSON 文档存取（一棵树 = 一份配置集），
 * 管理端做期望态更新（整树替换或字段级不动），读取面供菜单渲染/权限投影消费。
 * 装配期如何消费持久化配置（注册表合并策略）属接线，归合流。
 *
 * 词汇纪律（ADR-0010）：menu（菜单）/ node（节点）/ route（路由）/ icon
 * 均为跨行业通用词。节点形状与 product-ui MenuNode 一一对应（code/title/
 * routePath/icon/permission/hideInMenu/children）——本包不依赖视图包（依赖
 * 方向：视图包按 manifest 投影菜单；持久化配置是同一形状的服务端事实源），
 * 两端形状一致性由两侧测试锚定。
 *
 * 取舍（表形态）：menu_configs 是配置数据，不是业务事实——不套证据公共列、
 * 不套 append-only/supersedes（修正 = 直接改行；纪律只约束事实表，见
 * business-store 包 README）。无 delete：配置集将被角色/装配引用，硬删引入
 * 悬挂引用；停用路径 = active=false（软停用，同 items/customers 体例）。
 */
import { TenantId } from '@smes/business-core';

/**
 * 菜单配置节点：树形文档的原子单元（与 product-ui MenuNode 一一对应的
 * 服务端形状；permission 为普通 string——形状校验在输入解析层，品牌化只
 * 发生在权限判定入口）。
 */
export interface MenuConfigNode {
  /** 节点码（配置集内全局唯一的人读键，如 workbench / m.verify）。 */
  readonly code: string;
  readonly title: string;
  /** 前端路由路径（可空——纯分组节点无路由；提供时须 '/' 开头）。 */
  readonly routePath?: string;
  /** 图标名（可空，自由文本）。 */
  readonly icon?: string;
  /** 访问所需权限码（可空——无码即全员可见，与 product-ui 过滤语义一致）。 */
  readonly permission?: string;
  /** 不进侧栏但路由保留（可空；与 product-ui 投影语义一致）。 */
  readonly hideInMenu?: boolean;
  readonly children?: readonly MenuConfigNode[];
}

/** 菜单配置集（一行 = 一棵节点树文档）。createdAt/updatedAt 为 ISO-8601 字符串。 */
export interface MenuConfig {
  readonly id: string;
  readonly tenant: TenantId;
  /** 配置集键（租户内唯一业务键，如 default / mobile）。 */
  readonly code: string;
  readonly name: string;
  /** 节点树（整树 JSON 文档；空数组 = 占位配置集）。 */
  readonly nodes: readonly MenuConfigNode[];
  /** 软停用（false = 不再参与菜单渲染/权限码聚合）。 */
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMenuConfigInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly nodes: readonly MenuConfigNode[];
  readonly active?: boolean;
}

/** 字段级期望态更新：未提供的键不变；code 不可变（唯一键稳定性）；nodes 提供即整树替换。 */
export interface UpdateMenuConfigInput {
  readonly name?: string;
  readonly nodes?: readonly MenuConfigNode[];
  readonly active?: boolean;
}

/**
 * 菜单配置存储端口。实现方保证：
 *  - create 在租户内 code 冲突时抛 MenuConfigConflictError；
 *  - update 对不存在的 id 返回 null（404 语义由用例层翻译）；
 *  - list 按 code 升序（稳定的人读序，同 items/customers 体例）；
 *  - updatedAt 随每次成功 update 推进（服务端时间）。
 */
export interface MenuConfigStore {
  create(input: CreateMenuConfigInput): Promise<MenuConfig>;
  list(tenant: TenantId): Promise<readonly MenuConfig[]>;
  find(tenant: TenantId, id: string): Promise<MenuConfig | null>;
  update(tenant: TenantId, id: string, input: UpdateMenuConfigInput): Promise<MenuConfig | null>;
}
