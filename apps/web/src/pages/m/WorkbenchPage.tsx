/**
 * 移动工作台页（M5 首波，workbench:read；功能拆解 105/106 移动首页/待办的
 * 呈现面）：本人待办（workbench API——"仅本人"是服务端数据级过滤合同）+
 * 快捷入口（报工/扫码/库存查询/我的工时四高频动作 + S3 移动呈现增量 11 页
 * ——覆盖矩阵 §3.2 19 项 + §3.4 #116 的可导航到达入口）。
 *
 * 与桌面 WorkbenchPage 的分工：桌面是计数卡片 + 全量表格（管理视角），
 * 移动是"快捷入口 + open 待办清单 + 完成按钮"（工人视角，卡片列表替表格）。
 * 数据层与组件完全复用（workbenchApi / ApiErrorHint / Card / Button）；快捷
 * 入口可见性复用 filterMenuByPermissions（与底部导航同一 RBAC 投影语义）；
 * 子页入口直引 MOBILE_SUBPAGES（注册表单一事实源）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import { Link } from 'react-router';
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  ClipboardPen,
  Clock3,
  History,
  ListChecks,
  LoaderCircle,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  ScanLine,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { filterMenuByPermissions, permissionCode, toPermissionCodes } from '@smes/product-ui';
import type { MenuNode } from '@smes/product-ui';
import { MOBILE_SUBPAGES } from '@/mobile';
import { useMergedMenu } from '@/shell/useMenuConfig';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { completeTodo, listMyTodos } from '@/data/workbenchApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** 快捷入口注册（MenuNode 形状走权限投影；图标为装配层视觉映射）。 */
const QUICK_ENTRY_ICONS: Record<string, LucideIcon> = {
  'quick-report': ClipboardPen,
  'quick-scan': ScanLine,
  'quick-stock': Boxes,
  'quick-hours': Clock3,
  // S3 子页图标（键=移动页码，单一事实源见 MOBILE_SUBPAGES）
  'm.verify': ClipboardCheck,
  'm.parts': PackageOpen,
  'm.parts-approval': PackageCheck,
  'm.inspection': ShieldCheck,
  'm.fault': TriangleAlert,
  'm.receipt': PackagePlus,
  'm.transfer': ArrowLeftRight,
  'm.stocktake': ClipboardList,
  'm.progress': ListChecks,
  'm.op-progress': BarChart3,
  'm.mine': History,
};

/** 快捷区核心四项（工作台页自有 UX，不进菜单配置管辖——T1 #99 合并只作用于子页注册表）。 */
const QUICK_CORE: readonly MenuNode[] = [
  { code: 'quick-report', title: '扫码报工', routePath: '/m/report', permission: permissionCode('report:submit') },
  // 扫码指向桌面通用扫码页（跨环节数据采集，非移动组专属动作）
  { code: 'quick-scan', title: '扫码', routePath: '/scan', permission: permissionCode('scan:read') },
  { code: 'quick-stock', title: '库存查询', routePath: '/m/stock', permission: permissionCode('stock:read') },
  { code: 'quick-hours', title: '我的工时', routePath: '/m/hours', permission: permissionCode('hours:read') },
];

export function MobileWorkbenchPage() {
  const { data: permissionData } = usePermissions({});
  // T1 #99：S3 移动呈现增量 11 页（覆盖矩阵 §3.2 19 项 + §3.4 #116）的入口
  // 受移动菜单配置（code='mobile'）合并——未进配置树的子页隐藏（fail-open：
  // 配置不可用 = 注册表全量，行为与 S3 一致）；核心四项恒在。
  const mergedSubpages = useMergedMenu(MOBILE_SUBPAGES, 'mobile');
  const quickEntries = filterMenuByPermissions(
    [...QUICK_CORE, ...mergedSubpages],
    toPermissionCodes(permissionData),
  );

  const queryClient = useQueryClient();
  const todosQuery = useQuery({ queryKey: ['workbench', 'todos'], queryFn: listMyTodos });
  const doneMutation = useMutation({
    mutationFn: completeTodo,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workbench'] });
    },
  });
  const openTodos = todosQuery.data?.filter((todo) => todo.status === 'open') ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>快捷入口</CardTitle>
          <CardDescription>车间高频动作（按权限显示）。</CardDescription>
        </CardHeader>
        <CardContent>
          {quickEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前身份无可用入口。</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {quickEntries.map((entry) => {
                const Icon = QUICK_ENTRY_ICONS[entry.code] ?? ScanLine;
                return (
                  <Link
                    key={entry.code}
                    to={entry.routePath ?? '/m'}
                    className="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-background p-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <Icon className="size-5 shrink-0" />
                    {entry.title}
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的待办</CardTitle>
          <CardDescription>分派给当前登录用户的未完成待办（服务端按身份过滤）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {todosQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {todosQuery.isError && <ApiErrorHint error={todosQuery.error} />}
          {doneMutation.isError && <ApiErrorHint error={doneMutation.error} />}
          {todosQuery.data !== undefined && openTodos.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无待办。</p>
          )}
          {openTodos.map((todo) => (
            <div
              key={todo.id}
              className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm">{todo.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{todo.source}</span>
                  {todo.dueAt !== null && <span>截止 {todo.dueAt.slice(0, 10)}</span>}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-11 shrink-0"
                disabled={doneMutation.isPending && doneMutation.variables === todo.id}
                onClick={() => doneMutation.mutate(todo.id)}
              >
                <CheckCircle2 />
                完成
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
