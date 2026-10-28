/**
 * 不合格处置页（S2 批次）：不合格明细列表（状态/质检单过滤）+ 行选中处置
 * （返工/让步/报废 + 原因必填）与闭环。#63-66 质检不合格闭环的处置面。
 *
 * W10b Round-2 缺陷批：详情白名单中文读面（UX-QC-R2-03，照 W7
 * InspectionDetailView 模式——裸 JSON 的 nonconform/milestones/inspectionState
 * 改结构化字段 + 中文标签 + 时刻本地化）；列表创建时刻接 datetime 本地化
 * （同号）；切行清除上次操作结果（UX-QC-R2-02 同类，处置卡与质检卡同模式）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：inspection namespace 绑定（zh-CN 权威源=原页面文案；业务数据与
// 服务端 message 不翻译；namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  closeNonconformity,
  disposeNonconformity,
  getNonconformityDetail,
  listNonconformities,
} from '../../data/inspectionApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { formatLocalDateTime, shortId } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const NONCONFORM_STATES = ['open', 'disposed', 'closed'] as const;

/** 三态 label key 映射（UX-QC-04，照 P1 映射模式；未知 id 原样返回）。 */
const NONCONFORM_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  open: 'nonconform-state.open',
  disposed: 'nonconform-state.disposed',
  closed: 'nonconform-state.closed',
  voided: 'nonconform-state.voided',
};

/** 质检单四态 label key 映射（详情「关联质检单状态」读面；与质检队列页同口径）。 */
const INSPECTION_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  pending: 'state.pending',
  passed: 'state.passed',
  failed: 'state.failed',
  closed: 'state.closed',
};

/** 处置枚举 label key 映射（详情读面；与质检单详情不合格明细表同口径）。 */
const NONCONFORM_DISPOSAL_LABEL_KEYS: Readonly<Record<string, string>> = {
  rework: 'disposal.rework',
  concession: 'disposal.concession',
  scrap: 'disposal.scrap',
};

/** 处置单迁移动词 label key 映射（详情流转记录读面；与 inspection-config 非标配置同口径）。 */
const NONCONFORM_EVENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  DISPOSE: 'nonconform-event.dispose',
  CLOSE: 'nonconform-event.close',
  VOID: 'nonconform-event.void',
};

function nonconformStateLabel(state: string, t: TFunction): string {
  const key = NONCONFORM_STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function inspectionStateLabel(state: string, t: TFunction): string {
  const key = INSPECTION_STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function nonconformDisposalLabel(disposal: string, t: TFunction): string {
  const key = NONCONFORM_DISPOSAL_LABEL_KEYS[disposal];
  return key === undefined ? disposal : t(key);
}

function nonconformEventLabel(event: string, t: TFunction): string {
  const key = NONCONFORM_EVENT_LABEL_KEYS[event];
  return key === undefined ? event : t(key);
}

/** 列表列（i18n 波 2：label 经 t() 取 inspection namespace nonconformities.columns.*）。 */
function listColumns(t: TFunction) {
  return [
    { key: 'id', label: t('nonconformities.columns.id'), mono: true },
    { key: 'inspectionId', label: t('nonconformities.columns.inspection'), mono: true },
    { key: 'state', label: t('nonconformities.columns.state'), mono: true },
    { key: 'quantity', label: t('nonconformities.columns.quantity') },
    { key: 'objectVersion', label: t('nonconformities.columns.version'), mono: true },
    { key: 'createdAt', label: t('nonconformities.columns.created-at'), format: 'datetime' as const },
  ];
}

export function NonconformitiesPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inspection');
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

  // UX-QC-R2-02 同类：切行清除上一单操作结果（结果横幅跨单粘滞，照质检队列卡模式）。
  useEffect(() => {
    setOutcome(null);
  }, [selectedId]);

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
          <CardTitle>{t('nonconformities.title')}</CardTitle>
          <CardDescription>{t('nonconformities.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="nc-state-filter">{t('nonconformities.filter.state-label')}</Label>
              <Select id="nc-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">{t('nonconformities.filter.all-states')}</option>
                {NONCONFORM_STATES.map((state) => (
                  <option key={state} value={state}>{nonconformStateLabel(state, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="nc-inspection-filter">{t('nonconformities.filter.inspection-label')}</Label>
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
            empty={t('nonconformities.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              rows={(listQuery.data ?? []).map((row) => ({
                ...row,
                state:
                  typeof row['state'] === 'string'
                    ? nonconformStateLabel(row['state'] as string, t)
                    : row['state'],
              }))}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('nonconformities.disposal-card.title')}</CardTitle>
            <CardDescription>{t('nonconformities.disposal-card.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <NonconformDetailView detail={detailQuery.data ?? {}} />
            </QueryState>
            <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-disposal">{t('nonconformities.disposal-card.disposal-label')}</Label>
                <Select id="nc-disposal" value={disposal} onChange={(e) => setDisposal(e.target.value as typeof disposal)}>
                  <option value="rework">{t('disposal.rework')}</option>
                  <option value="concession">{t('disposal.concession')}</option>
                  <option value="scrap">{t('disposal.scrap')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-reason">{t('nonconformities.disposal-card.reason-label')}</Label>
                <Input id="nc-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="nc-remark">{t('nonconformities.disposal-card.remark-label')}</Label>
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
                {t('nonconformities.disposal-card.submit-dispose')}
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
                {t('nonconformities.disposal-card.submit-close')}
              </Button>
            </div>
            {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * 处置单详情结构化读面（UX-QC-R2-03，照 W7 InspectionDetailView 白名单+中文
 * 标签模式）。后端详情形状 = { nonconform, milestones, inspectionState }
 * （inspection.service.nonconformDetail）；白名单省略 tenant/flowConfigId 技术
 * 键，嵌套 milestones 以「流转记录」时间线呈现，关联质检单当前态中文化。
 */
function NonconformDetailView({ detail }: { readonly detail: Record<string, unknown> }) {
  const { t } = useTranslation('inspection');
  const nc =
    typeof detail['nonconform'] === 'object' && detail['nonconform'] !== null
      ? (detail['nonconform'] as Record<string, unknown>)
      : {};
  const milestones = Array.isArray(detail['milestones'])
    ? (detail['milestones'] as readonly Record<string, unknown>[])
    : [];
  const orderState = detail['inspectionState'];

  const text = (key: string): string => {
    const value = nc[key];
    return value === undefined || value === null ? '' : String(value);
  };
  const datetime = (key: string): string => {
    const raw = text(key);
    return raw.length > 0 ? formatLocalDateTime(raw) : '';
  };

  const fields = (
    [
      { label: t('nonconformities.detail.fields.id'), value: text('id'), mono: true },
      { label: t('nonconformities.detail.fields.inspection-id'), value: text('inspectionId'), mono: true },
      { label: t('nonconformities.detail.fields.state'), value: text('state').length > 0 ? nonconformStateLabel(text('state'), t) : '' },
      { label: t('nonconformities.detail.fields.item'), value: text('itemId'), mono: true },
      { label: t('nonconformities.detail.fields.quantity'), value: text('quantity') },
      { label: t('nonconformities.detail.fields.reason'), value: text('reason') },
      {
        label: t('nonconformities.detail.fields.disposal'),
        value:
          typeof nc['disposal'] === 'string' && nc['disposal'].length > 0
            ? nonconformDisposalLabel(nc['disposal'] as string, t)
            : '',
      },
      { label: t('nonconformities.detail.fields.dispose-remark'), value: text('disposeRemark') },
      { label: t('nonconformities.detail.fields.disposed-by'), value: text('disposedBy'), mono: true },
      { label: t('nonconformities.detail.fields.disposed-at'), value: datetime('disposedAt') },
      { label: t('nonconformities.detail.fields.close-remark'), value: text('closeRemark') },
      { label: t('nonconformities.detail.fields.closed-by'), value: text('closedBy'), mono: true },
      { label: t('nonconformities.detail.fields.closed-at'), value: datetime('closedAt') },
      { label: t('nonconformities.detail.fields.created-at'), value: datetime('createdAt') },
      { label: t('nonconformities.detail.fields.updated-at'), value: datetime('updatedAt') },
      {
        label: t('nonconformities.detail.fields.inspection-state'),
        value: typeof orderState === 'string' && orderState.length > 0 ? inspectionStateLabel(orderState, t) : '',
      },
    ] satisfies ReadonlyArray<{ readonly label: string; readonly value: string; readonly mono?: boolean }>
  ).filter((field) => field.value.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-xs text-muted-foreground">{field.label}</dt>
            <dd className={field.mono === true ? 'break-all font-mono text-xs' : 'break-all text-xs'}>
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      {milestones.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('nonconformities.detail.milestones.heading')}</p>
          <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
            {milestones.map((milestone, index) => {
              const from = nonconformStateLabel(String(milestone['from'] ?? ''), t);
              const to = nonconformStateLabel(String(milestone['to'] ?? ''), t);
              const event = String(milestone['event'] ?? '');
              const at = formatLocalDateTime(milestone['occurredAt']);
              const actor = String(milestone['actor'] ?? '');
              return (
                <li key={index}>
                  {t('nonconformities.detail.milestones.entry', {
                    from,
                    to,
                    event: nonconformEventLabel(event, t),
                  })}
                  {at !== '—' ? ` · ${at}` : ''}
                  {actor.length > 0 ? ` · ${t('nonconformities.detail.milestones.operator')} ${shortId(actor)}` : ''}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
