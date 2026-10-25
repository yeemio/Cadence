/**
 * 移动工作令进度查询页（S3 移动呈现，workorder:read；覆盖矩阵 §3.2 #134
 * 工作令进度查询）：GET /workorder/work-orders/:id/progress（计划 vs 实际：
 * 计划日期 + 当前态 + 迁移里程碑 + 交付倒计时）。权限码与后端
 * workorder.controllers.ts:150-154 同码。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, SearchX } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchWorkOrderProgress } from '@/data/mobile-ops';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { WORK_ORDER_STATE_LABELS } from './labels';

export function MobileProgressPage() {
  const [idInput, setIdInput] = useState('');
  const [queryId, setQueryId] = useState<string | null>(null);

  const progressQuery = useQuery({
    queryKey: ['workorder', 'progress', queryId],
    queryFn: () => fetchWorkOrderProgress(queryId as string),
    enabled: queryId !== null,
    retry: false, // 404（不存在的工作令）直接反馈，不重试
  });

  const view = progressQuery.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>工作令进度</CardTitle>
          <CardDescription>输入工作令 id 查询计划 vs 实际进度与里程碑。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
              value={idInput}
              placeholder="wo-…（手填）"
              onChange={(event) => setIdInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && idInput.trim().length > 0) setQueryId(idInput.trim());
              }}
            />
            <Button
              className="h-11 shrink-0"
              disabled={idInput.trim().length === 0}
              onClick={() => setQueryId(idInput.trim())}
            >
              查询
            </Button>
          </div>

          {progressQuery.isPending && queryId !== null && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {progressQuery.isError && <ApiErrorHint error={progressQuery.error} />}

          {view !== undefined && (
            <>
              <div className="flex flex-col gap-1 rounded-lg border bg-background px-3 py-2.5">
                <span className="text-sm font-medium">{view.projectName}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    {WORK_ORDER_STATE_LABELS[view.state] ?? view.state}
                  </span>
                  <span className="font-mono">{view.workOrderId}</span>
                  {view.plannedDeliveryAt !== null && (
                    <span>计划交付 {view.plannedDeliveryAt.slice(0, 10)}</span>
                  )}
                  {view.daysToDelivery !== null && (
                    <span className={view.daysToDelivery < 0 ? 'font-medium text-destructive' : ''}>
                      {view.daysToDelivery >= 0 ? `距交付 ${view.daysToDelivery} 天` : `已逾期 ${-view.daysToDelivery} 天`}
                    </span>
                  )}
                </span>
              </div>

              {view.milestones.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <SearchX className="size-4 shrink-0" />
                  暂无迁移记录。
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {view.milestones.map((milestone, index) => (
                    <li
                      key={`${milestone.at}-${index}`}
                      className="flex flex-col gap-0.5 rounded-lg border bg-background px-3 py-2 text-sm"
                    >
                      <span>
                        {WORK_ORDER_STATE_LABELS[milestone.from] ?? milestone.from}
                        {' → '}
                        <span className="font-medium">
                          {WORK_ORDER_STATE_LABELS[milestone.to] ?? milestone.to}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{milestone.at.slice(0, 16).replace('T', ' ')}</span>
                        <span>{milestone.actor}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
