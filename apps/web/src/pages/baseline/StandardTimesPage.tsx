/**
 * 额定工时页（S2 批次）：双 scope（按工序/按产品图号）对标标准列表 + 定义命令。
 * 覆盖矩阵 #36 额定工时管理（v1.1 已登记无 revise 命令——误录不可修正，如实呈现）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defineStandardTime, listStandardTimes } from '../../data/baselineApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const LIST_COLUMNS = [
  { key: 'code', label: 'code', mono: true },
  { key: 'scope', label: '对标维度', mono: true },
  { key: 'targetCode', label: '对标目标', mono: true },
  { key: 'standardSeconds', label: '每件秒' },
  { key: 'preparationSeconds', label: '每批秒' },
  { key: 'status', label: '状态', mono: true },
];

export function StandardTimesPage() {
  const queryClient = useQueryClient();
  const [scopeFilter, setScopeFilter] = useState('');
  const listQuery = useQuery({
    queryKey: ['baseline', 'standard-times', scopeFilter],
    queryFn: () => listStandardTimes(scopeFilter === '' ? {} : { scope: scopeFilter }),
  });

  const [code, setCode] = useState('');
  const [scope, setScope] = useState<'process' | 'product'>('process');
  const [targetCode, setTargetCode] = useState('');
  const [standardSeconds, setStandardSeconds] = useState('150');
  const [preparationSeconds, setPreparationSeconds] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      defineStandardTime({
        code: code.trim(),
        scope,
        targetCode: targetCode.trim(),
        standardSeconds: Number(standardSeconds),
        ...(preparationSeconds.trim().length > 0 ? { preparationSeconds: Number(preparationSeconds) } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['baseline', 'standard-times'] });
        setCode('');
        setTargetCode('');
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
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>额定工时</CardTitle>
          <CardDescription>
            StandardTimeLookup 对标端口（hours 对标消费）；当前版本无 revise 命令——误录不可修正。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="st-scope-filter">对标维度过滤</Label>
            <Select id="st-scope-filter" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="process">按工序</option>
              <option value="product">按产品（图号）</option>
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无额定工时（先在下方定义）"
          >
            <ModuleTable columns={LIST_COLUMNS} rows={listQuery.data ?? []} rowIdKey="code" />
          </QueryState>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>定义额定工时</CardTitle>
          <CardDescription>秒粒度整数（150=2.5 分钟）；standardSeconds 必填、preparationSeconds 可选缺省 0。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-code">code</Label>
              <Input id="st-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ST-OP10" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-scope">对标维度</Label>
              <Select id="st-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="process">按工序</option>
                <option value="product">按产品（图号）</option>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-target">对标目标（工序码或图号）</Label>
              <Input id="st-target" value={targetCode} onChange={(e) => setTargetCode(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-seconds">每件标准秒</Label>
              <Input id="st-seconds" type="number" min="1" step="1" value={standardSeconds} onChange={(e) => setStandardSeconds(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="st-prep">每批预备秒（可选）</Label>
              <Input id="st-prep" type="number" min="0" step="1" value={preparationSeconds} onChange={(e) => setPreparationSeconds(e.target.value)} />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  code.trim().length === 0 ||
                  targetCode.trim().length === 0 ||
                  Number(standardSeconds) < 1
                }
              >
                定义额定工时
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
