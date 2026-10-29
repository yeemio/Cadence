/**
 * 演示应用注册表 → 菜单树与路由清单（装配数据层，纯数据无浏览器依赖）。
 *
 * manifest 形状见 @smes/product-ui（ADR-0009 参照字段集）；
 * 词汇纪律 ADR-0010：模块代码用离散制造通用词（workbench/workorder/dispatch/system）。
 *
 * S2 批次（九循环模块桌面管理页）：workorder/listing/dispatch/reporting/
 * inspection/inventory/hours/costing/baseline 九模块按覆盖矩阵 §3.3 的 61 项
 * "后端就绪缺 Web 页面"建组挂页；菜单权限码全部用后端控制器实态 :read 码
 * （如 workorder:read 与 GET /workorder/work-orders 门禁同码——菜单可见性 =
 * 接口可达性，不虚构后端没有的权限）。
 */
import { buildMenuTree, flattenRoutes, permissionCode, SCAN_READ } from '@smes/product-ui';
import type { AppModuleManifest, MenuNode } from '@smes/product-ui';

const pc = permissionCode;

export const DEMO_MANIFESTS: readonly AppModuleManifest[] = [
  {code:'manufacturing-control',routePath:'/manufacturing',marketCategory:'base',entryPoint:'manufacturing/index.tsx',menuConfig:{title:'制造控制台',permission:pc('manufacturing:read')}},
  {
    // T1 能力子集 #1 运营总览：四源聚合页（工作台待办/交付态势/质检汇总/
    // 机加工时）。菜单可见性挂 workbench:read（工作台组入口码）；页面数据
    // 另涉 workorder/inspection/hours 三码——部分权限用户进入页面时按
    // overviewApi 取舍整页明示失败来源（不虚构后端没有的复合码）。
    code: 'overview',
    routePath: '/overview',
    marketCategory: 'base',
    entryPoint: 'overview/index.tsx',
    menuConfig: { title: '运营总览', permission: pc('workbench:read') },
  },
  {
    code: 'workbench',
    routePath: '/',
    marketCategory: 'base',
    entryPoint: 'workbench/index.tsx',
    // M1 增量 4-I：工作台页升级为真实页面（本人待办 + source 计数）；
    // 菜单可见性挂 workbench:read（与后端 GET /workbench/* 门禁同码）。
    menuConfig: { title: '工作台', icon: 'workbench', permission: pc('workbench:read') },
  },
  {
    code: 'masterdata',
    marketCategory: 'base',
    menuConfig: { title: '基础数据' },
    children: [
      {
        code: 'masterdata-item',
        routePath: '/masterdata/items',
        marketCategory: 'base',
        entryPoint: 'masterdata/items.tsx',
        menuConfig: { title: '物品', permission: pc('item:read') },
      },
      {
        code: 'masterdata-resource',
        routePath: '/masterdata/resources',
        marketCategory: 'base',
        entryPoint: 'masterdata/resources.tsx',
        menuConfig: { title: '资源', permission: pc('resource:read') },
      },
      // S3-a：S1 backfill 主数据三页挂基础数据组（菜单码与后端控制器同码）。
      {
        code: 'masterdata-customer',
        routePath: '/masterdata/customers',
        marketCategory: 'base',
        entryPoint: 'masterdata/customers.tsx',
        menuConfig: { title: '客户', permission: pc('customer:read') },
      },
      {
        code: 'masterdata-supplier',
        routePath: '/masterdata/suppliers',
        marketCategory: 'base',
        entryPoint: 'masterdata/suppliers.tsx',
        menuConfig: { title: '供应商', permission: pc('supplier:read') },
      },
      {
        code: 'masterdata-unit',
        routePath: '/masterdata/units',
        marketCategory: 'base',
        entryPoint: 'masterdata/units.tsx',
        menuConfig: { title: '计量单位', permission: pc('unit:read') },
      },
    ],
  },
  {
    code: 'manufacturing',
    marketCategory: 'base',
    menuConfig: { title: '制造运营' },
    children: [
      {
        code: 'workorder',
        routePath: '/workorders',
        marketCategory: 'process',
        entryPoint: 'workorder/index.tsx',
        // S2：占位页升级真实页面（列表+建令+详情操作+齐套看板）；
        // 菜单码切后端实态 workorder:read（与 GET /workorder/work-orders 同码）。
        menuConfig: { title: '工作令', permission: pc('workorder:read') },
      },
      {
        code: 'workorder-parts',
        routePath: '/workorders/parts',
        marketCategory: 'process',
        entryPoint: 'workorder/parts.tsx',
        menuConfig: { title: '配件申请', permission: pc('parts:read') },
      },
      {
        code: 'listing-sheets',
        routePath: '/listings/sheets',
        marketCategory: 'process',
        entryPoint: 'listing/sheets.tsx',
        menuConfig: { title: '清单', permission: pc('listing:read') },
      },
      {
        code: 'listing-gap-checks',
        routePath: '/listings/gap-checks',
        marketCategory: 'process',
        entryPoint: 'listing/gap-checks.tsx',
        menuConfig: { title: '缺口核查', permission: pc('gap:read') },
      },
      {
        code: 'dispatch',
        routePath: '/dispatches',
        marketCategory: 'process',
        entryPoint: 'dispatch/index.tsx',
        // S2：占位页升级真实页面（六类派工列表+创建+四态操作）。
        menuConfig: { title: '派工', permission: pc('dispatch:read') },
      },
      {
        code: 'outsourcing-lines',
        routePath: '/outsourcing/lines',
        marketCategory: 'process',
        entryPoint: 'dispatch/outsourcing-lines.tsx',
        menuConfig: { title: '外协明细', permission: pc('outsourcing:read') },
      },
      {
        code: 'scan',
        routePath: '/scan',
        marketCategory: 'base',
        entryPoint: 'scan/index.tsx',
        // M1 收尾波-②：真实扫码页（三档降级链）。扫码是跨环节的通用数据
        // 采集动作，故 marketCategory 记 base、挂制造运营分组展示。
        menuConfig: { title: '扫码', icon: 'scan', permission: SCAN_READ },
      },
      // M5 首波：预研期的扫码报工页（scan-report）升级为移动组 m.report
      // （/m/report，底部标签导航——见 mobile.ts）；桌面菜单不再保留预研条目。
    ],
  },
  {
    code: 'reporting',
    marketCategory: 'process',
    menuConfig: { title: '报工管理' },
    children: [
      {
        code: 'reports',
        routePath: '/reports',
        marketCategory: 'process',
        entryPoint: 'reporting/reports.tsx',
        menuConfig: { title: '报工单', permission: pc('report:read') },
      },
      {
        code: 'report-verification',
        routePath: '/reports/verification',
        marketCategory: 'process',
        entryPoint: 'reporting/verification.tsx',
        menuConfig: { title: '报工核查', permission: pc('report:read') },
      },
      {
        // UX-PRD-01（e1a8bd）：侧栏补「移动报工」入口。移动页 /m/report 挂移动
        // 导航面（mobile.ts），桌面注册表不得复制该路径（mobile.test「两注册表
        // 路径不重叠」钉死 + main.tsx 桌面分支先装配会劫持移动路由）——按合同
        // 「或其桌面引导」分支走引导页（pages/workbench/MobileReportGuidePage）。
        // 权限码与 m.report 同码 report:submit（M5 先例：动作页挂动作码）。
        code: 'mobile-report',
        routePath: '/reports/mobile',
        marketCategory: 'process',
        entryPoint: 'workbench/MobileReportGuidePage.tsx',
        menuConfig: { title: '移动报工', permission: pc('report:submit') },
      },
    ],
  },
  {
    code: 'purchasing',
    marketCategory: 'process',
    menuConfig: { title: '采购管理' },
    children: [
      {
        code: 'purchase-requests',
        routePath: '/purchase/requests',
        marketCategory: 'process',
        entryPoint: 'listing/purchase-requests.tsx',
        menuConfig: { title: '采购申请', permission: pc('purchase:read') },
      },
      {
        code: 'purchase-orders',
        routePath: '/purchase/orders',
        marketCategory: 'process',
        entryPoint: 'listing/purchase-orders.tsx',
        menuConfig: { title: '采购订单', permission: pc('purchase:read') },
      },
      {
        // UX-PUR-01/02（e1a8bd）：收货入口从「选中订单→详情内」提为侧栏直达。
        // 别名路径挂同一页面组件（listing/purchase-orders.tsx，收货操作在
        // 订单详情内）——不复制 /purchase/orders 路径（路由清单唯一性，menu.test
        // 钉死），不改收货业务逻辑（页面内部零触碰）。
        code: 'purchase-receiving',
        routePath: '/purchase/receiving',
        marketCategory: 'process',
        entryPoint: 'listing/purchase-orders.tsx',
        menuConfig: { title: '采购收货', permission: pc('purchase:receive') },
      },
      {
        code: 'purchase-returns',
        routePath: '/purchase/returns',
        marketCategory: 'process',
        entryPoint: 'listing/purchase-returns.tsx',
        menuConfig: { title: '采购退货', permission: pc('purchase:read') },
      },
      {
        code: 'purchase-details',
        routePath: '/purchase/details',
        marketCategory: 'process',
        entryPoint: 'listing/purchase-details.tsx',
        menuConfig: { title: '采购明细', permission: pc('purchase:read') },
      },
    ],
  },
  {
    code: 'quality',
    marketCategory: 'process',
    menuConfig: { title: '质量管理' },
    children: [
      {
        code: 'inspections',
        routePath: '/inspections',
        marketCategory: 'process',
        entryPoint: 'inspection/orders.tsx',
        menuConfig: { title: '质检队列', permission: pc('inspection:read') },
      },
      {
        code: 'nonconformities',
        routePath: '/inspections/nonconformities',
        marketCategory: 'process',
        entryPoint: 'inspection/nonconformities.tsx',
        menuConfig: { title: '不合格处置', permission: pc('nonconform:read') },
      },
    ],
  },
  {
    code: 'warehouse',
    marketCategory: 'process',
    menuConfig: { title: '仓储管理' },
    children: [
      {
        code: 'warehouses',
        routePath: '/inventory/warehouses',
        marketCategory: 'process',
        entryPoint: 'inventory/warehouses.tsx',
        menuConfig: { title: '仓库与库位', permission: pc('warehouse:read') },
      },
      {
        code: 'stock-levels',
        routePath: '/inventory/stock',
        marketCategory: 'process',
        entryPoint: 'inventory/stock-levels.tsx',
        menuConfig: { title: '实时库存', permission: pc('stock:read') },
      },
      {
        code: 'stock-operations',
        routePath: '/inventory/stock-operations',
        marketCategory: 'process',
        entryPoint: 'inventory/stock-operations.tsx',
        menuConfig: { title: '收发存操作', permission: pc('stock:read') },
      },
      {
        code: 'stocktakes',
        routePath: '/inventory/stocktakes',
        marketCategory: 'process',
        entryPoint: 'inventory/stocktakes.tsx',
        menuConfig: { title: '库存盘点', permission: pc('stocktake:read') },
      },
      {
        code: 'shipping-orders',
        routePath: '/inventory/shipping-orders',
        marketCategory: 'process',
        entryPoint: 'inventory/shipping-orders.tsx',
        menuConfig: { title: '发货任务', permission: pc('shipping:read') },
      },
    ],
  },
  {
    code: 'costing',
    marketCategory: 'process',
    menuConfig: { title: '成本与工时' },
    children: [
      {
        code: 'hours-stats',
        routePath: '/hours/stats',
        marketCategory: 'process',
        entryPoint: 'hours/stats.tsx',
        menuConfig: { title: '工时统计', permission: pc('hours:read') },
      },
      {
        code: 'costing',
        routePath: '/costing',
        marketCategory: 'process',
        entryPoint: 'costing/index.tsx',
        menuConfig: { title: '成本核算', permission: pc('costing:read') },
      },
    ],
  },
  {
    // S3-a：标准报表单页（口径四选一+时间窗求值）；权限复用 report:read
    //（standardreports 控制器实态——报表中心读取面，不虚构新码）。
    code: 'standard-reports',
    routePath: '/standard-reports',
    marketCategory: 'process',
    entryPoint: 'reporting/standard-reports.tsx',
    menuConfig: { title: '标准报表', permission: pc('report:read') },
  },
  {
    // AI 问数首版（CONTRACT v1 · 2026-10-28）：规则引擎问数页——三域自然语言
    // 查询（工作令进度/物料缺口/质量检验）返回结构化事实卡。菜单码=后端控制器
    // 实态码 ai-query:read（ai-query.controllers.ts 端点统一 @RequirePermission；
    // 域码缺失走回答通道 denied，菜单只管端点级可达性）。
    code: 'ai-query',
    routePath: '/ai-query',
    marketCategory: 'base',
    entryPoint: 'ai-query/index.tsx',
    menuConfig: { title: 'AI 问数', permission: pc('ai-query:read') },
  },
  {
    // 图纸文档组（D-WO-05 图纸页面呈现面）：drawing 域桌面页。独立成组裁量：
    // drawing 有独立权限码族（drawing:read / drawing:audit-read），无码角色
    // 整组空壳隐藏，不与工艺基线组（baseline=工序/路线/设备台账）混语义。
    // 菜单码与后端控制器实态同码（drawing-http.module.ts @RequirePermission）。
    code: 'drawing',
    marketCategory: 'base',
    menuConfig: { title: '图纸文档' },
    children: [
      {
        code: 'drawing-library',
        routePath: '/drawings',
        marketCategory: 'base',
        entryPoint: 'drawing/library.tsx',
        menuConfig: { title: '图纸库', permission: pc('drawing:read') },
      },
      {
        code: 'drawing-audit',
        routePath: '/drawings/view-audit',
        marketCategory: 'base',
        entryPoint: 'drawing/view-audit.tsx',
        menuConfig: { title: '查看留痕审计', permission: pc('drawing:audit-read') },
      },
    ],
  },
  {
    code: 'baseline',
    marketCategory: 'base',
    menuConfig: { title: '工艺与设备' },
    children: [
      {
        code: 'baseline-processes',
        routePath: '/baseline/processes',
        marketCategory: 'base',
        entryPoint: 'baseline/processes.tsx',
        menuConfig: { title: '工序', permission: pc('process:read') },
      },
      {
        code: 'baseline-routings',
        routePath: '/baseline/routings',
        marketCategory: 'base',
        entryPoint: 'baseline/routings.tsx',
        menuConfig: { title: '工艺路线', permission: pc('routing:read') },
      },
      {
        code: 'baseline-standard-times',
        routePath: '/baseline/standard-times',
        marketCategory: 'base',
        entryPoint: 'baseline/standard-times.tsx',
        menuConfig: { title: '额定工时', permission: pc('standardtime:read') },
      },
      {
        code: 'baseline-equipment',
        routePath: '/baseline/equipment',
        marketCategory: 'base',
        entryPoint: 'baseline/equipment.tsx',
        menuConfig: { title: '设备档案', permission: pc('equipment:read') },
      },
      {
        code: 'baseline-fault-reports',
        routePath: '/baseline/fault-reports',
        marketCategory: 'base',
        entryPoint: 'baseline/fault-reports.tsx',
        menuConfig: { title: '故障上报', permission: pc('fault:read') },
      },
      {
        code: 'baseline-outsourcing-rules',
        routePath: '/baseline/outsourcing-rules',
        marketCategory: 'base',
        entryPoint: 'baseline/outsourcing-rules.tsx',
        menuConfig: { title: '外协计价', permission: pc('outsourcing-rule:read') },
      },
      {
        code: 'baseline-material-validations',
        routePath: '/baseline/material-validations',
        marketCategory: 'base',
        entryPoint: 'baseline/material-validations.tsx',
        menuConfig: { title: '物料校验', permission: pc('material-validation:read') },
      },
    ],
  },
  {
    code: 'system',
    marketCategory: 'base',
    menuConfig: { title: '系统管理' },
    children: [
      {
        code: 'system-user',
        routePath: '/system/users',
        marketCategory: 'base',
        entryPoint: 'org/users.tsx',
        menuConfig: { title: '用户与角色', permission: pc('user:read') },
      },
      {
        code: 'system-role',
        routePath: '/system/roles',
        marketCategory: 'base',
        entryPoint: 'org/roles.tsx',
        menuConfig: { title: '角色与授权', permission: pc('role:read') },
      },
      // S3-a：S1 backfill 组织两页 + 操作日志查询页挂系统管理组。
      {
        code: 'system-department',
        routePath: '/system/departments',
        marketCategory: 'base',
        entryPoint: 'org/departments.tsx',
        menuConfig: { title: '机构', permission: pc('department:read') },
      },
      {
        code: 'system-position',
        routePath: '/system/positions',
        marketCategory: 'base',
        entryPoint: 'org/positions.tsx',
        menuConfig: { title: '岗位', permission: pc('position:read') },
      },
      {
        code: 'system-audit',
        routePath: '/system/audit',
        marketCategory: 'base',
        entryPoint: 'audit/logs.tsx',
        menuConfig: { title: '操作日志', permission: pc('audit:read') },
      },
      // T1 能力子集：菜单管理（#98/#99）与审批流配置（#102）挂系统管理组——
      // 权限码与 menu-config/approval-config 控制器实态同码（菜单可见性 =
      // 接口可达性）。通知中心（#101）不走侧栏——入口 = 顶栏铃铛（hideInMenu
      // 保留路由，见下方独立条目）。
      {
        code: 'system-menus',
        routePath: '/system/menus',
        marketCategory: 'base',
        entryPoint: 'system/menus.tsx',
        menuConfig: { title: '菜单管理', permission: pc('menu:read') },
      },
      {
        code: 'system-approval-config',
        routePath: '/system/approval-config',
        marketCategory: 'base',
        entryPoint: 'system/approval-config.tsx',
        menuConfig: { title: '审批流配置', permission: pc('approval-config:read') },
      },
      {
        code: 'system-session',
        routePath: '/system/sessions',
        marketCategory: 'base',
        entryPoint: 'org/sessions.tsx',
        menuConfig: {
          title: '会话审计',
          permission: pc('system:access'),
          hideInMenu: true,
        },
      },
    ],
  },
  {
    // T1 能力子集 #101 通知中心：路由存在但侧栏不进——入口 = 顶栏铃铛
    // （ShellLayout 未读徽标，notification:read 同码轮询 GET unread-count）。
    code: 'notifications',
    routePath: '/notifications',
    marketCategory: 'base',
    entryPoint: 'notifications/index.tsx',
    menuConfig: {
      title: '通知中心',
      permission: pc('notification:read'),
      hideInMenu: true,
    },
  },
];

export const menuTree = buildMenuTree(DEMO_MANIFESTS);

/** 全量路由清单（含 hideInMenu 项；权限守卫在路由层按 permission 码执行）。 */
export const menuRoutes = flattenRoutes(menuTree);

/**
 * i18n 波 1（ADR-0012）：静态菜单树 → menu namespace key 映射。
 * 条目 title 中文原文保留不动（zh-CN 权威源 + 渲染回落值，menu.test 断言零触碰）；
 * 渲染层（MenuNav）经 shell/menuTitle.ts 优先 key→t()。
 * 键形态 `menu:<group>.title`（分组）/ `menu:<group>.<segment>`（组内叶子，
 * segment=子码去掉 `<group>-` 前缀）/ `menu:<code>`（根叶子）。
 * 映射表以 `<code>::<静态 title>` 复合键索引——树内存在 code 撞名（costing 组
 * 与其同名叶子 costing），复合键零撞键；且 title 被 menu_configs 配置集覆盖后
 * 复合键自然失配 → 渲染层回落配置 title 原文（管理员语言业务数据不翻译，§5 b 类）。
 */
function buildMenuTitleKeys(nodes: readonly MenuNode[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const node of nodes) {
    if (node.children !== undefined && node.children.length > 0) {
      keys[`${node.code}::${node.title}`] = `menu:${node.code}.title`;
      for (const child of node.children) {
        const segment = child.code.startsWith(`${node.code}-`)
          ? child.code.slice(node.code.length + 1)
          : child.code;
        keys[`${child.code}::${child.title}`] = `menu:${node.code}.${segment}`;
      }
    } else {
      keys[`${node.code}::${node.title}`] = `menu:${node.code}`;
    }
  }
  return keys;
}

export const MENU_TITLE_KEYS: Readonly<Record<string, string>> = buildMenuTitleKeys(menuTree);
