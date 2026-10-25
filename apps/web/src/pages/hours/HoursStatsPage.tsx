/**
 * 工时统计页（S2 批次）：机加工时统计（工作令/日期窗过滤）+ 月度汇总/下钻明细/
 * 重算快照 + 月度重算命令。覆盖矩阵 #84 机加工时统计、#85 工时汇总。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMachiningStats,
  fetchMonthDetails,
  fetchMonthLedgers,
  fetchMonthSummary,
  rebuildMonth,
} from '../../data/hoursApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const TRADES = ['machining', 'assembly', 'electrical', 'aftercare', 'misc'] as const;

export function HoursStatsPage() {
  const queryClient = useQueryClient();
  const [workOrderId, setWorkOrderId] = useState('');
  const [appliedWorkOrderId, setAppliedWorkOrderId] = useState<string | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [tradeFilter, setTradeFilter] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const statsQuery = useQuery({
    queryKey: ['hours', 'machining-stats', appliedWorkOrderId],
    queryFn: () =>
      fetchMachiningStats(
        appliedWorkOrderId === null || appliedWorkOrderId.trim().length === 0
          ? {}
          : { workOrderId: appliedWorkOrderId.trim() },
      ),
  });

  const summaryQuery = useQuery({
    queryKey: ['hours', 'month-summary', loadedMonth],
    queryFn: () => fetchMonthSummary(loadedMonth as string),
    enabled: loadedMonth !== null,
  });
  const detailsQuery = useQuery({
    queryKey: ['hours', 'month-details', loadedMonth, tradeFilter],
    queryFn: () =>
      fetchMonthDetails(
        loadedMonth as string,
        tradeFilter === '' ? {} : { trade: tradeFilter },
      ),
    enabled: loadedMonth !== null,
  });
  const ledgersQuery = useQuery({
    queryKey: ['hours', 'month-ledgers', loadedMonth],
    queryFn: () => fetchMonthLedgers(loadedMonth as string),
    enabled: loadedMonth !== null,
  });

  const rebuildMutation = useMutation({
    mutationFn: () => rebuildMonth(month.trim()),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['hours'] });
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>机加工时统计</CardTitle>
          <CardDescription>产出 × 工时按工作令（仅机加工种；hours 消费已审核报工净额）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="hours-stats-wo">工作令过滤（可选）</Label>
              <Input id="hours-stats-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => setAppliedWorkOrderId(workOrderId)}>应用过滤</Button>
          </div>
          <QueryState
            isPending={statsQuery.isPending}
            error={statsQuery.error}
            isEmpty={statsQuery.data !== undefined && statsQuery.data.length === 0}
            empty="暂无机加工时事实"
          >
            <ModuleTable
              columns={[
                { key: 'workOrderId', label: '工作令', mono: true },
                { key: 'outputQty', label: '产出数量' },
                { key: 'laborMinutes', label: '工时（分钟）' },
                { key: 'from', label: '窗口起' },
                { key: 'to', label: '窗口止' },
              ]}
              rows={statsQuery.data ?? []}
            />
          </QueryState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>月度工时（汇总 / 明细 / 重算快照）</CardTitle>
          <CardDescription>汇总=实时净额；重算快照=当前版台账；重算命令幂等（月×工种）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="hours-month">月份（YYYY-MM）</Label>
              <Input id="hours-month" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2026-10" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="hours-trade">明细工种过滤（可选）</Label>
              <Select id="hours-trade" value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)}>
                <option value="">全部工种</option>
                {TRADES.map((trade) => (
                  <option key={trade} value={trade}>{trade}</option>
                ))}
              </Select>
            </div>
            <Button variant="outline" disabled={month.trim().length === 0} onClick={() => setLoadedMonth(month.trim())}>
              查询月度
            </Button>
            <Button
              variant="outline"
              disabled={rebuildMutation.isPending || month.trim().length === 0}
              onClick={() => rebuildMutation.mutate()}
            >
              重算该月
            </Button>
          </div>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}

          {loadedMonth !== null && (
            <>
              <QueryState isPending={summaryQuery.isPending} error={summaryQuery.error} isEmpty={false}>
                <RowDetail row={summaryQuery.data ?? {}} title="月度汇总（实时净额）" />
              </QueryState>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">月度明细（按人×日）</p>
                <QueryState
                  isPending={detailsQuery.isPending}
                  error={detailsQuery.error}
                  isEmpty={detailsQuery.data !== undefined && detailsQuery.data.length === 0}
                  empty="该月暂无工时明细"
                >
                  <ModuleTable
                    columns={[
                      { key: 'workerId', label: '工人', mono: true },
                      { key: 'workDate', label: '工作日' },
                      { key: 'trade', label: '工种', mono: true },
                      { key: 'minutes', label: '分钟' },
                    ]}
                    rows={detailsQuery.data ?? []}
                  />
                </QueryState>
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">重算快照（当前版台账）</p>
                <QueryState
                  isPending={ledgersQuery.isPending}
                  error={ledgersQuery.error}
                  isEmpty={ledgersQuery.data !== undefined && ledgersQuery.data.length === 0}
                  empty="该月暂无重算快照（执行重算后生成）"
                >
                  <ModuleTable
                    columns={[
                      { key: 'workerId', label: '工人', mono: true },
                      { key: 'trade', label: '工种', mono: true },
                      { key: 'minutes', label: '分钟' },
                      { key: 'version', label: '版本' },
                    ]}
                    rows={ledgersQuery.data ?? []}
                  />
                </QueryState>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
