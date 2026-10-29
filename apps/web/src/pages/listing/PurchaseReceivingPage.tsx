import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listReceivingOrders, receivingWarehouseOptions } from '../../data/listingApi';
import { errorOutcomeOf, postCommand, revisionOf, type CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { ReceiptInspectionHint } from '../../components/ReceiptInspectionHint';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 收货动作权限的专用投影；不拉取完整PO、单价、申请草稿或审批信息。 */
export function PurchaseReceivingPage() {
  const client = useQueryClient();
  const orders = useQuery({ queryKey: ['purchase', 'receiving-orders'], queryFn: listReceivingOrders });
  const warehouses = useQuery({ queryKey: ['purchase', 'receiving-warehouses'], queryFn: receivingWarehouseOptions });
  const [selectedId, setSelectedId] = useState(''); const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [warehouseId, setWarehouseId] = useState('');
  const [receiptRef, setReceiptRef] = useState(''); const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  const order = orders.data?.find((row) => row['id'] === selectedId);
  const lines = Array.isArray(order?.['lines']) ? order['lines'] as Record<string, unknown>[] : [];
  const ready = lines.length > 0 && lines.every((line) => { const value = quantities[String(line['lineNo'])]; return value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number(line['quantity']); });
  const mutation = useMutation({ mutationFn: () => postCommand(`/purchase/orders/${encodeURIComponent(selectedId)}/receipts`, 'purchase.order.receive.v1', {
    lines: lines.map((line) => ({ lineNo: Number(line['lineNo']), receivedQty: Number(quantities[String(line['lineNo'])]) })), receiptRef: receiptRef.trim() || null,
    ...(warehouseId ? { warehouseId } : {}),
  }, revisionOf(order ?? {}, '收货订单')), onSuccess: (result) => { setOutcome(result); if (result.committed) { setSelectedId(''); setQuantities({}); void client.invalidateQueries({ queryKey: ['purchase'] }); void client.invalidateQueries({ queryKey: ['inventory'] }); } }, onError: (error) => setOutcome(errorOutcomeOf(error)) });
  function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); if (order && ready) mutation.mutate(); }
  return <Card><CardHeader><CardTitle>采购收货</CardTitle><CardDescription>只列已下发待收货订单。收货不等于品质判定；明确类别的申请来源才能自动创建来料待检。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
    <QueryState isPending={orders.isPending} error={orders.error} isEmpty={orders.data?.length === 0} empty="暂无已下发待收货订单。">
      <ModuleTable columns={[{ key: 'id', label: '订单号', format: 'shortId' }, { key: 'supplierName', label: '供应商' }, { key: 'workOrderId', label: '工作令', format: 'shortId' }]} rows={orders.data ?? []} selectedId={selectedId} onSelect={(row) => { setSelectedId(String(row['id'])); setQuantities({}); setOutcome(null); }} />
    </QueryState>
    {order && <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <p className="text-sm sm:col-span-2">本单按一次收货定稿处理，请逐行填写本次确认数量；未收的行填0。若需后续多批次收货，请先由采购核对当前订单流程。</p>
      {lines.map((line) => <Label key={String(line['lineNo'])}>行{String(line['lineNo'])} · {String(line['itemId'])}（订购{String(line['quantity'])} / 已收{String(line['receivedQty'])}）<Input aria-label={`行${String(line['lineNo'])}收货数量`} type="number" min="0" max={Number(line['quantity'])} step="any" value={quantities[String(line['lineNo'])] ?? ''} onChange={(e) => setQuantities((old) => ({ ...old, [String(line['lineNo'])]: e.target.value }))} required /></Label>)}
      <Label>收货仓库<Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">使用本租户默认仓</option>{(warehouses.data ?? []).map((row) => <option key={String(row['id'])} value={String(row['id'])}>{String(row['code'])} · {String(row['name'])}</option>)}</Select></Label>
      <Label>收货单号<Input value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} /></Label>
      {warehouses.error && <p role="alert">仓库选项读取失败，请刷新核对后再收货。</p>}
      {lines.some((line) => !line['inspectionKind']) && <p role="note" className="text-sm text-amber-700 sm:col-span-2">部分行未关联唯一类别的采购申请，不会自动创建来料检。请由采购核对来源、品质按实际类别建检。</p>}
      <Button type="submit" disabled={mutation.isPending || !ready || Boolean(warehouses.error)}>确认收货</Button>
    </form>}
    {outcome && <><CommandOutcomeHint outcome={outcome} /><ReceiptInspectionHint outcome={outcome} /></>}
  </CardContent></Card>;
}
