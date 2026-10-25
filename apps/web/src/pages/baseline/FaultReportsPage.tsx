/**
 * 故障上报管理页（S2 批次）：三态故障单列表（状态过滤）+ 上报表单（上报即派修
 * open→assigned + IM 推送 + 维修待办）+ 行选中闭环（assigned→resolved）。
 * 端点能力按 baseline.controllers.ts 实态（POST /baseline/fault-reports/commands、
 * :id/resolution、GET list ?state=）。覆盖矩阵 #20 故障上报。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listFaultReports, reportFault, resolveFault } from '../../data/baselineApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 三态（baseline-fault-config.ts FAULT_REPORT_STATE_IDS 实态）。 */
const FAULT_STATES = ['open', 'assigned', 'resolved'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'equipmentCode', label: '设备', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'assignee', label: '维修人', mono: true },
  { key: 'reportedBy', label: '上报人', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '上报时刻' },
];

export function FaultReportsPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolveRemark, setResolveRemark] = useState('');

  const listQuery = useQuery({
    queryKey: ['baseline', 'fault-reports', stateFilter],
    queryFn: () => listFaultReports(stateFilter === '' ? undefined : stateFilter),
  });
  const selectedRow = listQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const [equipmentCode, setEquipmentCode] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['baseline', 'fault-reports'] });
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate(() =>
      reportFault({
        equipmentCode: equipmentCode.trim(),
        description: description.trim(),
        assignee: assignee.trim(),
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>故障单列表</CardTitle>
          <CardDescription>
            三态 open→assigned→resolved（真实 baseline fault-reports API 读回；上报即派修并发 IM 推送）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="fault-state-filter">状态过滤</Label>
            <Select id="fault-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">全部状态</option>
              {FAULT_STATES.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </Select>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="当前过滤条件下无故障单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
          {selectedRow !== null && (
            <div className="flex flex-col gap-3">
              <RowDetail row={selectedRow} title="故障单详情" />
              {String(selectedRow['state']) === 'assigned' && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex max-w-sm flex-1 flex-col gap-2">
                    <Label htmlFor="fault-resolve-remark">闭环备注（可选）</Label>
                    <Input
                      id="fault-resolve-remark"
                      value={resolveRemark}
                      onChange={(e) => setResolveRemark(e.target.value)}
                      placeholder="维修结论留痕"
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate(() => resolveFault(selectedRow, resolveRemark.trim()))}
                  >
                    确认修复（闭环）
                  </Button>
                </div>
              )}
            </div>
          )}
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>上报故障</CardTitle>
          <CardDescription>
            baseline.fault.report.v1：上报即派修（open→assigned + IM 推送 + 维修人待办）；
            设备码引用设备台账 code，维修人为用户 id。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleReport}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="fault-equipment">设备 code</Label>
              <Input
                id="fault-equipment"
                value={equipmentCode}
                onChange={(e) => setEquipmentCode(e.target.value)}
                placeholder="EQ-CNC-01"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="fault-assignee">维修人（用户 id）</Label>
              <Input
                id="fault-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="user-demo-operator"
                required
              />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="fault-description">故障描述</Label>
              <Input
                id="fault-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="主轴异响，需停机检查"
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  equipmentCode.trim().length === 0 ||
                  description.trim().length === 0 ||
                  assignee.trim().length === 0
                }
              >
                上报故障
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
