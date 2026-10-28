/**
 * 侧栏菜单渲染：分组节点渲染节标题，叶子节点渲染导航链接（hover/active 态）。
 * 图标为菜单代码 → lucide 图标的装配层视觉映射（未知代码回退 Circle）；
 * 菜单数据仍来自 product-ui 的 sidebar 投影（本文件不碰可见性语义）。
 * i18n 波 1：title 显示走 menuNodeTitle（key→t() 优先，配置集覆盖/无 key
 * 回落 title 原文——见 shell/menuTitle.ts 头注）。
 */
import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowLeftRight,
  Boxes,
  Calculator,
  CalendarClock,
  Circle,
  ClipboardCheck,
  ClipboardList,
  Clock,
  FilePlus,
  FileText,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  Package,
  PackageCheck,
  Percent,
  Route,
  ScanLine,
  ScrollText,
  Search,
  ShieldCheck,
  Ship,
  ShoppingCart,
  Table,
  Timer,
  Truck,
  Undo2,
  Users,
  Warehouse,
  Workflow,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MenuNode } from '@smes/product-ui';
import { MENU_TITLE_KEYS } from '../menu';
import { menuNodeTitle } from './menuTitle';
import { cn } from '@/lib/utils';

/** 菜单代码（ADR-0010 通用词）→ 图标。S2 批次新增九循环模块叶子映射。 */
const MENU_ICONS: Record<string, LucideIcon> = {
  workbench: LayoutDashboard,
  workorder: ClipboardList,
  'workorder-parts': Package,
  'listing-sheets': Layers,
  'listing-gap-checks': Search,
  dispatch: CalendarClock,
  'outsourcing-lines': Truck,
  scan: ScanLine,
  reports: FileText,
  'report-verification': ClipboardCheck,
  'purchase-requests': FilePlus,
  'purchase-orders': ShoppingCart,
  'purchase-returns': Undo2,
  'purchase-details': Table,
  inspections: ShieldCheck,
  nonconformities: XCircle,
  warehouses: Warehouse,
  'stock-levels': Boxes,
  'stock-operations': ArrowLeftRight,
  stocktakes: ListChecks,
  'shipping-orders': Ship,
  'hours-stats': Timer,
  costing: Calculator,
  'baseline-processes': Workflow,
  'baseline-routings': Route,
  'baseline-standard-times': Clock,
  'baseline-equipment': Wrench,
  'baseline-fault-reports': AlertTriangle,
  'baseline-outsourcing-rules': Percent,
  'baseline-material-validations': PackageCheck,
  'system-user': Users,
  'system-role': KeyRound,
  'system-session': ScrollText,
};

function iconFor(code: string): LucideIcon {
  return MENU_ICONS[code] ?? Circle;
}

export function MenuNav({ nodes }: { nodes: readonly MenuNode[] }) {
  const { t } = useTranslation();
  // UX-VW-01：侧栏空态引导（只读岗/无菜单权限账号不再只有品牌区一片空白）。
  // 组件级呈现——菜单注册与投影语义不在此文件（menu.ts / product-ui 投影不动）。
  if (nodes.length === 0) {
    return (
      <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        当前账号暂无可用的菜单。请联系管理员为账号分配角色与权限，分配后重新登录或刷新页面即可看到对应功能入口。
      </div>
    );
  }
  return (
    <nav className="flex flex-col gap-0.5">
      {nodes.map((node) =>
        node.children !== undefined && node.children.length > 0 ? (
          <div key={node.code} className="mt-5 first:mt-0">
            <div className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">
              {menuNodeTitle(node, MENU_TITLE_KEYS, t)}
            </div>
            <div className="flex flex-col gap-0.5">
              <MenuNav nodes={node.children} />
            </div>
          </div>
        ) : node.routePath !== undefined ? (
          <MenuLink key={node.code} node={node} />
        ) : null,
      )}
    </nav>
  );
}

function MenuLink({ node }: { node: MenuNode }) {
  const { t } = useTranslation();
  if (node.routePath === undefined) return null;
  const { routePath } = node;
  const Icon = iconFor(node.code);
  return (
    <NavLink
      to={routePath}
      end={routePath === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {menuNodeTitle(node, MENU_TITLE_KEYS, t)}
    </NavLink>
  );
}
