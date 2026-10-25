/**
 * 外协计价配置页（S2 批次）：计价规则列表 + set 命令（工序单价十进制串 +
 * 利润率万分比）。dispatch 外协建单实时取价消费本配置。覆盖矩阵 #13。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listOutsourcingRules, setOutsourcingRule } from '../../data/baselineApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const LIST_COLUMNS = [
  { key: 'code', label: 'code', mono: true },
  { key: 'processCode', label: '工序', mono: true },
  { key: 'unitPriceMinor', label: '单价（分）' },
  { key: 'marginPermyriad', label: '利润率（万分比）' },
  { key: 'status', label: '状态', mono: true },
];

export function OutsourcingRulesPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const listQuery = useQuery({
    queryKey: ['baseline', 'outsourcing-rules', statusFilter],
    queryFn: () => listOutsourcingRules(statusFilter === '' ? undefined : statusFilter),
  });

  const [code, setCode] = useState('');
  const [processCode, setProcessCode] = useState('');
  const [unitPrice, setUnitPrice] = useState('12.50');
  const [marginPermyriad, setMarginPermyriad] = useState('1500');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      setOutsourcingRule({
        code: code.trim(),
        processCode: processCode.trim(),
        unitPrice: unitPrice.trim(),
        marginPermyriad: Number(marginPermyriad),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['baseline', 'outsourcing-rules'] });
        setCode('');
        setProcessCode('');
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
          <CardTitle>外协计价规则</CardTitle>
          <CardDescription>set/revise + 实时取价；dispatch 外协建单实时取价联动。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="or-status-filter">状态过滤</Label>
            <Select id="or-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无计价规则（先在下方设定）"
          >
            <ModuleTable columns={LIST_COLUMNS} rows={listQuery.data ?? []} rowIdKey="code" />
          </QueryState>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>设定计价规则</CardTitle>
          <CardDescription>单价为十进制金额串（'12.50'，落库换算为分）；利润率万分比整数（1500=15%）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="or-code">规则 code</Label>
              <Input id="or-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="OR-OP30" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="or-process">工序 code</Label>
              <Input id="or-process" value={processCode} onChange={(e) => setProcessCode(e.target.value)} placeholder="OP-30" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="or-price">工序单价（十进制串）</Label>
              <Input id="or-price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="12.50" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="or-margin">利润率（万分比）</Label>
              <Input id="or-margin" type="number" min="0" step="1" value={marginPermyriad} onChange={(e) => setMarginPermyriad(e.target.value)} required />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  code.trim().length === 0 ||
                  processCode.trim().length === 0 ||
                  unitPrice.trim().length === 0
                }
              >
                设定规则
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
