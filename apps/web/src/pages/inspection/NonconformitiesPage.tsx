/**
 * 不合格处置页（S2 批次）：不合格明细列表（状态/质检单过滤）+ 行选中处置
 * （返工/让步/报废 + 原因必填）与闭环。#63-66 质检不合格闭环的处置面。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeNonconformity,
  disposeNonconformity,
  getNonconformityDetail,
  listNonconformities,
} from '../../data/inspectionApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const NONCONFORM_STATES = ['open', 'disposed', 'closed'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'inspectionId', label: '质检单', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'quantity', label: '数量' },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function NonconformitiesPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [inspectionIdFilter, setInspectionIdFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['inspection', 'nonconformities', stateFilter, inspectionIdFilter],
    queryFn: () =>
      listNonconformities({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(inspectionIdFilter.trim() === '' ? {} : { inspectionId: inspectionIdFilter.trim() }),
      }),
  });

  const selectedRow = listQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ['inspection', 'nonconformity', selectedId],
    queryFn: () => getNonconformityDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  const [disposal, setDisposal] = useState<'rework' | 'concession' | 'scrap'>('rework');
  const [reason, setReason] = useState('');
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inspection', 'nonconformities'] });
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
          <CardTitle>不合格处置</CardTitle>
          <CardDescription>判定不合格自动生成处置单（open→disposed→closed）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="nc-state-filter">状态过滤</Label>
              <Select id="nc-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {NONCONFORM_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="nc-inspection-filter">质检单过滤（可选）</Label>
              <Input
                id="nc-inspection-filter"
                value={inspectionIdFilter}
                onChange={(e) => setInspectionIdFilter(e.target.value)}
              />
            </div>
          </div>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="当前过滤条件下无不合格处置单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <Card>
          <CardHeader>
            <CardTitle>处置单详情与操作</CardTitle>
            <CardDescription>处置（返工/让步/报废 + 原因必填留痕）→ 闭环。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <RowDetail row={detailQuery.data ?? {}} />
            </QueryState>
            <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-disposal">处置方式</Label>
                <Select id="nc-disposal" value={disposal} onChange={(e) => setDisposal(e.target.value as typeof disposal)}>
                  <option value="rework">返工</option>
                  <option value="concession">让步</option>
                  <option value="scrap">报废</option>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-reason">不合格原因（必填）</Label>
                <Input id="nc-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-remark">备注（可选）</Label>
                <Input id="nc-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={mutation.isPending || reason.trim().length === 0}
                onClick={() =>
                  mutation.mutate(() =>
                    disposeNonconformity(String(selectedRow['id']), selectedRow, {
                      disposal,
                      reason: reason.trim(),
                      ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
                    }),
                  )
                }
              >
                执行处置
              </Button>
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate(() =>
                    closeNonconformity(
                      String(selectedRow['id']),
                      selectedRow,
                      remark.trim().length > 0 ? remark.trim() : undefined,
                    ),
                  )
                }
              >
                闭环
              </Button>
            </div>
            {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
