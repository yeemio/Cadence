/**
 * 报工管理页（S2 批次）：五类报工单列表（kind/状态/派工单/申报人/图号过滤）+
 * 选中单详情（修正链+留痕）+ 核查/修正/撤销操作 + 图号×工序进度 + 产出趋势。
 * 覆盖矩阵 #44-48（五类报工）。
 *
 * i18n 波 2（ADR-0012 / proposal §8）：页面 chrome 文案接 reporting namespace
 * t()（zh-CN 权威源=本文案原文；业务数据与服务端 message 不翻译；namespace
 * 注册与 shell init 由总控统一接线）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：reporting namespace 绑定（namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail, type TableColumn } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 五类 id（i18n 波 2：label 经 reporting namespace kind.* 取文案）。 */
const REPORT_KINDS = ['part', 'assembly', 'electrical', 'aftermarket', 'oddjob'] as const;

const REPORT_STATES = ['pending', 'reported', 'verified', 'revoked'] as const;

/** 五类 label key 映射（未知 id 原样返回）。 */
const KIND_LABEL_KEYS: Readonly<Record<string, string>> = {
  part: 'kind.part',
  assembly: 'kind.assembly',
  electrical: 'kind.electrical',
  aftermarket: 'kind.aftermarket',
  oddjob: 'kind.oddjob',
};

// UX-PRD-05：报工单四态（词源 reporting-config REPORT_STATES：待报/已报/已核查/已撤销，
// 不造新词；i18n 波 2 label 经 state.* 取文案）。
const STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  pending: 'state.pending',
  reported: 'state.reported',
  verified: 'state.verified',
  revoked: 'state.revoked',
};

function reportStateLabel(state: unknown, t: TFunction): string {
  const id = state === null || state === undefined ? '' : String(state);
  const key = STATE_LABEL_KEYS[id];
  return key === undefined ? id : t(key);
}

function reportKindLabel(kind: unknown, t: TFunction): string {
  const id = kind === null || kind === undefined ? '' : String(kind);
  const key = KIND_LABEL_KEYS[id];
  return key === undefined ? id : t(key);
}

/** 列表列（i18n 波 2：label 经 t() 取 reporting namespace column.*）。 */
function listColumns(t: TFunction): readonly TableColumn[] {
  return [
    { key: 'id', label: t('column.id'), mono: true },
    { key: 'kind', label: t('column.kind'), mono: true },
    { key: 'state', label: t('column.state'), mono: true },
    { key: 'dispatchId', label: t('column.dispatch-order'), mono: true },
    { key: 'doneQty', label: t('column.done-qty') },
    { key: 'laborMinutes', label: t('column.labor-minutes') },
    { key: 'reporter', label: t('column.reporter'), mono: true },
    { key: 'objectVersion', label: t('column.version'), mono: true },
  ] satisfies readonly TableColumn[];
}

/** 列表行：状态/类别列显示中文（其余字段原样；label 经 t() 取文案）。 */
function displayReportRows(
  rows: readonly Record<string, unknown>[],
  t: TFunction,
): readonly Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    state: reportStateLabel(row['state'], t),
    kind: reportKindLabel(row['kind'], t),
  }));
}

export function ReportsPage() {
  const { t } = useTranslation('reporting');
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
          <CardTitle>{t('list.title')}</CardTitle>
          <CardDescription>{t('list.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-kind-filter">{t('list.kind-filter')}</Label>
              <Select id="rep-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">{t('list.kind-all')}</option>
                {REPORT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{reportKindLabel(kind, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-state-filter">{t('list.state-filter')}</Label>
              <Select id="rep-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">{t('list.state-all')}</option>
                {REPORT_STATES.map((state) => (
                  <option key={state} value={state}>{reportStateLabel(state, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rep-drawing-filter">{t('list.drawing-filter')}</Label>
              <Input id="rep-drawing-filter" value={drawingNoFilter} onChange={(e) => setDrawingNoFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={reportsQuery.isPending}
            error={reportsQuery.error}
            isEmpty={reportsQuery.data !== undefined && reportsQuery.data.length === 0}
            empty={t('list.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              rows={displayReportRows(reportsQuery.data ?? [], t)}
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
  const { t } = useTranslation('reporting');
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
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.title')}</CardTitle>
        <CardDescription>{t('detail.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} />
        </QueryState>

        <div className="grid gap-4 lg:grid-cols-4 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-remark">{t('detail.remark-label')}</Label>
            <Input id="rep-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-reason">{t('detail.reason-label')}</Label>
            <Input id="rep-op-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-qty">{t('detail.qty-label')}</Label>
            <Input id="rep-op-qty" type="number" min="0.000001" step="any" value={doneQty} onChange={(e) => setDoneQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rep-op-minutes">{t('detail.minutes-label')}</Label>
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
            {t('detail.verify-button')}
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
            {t('detail.audit-button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => revokeReport(id, row, reason.trim().length > 0 ? reason.trim() : undefined))}
          >
            {t('detail.revoke-button')}
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

/** 图号×工序进度 + 产出趋势（reporting 查询面）。 */
function ProgressQueriesCard() {
  const { t } = useTranslation('reporting');
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
          <CardTitle>{t('progress.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="rep-drawing-input">{t('progress.drawing-label')}</Label>
              <Input id="rep-drawing-input" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={drawingNo.trim().length === 0}
              onClick={() => setLoadedDrawingNo(drawingNo.trim())}
            >
              {t('progress.query-button')}
            </Button>
          </div>
          {loadedDrawingNo !== null && (
            <QueryState
              isPending={drawingQuery.isPending}
              error={drawingQuery.error}
              isEmpty={drawingQuery.data !== undefined && drawingQuery.data.length === 0}
              empty={t('progress.empty')}
            >
              <ModuleTable
                columns={[
                  { key: 'drawingNo', label: t('column.drawing-number'), mono: true },
                  { key: 'operationCode', label: t('column.operation'), mono: true },
                  { key: 'doneQty', label: t('column.done-qty') },
                  { key: 'state', label: t('column.state'), mono: true },
                ]}
                rows={drawingQuery.data ?? []}
              />
            </QueryState>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('trend.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={trendQuery.isPending}
            error={trendQuery.error}
            isEmpty={trendQuery.data !== undefined && trendQuery.data.length === 0}
            empty={t('trend.empty')}
          >
            <ModuleTable
              columns={[
                { key: 'date', label: t('column.date') },
                { key: 'doneQty', label: t('column.output-qty') },
                { key: 'laborMinutes', label: t('column.labor-minutes') },
              ]}
              rows={trendQuery.data ?? []}
            />
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}
