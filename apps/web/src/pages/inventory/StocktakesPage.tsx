/**
 * 库存盘点页（S2 批次）：盘点台账（状态过滤）+ 开单 + 行选中实盘录入（单行 ×
 * complete 开关）+ 审核调账。覆盖矩阵 #83 库存盘点。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveStocktake, getStocktakeDetail, listStocktakes, openStocktake, recordStocktake } from '../../data/inventoryApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const STOCKTAKE_STATES = ['draft', 'counting', 'reconciled', 'adjusted'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'warehouseId', label: '仓库', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function StocktakesPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['inventory', 'stocktakes', stateFilter],
    queryFn: () => listStocktakes(stateFilter === '' ? undefined : stateFilter),
  });
  const selectedRow = listQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;
  const detailQuery = useQuery({
    queryKey: ['inventory', 'stocktake', selectedId],
    queryFn: () => getStocktakeDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  const [warehouseId, setWarehouseId] = useState('');
  const [countItemId, setCountItemId] = useState('');
  const [countedQty, setCountedQty] = useState('0');
  const [complete, setComplete] = useState(false);
  const [adjustRemark, setAdjustRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] });
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>盘点台账</CardTitle>
          <CardDescription>draft→counting→reconciled→adjusted；账面=实盘调账留痕。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="st-state-filter">状态过滤</Label>
            <Select id="st-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">全部状态</option>
              {STOCKTAKE_STATES.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无盘点单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-new-wh">开单仓库 id（盘点范围=该仓全部有账物料）</Label>
              <Input id="st-new-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={mutation.isPending || warehouseId.trim().length === 0}
              onClick={() => mutation.mutate(() => openStocktake({ warehouseId: warehouseId.trim() }))}
            >
              开盘点单
            </Button>
          </div>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <Card>
          <CardHeader>
            <CardTitle>盘点单详情与录入</CardTitle>
            <CardDescription>实盘录入（移动端同径 record 命令）；complete=true 提交差异进 reconciled。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <RowDetail row={detailQuery.data ?? {}} />
            </QueryState>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor="st-record-item">实盘物料 id</Label>
                <Input id="st-record-item" value={countItemId} onChange={(e) => setCountItemId(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="st-record-qty">实盘数量（可 0）</Label>
                <Input id="st-record-qty" type="number" min="0" step="any" value={countedQty} onChange={(e) => setCountedQty(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="st-record-complete">本轮录完提交差异</Label>
                <Select id="st-record-complete" value={complete ? 'yes' : 'no'} onChange={(e) => setComplete(e.target.value === 'yes')}>
                  <option value="no">继续录（false）</option>
                  <option value="yes">提交差异（true）</option>
                </Select>
              </div>
              <Button
                variant="outline"
                disabled={mutation.isPending || countItemId.trim().length === 0}
                onClick={() =>
                  mutation.mutate(() =>
                    recordStocktake(String(selectedRow['id']), selectedRow, {
                      lines: [{ itemId: countItemId.trim(), countedQty: Number(countedQty) }],
                      complete,
                    }),
                  )
                }
              >
                录入实盘
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor="st-approve-remark">审核调账理由（必填）</Label>
                <Input id="st-approve-remark" value={adjustRemark} onChange={(e) => setAdjustRemark(e.target.value)} />
              </div>
              <Button
                disabled={mutation.isPending || adjustRemark.trim().length === 0}
                onClick={() =>
                  mutation.mutate(() => approveStocktake(String(selectedRow['id']), selectedRow, adjustRemark.trim()))
                }
              >
                审核调账
              </Button>
            </div>
            {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
