/**
 * 工序管理页（S2 批次）：版本化工序主数据列表 + 定义命令 + 行选中停启用。
 * 覆盖矩阵 #10 工序管理。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defineProcess, listProcesses, reviseProcess } from '../../data/baselineApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const LIST_COLUMNS = [
  { key: 'code', label: 'code', mono: true },
  { key: 'name', label: '名称' },
  { key: 'category', label: '类别' },
  { key: 'status', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function ProcessesPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['baseline', 'processes', statusFilter],
    queryFn: () => listProcesses(statusFilter === '' ? undefined : statusFilter),
  });
  const selectedRow = listQuery.data?.find((row) => String(row['code']) === selectedCode) ?? null;

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['baseline', 'processes'] });
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleDefine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate(() =>
      defineProcess({
        code: code.trim(),
        name: name.trim(),
        category,
        description,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>工序列表</CardTitle>
          <CardDescription>版本化主数据（supersedes 链）；点行选中后停/启用。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="proc-status-filter">状态过滤</Label>
            <Select id="proc-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无工序（先在下方定义）"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              rowIdKey="code"
              selectedId={selectedCode}
              onSelect={(row) => setSelectedCode(String(row['code']))}
            />
          </QueryState>
          {selectedRow !== null && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate(() =>
                    reviseProcess(selectedRow, { status: String(selectedRow['status']) === 'active' ? 'draft' : 'active' }),
                  )
                }
              >
                {String(selectedRow['status']) === 'active' ? '停用（转 draft）' : '启用（转 active）'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>定义工序</CardTitle>
          <CardDescription>code 字母/数字开头（可含点/下划线/连字符，≤64 字符）；定义即 active。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleDefine}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="proc-code">工序 code</Label>
              <Input id="proc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="OP-10" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="proc-name">名称</Label>
              <Input id="proc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="粗车外圆" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="proc-category">类别（可选）</Label>
              <Input id="proc-category" value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="proc-description">描述（可选）</Label>
              <Input id="proc-description" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={mutation.isPending || code.trim().length === 0 || name.trim().length === 0}>
                定义工序
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
