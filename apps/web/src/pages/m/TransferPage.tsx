/**
 * 移动调拨移库页（S3 移动呈现，stock:transfer；覆盖矩阵 §3.2 #132 调拨和移库）：
 * POST /inventory/stock/transfers（stock.transfer.v1）——跨仓调拨与仓内移库
 * 同命令（fromWarehouseId ≠ toWarehouseId = 调拨；相等 + 库位差异 = 移库）。
 * 权限码与后端 inventory.controllers.ts:116-120 同码。
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { transferStock } from '@/data/inventoryApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OpsOutcome } from './OpsOutcome';

interface TransferFormState {
  readonly itemId: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly quantity: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly remark: string;
}

const EMPTY_FORM: TransferFormState = {
  itemId: '',
  fromWarehouseId: '',
  toWarehouseId: '',
  quantity: '1',
  fromLocationId: '',
  toLocationId: '',
  remark: '',
};

export function MobileTransferPage() {
  const [form, setForm] = useState<TransferFormState>(EMPTY_FORM);
  const [invalid, setInvalid] = useState<string | null>(null);

  const transferMutation = useMutation({
    mutationFn: (input: Omit<TransferFormState, 'quantity'> & { readonly quantity: number }) =>
      transferStock({
        itemId: input.itemId.trim(),
        fromWarehouseId: input.fromWarehouseId.trim(),
        toWarehouseId: input.toWarehouseId.trim(),
        quantity: input.quantity,
        fromLocationId: input.fromLocationId.trim().length > 0 ? input.fromLocationId.trim() : undefined,
        toLocationId: input.toLocationId.trim().length > 0 ? input.toLocationId.trim() : undefined,
        remark: input.remark.trim().length > 0 ? input.remark.trim() : undefined,
      }),
  });

  function handleSubmit(): void {
    if (transferMutation.isPending) return;
    if (
      form.itemId.trim().length === 0 ||
      form.fromWarehouseId.trim().length === 0 ||
      form.toWarehouseId.trim().length === 0
    ) {
      setInvalid('物料 id 与两端仓库 id 必填');
      return;
    }
    const quantity = Number(form.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setInvalid('数量须为正数');
      return;
    }
    if (
      form.fromWarehouseId.trim() === form.toWarehouseId.trim() &&
      form.fromLocationId.trim() === form.toLocationId.trim()
    ) {
      setInvalid('仓内移库须两端库位不同');
      return;
    }
    setInvalid(null);
    transferMutation.mutate({
      itemId: form.itemId,
      fromWarehouseId: form.fromWarehouseId,
      toWarehouseId: form.toWarehouseId,
      quantity,
      fromLocationId: form.fromLocationId,
      toLocationId: form.toLocationId,
      remark: form.remark,
    });
  }

  const sameWarehouse = form.fromWarehouseId.trim() === form.toWarehouseId.trim();
  const committed = transferMutation.data?.committed === true;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>调拨和移库</CardTitle>
          <CardDescription>
            跨仓调拨（两端仓库不同）与仓内移库（同仓不同库位）同命令提交。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
              调出仓库
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.fromWarehouseId}
                placeholder="wh-…"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, fromWarehouseId: event.target.value }))
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              调入仓库
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.toWarehouseId}
                placeholder="wh-…"
                onChange={(event) => setForm((prev) => ({ ...prev, toWarehouseId: event.target.value }))}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              调出库位（可选）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.fromLocationId}
                placeholder="loc-…"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, fromLocationId: event.target.value }))
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              调入库位（可选）
              <input
                className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                value={form.toLocationId}
                placeholder="loc-…"
                onChange={(event) => setForm((prev) => ({ ...prev, toLocationId: event.target.value }))}
              />
            </label>
          </div>
          {sameWarehouse && (
            <p className="text-xs text-muted-foreground">
              两端仓库相同——按仓内移库提交，须两端库位不同。
            </p>
          )}
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
          <label className="flex flex-col gap-1 text-sm">
            备注
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.remark}
              placeholder="可选"
              onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
            />
          </label>

          <Button className="h-12" disabled={transferMutation.isPending} onClick={handleSubmit}>
            {transferMutation.isPending ? '提交中…' : (
              <>
                <ArrowLeftRight />
                提交调拨
              </>
            )}
          </Button>

          {transferMutation.isError && <ApiErrorHint error={transferMutation.error} />}
          {invalid !== null && <p className="text-xs text-destructive">{invalid}</p>}
          <OpsOutcome outcome={transferMutation.data ?? null} />
          {committed && (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              onClick={() => {
                setForm(EMPTY_FORM);
                transferMutation.reset();
              }}
            >
              再调一单
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
