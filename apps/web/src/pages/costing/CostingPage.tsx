/**
 * 成本口径页（S2 批次）：口径版本链列表 + 口径发布（工种时薪表）+ 工作令成本
 * 查询（三分类汇总/构成明细/快照回看/版本对比）+ 重算/导出命令。
 * costing 模块全域页面（不在 61 项覆盖矩阵内，属九模块补全）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  compareCostingModels,
  exportCosting,
  getWorkOrderCostDetails,
  getWorkOrderCostSnapshots,
  getWorkOrderCostSummary,
  listCostingEvents,
  listCostingModels,
  publishCostingModel,
  rebuildCosting,
} from '../../data/costingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const TRADES = ['machining', 'assembly', 'electrical', 'aftercare', 'misc'] as const;

export function CostingPage() {
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({ queryKey: ['costing', 'models'], queryFn: () => listCostingModels() });
  const eventsQuery = useQuery({ queryKey: ['costing', 'events'], queryFn: listCostingEvents });

  // ---- 口径发布表单 ----
  const [code, setCode] = useState('standard');
  const [trade, setTrade] = useState<(typeof TRADES)[number]>('machining');
  const [rateMinor, setRateMinor] = useState('6000');
  const [name, setName] = useState('');
  const [publishOutcome, setPublishOutcome] = useState<CommandOutcomeView | null>(null);

  const publishMutation = useMutation({
    mutationFn: () =>
      publishCostingModel({
        code: code.trim(),
        hourlyRates: { [trade]: Number(rateMinor) },
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      }),
    onSuccess: (result) => {
      setPublishOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['costing'] });
    },
    onError: (error) =>
      setPublishOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  // ---- 工作令成本查询 ----
  const [workOrderId, setWorkOrderId] = useState('');
  const [loadedWorkOrderId, setLoadedWorkOrderId] = useState<string | null>(null);
  const [compareA, setCompareA] = useState('1');
  const [compareB, setCompareB] = useState('2');
  const [cmdOutcome, setCmdOutcome] = useState<CommandOutcomeView | null>(null);

  const summaryQuery = useQuery({
    queryKey: ['costing', 'wo-summary', loadedWorkOrderId],
    queryFn: () => getWorkOrderCostSummary(loadedWorkOrderId as string),
    enabled: loadedWorkOrderId !== null,
  });
  const detailsQuery = useQuery({
    queryKey: ['costing', 'wo-details', loadedWorkOrderId],
    queryFn: () => getWorkOrderCostDetails(loadedWorkOrderId as string),
    enabled: loadedWorkOrderId !== null,
  });
  const snapshotsQuery = useQuery({
    queryKey: ['costing', 'wo-snapshots', loadedWorkOrderId],
    queryFn: () => getWorkOrderCostSnapshots(loadedWorkOrderId as string),
    enabled: loadedWorkOrderId !== null,
  });
  const compareQuery = useQuery({
    queryKey: ['costing', 'compare', loadedWorkOrderId, code, compareA, compareB],
    queryFn: () =>
      compareCostingModels({
        workOrderId: loadedWorkOrderId as string,
        code: code.trim(),
        a: Number(compareA),
        b: Number(compareB),
      }),
    enabled:
      loadedWorkOrderId !== null &&
      Number(compareA) >= 1 &&
      Number(compareB) >= 1 &&
      Number(compareA) !== Number(compareB),
  });

  const cmdMutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setCmdOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['costing'] });
    },
    onError: (error) =>
      setOutcomeFromError(setCmdOutcome, error),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>口径版本链</CardTitle>
          <CardDescription>同码升版（'standard' 为缺省口径码）；金额可见性为敏感权限（casbin 策略层）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <QueryState
            isPending={modelsQuery.isPending}
            error={modelsQuery.error}
            isEmpty={modelsQuery.data !== undefined && modelsQuery.data.length === 0}
            empty="暂无口径版本（先发布一口径）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: '口径码', mono: true },
                { key: 'version', label: '版本' },
                { key: 'name', label: '名称' },
                { key: 'status', label: '状态', mono: true },
                { key: 'createdAt', label: '发布时刻' },
              ]}
              rows={modelsQuery.data ?? []}
            />
          </QueryState>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-code">口径码</Label>
              <Input id="cost-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-name">名称（可选）</Label>
              <Input id="cost-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-trade">时薪工种</Label>
              <Select id="cost-trade" value={trade} onChange={(e) => setTrade(e.target.value as typeof trade)}>
                {TRADES.map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-rate">时薪（分/小时）</Label>
              <Input id="cost-rate" type="number" min="1" step="1" value={rateMinor} onChange={(e) => setRateMinor(e.target.value)} />
            </div>
            <Button
              disabled={publishMutation.isPending || code.trim().length === 0 || Number(rateMinor) <= 0}
              onClick={() => publishMutation.mutate()}
            >
              发布口径
            </Button>
          </div>
          {publishOutcome !== null && <CommandOutcomeHint outcome={publishOutcome} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>工作令成本</CardTitle>
          <CardDescription>三分类汇总（材料/外协/工时）+ 构成明细 + 快照回看 + 同码两版本对比。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] lg:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-wo">工作令 id</Label>
              <Input id="cost-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-compare-a">对比版本 a</Label>
              <Input id="cost-compare-a" type="number" min="1" step="1" value={compareA} onChange={(e) => setCompareA(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-compare-b">对比版本 b</Label>
              <Input id="cost-compare-b" type="number" min="1" step="1" value={compareB} onChange={(e) => setCompareB(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cost-model-code">口径码（重算/导出用）</Label>
              <Input id="cost-model-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={workOrderId.trim().length === 0}
              onClick={() => setLoadedWorkOrderId(workOrderId.trim())}
            >
              查询成本
            </Button>
            <Button
              variant="outline"
              disabled={cmdMutation.isPending || workOrderId.trim().length === 0}
              onClick={() => cmdMutation.mutate(() => rebuildCosting({ workOrderId: workOrderId.trim(), modelCode: code }))}
            >
              重算
            </Button>
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={cmdMutation.isPending || workOrderId.trim().length === 0}
              onClick={() => cmdMutation.mutate(() => exportCosting({ workOrderId: workOrderId.trim(), modelCode: code }))}
            >
              导出快照（ExcelPort）
            </Button>
          </div>
          {cmdOutcome !== null && <CommandOutcomeHint outcome={cmdOutcome} />}

          {loadedWorkOrderId !== null && (
            <>
              <QueryState isPending={summaryQuery.isPending} error={summaryQuery.error} isEmpty={false}>
                <RowDetail row={summaryQuery.data ?? {}} title="三分类汇总" />
              </QueryState>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">构成明细</p>
                <QueryState
                  isPending={detailsQuery.isPending}
                  error={detailsQuery.error}
                  isEmpty={detailsQuery.data !== undefined && detailsQuery.data.length === 0}
                  empty="暂无构成明细（先重算生成快照）"
                >
                  <ModuleTable
                    columns={[
                      { key: 'category', label: '分类', mono: true },
                      { key: 'source', label: '来源', mono: true },
                      { key: 'amountMinor', label: '金额（分）' },
                      { key: 'qty', label: '数量' },
                    ]}
                    rows={detailsQuery.data ?? []}
                  />
                </QueryState>
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">快照版本回看</p>
                <QueryState
                  isPending={snapshotsQuery.isPending}
                  error={snapshotsQuery.error}
                  isEmpty={snapshotsQuery.data !== undefined && snapshotsQuery.data.length === 0}
                  empty="暂无快照"
                >
                  <ModuleTable
                    columns={[
                      { key: 'modelCode', label: '口径码', mono: true },
                      { key: 'modelVersion', label: '口径版本' },
                      { key: 'totalMinor', label: '总额（分）' },
                      { key: 'createdAt', label: '生成时刻' },
                    ]}
                    rows={snapshotsQuery.data ?? []}
                  />
                </QueryState>
              </div>
              <QueryState isPending={compareQuery.isPending} error={compareQuery.error} isEmpty={false}>
                <RowDetail row={compareQuery.data ?? {}} title="口径版本对比（a vs b）" />
              </QueryState>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>口径事件审计</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={eventsQuery.isPending}
            error={eventsQuery.error}
            isEmpty={eventsQuery.data !== undefined && eventsQuery.data.length === 0}
            empty="暂无口径事件"
          >
            <ModuleTable
              columns={[
                { key: 'id', label: 'id', mono: true },
                { key: 'kind', label: '事件', mono: true },
                { key: 'createdAt', label: '时刻' },
              ]}
              rows={eventsQuery.data ?? []}
            />
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}

function setOutcomeFromError(
  setter: (outcome: CommandOutcomeView | null) => void,
  error: unknown,
): void {
  setter({
    committed: false,
    status: 'error',
    reason: error instanceof Error ? error.message : String(error),
  });
}
