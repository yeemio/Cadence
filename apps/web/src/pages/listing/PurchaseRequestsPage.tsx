/**
 * 采购申请页（S2 批次）：三类申请（非标件/标准配件/设备）列表 + 手工发起表单。
 * 覆盖矩阵 #54-56。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPurchaseRequest, listPurchaseRequests } from '../../data/listingApi';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const REQUEST_KINDS = [
  { value: 'nonstandard', label: '非标件' },
  { value: 'standard', label: '标准配件' },
  { value: 'equipment', label: '设备' },
] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类别', mono: true },
  { key: 'itemId', label: '物料', mono: true },
  { key: 'quantity', label: '数量' },
  { key: 'state', label: '状态', mono: true },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function PurchaseRequestsPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');

  const requestsQuery = useQuery({
    queryKey: ['purchase', 'requests', stateFilter, workOrderIdFilter],
    queryFn: () =>
      listPurchaseRequests({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
      }),
  });

  const [kind, setKind] = useState<'nonstandard' | 'standard' | 'equipment'>('nonstandard');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [workOrderId, setWorkOrderId] = useState('');
  const [remark, setRemark] = useState('');

  const createMutation = useMutation({
    mutationFn: createPurchaseRequest,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchase', 'requests'] }),
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      {
        kind,
        itemId: itemId.trim(),
        quantity: Number(quantity),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      },
      {
        onSuccess: () => {
          setItemId('');
          setQuantity('1');
          setWorkOrderId('');
          setRemark('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>采购申请列表</CardTitle>
          <CardDescription>缺口一键发起与手工发起共用此台账（state: draft/approved/converted）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-state-filter">状态过滤</Label>
              <Select id="pr-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                <option value="draft">draft</option>
                <option value="approved">approved</option>
                <option value="converted">converted</option>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-wo-filter">工作令过滤（可选）</Label>
              <Input id="pr-wo-filter" value={workOrderIdFilter} onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={requestsQuery.isPending}
            error={requestsQuery.error}
            isEmpty={requestsQuery.data !== undefined && requestsQuery.data.length === 0}
            empty="当前过滤条件下无采购申请"
          >
            <ModuleTable columns={LIST_COLUMNS} rows={requestsQuery.data ?? []} />
          </QueryState>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>手工发起采购申请</CardTitle>
          <CardDescription>purchase.request.create.v1（source=manual；缺口一键发起走核查页联动）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-kind">申请类别</Label>
              <Select id="pr-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {REQUEST_KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-item">物料 id</Label>
              <Input id="pr-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-qty">数量</Label>
              <Input id="pr-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-wo">工作令（可选）</Label>
              <Input id="pr-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="pr-remark">备注（可选）</Label>
              <Input id="pr-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                发起失败：{createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error)}
              </p>
            )}
            {createMutation.data !== undefined && (
              <div className="sm:col-span-2"><CommandOutcomeHint outcome={createMutation.data} /></div>
            )}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={createMutation.isPending || itemId.trim().length === 0 || Number(quantity) <= 0}
              >
                提交采购申请
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
