/**
 * 设备档案页（S2 批次）：设备台账列表 + 登记命令。覆盖矩阵 #16 设备档案。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listEquipment, registerEquipment } from '../../data/baselineApi';
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
  { key: 'type', label: '类型' },
  { key: 'location', label: '位置' },
  { key: 'status', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function EquipmentPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const listQuery = useQuery({
    queryKey: ['baseline', 'equipment', statusFilter],
    queryFn: () => listEquipment(statusFilter === '' ? undefined : statusFilter),
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [location, setLocation] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () => registerEquipment({ code: code.trim(), name: name.trim(), type, location }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['baseline', 'equipment'] });
        setCode('');
        setName('');
        setType('');
        setLocation('');
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
          <CardTitle>设备档案</CardTitle>
          <CardDescription>设备台账（EquipmentRecord）；故障上报按设备 code 挂接。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="equip-status-filter">状态过滤</Label>
            <Select id="equip-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="draft">draft</option>
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无设备（先在下方登记）"
          >
            <ModuleTable columns={LIST_COLUMNS} rows={listQuery.data ?? []} rowIdKey="code" />
          </QueryState>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>登记设备</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="equip-code">设备 code</Label>
              <Input id="equip-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="EQ-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="equip-name">名称</Label>
              <Input id="equip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="数控车床" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="equip-type">类型（可选）</Label>
              <Input id="equip-type" value={type} onChange={(e) => setType(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="equip-location">位置（可选）</Label>
              <Input id="equip-location" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={mutation.isPending || code.trim().length === 0 || name.trim().length === 0}>
                登记设备
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
