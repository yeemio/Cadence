/**
 * 采购明细页（S2 批次）：采购明细视图 + 逾期未交明细 + 逾期事实扫描（催货触发）
 * + 明细导出载荷读回。覆盖矩阵 #62 采购明细查询。
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { exportPurchaseDetails, getPurchaseDetails, listOverdue, scanOverdue } from '../../data/listingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { formatLocalDateTime } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function PurchaseDetailsPage() {
  const [workOrderId, setWorkOrderId] = useState('');
  const [loadedWorkOrderId, setLoadedWorkOrderId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const detailsQuery = useQuery({
    queryKey: ['purchase', 'details', loadedWorkOrderId],
    queryFn: () => getPurchaseDetails(loadedWorkOrderId ?? undefined),
  });
  const exportQuery = useQuery({
    queryKey: ['purchase', 'details-export', loadedWorkOrderId],
    queryFn: () => exportPurchaseDetails(loadedWorkOrderId ?? undefined),
    enabled: loadedWorkOrderId !== null,
  });
  const overdueQuery = useQuery({ queryKey: ['purchase', 'overdue'], queryFn: listOverdue });

  const scanMutation = useMutation({
    mutationFn: scanOverdue,
    onSuccess: (result) => setOutcome(result),
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>采购明细</CardTitle>
          <CardDescription>全部/按工作令的采购明细视图（可另查导出载荷与逾期未交明细）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="pd-wo">工作令过滤（可选；空 = 全部）</Label>
              <Input
                id="pd-wo"
                value={workOrderId}
                onChange={(e) => setWorkOrderId(e.target.value)}
                placeholder="留空查全部"
              />
            </div>
            <Button variant="outline" onClick={() => setLoadedWorkOrderId(workOrderId.trim().length > 0 ? workOrderId.trim() : null)}>
              查询明细
            </Button>
          </div>
          <QueryState isPending={detailsQuery.isPending} error={detailsQuery.error} isEmpty={false}>
            <>
              <ModuleTable columns={[
                { key: 'purchaseOrderId', label: '采购订单', mono: true, format: 'shortId' },
                { key: 'stateLabel', label: '状态' }, { key: 'supplierName', label: '供应商' },
                { key: 'lineNo', label: '行号' }, { key: 'itemId', label: '物料', mono: true },
                { key: 'drawingNo', label: '图号' }, { key: 'quantity', label: '订购数量' },
                { key: 'receivedQty', label: '已收数量' }, { key: 'unitPrice', label: '单价（元）' },
                { key: 'amount', label: '已收金额（元）' }, { key: 'delivery', label: '交期' },
              ]} rows={(Array.isArray(detailsQuery.data?.['rows']) ? detailsQuery.data['rows'] : []).map((row: Record<string, unknown>) => ({
                ...row, unitPrice: typeof row['unitPriceMinor'] === 'number' ? (row['unitPriceMinor'] / 100).toFixed(2) : '未定价',
                amount: typeof row['amountMinor'] === 'number' ? (row['amountMinor'] / 100).toFixed(2) : '—',
                delivery: formatLocalDateTime(row['promisedAt']),
              }))} />
              <p className="text-sm">已收金额合计：{((Number(detailsQuery.data?.['totalAmountMinor']) || 0) / 100).toFixed(2)} 元</p>
            </>
          </QueryState>
          {loadedWorkOrderId !== null && (
            <QueryState isPending={exportQuery.isPending} error={exportQuery.error} isEmpty={false}>
              <details><summary className="cursor-pointer text-sm">查看导出数据（技术明细）</summary><RowDetail row={exportQuery.data ?? {}} title="导出载荷" /></details>
            </QueryState>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>逾期未交明细</CardTitle>
          <CardDescription>交期口径锚点 = 订单 promisedAt；扫描命令追加逾期事实（催货触发面）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={overdueQuery.isPending}
            error={overdueQuery.error}
            isEmpty={overdueQuery.data !== undefined && overdueQuery.data.length === 0}
            empty="当前无逾期未交明细"
          >
            <ModuleTable
              columns={[
                { key: 'purchaseOrderId', label: '采购订单', mono: true },
                { key: 'lineNo', label: '行号' },
                { key: 'itemId', label: '物料', mono: true },
                { key: 'promisedAt', label: '交期' },
                { key: 'daysOverdue', label: '逾期天数' },
              ]}
              rows={overdueQuery.data ?? []}
            />
          </QueryState>
          <div>
            <Button variant="outline" size="sm" disabled={scanMutation.isPending} onClick={() => scanMutation.mutate()}>
              执行逾期扫描
            </Button>
          </div>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        </CardContent>
      </Card>
    </div>
  );
}
