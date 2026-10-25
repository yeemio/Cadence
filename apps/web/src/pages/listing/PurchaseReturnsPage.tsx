/**
 * 采购退货页（S2 批次）：按采购订单查退货单 + 退货建单（行号×数量×原因）+
 * 撤销操作。覆盖矩阵 #61 采购退货。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPurchaseReturn, listPurchaseReturns, revokePurchaseReturn } from '../../data/listingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'purchaseOrderId', label: '采购订单', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function PurchaseReturnsPage() {
  const queryClient = useQueryClient();
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [loadedOrderId, setLoadedOrderId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [revokeRemark, setRevokeRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const returnsQuery = useQuery({
    queryKey: ['purchase', 'returns', loadedOrderId],
    queryFn: () => listPurchaseReturns(loadedOrderId as string),
    enabled: loadedOrderId !== null,
  });

  // ---- 建单表单 ----
  const [lineNo, setLineNo] = useState('1');
  const [returnedQty, setReturnedQty] = useState('1');
  const [reason, setReason] = useState('');
  const [remark, setRemark] = useState('');

  const createAction = useMutation({
    mutationFn: () =>
      createPurchaseReturn({
        purchaseOrderId: (loadedOrderId ?? purchaseOrderId).trim(),
        lines: [
          {
            lineNo: Number(lineNo),
            returnedQty: Number(returnedQty),
            ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          },
        ],
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        setLoadedOrderId(purchaseOrderId.trim());
        queryClient.invalidateQueries({ queryKey: ['purchase', 'returns'] });
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  const revokeAction = useMutation({
    mutationFn: (row: Record<string, unknown>) =>
      revokePurchaseReturn(String(row['id']), row, revokeRemark.trim().length > 0 ? revokeRemark.trim() : undefined),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['purchase', 'returns'] });
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (purchaseOrderId.trim().length === 0) return;
    setLoadedOrderId(purchaseOrderId.trim());
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (purchaseOrderId.trim().length === 0 || Number(returnedQty) <= 0) return;
    createAction.mutate();
  }

  const selectedRow = (returnsQuery.data ?? []).find((row) => String(row['id']) === targetId.trim());

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>采购退货单</CardTitle>
          <CardDescription>退货单按采购订单查询（open→revoked 可撤销）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="ret-po">采购订单 id</Label>
              <Input id="ret-po" value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} required />
            </div>
            <Button type="submit" variant="outline">查询退货单</Button>
          </form>
          {loadedOrderId !== null && (
            <QueryState
              isPending={returnsQuery.isPending}
              error={returnsQuery.error}
              isEmpty={returnsQuery.data !== undefined && returnsQuery.data.length === 0}
              empty="该订单尚无退货单"
            >
              <ModuleTable columns={LIST_COLUMNS} rows={returnsQuery.data ?? []} />
            </QueryState>
          )}
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-target">撤销目标退货单 id（取上表）</Label>
              <Input id="ret-target" value={targetId} onChange={(e) => setTargetId(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-remark">撤销备注（可选）</Label>
              <Input id="ret-remark" value={revokeRemark} onChange={(e) => setRevokeRemark(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={revokeAction.isPending || selectedRow === undefined}
              onClick={() => selectedRow !== undefined && revokeAction.mutate(selectedRow)}
            >
              撤销退货单
            </Button>
          </div>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>新建退货单</CardTitle>
          <CardDescription>purchase.return.create.v1：行号取采购订单行 lineNo（1 起）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-new-lineno">退货行号 lineNo</Label>
              <Input id="ret-new-lineno" type="number" min="1" step="1" value={lineNo} onChange={(e) => setLineNo(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-new-qty">退货数量</Label>
              <Input id="ret-new-qty" type="number" min="0.000001" step="any" value={returnedQty} onChange={(e) => setReturnedQty(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-new-reason">退货原因（可选）</Label>
              <Input id="ret-new-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ret-new-remark">备注（可选）</Label>
              <Input id="ret-new-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createAction.isPending || purchaseOrderId.trim().length === 0 || Number(returnedQty) <= 0}>
                提交退货单
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
