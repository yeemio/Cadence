/**
 * 报工管理页（S2 批次）：五类报工单列表（kind/状态/派工单/申报人/图号过滤）+
 * 选中单详情（修正链+留痕）+ 核查/修正/撤销操作 + 图号×工序进度 + 产出趋势。
 * 覆盖矩阵 #44-48（五类报工）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  auditEditReport,
  getDrawingOperationProgress,
  getOutputTrend,
  getReportDetail,
  listReports,
  revokeReport,
  verifyReport,
} from '../../data/reportingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const REPORT_KINDS = [
  { value: 'part', label: '零件' },
  { value: 'assembly', label: '装配' },
  { value: 'electrical', label: '电气' },
  { value: 'aftermarket', label: '售后' },
  { value: 'oddjob', label: '零工' },
] as const;

const REPORT_STATES = ['pending', 'reported', 'verified', 'revoked'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类别', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'dispatchId', label: '派工单', mono: true },
  { key: 'doneQty', label: '完工数量' },
  { key: 'laborMinutes', label: '工时（分钟）' },
  { key: 'reporter', label: '申报人', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function ReportsPage() {
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [drawingNoFilter, setDrawingNoFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reportsQuery = useQuery({
    queryKey: ['reports', 'list', kindFilter, stateFilter, drawingNoFilter],
    queryFn: () =>
      listReports({
        ...(kindFilter === '' ? {} : { kind: kindFilter }),
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(drawingNoFilter.trim() === '' ? {} : { drawingNo: drawingNoFilter.trim() }),
      }),
  });

  const selectedRow = reportsQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>报工单列表</CardTitle>
          <CardDescription>
            五类报工（工艺属性随单快照、业务时间补录、fail-closed 校验）；点行选中后核查/修正/撤销。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-kind-filter">类别过滤</Label>
              <Select id="rep-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">全部类别</option>
                {REPORT_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-state-filter">状态过滤</Label>
              <Select id="rep-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {REPORT_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-drawing-filter">图号过滤（可选）</Label>
              <Input id="rep-drawing-filter" value={drawingNoFilter} onChange={(e) => setDrawingNoFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={reportsQuery.isPending}
            error={reportsQuery.error}
            isEmpty={reportsQuery.data !== undefined && reportsQuery.data.length === 0}
            empty="当前过滤条件下无报工单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={reportsQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <ReportDetailCard
          row={selectedRow}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['reports'] })}
        />
      )}

      <ProgressQueriesCard />
    </div>
  );
}

function ReportDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['reports', 'detail', id],
    queryFn: () => getReportDetail(id),
  });
  const [remark, setRemark] = useState('');
  const [reason, setReason] = useState('');
  const [doneQty, setDoneQty] = useState('');
  const [laborMinutes, setLaborMinutes] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) onChanged();
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>报工单详情与核查操作</CardTitle>
        <CardDescription>
          核查→ReportVerified（载荷=hours 消费合同）；修正=修正版+原因（不改原单）；撤销=冲销。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} />
        </QueryState>

        <div className="grid gap-4 lg:grid-cols-4 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-remark">核查备注（可选）</Label>
            <Input id="rep-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-reason">修正原因（修正必填）</Label>
            <Input id="rep-op-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-qty">修正数量（可选）</Label>
            <Input id="rep-op-qty" type="number" min="0.000001" step="any" value={doneQty} onChange={(e) => setDoneQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-minutes">修正工时分钟（可选）</Label>
            <Input id="rep-op-minutes" type="number" min="1" step="1" value={laborMinutes} onChange={(e) => setLaborMinutes(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => verifyReport(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            核查通过
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || reason.trim().length === 0}
            onClick={() =>
              mutation.mutate(() =>
                auditEditReport(id, row, {
                  reason: reason.trim(),
                  ...(doneQty.trim().length > 0 ? { doneQty: Number(doneQty) } : {}),
                  ...(laborMinutes.trim().length > 0 ? { laborMinutes: Number(laborMinutes) } : {}),
                }),
              )
            }
          >
            提交修正版
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => revokeReport(id, row, reason.trim().length > 0 ? reason.trim() : undefined))}
          >
            撤销冲销
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

/** 图号×工序进度 + 产出趋势（reporting 查询面）。 */
function ProgressQueriesCard() {
  const [drawingNo, setDrawingNo] = useState('');
  const [loadedDrawingNo, setLoadedDrawingNo] = useState<string | null>(null);

  const drawingQuery = useQuery({
    queryKey: ['reports', 'drawing-progress', loadedDrawingNo],
    queryFn: () => getDrawingOperationProgress(loadedDrawingNo as string),
    enabled: loadedDrawingNo !== null,
  });
  const trendQuery = useQuery({ queryKey: ['reports', 'output-trend'], queryFn: () => getOutputTrend() });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>图号 × 工序进度</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="rep-drawing-input">图号</Label>
              <Input id="rep-drawing-input" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={drawingNo.trim().length === 0}
              onClick={() => setLoadedDrawingNo(drawingNo.trim())}
            >
              查询进度
            </Button>
          </div>
          {loadedDrawingNo !== null && (
            <QueryState
              isPending={drawingQuery.isPending}
              error={drawingQuery.error}
              isEmpty={drawingQuery.data !== undefined && drawingQuery.data.length === 0}
              empty="该图号暂无工序进度事实"
            >
              <ModuleTable
                columns={[
                  { key: 'drawingNo', label: '图号', mono: true },
                  { key: 'operationCode', label: '工序', mono: true },
                  { key: 'doneQty', label: '完工数量' },
                  { key: 'state', label: '状态', mono: true },
                ]}
                rows={drawingQuery.data ?? []}
              />
            </QueryState>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>产出趋势（12 日窗口）</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={trendQuery.isPending}
            error={trendQuery.error}
            isEmpty={trendQuery.data !== undefined && trendQuery.data.length === 0}
            empty="暂无产出事实"
          >
            <ModuleTable
              columns={[
                { key: 'date', label: '日期' },
                { key: 'outputQty', label: '产出数量' },
                { key: 'reportCount', label: '报工单数' },
              ]}
              rows={trendQuery.data ?? []}
            />
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}
