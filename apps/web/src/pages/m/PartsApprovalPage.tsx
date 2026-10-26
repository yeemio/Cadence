/**
 * 移动配件审批页（S3 移动呈现，parts:approve；覆盖矩阵 §3.2 #118 配件审批）：
 * GET /workorder/parts-requests?state=submitted 待审队列（parts:read）→
 * POST /workorder/parts-requests/:id/approval（workorder.parts.approve.v1：
 * decision approve/reject + 决策理由 remark 必填 1~2000；expectedRevision 取行
 * objectVersion）。权限码与后端 workorder.controllers.ts:208-240 同码。
 *
 * fix-wave-2 D-12/D-6 移动收尾：待审队列查询按 session 权限投影门禁——门禁码
 * 取端点实码 parts:read（GET /workorder/parts-requests 的 @RequirePermission），
 * 非导航注册码 parts:approve（动作码不折算读码）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';
import { PARTS_READ } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchPartsRequests } from '@/data/mobile-ops';
import { decidePartsRequest } from '@/data/workorderApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OpsOutcome } from './OpsOutcome';
import { PARTS_STATE_LABELS, labelOf } from './labels';
import type { PartsRequestRowView } from '@smes/product-ui';

type Decision = 'approve' | 'reject';

export function MobilePartsApprovalPage() {
  const queryClient = useQueryClient();
  // D-12：待审队列查询按 session 权限投影（parts:read，端点实码；见文件头注释）。
  const accessible = useMobileDataAccess(PARTS_READ);
  const queueQuery = useQuery({
    queryKey: ['workorder', 'parts-requests', 'submitted'],
    queryFn: () => fetchPartsRequests(),
    enabled: accessible,
  });

  const [remarkInputs, setRemarkInputs] = useState<Record<string, string>>({});
  const decideMutation = useMutation({
    mutationFn: (input: { row: PartsRequestRowView; decision: Decision; remark: string }) =>
      decidePartsRequest(input.row.id, { objectVersion: input.row.objectVersion }, {
        decision: input.decision,
        remark: input.remark,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workorder', 'parts-requests'] });
    },
  });

  const rows = queueQuery.data ?? [];

  function decide(row: PartsRequestRowView, decision: Decision): void {
    if (decideMutation.isPending) return;
    const remark = (remarkInputs[row.id] ?? '').trim();
    if (remark.length === 0) {
      // 后端 requireBoundedString(1,2000)：理由必填——前后端同口径前置提示。
      decideMutation.reset();
      setRemarkInputs((prev) => ({ ...prev, [`${row.id}::error`]: '决策理由必填（1~2000 字）' }));
      return;
    }
    setRemarkInputs((prev) => ({ ...prev, [`${row.id}::error`]: '' }));
    decideMutation.mutate({ row, decision, remark });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>配件审批</CardTitle>
          <CardDescription>待审批申请（提交即待审）；批准进入发货链，拒绝即终结。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!accessible ? (
            <MobileNoAccessHint code={PARTS_READ} />
          ) : (
            <>
              {queueQuery.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> 正在加载…
                </p>
              )}
              {queueQuery.isError && <ApiErrorHint error={queueQuery.error} />}
            </>
          )}
          {decideMutation.isError && <ApiErrorHint error={decideMutation.error} />}
          {queueQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无待审批的配件申请。</p>
          )}
          {rows.map((row) => {
            const busy = decideMutation.isPending && decideMutation.variables?.row.id === row.id;
            const remarkError = remarkInputs[`${row.id}::error`] ?? '';
            return (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {labelOf(PARTS_STATE_LABELS, row.state)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{row.id}</span>
                </div>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="truncate">
                    工作令 <span className="font-mono">{row.workOrderId}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>
                      物料 <span className="font-mono">{row.itemId}</span>
                    </span>
                    <span>× {row.quantity}</span>
                    <span>{row.requester}</span>
                    <span>{row.createdAt.slice(0, 10)}</span>
                  </span>
                  {row.remark !== null && (
                    <span className="text-xs text-muted-foreground">申请备注：{row.remark}</span>
                  )}
                </div>
                <input
                  className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                  placeholder="决策理由（必填）"
                  value={remarkInputs[row.id] ?? ''}
                  onChange={(event) =>
                    setRemarkInputs((prev) => ({ ...prev, [row.id]: event.target.value }))
                  }
                />
                {remarkError.length > 0 && <p className="text-xs text-destructive">{remarkError}</p>}
                <div className="flex gap-2">
                  <Button
                    className="h-11 flex-1"
                    disabled={decideMutation.isPending}
                    onClick={() => decide(row, 'approve')}
                  >
                    {busy && decideMutation.variables?.decision === 'approve' ? '提交中…' : (
                      <>
                        <CheckCircle2 />
                        批准
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 flex-1"
                    disabled={decideMutation.isPending}
                    onClick={() => decide(row, 'reject')}
                  >
                    {busy && decideMutation.variables?.decision === 'reject' ? '提交中…' : (
                      <>
                        <XCircle />
                        拒绝
                      </>
                    )}
                  </Button>
                </div>
                {decideMutation.variables?.row.id === row.id && (
                  <OpsOutcome outcome={decideMutation.data ?? null} />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
