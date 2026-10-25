/**
 * 缺口核查页（S2 批次）：按工作令执行 gap.check（清单×库存可用量，不可变快照）
 * + 读回最新快照。覆盖矩阵 #73-76（加工非标件/外购非标件/标准件/电气件核查）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLatestGapCheck, runGapCheck } from '../../data/listingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function GapChecksPage() {
  const queryClient = useQueryClient();
  const [workOrderId, setWorkOrderId] = useState('');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const latestQuery = useQuery({
    queryKey: ['listing', 'gap-check', loadedId],
    queryFn: () => getLatestGapCheck(loadedId as string),
    enabled: loadedId !== null,
  });

  const runMutation = useMutation({
    mutationFn: () => runGapCheck(workOrderId.trim()),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        setLoadedId(workOrderId.trim());
        queryClient.invalidateQueries({ queryKey: ['listing', 'gap-check'] });
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workOrderId.trim().length === 0) return;
    setLoadedId(workOrderId.trim());
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>缺口核查</CardTitle>
          <CardDescription>
            快照不可变（每次核查追加新事实）：四类清单 × 库存可用量；结果可一键发起采购申请。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="gap-wo">工作令 id</Label>
              <Input
                id="gap-wo"
                value={workOrderId}
                onChange={(e) => setWorkOrderId(e.target.value)}
                placeholder="粘贴工作令 id"
                required
              />
            </div>
            <Button type="submit" variant="outline">读最新快照</Button>
            <Button
              type="button"
              disabled={runMutation.isPending || workOrderId.trim().length === 0}
              onClick={() => runMutation.mutate()}
            >
              执行缺口核查
            </Button>
          </form>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {runMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              核查失败：{runMutation.error instanceof Error ? runMutation.error.message : String(runMutation.error)}
            </p>
          )}
        </CardContent>
      </Card>

      {loadedId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>最新核查快照</CardTitle>
            <CardDescription>GET /listing/work-orders/:id/gap-checks/latest（无核查记录时返回空）。</CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState isPending={latestQuery.isPending} error={latestQuery.error} isEmpty={false}>
              <RowDetail row={latestQuery.data ?? {}} />
            </QueryState>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
