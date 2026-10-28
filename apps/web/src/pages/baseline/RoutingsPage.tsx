/**
 * 工艺路线页（S2 批次）：版本链列表（supersedes）+ 定义命令（图号=业务键，
 * 有序工序步）+ 按图号查详情。覆盖矩阵 #35 工艺路线。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defineRouting, getRouting, listRoutings } from '../../data/baselineApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const LIST_COLUMNS = [
  { key: 'drawingNo', label: '图号', mono: true },
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function RoutingsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedDrawingNo, setSelectedDrawingNo] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['baseline', 'routings', statusFilter],
    queryFn: () => listRoutings(statusFilter === '' ? undefined : statusFilter),
  });
  const detailQuery = useQuery({
    queryKey: ['baseline', 'routing', selectedDrawingNo],
    queryFn: () => getRouting(selectedDrawingNo as string),
    enabled: selectedDrawingNo !== null,
  });

  const [drawingNo, setDrawingNo] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      defineRouting({
        drawingNo: drawingNo.trim(),
        steps: steps
          .split(/[,\s]+/)
          .map((step) => step.trim())
          .filter((step) => step.length > 0),
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['baseline', 'routings'] });
        setDrawingNo('');
        setName('');
        setSteps('');
      }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>工艺路线</CardTitle>
          <CardDescription>租户内一图一链；reporting 末道判定消费本版本链。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="routing-status-filter">状态过滤</Label>
            <Select id="routing-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无工艺路线（先在下方定义）"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              rowIdKey="drawingNo"
              selectedId={selectedDrawingNo}
              onSelect={(row) => setSelectedDrawingNo(String(row['drawingNo']))}
            />
          </QueryState>
          {selectedDrawingNo !== null && (
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <RowDetail row={detailQuery.data ?? {}} title="工艺路线详情（按图号）" />
            </QueryState>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>定义工艺路线</CardTitle>
          <CardDescription>工序步为有序工序 code（逗号或空格分隔；数组位置即工序顺序）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="routing-drawing">图号（业务键）</Label>
              <Input id="routing-drawing" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} placeholder="DWG-1001" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="routing-name">名称（可选）</Label>
              <Input id="routing-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="routing-steps">工序步序列（OP-10, OP-20, …）</Label>
              <Input id="routing-steps" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="OP-10, OP-20, OP-30" required />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  drawingNo.trim().length === 0 ||
                  steps.split(/[,\s]+/).filter((step) => step.trim().length > 0).length === 0
                }
              >
                定义工艺路线
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
