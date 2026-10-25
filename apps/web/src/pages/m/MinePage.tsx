/**
 * 移动我的报工页（S3 移动呈现，report:read；覆盖矩阵 §3.2 #136 我的报工 +
 * §3.4 #116 报工记录管理）：GET /reports/mine 本人双键 (tenant, reporter)——
 * "仅本人完成"数据权限边界由服务端合同保证（reporting.controllers.ts:103-110）。
 * 记录列表卡片呈现（五类 kind × 四态徽标）。
 */
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchMyReports } from '@/data/mobile-ops';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { REPORT_KIND_LABELS, REPORT_STATE_LABELS, labelOf } from './labels';

export function MobileMinePage() {
  const mineQuery = useQuery({
    queryKey: ['reports', 'mine'],
    queryFn: fetchMyReports,
  });

  const rows = mineQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>我的报工</CardTitle>
          <CardDescription>本人提交的全部报工记录（服务端按身份过滤）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {mineQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {mineQuery.isError && <ApiErrorHint error={mineQuery.error} />}
          {mineQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无报工记录——去报工页提交第一单。</p>
          )}
          {rows.map((report) => (
            <div
              key={report.id}
              className="flex flex-col gap-1 rounded-lg border bg-background px-3 py-2.5"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {labelOf(REPORT_KIND_LABELS, report.kind)}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {labelOf(REPORT_STATE_LABELS, report.state)}
                </span>
              </span>
              <span className="truncate text-sm">
                派工单 <span className="font-mono">{report.dispatchId}</span>
              </span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>完成 {report.doneQty}</span>
                <span>{report.laborMinutes} 分钟</span>
                <span>{report.businessTime.slice(0, 16).replace('T', ' ')}</span>
              </span>
              {report.operationCode !== null && (
                <span className="text-xs text-muted-foreground">
                  工序 <span className="font-mono">{report.operationCode}</span>
                  {report.drawingNo !== null && <>／图号 <span className="font-mono">{report.drawingNo}</span></>}
                </span>
              )}
              {report.remark !== null && (
                <span className="text-xs text-muted-foreground">备注：{report.remark}</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
