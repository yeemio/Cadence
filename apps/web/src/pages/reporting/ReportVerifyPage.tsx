/**
 * 报工核查页（S2 批次）：待核查队列（pending-verification 端点）+ 行选中核查/
 * 撤销操作。覆盖矩阵 #49-53（五类报工核查）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listPendingVerification, revokeReport, verifyReport } from '../../data/reportingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const QUEUE_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类别', mono: true },
  { key: 'dispatchId', label: '派工单', mono: true },
  { key: 'doneQty', label: '完工数量' },
  { key: 'laborMinutes', label: '工时（分钟）' },
  { key: 'reporter', label: '申报人', mono: true },
  { key: 'businessTime', label: '业务时间' },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function ReportVerifyPage() {
  const queryClient = useQueryClient();
  const queueQuery = useQuery({ queryKey: ['reports', 'pending-verification'], queryFn: listPendingVerification });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const selectedRow = queueQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        setSelectedId(null);
        queryClient.invalidateQueries({ queryKey: ['reports'] });
      }
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
        <CardTitle>待核查队列</CardTitle>
        <CardDescription>
          GET /reports/pending-verification；核查通过即计入工时账（hours 消费合同）；点行选中后操作。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState
          isPending={queueQuery.isPending}
          error={queueQuery.error}
          isEmpty={queueQuery.data !== undefined && queueQuery.data.length === 0}
          empty="当前无待核查报工单"
        >
          <ModuleTable
            columns={QUEUE_COLUMNS}
            rows={queueQuery.data ?? []}
            selectedId={selectedId}
            onSelect={(row) => setSelectedId(String(row['id']))}
          />
        </QueryState>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="verify-remark">核查备注（可选；撤销时作原因）</Label>
            <Input id="verify-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <Button
            disabled={mutation.isPending || selectedRow === null}
            onClick={() =>
              selectedRow !== null &&
              mutation.mutate(() =>
                verifyReport(String(selectedRow['id']), selectedRow, remark.trim().length > 0 ? remark.trim() : undefined),
              )
            }
          >
            核查通过
          </Button>
          <Button
            variant="outline"
            disabled={mutation.isPending || selectedRow === null}
            onClick={() =>
              selectedRow !== null &&
              mutation.mutate(() =>
                revokeReport(String(selectedRow['id']), selectedRow, remark.trim().length > 0 ? remark.trim() : undefined),
              )
            }
          >
            撤销冲销
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}
