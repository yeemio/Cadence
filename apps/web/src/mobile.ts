/**
 * 移动端路由注册表（M5 首波）：车间工人移动页面集的装配数据层（纯数据，
 * 无浏览器依赖——与 menu.ts 同体例的镜像注册表）。
 *
 * 形状取舍：复用 product-ui MenuNode（code/title/routePath/icon/permission）
 * 而非再造一套——底部导航的权限投影直接走 filterMenuByPermissions（精确码
 * 匹配 + admin bypass 语义零新代码），路由清单走 flattenRoutes。
 *
 * 为什么不并入 DEMO_MANIFESTS：桌面菜单树（两级分组）与移动标签栏（扁平
 * 四项）是两个导航面；并入会互相污染（桌面侧栏出现移动项/移动标签栏被要求
 * 分组语义）。移动组独立注册，两注册表各自演进。
 *
 * 页面码三问（ADR-0010）：m.workbench/m.report/m.hours/m.stock——workbench/
 * report/hours/stock 均为跨行业通用词（report 在 ADR-0010 内核白名单），
 * m. 前缀是装配层的路由组命名空间（非业务词汇）。功能拆解映射：105/106
 * 移动首页/待办 → m.workbench；107~114 移动生产作业（报工呈现面）→
 * m.report；137 我的工时统计(移) → m.hours；128~133 移动仓储（查询呈现面）
 * → m.stock。权限码与各模块后端端点一一对应（镜像逻辑归各模块 API 的
 * M5 PWA 呈现口径）。
 */
import { flattenRoutes, HOURS_READ, permissionCode, STOCK_READ, WORKBENCH_READ } from '@smes/product-ui';
import type { MenuNode, MenuRoute } from '@smes/product-ui';

const pc = permissionCode;

/** 移动标签栏四项（顺序即导航顺序：工作台为首页）。 */
export const MOBILE_MENU: readonly MenuNode[] = [
  {
    code: 'm.workbench',
    title: '工作台',
    routePath: '/m',
    icon: 'workbench',
    permission: WORKBENCH_READ,
  },
  {
    code: 'm.report',
    title: '报工',
    routePath: '/m/report',
    icon: 'report',
    permission: pc('report:submit'),
  },
  {
    code: 'm.hours',
    title: '工时',
    routePath: '/m/hours',
    icon: 'hours',
    permission: HOURS_READ,
  },
  {
    code: 'm.stock',
    title: '库存',
    routePath: '/m/stock',
    icon: 'stock',
    permission: STOCK_READ,
  },
];

/** 移动组全量路由清单（main.tsx 装配用；权限投影由底部导航自行执行）。 */
export const mobileRoutes: readonly MenuRoute[] = flattenRoutes(MOBILE_MENU);
