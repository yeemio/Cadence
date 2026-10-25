/**
 * 移动报工核查页（S3 移动呈现，report:verify；覆盖矩阵 §3.2 111-114 四类报工
 * 核查）：GET /reports/pending-verification 待核查队列（reported 链尾、先进先核；
 * 四类 kind 同队列经徽标区分）→ POST /reports/:id/verify（report.verify.v1，
 * expectedRevision 取行 objectVersion 乐观锁）。权限码与后端
 * reporting.controllers.ts:139-150 同码。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, LoaderCircle } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchPendingVerification } from '@/data/mobile-ops';
import { verifyReport } from '@/data/reportingApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OpsOutcome } from './OpsOutcome';
import { REPORT_KIND_LABELS, labelOf } from './labels';
import type { WorkReportRowView } from '@smes/product-ui';

export function MobileVerifyPage() {
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({
    queryKey: ['reports', 'pending-verification'],
    queryFn: fetchPendingVerification,
  });

  const [remarkInputs, setRemarkInputs] = useState<Record<string, string>>({});
  const verifyMutation = useMutation({
    mutationFn: (input: {
      report: WorkReportRowView;
      remark: string | undefined;
    }) =>
      verifyReport(input.report.id, { objectVersion: input.report.objectVersion }, input.remark),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  const rows = pendingQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>报工核查</CardTitle>
          <CardDescription>
            待核查队列（已报态按时间先进先核；五类报工同队列）。核查通过后进入工时归集。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {pendingQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {pendingQuery.isError && <ApiErrorHint error={pendingQuery.error} />}
          {verifyMutation.isError && <ApiErrorHint error={verifyMutation.error} />}
          {pendingQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">队列为空——暂无待核查报工。</p>
          )}
          {rows.map((report) => {
            const busy = verifyMutation.isPending && verifyMutation.variables?.report.id === report.id;
            return (
              <div
                key={report.id}
                className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {labelOf(REPORT_KIND_LABELS, report.kind)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{report.id}</span>
                </div>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="truncate">
                    派工单 <span className="font-mono">{report.dispatchId}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>完成 {report.doneQty}</span>
                    <span>{report.laborMinutes} 分钟</span>
                    <span>{report.reporter}</span>
                    <span>{report.businessTime.slice(0, 16).replace('T', ' ')}</span>
                  </span>
                  {report.operationCode !== null && (
                    <span className="text-xs text-muted-foreground">
                      工序 <span className="font-mono">{report.operationCode}</span>
                      {report.drawingNo !== null && <>／图号 <span className="font-mono">{report.drawingNo}</span></>}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
                    placeholder="核查备注（可选）"
                    value={remarkInputs[report.id] ?? ''}
                    onChange={(event) =>
                      setRemarkInputs((prev) => ({ ...prev, [report.id]: event.target.value }))
                    }
                  />
                  <Button
                    className="h-11 shrink-0"
                    disabled={verifyMutation.isPending}
                    onClick={() =>
                      verifyMutation.mutate({
                        report,
                        remark: (remarkInputs[report.id] ?? '').trim() || undefined,
                      })
                    }
                  >
                    {busy ? '核查中…' : (
                      <>
                        <BadgeCheck />
                        核查
                      </>
                    )}
                  </Button>
                </div>
                {verifyMutation.variables?.report.id === report.id && (
                  <OpsOutcome outcome={verifyMutation.data ?? null} />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
