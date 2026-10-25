/**
 * 移动配件申请页（S3 移动呈现，parts:request；覆盖矩阵 §3.2 #117 配件申请）：
 * 售后配件申请表单 → POST /workorder/parts-requests（workorder.parts.request.v1：
 * 建单 + 自动 SUBMIT 落 submitted 待审态）。权限码与后端
 * workorder.controllers.ts:200-206 同码。
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PackageOpen } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { createPartsRequest } from '@/data/workorderApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OpsOutcome } from './OpsOutcome';

interface PartsFormState {
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly remark: string;
}

const EMPTY_FORM: PartsFormState = { workOrderId: '', itemId: '', quantity: '1', remark: '' };

export function MobilePartsPage() {
  const [form, setForm] = useState<PartsFormState>(EMPTY_FORM);
  const [invalid, setInvalid] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: { workOrderId: string; itemId: string; quantity: number; remark: string }) =>
      createPartsRequest({
        workOrderId: input.workOrderId.trim(),
        itemId: input.itemId.trim(),
        quantity: input.quantity,
        remark: input.remark.trim().length > 0 ? input.remark.trim() : undefined,
      }),
  });

  function handleSubmit(): void {
    if (createMutation.isPending) return;
    if (form.workOrderId.trim().length === 0 || form.itemId.trim().length === 0) {
      setInvalid('工作令 id 与物料 id 必填');
      return;
    }
    const quantity = Number(form.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setInvalid('数量须为正数');
      return;
    }
    setInvalid(null);
    createMutation.mutate({
      workOrderId: form.workOrderId,
      itemId: form.itemId,
      quantity,
      remark: form.remark,
    });
  }

  const committed = createMutation.data?.committed === true;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>配件申请</CardTitle>
          <CardDescription>提交后进入待审批队列（审批在配件审批页处理）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            工作令 id
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.workOrderId}
              placeholder="wo-…（手填）"
              onChange={(event) => setForm((prev) => ({ ...prev, workOrderId: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            物料 id
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.itemId}
              placeholder="itm-…（手填）"
              onChange={(event) => setForm((prev) => ({ ...prev, itemId: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            申请数量
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

          <Button className="h-12" disabled={createMutation.isPending} onClick={handleSubmit}>
            {createMutation.isPending ? '提交中…' : (
              <>
                <PackageOpen />
                提交申请
              </>
            )}
          </Button>

          {createMutation.isError && <ApiErrorHint error={createMutation.error} />}
          {invalid !== null && <p className="text-xs text-destructive">{invalid}</p>}
          <OpsOutcome outcome={createMutation.data ?? null} />
          {committed && (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              onClick={() => {
                setForm(EMPTY_FORM);
                createMutation.reset();
              }}
            >
              再填一单
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
