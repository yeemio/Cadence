/**
 * 移动故障上报页（S3 移动呈现，fault:report；覆盖矩阵 §3.2 #127 故障上报）：
 * 设备故障上报表单 → POST /baseline/fault-reports/commands（baseline.fault.report.v1：
 * equipmentCode/description/assignee——上报即派修，IM 推送联动由后端承担）。
 * 权限码与后端 baseline.controllers.ts:283-296 同码。
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { reportFault } from '@/data/baselineApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OpsOutcome } from './OpsOutcome';

interface FaultFormState {
  readonly equipmentCode: string;
  readonly description: string;
  readonly assignee: string;
}

const EMPTY_FORM: FaultFormState = { equipmentCode: '', description: '', assignee: '' };

export function MobileFaultPage() {
  const [form, setForm] = useState<FaultFormState>(EMPTY_FORM);
  const [invalid, setInvalid] = useState<string | null>(null);

  const reportMutation = useMutation({
    mutationFn: (input: FaultFormState) =>
      reportFault({
        equipmentCode: input.equipmentCode.trim(),
        description: input.description.trim(),
        assignee: input.assignee.trim(),
      }),
  });

  function handleSubmit(): void {
    if (reportMutation.isPending) return;
    if (
      form.equipmentCode.trim().length === 0 ||
      form.description.trim().length === 0 ||
      form.assignee.trim().length === 0
    ) {
      setInvalid('设备业务码、故障描述、维修人员均必填');
      return;
    }
    setInvalid(null);
    reportMutation.mutate(form);
  }

  const committed = reportMutation.data?.committed === true;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>故障上报</CardTitle>
          <CardDescription>上报即派修（后端联动消息推送，指派维修人员）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            设备业务码
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.equipmentCode}
              placeholder="设备 code（手填）"
              onChange={(event) => setForm((prev) => ({ ...prev, equipmentCode: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            故障描述
            <textarea
              className="min-h-24 rounded-lg border border-input bg-background px-3 py-2 text-sm"
              value={form.description}
              placeholder="现象/位置/影响（必填）"
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            维修人员
            <input
              className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={form.assignee}
              placeholder="用户 id（手填）"
              onChange={(event) => setForm((prev) => ({ ...prev, assignee: event.target.value }))}
            />
          </label>

          <Button className="h-12" disabled={reportMutation.isPending} onClick={handleSubmit}>
            {reportMutation.isPending ? '提交中…' : (
              <>
                <TriangleAlert />
                上报故障
              </>
            )}
          </Button>

          {reportMutation.isError && <ApiErrorHint error={reportMutation.error} />}
          {invalid !== null && <p className="text-xs text-destructive">{invalid}</p>}
          <OpsOutcome outcome={reportMutation.data ?? null} />
          {committed && (
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              onClick={() => {
                setForm(EMPTY_FORM);
                reportMutation.reset();
              }}
            >
              再报一单
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
