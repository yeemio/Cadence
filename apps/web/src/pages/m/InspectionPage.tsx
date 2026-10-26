/**
 * 移动质检页（S3 移动呈现，inspection:judge；覆盖矩阵 §3.2 119-122 四类质检）：
 * GET /inspection/orders 待检队列（inspection:read；四类 kind 同队列经徽标区分，
 * 可按 kind 过滤）→ POST /inspection/orders/:id/judgment 判定
 * （inspection.judge.v1：passedQty/failedQty）与 :id/recheck 复检
 * （inspection.recheck.v1，failed 态卡提供）；expectedRevision 取行
 * objectVersion。权限码与后端 inspection.controllers.ts:63-114 同码。
 *
 * fix-wave-2 D-12/D-6 移动收尾：队列查询按 session 权限投影门禁——门禁码取
 * 端点实码 inspection:read（GET /inspection/orders 的 @RequirePermission），
 * 非导航注册码 inspection:judge（动作码不折算读码）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, LoaderCircle, RotateCw } from 'lucide-react';
import { INSPECTION_READ } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { fetchInspectionQueue } from '@/data/mobile-ops';
import { judgeInspectionOrder, recheckInspectionOrder } from '@/data/inspectionApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { OpsOutcome } from './OpsOutcome';
import { INSPECTION_KIND_LABELS, INSPECTION_STATE_LABELS, labelOf } from './labels';
import type { InspectionOrderRowView } from '@smes/product-ui';

/** kind 过滤页签（全部 + 四类；键值为后端 kind 实态）。 */
const KIND_TABS: ReadonlyArray<{ readonly value: string | null; readonly title: string }> = [
  { value: null, title: '全部' },
  { value: 'self_outsourced', title: '自制外协' },
  { value: 'nonstandard_purchase', title: '非标件采购' },
  { value: 'standard_purchase', title: '标准配件' },
  { value: 'equipment_purchase', title: '设备采购' },
];

/** 判定/复检同载荷形状（S2 inspectionApi 先例）。 */
interface JudgeInput {
  readonly passedQty: number;
  readonly failedQty: number;
  readonly remark?: string | undefined;
}

export function MobileInspectionPage() {
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // D-12：队列查询按 session 权限投影（inspection:read，端点实码；见文件头注释）。
  const accessible = useMobileDataAccess(INSPECTION_READ);
  const queueQuery = useQuery({
    queryKey: ['inspection', 'orders', kindFilter],
    queryFn: () => fetchInspectionQueue(kindFilter === null ? {} : { kind: kindFilter }),
    enabled: accessible,
  });

  // 展开态：一张卡一个判定表单（quantity 预填通过数量）
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [passedInput, setPassedInput] = useState('');
  const [failedInput, setFailedInput] = useState('');
  const [remarkInput, setRemarkInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const judgeMutation = useMutation({
    mutationFn: (input: { row: InspectionOrderRowView; kind: 'judge' | 'recheck' } & JudgeInput) =>
      input.kind === 'judge'
        ? judgeInspectionOrder(input.row.id, { objectVersion: input.row.objectVersion }, {
            passedQty: input.passedQty,
            failedQty: input.failedQty,
            remark: input.remark,
          })
        : recheckInspectionOrder(input.row.id, { objectVersion: input.row.objectVersion }, {
            passedQty: input.passedQty,
            failedQty: input.failedQty,
            remark: input.remark,
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inspection', 'orders'] });
    },
  });

  function openForm(row: InspectionOrderRowView, kind: 'judge' | 'recheck'): void {
    if (judgeMutation.isPending) return;
    setExpandedId(`${row.id}::${kind}`);
    setPassedInput(kind === 'recheck' ? '' : String(row.quantity));
    setFailedInput('0');
    setRemarkInput('');
    setFormError(null);
    judgeMutation.reset();
  }

  function submit(row: InspectionOrderRowView, kind: 'judge' | 'recheck'): void {
    const passedQty = Number(passedInput);
    const failedQty = Number(failedInput);
    if (
      !Number.isFinite(passedQty) ||
      !Number.isFinite(failedQty) ||
      passedQty < 0 ||
      failedQty < 0 ||
      passedQty + failedQty === 0
    ) {
      setFormError('合格/不合格数量须 ≥0 且合计 >0');
      return;
    }
    if (passedQty + failedQty > row.quantity) {
      setFormError(`合格+不合格不得超过送检数量 ${row.quantity}`);
      return;
    }
    setFormError(null);
    judgeMutation.mutate({
      row,
      kind,
      passedQty,
      failedQty,
      remark: remarkInput.trim().length > 0 ? remarkInput.trim() : undefined,
    });
  }

  const rows = queueQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>质检</CardTitle>
          <CardDescription>四类质检单（待检判定、不合格复检）；判定放行联动入库。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {KIND_TABS.map((tab) => (
              <button
                key={tab.title}
                type="button"
                className={cn(
                  'h-9 rounded-lg border px-2.5 text-xs transition-colors',
                  kindFilter === tab.value
                    ? 'border-primary/50 bg-primary/5 font-medium text-primary'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setKindFilter(tab.value)}
              >
                {tab.title}
              </button>
            ))}
          </div>

          {!accessible ? (
            <MobileNoAccessHint code={INSPECTION_READ} />
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
          {judgeMutation.isError && <ApiErrorHint error={judgeMutation.error} />}
          {queueQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">该过滤下暂无质检单。</p>
          )}

          {rows.map((row) => {
            const judgeKey = `${row.id}::judge`;
            const recheckKey = `${row.id}::recheck`;
            const expandedKey = expandedId === judgeKey ? 'judge' : expandedId === recheckKey ? 'recheck' : null;
            return (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {labelOf(INSPECTION_KIND_LABELS, row.kind)}
                  </span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs',
                      row.state === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {labelOf(INSPECTION_STATE_LABELS, row.state)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>送检 {row.quantity}</span>
                    {row.itemId !== null && (
                      <span>
                        物料 <span className="font-mono">{row.itemId}</span>
                      </span>
                    )}
                    {row.drawingNo !== null && (
                      <span>
                        图号 <span className="font-mono">{row.drawingNo}</span>
                      </span>
                    )}
                    {row.sourceRefId !== null && (
                      <span>
                        来源 <span className="font-mono">{row.sourceRefId}</span>
                      </span>
                    )}
                  </span>
                  {row.passedQty !== null && row.failedQty !== null && (
                    <span className="text-xs text-muted-foreground">
                      已判定：合格 {row.passedQty}／不合格 {row.failedQty}
                      {row.judgeRemark !== null && <>（{row.judgeRemark}）</>}
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground">{row.id}</span>
                </div>

                <div className="flex gap-2">
                  {row.state === 'pending' && (
                    <Button
                      size="sm"
                      className="h-11"
                      disabled={judgeMutation.isPending}
                      onClick={() => openForm(row, 'judge')}
                    >
                      <ClipboardCheck />
                      判定
                    </Button>
                  )}
                  {row.state === 'failed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11"
                      disabled={judgeMutation.isPending}
                      onClick={() => openForm(row, 'recheck')}
                    >
                      <RotateCw />
                      复检
                    </Button>
                  )}
                </div>

                {expandedKey !== null && (
                  <div className="flex flex-col gap-2 border-t pt-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1 text-sm">
                        合格数量
                        <input
                          className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={passedInput}
                          onChange={(event) => setPassedInput(event.target.value)}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        不合格数量
                        <input
                          className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={failedInput}
                          onChange={(event) => setFailedInput(event.target.value)}
                        />
                      </label>
                    </div>
                    <input
                      className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                      placeholder="判定备注（可选）"
                      value={remarkInput}
                      onChange={(event) => setRemarkInput(event.target.value)}
                    />
                    {formError !== null && <p className="text-xs text-destructive">{formError}</p>}
                    <div className="flex gap-2">
                      <Button
                        className="h-11"
                        disabled={judgeMutation.isPending}
                        onClick={() => submit(row, expandedKey)}
                      >
                        {judgeMutation.isPending ? '提交中…' : expandedKey === 'recheck' ? '提交复检' : '提交判定'}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={judgeMutation.isPending}
                        onClick={() => setExpandedId(null)}
                      >
                        收起
                      </Button>
                    </div>
                    {judgeMutation.variables?.row.id === row.id && (
                      <OpsOutcome outcome={judgeMutation.data ?? null} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
