/**
 * 通知中心页（T1 能力子集：0920 #101 消息通知——站内消息面）。入口 = 顶栏
 * 铃铛（ShellLayout 未读计数徽标）；本页 = 本人收件箱（列表 + 单条已读 +
 * 全部置读）。数据级 (tenant, recipient) 双键过滤在后端收口——本人身份由
 * 会话令牌携带。业务消息来源 = 待办桥（待办/审批/派修/点名创建即投递）+
 * 运维补发端点。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../data/notificationsApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function formatStamp(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const listQuery = useQuery({ queryKey: ['notifications', 'list'], queryFn: fetchNotifications });
  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000, // 与顶栏铃铛同频（新消息提醒面）
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };
  const markOne = useMutation({ mutationFn: markNotificationRead, onSuccess: invalidate });
  const markAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: invalidate });

  const unread = unreadQuery.data ?? 0;
  const rows = listQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            通知中心
            {unread > 0 && (
              <span className="ml-2 rounded-full bg-primary px-2 py-0.5 align-middle text-xs font-medium text-primary-foreground">
                未读 {unread}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            待办/审批/派修/点名等业务消息的站内投递（新→旧）；已读为单向标记（幂等）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              共 {rows.length} 条
              {unreadQuery.data !== undefined ? `（未读 ${unread}）` : ''}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={markAll.isPending || unread === 0}
              onClick={() => markAll.mutate(undefined)}
            >
              全部置读
            </Button>
          </div>
          {(markOne.isError || markAll.isError) && (
            <ApiErrorHint error={markOne.error ?? markAll.error} />
          )}
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.isError ? listQuery.error : null}
            isEmpty={rows.length === 0}
            empty="暂无站内通知（业务待办创建/运维补发后出现在此）"
          >
            <div className="flex flex-col">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    'flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4',
                    row.readAt === null && 'bg-primary/5',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.readAt === null && (
                        <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="未读" />
                      )}
                      <span className={cn('text-sm', row.readAt === null && 'font-medium')}>{row.title}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {row.source}
                      </span>
                      {row.refType !== null && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {row.refType}
                          {row.refId === null ? '' : `/${row.refId.slice(0, 13)}`}
                        </span>
                      )}
                    </div>
                    {row.body !== null && <p className="mt-1 text-sm text-muted-foreground">{row.body}</p>}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatStamp(row.createdAt)}
                      {row.readAt !== null ? ` · 已读 ${formatStamp(row.readAt)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={row.readAt !== null || markOne.isPending}
                      onClick={() => markOne.mutate(row.id)}
                    >
                      {row.readAt !== null ? '已读' : '标记已读'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}
