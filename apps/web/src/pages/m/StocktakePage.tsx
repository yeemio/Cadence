/**
 * 移动盘点页（S3 移动呈现，stocktake:record；覆盖矩阵 §3.2 #133 库存盘点）：
 * stocktake 四态 API 全径——GET /inventory/stocktakes 台账（stocktake:read）+
 * GET :id 详情 + POST /inventory/stocktakes 开单 + POST :id/records 实盘录入
 * （complete=true 提交差异）+ POST :id/approval 审核调账（stocktake:approve）。
 * expectedRevision 取详情行 objectVersion（record 录行不推版本，后端口径）。
 * 权限码与后端 inventory.controllers.ts:123-160 同码。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, LoaderCircle } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { approveStocktake, openStocktake, recordStocktake } from '@/data/inventoryApi';
import { fetchStocktakeDetail, fetchStocktakeList } from '@/data/mobile-ops';
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
import { STOCKTAKE_STATE_LABELS, labelOf } from './labels';

export function MobileStocktakePage() {
  const queryClient = useQueryClient();

  // ---- 台账列表 + 选中详情 ----
  const listQuery = useQuery({
    queryKey: ['inventory', 'stocktakes'],
    queryFn: () => fetchStocktakeList(),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: ['inventory', 'stocktakes', selectedId],
    queryFn: () => fetchStocktakeDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  // ---- 开单 ----
  const [openWarehouseId, setOpenWarehouseId] = useState('');
  const [openRemark, setOpenRemark] = useState('');
  const openMutation = useMutation({
    mutationFn: () =>
      openStocktake({
        warehouseId: openWarehouseId.trim(),
        remark: openRemark.trim().length > 0 ? openRemark.trim() : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] });
    },
  });

  // ---- 实盘录入（选中详情的行集） ----
  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  const [complete, setComplete] = useState(false);
  const recordMutation = useMutation({
    mutationFn: (input: {
      id: string;
      objectVersion: number;
      lines: ReadonlyArray<{ itemId: string; countedQty: number }>;
    }) =>
      recordStocktake(
        input.id,
        { objectVersion: input.objectVersion },
        { lines: input.lines, complete },
      ),
    onSuccess: (_data, variables) => {
      setCountInputs({});
      setComplete(false);
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] });
      setSelectedId(variables.id);
    },
  });

  // ---- 审核调账 ----
  const [approveRemark, setApproveRemark] = useState('');
  const approveMutation = useMutation({
    mutationFn: (input: { id: string; objectVersion: number }) =>
      approveStocktake(input.id, { objectVersion: input.objectVersion }, approveRemark.trim()),
    onSuccess: (_data, variables) => {
      setApproveRemark('');
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] });
      setSelectedId(variables.id);
    },
  });

  const detail = detailQuery.data?.stocktake ?? null;
  const rows = listQuery.data ?? [];

  function submitRecord(): void {
    if (recordMutation.isPending || detail === null) return;
    const lines = detail.lines
      .map((line) => ({ itemId: line.itemId, raw: (countInputs[line.itemId] ?? '').trim() }))
      .filter((entry) => entry.raw.length > 0)
      .map((entry) => ({ itemId: entry.itemId, countedQty: Number(entry.raw) }));
    if (lines.length === 0) return;
    if (lines.some((line) => !Number.isFinite(line.countedQty) || line.countedQty < 0)) {
      return; // 非法实盘量不提交（输入层 type=number 已约束，此处兜底）
    }
    recordMutation.mutate({ id: detail.id, objectVersion: detail.objectVersion, lines });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>库存盘点</CardTitle>
          <CardDescription>开单 → 实盘录入（可多轮）→ 提交差异 → 审核调账。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
              value={openWarehouseId}
              placeholder="仓库 id（开单）"
              onChange={(event) => setOpenWarehouseId(event.target.value)}
            />
            <Button
              className="h-11 shrink-0"
              disabled={openMutation.isPending || openWarehouseId.trim().length === 0}
              onClick={() => openMutation.mutate()}
            >
              {openMutation.isPending ? '开单中…' : '开单盘点'}
            </Button>
          </div>
          <input
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
            value={openRemark}
            placeholder="备注（可选；开单默认全仓有账物料）"
            onChange={(event) => setOpenRemark(event.target.value)}
          />
          {openMutation.isError && <ApiErrorHint error={openMutation.error} />}
          <OpsOutcome outcome={openMutation.data ?? null} />

          {listQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {listQuery.isError && <ApiErrorHint error={listQuery.error} />}
          {listQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无盘点单。</p>
          )}
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={cn(
                  'flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                  selectedId === row.id
                    ? 'border-primary/50 bg-primary/5'
                    : 'bg-background hover:border-primary/30',
                )}
                onClick={() => {
                  setSelectedId(row.id);
                  setCountInputs({});
                  setComplete(false);
                  detailQuery.refetch();
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {labelOf(STOCKTAKE_STATE_LABELS, row.state)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{row.id}</span>
                </span>
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>
                    仓库 <span className="font-mono">{row.warehouseId}</span>
                  </span>
                  <span>{row.lines.length} 行</span>
                  <span>{row.createdAt.slice(0, 10)}</span>
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {selectedId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>盘点单详情</CardTitle>
            <CardDescription>
              {detail !== null ? labelOf(STOCKTAKE_STATE_LABELS, detail.state) : '加载中…'}
              ——账面量快照 vs 实盘量；录完后勾选“提交差异”进入待审核。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {detailQuery.isPending && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> 正在加载…
              </p>
            )}
            {detailQuery.isError && <ApiErrorHint error={detailQuery.error} />}
            {recordMutation.isError && <ApiErrorHint error={recordMutation.error} />}
            {approveMutation.isError && <ApiErrorHint error={approveMutation.error} />}

            {detail !== null && (
              <>
                {detail.lines.map((line) => (
                  <div
                    key={line.itemId}
                    className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-mono text-xs">{line.itemId}</span>
                      <span className="text-xs text-muted-foreground">
                        账面 {line.systemQty}
                        {line.countedQty !== null && <>／实盘 {line.countedQty}</>}
                        {line.countedQty !== null && line.countedQty !== line.systemQty && (
                          <span className={line.countedQty > line.systemQty ? ' text-emerald-700' : ' text-destructive'}>
                            （差异 {line.countedQty - line.systemQty > 0 ? '+' : ''}
                            {line.countedQty - line.systemQty}）
                          </span>
                        )}
                      </span>
                    </div>
                    <input
                      className="h-11 w-24 shrink-0 rounded-lg border border-input bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      placeholder="实盘"
                      value={countInputs[line.itemId] ?? ''}
                      onChange={(event) =>
                        setCountInputs((prev) => ({ ...prev, [line.itemId]: event.target.value }))
                      }
                    />
                  </div>
                ))}

                {(detail.state === 'counting' || detail.state === 'draft') && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={complete}
                        onChange={(event) => setComplete(event.target.checked)}
                      />
                      提交差异（全部录完后勾选——进入待审核调账）
                    </label>
                    <Button
                      className="h-12"
                      disabled={recordMutation.isPending}
                      onClick={submitRecord}
                    >
                      {recordMutation.isPending ? '录入中…' : (
                        <>
                          <ClipboardList />
                          保存实盘
                        </>
                      )}
                    </Button>
                    {recordMutation.variables?.id === detail.id && (
                      <OpsOutcome outcome={recordMutation.data ?? null} />
                    )}
                  </>
                )}

                {detail.state === 'reconciled' && (
                  <>
                    <input
                      className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                      placeholder="审核理由（必填——账面=实盘留痕）"
                      value={approveRemark}
                      onChange={(event) => setApproveRemark(event.target.value)}
                    />
                    <Button
                      className="h-12"
                      disabled={approveMutation.isPending || approveRemark.trim().length === 0}
                      onClick={() =>
                        approveMutation.mutate({ id: detail.id, objectVersion: detail.objectVersion })
                      }
                    >
                      {approveMutation.isPending ? '审核中…' : '审核调账'}
                    </Button>
                    {approveMutation.variables?.id === detail.id && (
                      <OpsOutcome outcome={approveMutation.data ?? null} />
                    )}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
