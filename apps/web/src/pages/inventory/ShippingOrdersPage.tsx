/**
 * 发货管理页（S2 批次）：发货任务列表（状态/工作令过滤）+ 建任务执行出库 +
 * 行选中确认发货。覆盖矩阵 #71 发货任务、#72 发货记录。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmShipping, executeShipping, getShippingDetail, listShippingOrders } from '../../data/inventoryApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const SHIPPING_STATES = ['draft', 'executing', 'shipped'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'carrier', label: '承运' },
  { key: 'trackingNo', label: '运单号', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function ShippingOrdersPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['inventory', 'shipping', stateFilter, workOrderIdFilter],
    queryFn: () =>
      listShippingOrders({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
      }),
  });
  const selectedRow = listQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;
  const detailQuery = useQuery({
    queryKey: ['inventory', 'shipping-detail', selectedId],
    queryFn: () => getShippingDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  const [workOrderId, setWorkOrderId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [carrier, setCarrier] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [confirmCarrier, setConfirmCarrier] = useState('');
  const [confirmTrackingNo, setConfirmTrackingNo] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inventory', 'shipping'] });
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>发货任务</CardTitle>
          <CardDescription>三态（draft→executing→shipped）；建任务即执行出库（可用量校验）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-state-filter">状态过滤</Label>
              <Select id="ship-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {SHIPPING_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-wo-filter">工作令过滤（可选）</Label>
              <Input id="ship-wo-filter" value={workOrderIdFilter} onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="当前过滤条件下无发货任务"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <Card>
          <CardHeader>
            <CardTitle>发货任务详情与确认</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <RowDetail row={detailQuery.data ?? {}} />
            </QueryState>
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ship-confirm-carrier">确认承运（可选）</Label>
                <Input id="ship-confirm-carrier" value={confirmCarrier} onChange={(e) => setConfirmCarrier(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ship-confirm-tracking">确认运单号（可选）</Label>
                <Input id="ship-confirm-tracking" value={confirmTrackingNo} onChange={(e) => setConfirmTrackingNo(e.target.value)} />
              </div>
              <Button
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate(() =>
                    confirmShipping(String(selectedRow['id']), selectedRow, {
                      ...(confirmCarrier.trim().length > 0 ? { carrier: confirmCarrier.trim() } : {}),
                      ...(confirmTrackingNo.trim().length > 0 ? { trackingNo: confirmTrackingNo.trim() } : {}),
                    }),
                  )
                }
              >
                确认发货
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>建发货任务并执行</CardTitle>
          <CardDescription>行集起步为单行（多行扩展留后续）；仓库缺省走服务端默认仓配置。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-new-wo">工作令（可选）</Label>
              <Input id="ship-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-new-item">物料 id</Label>
              <Input id="ship-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-new-qty">数量</Label>
              <Input id="ship-new-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-new-carrier">承运（可选）</Label>
              <Input id="ship-new-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ship-new-tracking">运单号（可选）</Label>
              <Input id="ship-new-tracking" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
            </div>
            <Button
              disabled={mutation.isPending || itemId.trim().length === 0 || Number(quantity) <= 0}
              onClick={() =>
                mutation.mutate(() =>
                  executeShipping({
                    lines: [{ itemId: itemId.trim(), quantity: Number(quantity) }],
                    ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
                    ...(carrier.trim().length > 0 ? { carrier: carrier.trim() } : {}),
                    ...(trackingNo.trim().length > 0 ? { trackingNo: trackingNo.trim() } : {}),
                  }),
                )
              }
            >
              执行发货出库
            </Button>
          </div>
          {outcome !== null && <div className="mt-4"><CommandOutcomeHint outcome={outcome} /></div>}
        </CardContent>
      </Card>
    </div>
  );
}
