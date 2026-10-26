/**
 * 工作台页（M1 增量 4-I）：登录后首页——本人待办列表 + 按 source 计数卡片
 * + 完成按钮。数据全部走真实 workbench API（本人视角是服务端数据级过滤
 * 合同，前端不自带 assignee 筛选）。
 *
 * fix-wave-2 D-12/D-6：页面数据请求按 session 权限投影（菜单可见性 =
 * 接口可达性纪律对齐到首页数据请求，数据源与侧栏投影同款 usePermissions
 * + toPermissionCodes）——无 workbench:read 不发起任何 workbench 请求，
 * 卡片直接呈现显式"无权限"终态（不再依赖失败分支兜底）；万一请求已发出
 * 而 403（如服务端策略与会话投影短暂不一致），isError 分支仍显式报错，
 * 卡片不再停在"正在加载…"。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { completeTodo, fetchWorkbenchSummary, listMyTodos } from '../../data/workbenchApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** 工作台数据面门禁码（与后端 GET /workbench/* 的 @RequirePermission 同码）。 */
const WORKBENCH_READ = permissionCode('workbench:read');

/**
 * D-12 投影判定（唯一决策点，页面两查询的 enabled 即本函数返回值）：
 * 入参 = refine usePermissions 的原始 data（undefined=会话权限未就绪）。
 * 未就绪或无 workbench:read → false（不发起任何 workbench 请求）；
 * admin 通配 bypass 由 sessionHasPermission 内含。
 */
export function canAccessWorkbench(permissionData: unknown): boolean {
  return permissionData !== undefined && sessionHasPermission(toPermissionCodes(permissionData), WORKBENCH_READ);
}

/** 无权限终态（D-6）：与页内既有空态同形态（muted 行内文案，先例=移动页"当前身份无可用入口。"）。 */
function NoAccessHint() {
  return (
    <p className="text-sm text-muted-foreground">
      当前身份无工作台读取权限（workbench:read），不发起数据请求。
    </p>
  );
}

/** 计数卡片：一个来源一行（source 模块码 + open 数）。 */
function SourceCountCards({ accessible }: { readonly accessible: boolean }) {
  const summaryQuery = useQuery({
    queryKey: ['workbench', 'summary'],
    queryFn: fetchWorkbenchSummary,
    enabled: accessible,
  });

  if (!accessible) {
    return <NoAccessHint />;
  }
  if (summaryQuery.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> 正在加载…
      </p>
    );
  }
  if (summaryQuery.isError) {
    return <ApiErrorHint error={summaryQuery.error} />;
  }
  const { bySource, openTotal } = summaryQuery.data;
  if (openTotal === 0) {
    return <p className="text-sm text-muted-foreground">没有待处理的待办。</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {bySource.map((row) => (
        <Card key={row.source}>
          <CardHeader className="pb-2">
            <CardDescription className="font-mono text-xs">{row.source}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{row.open}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function WorkbenchPage() {
  // D-12：session 权限投影（与 ShellLayout 侧栏投影同数据源）。permissions
  // 未就绪（undefined）时不发起请求、也不误报无权限（保持加载态一个 tick）。
  const { data: permissionData } = usePermissions({});
  const accessible = canAccessWorkbench(permissionData);

  const queryClient = useQueryClient();
  const todosQuery = useQuery({
    queryKey: ['workbench', 'todos'],
    queryFn: listMyTodos,
    enabled: accessible,
  });
  const doneMutation = useMutation({
    mutationFn: completeTodo,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workbench'] });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>待办概览</CardTitle>
          <CardDescription>当前登录用户未完成待办按来源模块计数。</CardDescription>
        </CardHeader>
        <CardContent>
          <SourceCountCards accessible={accessible} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的待办</CardTitle>
          <CardDescription>仅显示分派给当前登录用户的待办（服务端按身份过滤）。</CardDescription>
        </CardHeader>
        <CardContent>
          {!accessible ? (
            <NoAccessHint />
          ) : (
            <>
              {todosQuery.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> 正在加载…
                </p>
              )}
              {/* D-6 兜底：请求已发出而失败（含 403）时显式报错，不停在加载态 */}
              {todosQuery.isError && <ApiErrorHint error={todosQuery.error} />}
              {doneMutation.isError && <ApiErrorHint error={doneMutation.error} />}
              {todosQuery.data !== undefined && todosQuery.data.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无待办。</p>
              )}
              {todosQuery.data !== undefined && todosQuery.data.length > 0 && (
            /* 窄屏横滚（M5 响应式取舍：列完整性优先，卡片化留后续重设计） */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 pr-4 font-medium">标题</th>
                  <th className="py-2 pr-4 font-medium">来源</th>
                  <th className="py-2 pr-4 font-medium">指向</th>
                  <th className="py-2 pr-4 font-medium">截止</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {todosQuery.data.map((todo) => (
                  <tr key={todo.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">
                      <span className={todo.status === 'open' ? 'text-amber-600' : 'text-muted-foreground'}>
                        {todo.status === 'open' ? '进行中' : '已完成'}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{todo.title}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{todo.source}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {todo.refType === null ? '—' : `${todo.refType}:${todo.refId ?? ''}`}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {todo.dueAt === null ? '—' : todo.dueAt.slice(0, 10)}
                    </td>
                    <td className="py-2 text-right">
                      {todo.status === 'open' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11"
                      disabled={doneMutation.isPending && doneMutation.variables === todo.id}
                      onClick={() => doneMutation.mutate(todo.id)}
                    >
                          <CheckCircle2 />
                          完成
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
