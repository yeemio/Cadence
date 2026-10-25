/**
 * 移动图号/工序进度查询页（S3 移动呈现，report:read；覆盖矩阵 §3.2 #135
 * 图号/工序进度查询）：GET /reporting/drawings/:drawingNo/operation-progress
 * （图号 × 工序净报工聚合：netDoneQty/netLaborMinutes = reported+verified 链尾
 * 合计，revoked 不计；已核查口径单列）。权限码与后端
 * reporting.controllers.ts:173-184 同码。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, SearchX } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchDrawingOperationProgress } from '@/data/mobile-ops';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function MobileOpProgressPage() {
  const [drawingInput, setDrawingInput] = useState('');
  const [queryDrawingNo, setQueryDrawingNo] = useState<string | null>(null);

  const progressQuery = useQuery({
    queryKey: ['reporting', 'drawing-progress', queryDrawingNo],
    queryFn: () => fetchDrawingOperationProgress(queryDrawingNo as string),
    enabled: queryDrawingNo !== null,
    retry: false,
  });

  const rows = progressQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>图号/工序进度</CardTitle>
          <CardDescription>按图号查各工序净报工进度（净额 = 已报+已核查合计，撤销不计）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
              value={drawingInput}
              placeholder="图号（手填）"
              onChange={(event) => setDrawingInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && drawingInput.trim().length > 0) {
                  setQueryDrawingNo(drawingInput.trim());
                }
              }}
            />
            <Button
              className="h-11 shrink-0"
              disabled={drawingInput.trim().length === 0}
              onClick={() => setQueryDrawingNo(drawingInput.trim())}
            >
              查询
            </Button>
          </div>

          {progressQuery.isPending && queryDrawingNo !== null && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {progressQuery.isError && <ApiErrorHint error={progressQuery.error} />}

          {progressQuery.data !== undefined && rows.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <SearchX className="size-4 shrink-0" />
              该图号暂无报工进度。
            </p>
          )}
          {rows.map((row) => (
            <div
              key={row.operationCode ?? '(未挂工序)'}
              className="flex flex-col gap-1 rounded-lg border bg-background px-3 py-2.5"
            >
              <span className="flex items-center justify-between gap-2 text-sm">
                <span className="font-mono">{row.operationCode ?? '未挂工序'}</span>
                <span className="text-xs text-muted-foreground">{row.reportCount} 单</span>
              </span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>净完成 {row.netDoneQty}（已核查 {row.verifiedQty}）</span>
                <span>净工时 {row.netLaborMinutes} 分钟（已核查 {row.verifiedLaborMinutes}）</span>
              </span>
              {row.lastReportedAt !== null && (
                <span className="text-xs text-muted-foreground">
                  最近报工 {row.lastReportedAt.slice(0, 16).replace('T', ' ')}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
