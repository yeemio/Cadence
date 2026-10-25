/**
 * 移动入库页（S3 移动呈现，stock:receive；覆盖矩阵 §3.2 128-130 三类入库）：
 * POST /inventory/stock/receipts（stock.receive.v1）三类来源 kind——质检放行
 * （须带质检单 id）/ 采购收货（须带收货幂等键 receiptKey）/ 完工入库。
 * 权限码与后端 inventory.controllers.ts:104-108 同码。
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PackagePlus } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { receiveStock } from '@/data/inventoryApi';
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
import { RECEIPT_KIND_LABELS } from './labels';

type ReceiptKind = 'inspection' | 'purchase' | 'production';

const KIND_OPTIONS: ReadonlyArray<{ readonly value: ReceiptKind; readonly title: string }> = [
  { value: 'inspection', title: '质检放行' },
  { value: 'purchase', title: '采购收货' },
  { value: 'production', title: '完工' },
];

interface ReceiptFormState {
  readonly kind: ReceiptKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: string;
  readonly locationId: string;
  readonly inspectionId: string;
  readonly receiptKey: string;
  readonly purchaseOrderId: string;
  readonly workOrderId: string;
  readonly remark: string;
}

const EMPTY_FORM: ReceiptFormState = {
  kind: 'inspection',
  itemId: '',
  warehouseId: '',
  quantity: '1',
  locationId: '',
  inspectionId: '',
  receiptKey: '',
  purchaseOrderId: '',
  workOrderId: '',
  remark: '',
};

export function MobileReceiptPage() {
  const [form, setForm] = useState<ReceiptFormState>(EMPTY_FORM);
  const [invalid, setInvalid] = useState<string | null>(null);

  const receiveMutation = useMutation({
    mutationFn: (input: Omit<ReceiptFormState, 'quantity'> & { readonly quantity: number }) =>
      receiveStock({
        kind: input.kind,
        itemId: input.itemId.trim(),
        warehouseId: input.warehouseId.trim(),
        quantity: input.quantity,
        locationId: input.locationId.trim().length > 0 ? input.locationId.trim() : undefined,
        inspectionId: input.inspectionId.trim().length > 0 ? input.inspectionId.trim() : undefined,
        purchaseOrderId:
          input.purchaseOrderId.trim().length > 0 ? input.purchaseOrderId.trim() : undefined,
        workOrderId: input.workOrderId.trim().length > 0 ? input.workOrderId.trim() : undefined,
        receiptKey: input.receiptKey.trim().length > 0 ? input.receiptKey.trim() : undefined,
        remark: input.remark.trim().length > 0 ? input.remark.trim() : undefined,
      }),
  });

  function handleSubmit(): void {
    if (receiveMutation.isPending) return;
    if (form.itemId.trim().length === 0 || form.warehouseId.trim().length === 0) {
      setInvalid('物料 id 与仓库 id 必填');
      return;
    }
    const quantity = Number(form.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setInvalid('数量须为正数');
      return;
    }
    // 后端校验口径前置（S2 receiveStock 注释：inspection 须带质检单、purchase 须带幂等键）。
    if (form.kind === 'inspection' && form.inspectionId.trim().length === 0) {
      setInvalid('质检放行入库须带质检单 id');
      return;
    }
    if (form.kind === 'purchase' && form.receiptKey.trim().length === 0) {
      setInvalid('采购收货入库须带收货幂等键 receiptKey');
      return;
    }
    setInvalid(null);
    receiveMutation.mutate({
      kind: form.kind,
      itemId: form.itemId,
      warehouseId: form.warehouseId,
      quantity,
      locationId: form.locationId,
      inspectionId: form.inspectionId,
      receiptKey: form.receiptKey,
      purchaseOrderId: form.purchaseOrderId,
      workOrderId: form.workOrderId,
      remark: form.remark,
    });
  }

  const committed = receiveMutation.data?.committed === true;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>入库</CardTitle>
          <CardDescription>三类入库来源：质检放行（带质检单）/ 采购收货（带幂等键）/ 完工。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'h-9 rounded-lg border px-2.5 text-xs transition-colors',
                  form.kind === option.value
                    ? 'border-primary/50 bg-primary/5 font-medium text-primary'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setForm((prev) => ({ ...prev, kind: option.value }))}
              >
                {option.title}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            当前来源：{RECEIPT_KIND_LABELS[form.kind]}
          </p>

          <label className="flex flex-col gap-1 text-sm">
            物料 id
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.itemId}
              placeholder="itm-…（手填）"
              onChange={(event) => setForm((prev) => ({ ...prev, itemId: event.target.value }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              仓库 id
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.warehouseId}
                placeholder="wh-…"
                onChange={(event) => setForm((prev) => ({ ...prev, warehouseId: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              库位 id（可选）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.locationId}
                placeholder="loc-…"
                onChange={(event) => setForm((prev) => ({ ...prev, locationId: event.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            数量
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              type="number"
              min="0.01"
              step="any"
              inputMode="decimal"
              value={form.quantity}
              onChange={(event) => setForm((prev) => ({ ...prev, quantity: event.target.value }))}
            />
          </label>

          {form.kind === 'inspection' && (
            <label className="flex flex-col gap-1 text-sm">
              质检单 id（必填——放行事实）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.inspectionId}
                placeholder="ins-…"
                onChange={(event) => setForm((prev) => ({ ...prev, inspectionId: event.target.value }))}
              />
            </label>
          )}
          {form.kind === 'purchase' && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                收货幂等键（必填——防重复收货）
                <input
                  className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                  value={form.receiptKey}
                  placeholder="如 PO-0001-L1"
                  onChange={(event) => setForm((prev) => ({ ...prev, receiptKey: event.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                采购单 id（可选）
                <input
                  className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                  value={form.purchaseOrderId}
                  placeholder="po-…"
                  onChange={(event) => setForm((prev) => ({ ...prev, purchaseOrderId: event.target.value }))}
                />
              </label>
            </>
          )}
          {form.kind === 'production' && (
            <label className="flex flex-col gap-1 text-sm">
              工作令 id（可选——完工归集）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.workOrderId}
                placeholder="wo-…"
                onChange={(event) => setForm((prev) => ({ ...prev, workOrderId: event.target.value }))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            备注
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.remark}
              placeholder="可选"
              onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
            />
          </label>

          <Button className="h-12" disabled={receiveMutation.isPending} onClick={handleSubmit}>
            {receiveMutation.isPending ? '提交中…' : (
              <>
                <PackagePlus />
                提交入库
              </>
            )}
          </Button>

          {receiveMutation.isError && <ApiErrorHint error={receiveMutation.error} />}
          {invalid !== null && <p className="text-xs text-destructive">{invalid}</p>}
          <OpsOutcome outcome={receiveMutation.data ?? null} />
          {committed && (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              onClick={() => {
                setForm(EMPTY_FORM);
                receiveMutation.reset();
              }}
            >
              再录一单
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
