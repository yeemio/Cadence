/**
 * 工作台页（M1 增量 4-I）：登录后首页——本人待办列表 + 按 source 计数卡片
 * + 完成按钮。数据全部走真实 workbench API（本人视角是服务端数据级过滤
 * 合同，前端不自带 assignee 筛选）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
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

/** 计数卡片：一个来源一行（source 模块码 + open 数）。 */
function SourceCountCards() {
  const summaryQuery = useQuery({ queryKey: ['workbench', 'summary'], queryFn: fetchWorkbenchSummary });

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
  const queryClient = useQueryClient();
  const todosQuery = useQuery({ queryKey: ['workbench', 'todos'], queryFn: listMyTodos });
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
          <SourceCountCards />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的待办</CardTitle>
          <CardDescription>仅显示分派给当前登录用户的待办（服务端按身份过滤）。</CardDescription>
        </CardHeader>
        <CardContent>
          {todosQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
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
        </CardContent>
      </Card>
    </div>
  );
}
