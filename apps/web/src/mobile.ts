/**
 * 移动端路由注册表（M5 首波 + S3 增量）：车间工人移动页面集的装配数据层
 * （纯数据，无浏览器依赖——与 menu.ts 同体例的镜像注册表）。
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
 *
 * S3 增量（覆盖矩阵 §3.2 19 项 + §3.4 #116 清零）：底部主标签 ≤5 不变——
 * 新页不进 MOBILE_MENU（MobileLayout 底部导航仍四标签），注册在
 * MOBILE_SUBPAGES 子页表：入口走 m.workbench 快捷区（WorkbenchPage 按
 * MOBILE_SUBPAGES 权限投影展开）+ mobileRoutes 全量路由清单（main.tsx
 * 装配用）。子页码延续三问：verify/parts/inspection/fault/receipt/transfer/
 * stocktake/progress/mine 均为跨行业通用词；op-progress 为 progress 的
 * 图号/工序维度限定词组。权限码全部按各模块控制器 @RequirePermission 实态
 * 同码（动作页挂动作码、查询页挂读码——沿 m.report 挂 report:submit 的
 * M5 先例）：111-114 报工核查 → m.verify(report:verify)；117 配件申请 →
 * m.parts(parts:request)；118 配件审批 → m.parts-approval(parts:approve)；
 * 119-122 四类质检 → m.inspection(inspection:judge)；127 故障上报 →
 * m.fault(fault:report)；128-130 三类入库 → m.receipt(stock:receive)；
 * 132 调拨移库 → m.transfer(stock:transfer)；133 库存盘点 →
 * m.stocktake(stocktake:record)；134 工作令进度 → m.progress(workorder:read)；
 * 135 图号工序进度 → m.op-progress(report:read)；136+#116 我的报工 →
 * m.mine(report:read)。
 */
import {
  INSPECTION_JUDGE,
  PARTS_APPROVE,
  PARTS_REQUEST,
  REPORT_READ,
  REPORT_VERIFY,
  STOCK_RECEIVE,
  STOCK_TRANSFER,
  STOCKTAKE_RECORD,
  WORKBENCH_READ,
  WORKORDER_READ,
  flattenRoutes,
  HOURS_READ,
  permissionCode,
  STOCK_READ,
} from '@smes/product-ui';
import type { MenuNode, MenuRoute } from '@smes/product-ui';

const pc = permissionCode;

/** 移动标签栏四项（顺序即导航顺序：工作台为首页；S3 起冻结不再增项）。 */
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

/** 移动子页注册表（S3 增量 11 页：不进底部标签，入口走工作台快捷区）。 */
export const MOBILE_SUBPAGES: readonly MenuNode[] = [
  {
    code: 'm.verify',
    title: '报工核查',
    routePath: '/m/verify',
    icon: 'verify',
    permission: REPORT_VERIFY,
  },
  {
    code: 'm.parts',
    title: '配件申请',
    routePath: '/m/parts',
    icon: 'parts',
    permission: PARTS_REQUEST,
  },
  {
    code: 'm.parts-approval',
    title: '配件审批',
    routePath: '/m/parts-approval',
    icon: 'parts-approval',
    permission: PARTS_APPROVE,
  },
  {
    code: 'm.inspection',
    title: '质检',
    routePath: '/m/inspection',
    icon: 'inspection',
    permission: INSPECTION_JUDGE,
  },
  {
    code: 'm.fault',
    title: '故障上报',
    routePath: '/m/fault',
    icon: 'fault',
    permission: pc('fault:report'),
  },
  {
    code: 'm.receipt',
    title: '入库',
    routePath: '/m/receipt',
    icon: 'receipt',
    permission: STOCK_RECEIVE,
  },
  {
    code: 'm.transfer',
    title: '调拨移库',
    routePath: '/m/transfer',
    icon: 'transfer',
    permission: STOCK_TRANSFER,
  },
  {
    code: 'm.stocktake',
    title: '库存盘点',
    routePath: '/m/stocktake',
    icon: 'stocktake',
    permission: STOCKTAKE_RECORD,
  },
  {
    code: 'm.progress',
    title: '工作令进度',
    routePath: '/m/progress',
    icon: 'progress',
    permission: WORKORDER_READ,
  },
  {
    code: 'm.op-progress',
    title: '工序进度',
    routePath: '/m/op-progress',
    icon: 'op-progress',
    permission: REPORT_READ,
  },
  {
    code: 'm.mine',
    title: '我的报工',
    routePath: '/m/mine',
    icon: 'mine',
    permission: REPORT_READ,
  },
];

/** 移动组全量路由清单（标签 + 子页；main.tsx 装配用；权限投影由各导航面自行执行）。 */
export const mobileRoutes: readonly MenuRoute[] = flattenRoutes([...MOBILE_MENU, ...MOBILE_SUBPAGES]);

/**
 * i18n 波 1（ADR-0012）：移动注册表 → menu namespace key 映射（与 menu.ts
 * 同体例，复合键 `<code>::<静态 title>` 索引；title 中文原文保留为 zh-CN
 * 权威源与回落值，渲染层走 shell/menuTitle.ts）。移动码 `m.<slug>` 唯一 →
 * 键 `menu:m.<slug>`。
 */
const mobileTitleKeyEntries = [...MOBILE_MENU, ...MOBILE_SUBPAGES].map(
  (node) => [`${node.code}::${node.title}`, `menu:${node.code}`] as const,
);
export const MOBILE_TITLE_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  mobileTitleKeyEntries,
);
