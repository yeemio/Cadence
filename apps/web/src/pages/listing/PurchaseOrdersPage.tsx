/**
 * 采购订单页（S2 批次）：五态订单列表（状态/工作令过滤）+ 建单提交表单 + 选中
 * 订单全流程视图 + 审批/下发/收货操作。覆盖矩阵 #59 采购订单、#60 采购收货。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approvePurchaseOrder,
  getPurchaseOrderDetail,
  issuePurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from '../../data/listingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const ORDER_STATES = ['draft', 'submitted', 'approved', 'issued', 'received'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'supplierName', label: '供应商' },
  { key: 'state', label: '状态', mono: true },
  { key: 'promisedAt', label: '交期' },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function PurchaseOrdersPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ordersQuery = useQuery({
    queryKey: ['purchase', 'orders', stateFilter, workOrderIdFilter],
    queryFn: () =>
      listPurchaseOrders({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
      }),
  });

  const selectedRow = ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>采购订单列表</CardTitle>
          <CardDescription>五态全链（draft→submitted→approved→issued→received）；点行选中后操作。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="po-state-filter">状态过滤</Label>
              <Select id="po-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {ORDER_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="po-wo-filter">工作令过滤（可选）</Label>
              <Input id="po-wo-filter" value={workOrderIdFilter} onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty="当前过滤条件下无采购订单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={ordersQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <OrderDetailCard
          row={selectedRow}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['purchase'] })}
        />
      )}

      <SubmitOrderCard onChanged={() => queryClient.invalidateQueries({ queryKey: ['purchase'] })} />
    </div>
  );
}

function OrderDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['purchase', 'order-detail', id],
    queryFn: () => getPurchaseOrderDetail(id),
  });
  const [remark, setRemark] = useState('');
  const [lineNo, setLineNo] = useState('1');
  const [receivedQty, setReceivedQty] = useState('1');
  const [receiptRef, setReceiptRef] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) onChanged();
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>订单全流程视图与操作</CardTitle>
        <CardDescription>审批（理由必填）/下发/收货（lineNo×数量，联动库存 receiptKey 幂等入库）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} />
        </QueryState>

        <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1fr] lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-remark">决策理由（审批必填）</Label>
            <Input id="po-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="审批理由" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-lineno">收货行号 lineNo</Label>
            <Input id="po-op-lineno" type="number" min="1" step="1" value={lineNo} onChange={(e) => setLineNo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-qty">收货数量</Label>
            <Input id="po-op-qty" type="number" min="0.000001" step="any" value={receivedQty} onChange={(e) => setReceivedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-receipt">收货单号（可选）</Label>
            <Input id="po-op-receipt" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => approvePurchaseOrder(id, row, remark.trim() || '同意'))}
          >
            审批通过
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(() => issuePurchaseOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))
            }
          >
            下发订单
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || Number(receivedQty) <= 0}
            onClick={() =>
              mutation.mutate(() =>
                receivePurchaseOrder(id, row, {
                  lines: [{ lineNo: Number(lineNo), receivedQty: Number(receivedQty) }],
                  ...(receiptRef.trim().length > 0 ? { receiptRef: receiptRef.trim() } : {}),
                }),
              )
            }
          >
            收货入库
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

function SubmitOrderCard({ onChanged }: { readonly onChanged: () => void }) {
  const [supplierRef, setSupplierRef] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [promisedAt, setPromisedAt] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPriceMinor, setUnitPriceMinor] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      submitPurchaseOrder({
        promisedAt: promisedAt.trim(),
        lines: [{ itemId: itemId.trim(), quantity: Number(quantity), ...(unitPriceMinor.trim().length > 0 ? { unitPriceMinor: Number(unitPriceMinor) } : {}) }],
        ...(supplierRef.trim().length > 0 ? { supplierRef: supplierRef.trim() } : {}),
        ...(supplierName.trim().length > 0 ? { supplierName: supplierName.trim() } : {}),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        onChanged();
        setSupplierRef('');
        setSupplierName('');
        setPromisedAt('');
        setWorkOrderId('');
        setItemId('');
        setQuantity('1');
        setUnitPriceMinor('');
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>建单并提交采购订单</CardTitle>
        <CardDescription>
          purchase.order.submit.v1：交期必填（逾期事实口径锚点）；单价单位为分（整数，可空=未定价）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-supplier-ref">供应商引用（可选）</Label>
            <Input id="po-new-supplier-ref" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="SUP-01" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-supplier-name">供应商名称（可选）</Label>
            <Input id="po-new-supplier-name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-promised">交期（必填，ISO 8601）</Label>
            <Input id="po-new-promised" value={promisedAt} onChange={(e) => setPromisedAt(e.target.value)} placeholder="2026-12-01" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-wo">工作令（可选）</Label>
            <Input id="po-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-item">行 1 物料 id</Label>
            <Input id="po-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-qty">行 1 数量</Label>
            <Input id="po-new-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-price">行 1 单价（分，整数，可选）</Label>
            <Input id="po-new-price" type="number" min="1" step="1" value={unitPriceMinor} onChange={(e) => setUnitPriceMinor(e.target.value)} />
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              建单失败：{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </p>
          )}
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                promisedAt.trim().length === 0 ||
                itemId.trim().length === 0 ||
                Number(quantity) <= 0
              }
            >
              建单并提交
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
