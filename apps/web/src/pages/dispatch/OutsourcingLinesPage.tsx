/**
 * 外协管理页（S2 批次）：供应商维度外协明细（supplierRef 必填）+ 单价补录 +
 * 打印数据读回。外协取价实时联动 baseline 外协计价规则（后端能力）。
 * fix-wave-6 6a-1 增量：明细行状态/取消原因列（RREQ-DP-031）+ 取消外协操作
 * （仅已派工行可选；原因选填 ≤200 字；行取消释放工序占用）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  backfillOutsourcingPrice,
  cancelOutsourcingLine,
  getOutsourcingPrintData,
  listOutsourcingLines,
} from '../../data/dispatchApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LINE_COLUMNS = [
  { key: 'id', label: '行 id', mono: true },
  { key: 'dispatchId', label: '派工单', mono: true },
  { key: 'processCode', label: '工序', mono: true },
  { key: 'drawingNo', label: '图号', mono: true },
  { key: 'quantity', label: '数量' },
  { key: 'unitPriceMinor', label: '单价（分）' },
  { key: 'dispatchState', label: '单状态', mono: true },
  { key: 'statusLabel', label: '行状态' },
  { key: 'cancelReason', label: '取消原因' },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function OutsourcingLinesPage() {
  const queryClient = useQueryClient();
  const [supplierRef, setSupplierRef] = useState('');
  const [loadedSupplier, setLoadedSupplier] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<Record<string, unknown> | null>(null);
  const [unitPriceMinor, setUnitPriceMinor] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [printOrderId, setPrintOrderId] = useState('');
  const [loadedPrintOrderId, setLoadedPrintOrderId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const linesQuery = useQuery({
    queryKey: ['outsourcing', 'lines', loadedSupplier],
    queryFn: () => listOutsourcingLines(loadedSupplier as string),
    enabled: loadedSupplier !== null,
  });
  const printQuery = useQuery({
    queryKey: ['outsourcing', 'print', loadedPrintOrderId],
    queryFn: () => getOutsourcingPrintData(loadedPrintOrderId as string),
    enabled: loadedPrintOrderId !== null,
  });

  const backfillMutation = useMutation({
    mutationFn: () =>
      backfillOutsourcingPrice(String(selectedLine?.['id']), selectedLine as Record<string, unknown>, {
        unitPriceMinor: Number(unitPriceMinor),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['outsourcing'] });
        setUnitPriceMinor('');
      }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  // 取消外协（6a-1 RREQ-DP-031）：仅已派工（status=dispatched）行可取消；原因选填 ≤200。
  const selectedLineCancellable = selectedLine !== null && String(selectedLine['status']) === 'dispatched';
  const cancelMutation = useMutation({
    mutationFn: () =>
      cancelOutsourcingLine(String(selectedLine?.['id']), selectedLine as Record<string, unknown>, {
        ...(cancelReason.trim().length > 0 ? { reason: cancelReason.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['outsourcing'] });
        setCancelReason('');
      }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supplierRef.trim().length === 0) return;
    setLoadedSupplier(supplierRef.trim());
    setSelectedLine(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>外协明细（供应商维度）</CardTitle>
          <CardDescription>supplierRef 必填查询；点行选中后补录单价（分）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="os-supplier">供应商引用 supplierRef</Label>
              <Input id="os-supplier" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} required />
            </div>
            <Button type="submit">查询外协明细</Button>
          </form>
          {loadedSupplier !== null && (
            <QueryState
              isPending={linesQuery.isPending}
              error={linesQuery.error}
              isEmpty={linesQuery.data !== undefined && linesQuery.data.length === 0}
              empty="该供应商当前无外协明细"
            >
              <ModuleTable
                columns={LINE_COLUMNS}
                rows={linesQuery.data ?? []}
                selectedId={selectedLine === null ? null : String(selectedLine['id'] ?? '')}
                onSelect={(row) => setSelectedLine(row)}
              />
            </QueryState>
          )}
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="os-price">补录单价（分，正整数）——作用于选中行</Label>
              <Input
                id="os-price"
                type="number"
                min="1"
                step="1"
                value={unitPriceMinor}
                onChange={(e) => setUnitPriceMinor(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={backfillMutation.isPending || selectedLine === null || Number(unitPriceMinor) <= 0}
              onClick={() => backfillMutation.mutate()}
            >
              补录单价
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="os-cancel-reason">取消外协原因（选填，≤200 字）——作用于选中行（仅已派工行）</Label>
              <Input
                id="os-cancel-reason"
                maxLength={200}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={cancelMutation.isPending || !selectedLineCancellable}
              onClick={() => cancelMutation.mutate()}
            >
              取消外协
            </Button>
          </div>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>外协加工单打印数据</CardTitle>
          <CardDescription>按外协派工单 id 读回打印数据（outsourcing/orders/:id/print-data）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="os-print-order">外协派工单 id</Label>
              <Input id="os-print-order" value={printOrderId} onChange={(e) => setPrintOrderId(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={printOrderId.trim().length === 0}
              onClick={() => setLoadedPrintOrderId(printOrderId.trim())}
            >
              读打印数据
            </Button>
          </div>
          {loadedPrintOrderId !== null && (
            <QueryState isPending={printQuery.isPending} error={printQuery.error} isEmpty={false}>
              <RowDetail row={printQuery.data ?? {}} />
            </QueryState>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
