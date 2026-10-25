/**
 * 出入库操作页（S2 批次）：三类入库（质检放行/采购收货/完工入库）+ 出库 +
 * 调拨/移库三组命令表单。覆盖矩阵 #77-80（三源入库 + 标准配件出库）、
 * #82 调拨和移库。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { issueStock, receiveStock, transferStock } from '../../data/inventoryApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function StockOperationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <ReceiveCard />
      <IssueCard />
      <TransferCard />
    </div>
  );
}

function ReceiveCard() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'inspection' | 'purchase' | 'production'>('production');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [inspectionId, setInspectionId] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      receiveStock({
        kind,
        itemId: itemId.trim(),
        warehouseId: warehouseId.trim(),
        quantity: Number(quantity),
        ...(kind === 'inspection' && inspectionId.trim().length > 0 ? { inspectionId: inspectionId.trim() } : {}),
        ...(kind === 'purchase' && receiptKey.trim().length > 0 ? { receiptKey: receiptKey.trim() } : {}),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['inventory'] });
        setQuantity('1');
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
        <CardTitle>入库</CardTitle>
        <CardDescription>
          三源入库：inspection=质检放行（须带质检单）；purchase=采购收货（须带 receiptKey 幂等键）；production=完工入库。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-kind">入库来源</Label>
            <Select id="recv-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="production">完工入库</option>
              <option value="inspection">质检放行</option>
              <option value="purchase">采购收货</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-item">物料 id</Label>
            <Input id="recv-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-wh">仓库 id</Label>
            <Input id="recv-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-qty">数量</Label>
            <Input id="recv-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          {kind === 'inspection' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="recv-inspection">质检单 id（inspection 必填）</Label>
              <Input id="recv-inspection" value={inspectionId} onChange={(e) => setInspectionId(e.target.value)} required />
            </div>
          )}
          {kind === 'purchase' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="recv-receipt-key">收货幂等键 receiptKey（purchase 必填）</Label>
              <Input id="recv-receipt-key" value={receiptKey} onChange={(e) => setReceiptKey(e.target.value)} required />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-wo">工作令（可选）</Label>
            <Input id="recv-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                itemId.trim().length === 0 ||
                warehouseId.trim().length === 0 ||
                Number(quantity) <= 0 ||
                (kind === 'inspection' && inspectionId.trim().length === 0) ||
                (kind === 'purchase' && receiptKey.trim().length === 0)
              }
            >
              执行入库
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function IssueCard() {
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [purpose, setPurpose] = useState<'production' | 'parts' | 'manual'>('production');
  const [workOrderId, setWorkOrderId] = useState('');
  const [reservationKey, setReservationKey] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      issueStock({
        itemId: itemId.trim(),
        warehouseId: warehouseId.trim(),
        quantity: Number(quantity),
        purpose,
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(reservationKey.trim().length > 0 ? { reservationKey: reservationKey.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['inventory'] });
        setQuantity('1');
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
        <CardTitle>出库</CardTitle>
        <CardDescription>
          直扣可用量或预占核销（reservationKey）；配件发货经配件申请「发货」联动走同命令。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-item">物料 id</Label>
            <Input id="issue-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-wh">仓库 id</Label>
            <Input id="issue-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-qty">数量</Label>
            <Input id="issue-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-purpose">出库目的</Label>
            <Select id="issue-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
              <option value="production">生产</option>
              <option value="parts">配件</option>
              <option value="manual">手工</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-wo">工作令（可选）</Label>
            <Input id="issue-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-reservation">预占键（可选=直扣）</Label>
            <Input id="issue-reservation" value={reservationKey} onChange={(e) => setReservationKey(e.target.value)} />
          </div>
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={mutation.isPending || itemId.trim().length === 0 || warehouseId.trim().length === 0 || Number(quantity) <= 0}
            >
              执行出库
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TransferCard() {
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState('');
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      transferStock({
        itemId: itemId.trim(),
        fromWarehouseId: fromWarehouseId.trim(),
        toWarehouseId: toWarehouseId.trim(),
        quantity: Number(quantity),
        ...(fromLocationId.trim().length > 0 ? { fromLocationId: fromLocationId.trim() } : {}),
        ...(toLocationId.trim().length > 0 ? { toLocationId: toLocationId.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inventory'] });
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
        <CardTitle>调拨 / 移库</CardTitle>
        <CardDescription>跨仓调拨（两仓不同）或仓内移库（同仓两库位不同）。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-item">物料 id</Label>
            <Input id="tr-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-qty">数量</Label>
            <Input id="tr-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-from-wh">源仓库</Label>
            <Input id="tr-from-wh" value={fromWarehouseId} onChange={(e) => setFromWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-to-wh">目的仓库</Label>
            <Input id="tr-to-wh" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-from-loc">源库位（可选）</Label>
            <Input id="tr-from-loc" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-to-loc">目的库位（可选）</Label>
            <Input id="tr-to-loc" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} />
          </div>
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                itemId.trim().length === 0 ||
                fromWarehouseId.trim().length === 0 ||
                toWarehouseId.trim().length === 0 ||
                Number(quantity) <= 0
              }
            >
              执行调拨
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
