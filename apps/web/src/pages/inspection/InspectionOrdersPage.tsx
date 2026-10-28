/**
 * 质检队列页（S2 批次）：四类质检队列（类别/状态过滤）+ 汇总事实 + 手工建单 +
 * 行选中判定/复检/特采 + 超时点名。覆盖矩阵 #63-66（自制外协/非标件采购/标准配件
 * 采购/设备采购质检）。
 *
 * W7 UX 缺陷批：状态/类别/来源枚举中文化（UX-QC-04，照 P1 派工 STATE_LABELS
 * 映射模式）；详情白名单中文读面（UX-QC-05，照 DispatchDetailView 模式）；
 * 特采确认接入既有命令通道 inspection.concession.v1（UX-QC-03/RQ-035）；
 * 建单表单补关联口径提示（UX-QC-02——后端建单载荷暂无工作令字段，关联经
 * 来源类型+来源对象，见 data/inspectionApi 实态）。
 *
 * W10b Round-2 缺陷批：特采按钮补类别前端闸（UX-QC-R2-01——非非标件采购类别
 * 直接禁用+人话说明，不依赖服务端拒绝）；业务拒文里的英文类别 id 映射中文
 * （同号——服务端拒文含 'self_outsourced' 等原词，前端替换后再呈现）；
 * 切行清除上一单操作结果（UX-QC-R2-02——结果横幅跨单粘滞）。
 *
 * M2 R1 岗位入口补齐：详情卡补「判定撤销」入口（RQ-037——passed/failed 态可撤，
 * pending/closed 前端闸用与服务端同口径的人话说明；inspection:judge 写权限闸照
 * UX-VW-R2-01 派工页模式 fail-closed；两步确认先讲后果再提交；撤销原因留空提交
 * null 走服务端默认留痕；切行清除上次撤销操作结果；失败呈现服务端 reason 并提示
 * 刷新核对，不引导盲目重复提交）。
 *
 * i18n 波 2（ADR-0012 / proposal §8）：页面 chrome 文案接 inspection namespace
 * t()（zh-CN 权威源=本文案原文；业务数据与服务端 message 不翻译；namespace
 * 注册与 shell init 由总控统一接线）。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：inspection namespace 绑定（namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import {
  confirmConcession,
  createInspectionOrder,
  getConcessionView,
  getInspectionDetail,
  getInspectionSummary,
  judgeInspectionOrder,
  listInspectionOrders,
  recheckInspectionOrder,
  revokeInspection,
  scanInspectionOverdue,
} from '../../data/inspectionApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { formatLocalDateTime, shortId } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 质检类别（i18n 波 2：中文 label 经 t() 取 kind.*；value 为后端类别 id）。 */
const INSPECTION_KINDS = [
  { value: 'self_outsourced', key: 'self-outsourced' },
  { value: 'nonstandard_purchase', key: 'nonstandard-purchase' },
  { value: 'standard_purchase', key: 'standard-purchase' },
  { value: 'equipment_purchase', key: 'equipment-purchase' },
] as const;

/** 判定撤销写权限码（M2 R1：与后端撤销质检端点 @RequirePermission 同码）。 */
const INSPECTION_JUDGE_CODE = permissionCode('inspection:judge');

const INSPECTION_STATES = ['pending', 'passed', 'failed', 'closed'] as const;

/** 四态 label key 映射（未知 id 原样返回；与后端 inspection-config 状态目录同口径）。 */
const INSPECTION_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  pending: 'state.pending',
  passed: 'state.passed',
  failed: 'state.failed',
  closed: 'state.closed',
};

/** 来源类型 label key 映射（手工建单 sourceType=null → 表格空值渲染 —）。 */
const INSPECTION_SOURCE_LABEL_KEYS: Readonly<Record<string, string>> = {
  report: 'source.report',
  dispatch: 'source.dispatch',
  receipt: 'source.receipt',
};

/** 质检单状态机迁移动词 label key 映射（里程碑读面；未知 id 原样返回）。 */
const INSPECTION_EVENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  PASS: 'event.pass',
  FAIL: 'event.fail',
  RECHECK_PASS: 'event.recheck-pass',
  CLOSE: 'event.close',
  REVOKE: 'event.revoke',
};

/** 不合格处置状态 label key 映射（明细读面共用；未知 id 原样返回）。 */
const NONCONFORM_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  open: 'nonconform-state.open',
  disposed: 'nonconform-state.disposed',
  closed: 'nonconform-state.closed',
  voided: 'nonconform-state.voided',
};

/** 处置枚举 label key 映射（明细读面；与不合格处置页口径一致）。 */
const NONCONFORM_DISPOSAL_LABEL_KEYS: Readonly<Record<string, string>> = {
  rework: 'disposal.rework',
  concession: 'disposal.concession',
  scrap: 'disposal.scrap',
};

function inspectionStateLabel(state: string, t: TFunction): string {
  const key = INSPECTION_STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function inspectionKindLabel(kind: string, t: TFunction): string {
  const key = INSPECTION_KINDS.find((entry) => entry.value === kind)?.key;
  return key === undefined ? kind : t(`kind.${key}`);
}

function inspectionSourceLabel(sourceType: string, t: TFunction): string {
  const key = INSPECTION_SOURCE_LABEL_KEYS[sourceType];
  return key === undefined ? sourceType : t(key);
}

function inspectionEventLabel(event: string, t: TFunction): string {
  const key = INSPECTION_EVENT_LABEL_KEYS[event];
  return key === undefined ? event : t(key);
}

function nonconformStateLabel(state: string, t: TFunction): string {
  const key = NONCONFORM_STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function nonconformDisposalLabel(disposal: string, t: TFunction): string {
  const key = NONCONFORM_DISPOSAL_LABEL_KEYS[disposal];
  return key === undefined ? disposal : t(key);
}

/**
 * 业务拒文里的英文质检类别 id → 中文（UX-QC-R2-01：服务端拒文含
 * 'self_outsourced' 等类别原词，呈现层替换；未知词原样保留不臆造）。
 */
const INSPECTION_KIND_TOKEN_PATTERN =
  /(self_outsourced|nonstandard_purchase|standard_purchase|equipment_purchase)/g;

function humanizeKindTokens(text: string, t: TFunction): string {
  return text.replace(INSPECTION_KIND_TOKEN_PATTERN, (token) => inspectionKindLabel(token, t));
}

/** 列表列（i18n 波 2：label 经 t() 取 inspection namespace orders.columns.*）。 */
function listColumns(t: TFunction) {
  return [
    { key: 'id', label: t('orders.columns.id'), mono: true },
    { key: 'kind', label: t('orders.columns.kind'), mono: true },
    { key: 'state', label: t('orders.columns.state'), mono: true },
    { key: 'sourceType', label: t('orders.columns.source'), mono: true },
    { key: 'itemId', label: t('orders.columns.item'), mono: true },
    { key: 'drawingNo', label: t('orders.columns.drawing-no'), mono: true },
    { key: 'quantity', label: t('orders.columns.quantity') },
    { key: 'objectVersion', label: t('orders.columns.version'), mono: true },
  ];
}

/**
 * 列表显示行：枚举列翻中文（行数据另拷贝，选中/乐观锁取原始行不受影响；
 * i18n 波 2 经 t() 取文案）。
 */
function displayRowOf(row: Record<string, unknown>, t: TFunction): Record<string, unknown> {
  const mapText = (key: string, labelOf: (value: string, t: TFunction) => string): unknown => {
    const value = row[key];
    return typeof value === 'string' && value.length > 0 ? labelOf(value, t) : value;
  };
  return {
    ...row,
    kind: mapText('kind', inspectionKindLabel),
    state: mapText('state', inspectionStateLabel),
    sourceType: mapText('sourceType', inspectionSourceLabel),
  };
}

export function InspectionOrdersPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inspection');
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ordersQuery = useQuery({
    queryKey: ['inspection', 'orders', kindFilter, stateFilter],
    queryFn: () =>
      listInspectionOrders({
        ...(kindFilter === '' ? {} : { kind: kindFilter }),
        ...(stateFilter === '' ? {} : { state: stateFilter }),
      }),
  });
  const summaryQuery = useQuery({ queryKey: ['inspection', 'summary'], queryFn: getInspectionSummary });

  const selectedRow = ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  const scanMutation = useMutation({
    mutationFn: scanInspectionOverdue,
    onSuccess: (result) => setOutcome(result),
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
          <CardTitle>{t('orders.title')}</CardTitle>
          <CardDescription>{t('orders.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="insp-kind-filter">{t('orders.filter.kind-label')}</Label>
              <Select id="insp-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">{t('orders.filter.all-kinds')}</option>
                {INSPECTION_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{t(`kind.${kind.key}`)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="insp-state-filter">{t('orders.filter.state-label')}</Label>
              <Select id="insp-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">{t('orders.filter.all-states')}</option>
                {INSPECTION_STATES.map((state) => (
                  <option key={state} value={state}>{inspectionStateLabel(state, t)}</option>
                ))}
              </Select>
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty={t('orders.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              rows={(ordersQuery.data ?? []).map((row) => displayRowOf(row, t))}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('summary.title')}</CardTitle>
            <CardDescription>{t('summary.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={summaryQuery.isPending} error={summaryQuery.error} isEmpty={false}>
              <InspectionSummaryView summary={summaryQuery.data ?? {}} />
            </QueryState>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={scanMutation.isPending}
                onClick={() => scanMutation.mutate()}
              >
                {t('summary.scan-overdue')}
              </Button>
            </div>
            {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          </CardContent>
        </Card>

        {selectedRow !== null && (
          <InspectionDetailCard
            row={selectedRow}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ['inspection'] })}
          />
        )}
      </div>

      <CreateInspectionCard onChanged={() => queryClient.invalidateQueries({ queryKey: ['inspection'] })} />
    </div>
  );
}

/** 质检汇总中文读面（UX-QC-05：白名单键+中文标签，替代裸键值 RowDetail）。 */
function InspectionSummaryView({ summary }: { readonly summary: Record<string, unknown> }) {
  const { t } = useTranslation('inspection');
  const count = (key: string): string => {
    const value = summary[key];
    return value === null || value === undefined ? '—' : String(value);
  };
  const rate = summary['passRate'];
  const passRate =
    typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
  const fields = [
    { label: t('summary.fields.pending'), value: count('pendingCount') },
    { label: t('summary.fields.passed'), value: count('passedCount') },
    { label: t('summary.fields.failed'), value: count('failedCount') },
    { label: t('summary.fields.closed'), value: count('closedCount') },
    { label: t('summary.fields.pass-rate'), value: passRate },
    { label: t('summary.fields.nonconform-open'), value: count('nonconformOpenCount') },
    { label: t('summary.fields.overdue'), value: count('overdueCount') },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="break-all text-xs">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 质检单详情结构化读面（UX-QC-05，照 DispatchDetailView 白名单+中文标签模式）。 */
function InspectionDetailView({ detail }: { readonly detail: Record<string, unknown> }) {
  const { t } = useTranslation('inspection');
  const order =
    typeof detail['order'] === 'object' && detail['order'] !== null
      ? (detail['order'] as Record<string, unknown>)
      : {};
  const nonconforms = Array.isArray(detail['nonconforms'])
    ? (detail['nonconforms'] as readonly Record<string, unknown>[])
    : [];
  const milestones = Array.isArray(detail['milestones'])
    ? (detail['milestones'] as readonly Record<string, unknown>[])
    : [];

  const text = (key: string): string => {
    const value = order[key];
    return value === undefined || value === null ? '' : String(value);
  };
  const datetime = (key: string): string => {
    const raw = text(key);
    return raw.length > 0 ? formatLocalDateTime(raw) : '';
  };

  const fields = (
    [
      { label: t('detail.fields.id'), value: text('id'), mono: true },
      { label: t('detail.fields.kind'), value: text('kind').length > 0 ? inspectionKindLabel(text('kind'), t) : '' },
      { label: t('detail.fields.state'), value: text('state').length > 0 ? inspectionStateLabel(text('state'), t) : '' },
      {
        label: t('detail.fields.source'),
        value: text('sourceType').length > 0 ? inspectionSourceLabel(text('sourceType'), t) : t('source.manual'),
      },
      { label: t('detail.fields.source-ref'), value: text('sourceRefId'), mono: true },
      { label: t('detail.fields.item'), value: text('itemId'), mono: true },
      { label: t('detail.fields.drawing-no'), value: text('drawingNo'), mono: true },
      { label: t('detail.fields.quantity'), value: text('quantity') },
      { label: t('detail.fields.passed-qty'), value: text('passedQty') },
      { label: t('detail.fields.failed-qty'), value: text('failedQty') },
      { label: t('detail.fields.judge-remark'), value: text('judgeRemark') },
      { label: t('detail.fields.judged-by'), value: text('judgedBy'), mono: true },
      { label: t('detail.fields.judged-at'), value: datetime('judgedAt') },
      { label: t('detail.fields.close-due-at'), value: datetime('closeDueAt') },
      { label: t('detail.fields.created-at'), value: datetime('createdAt') },
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
      {nonconforms.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('detail.nonconforms.heading')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.id')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.state')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.quantity')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.disposal')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.reason')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.nonconforms.columns.disposed-at')}</th>
                </tr>
              </thead>
              <tbody>
                {nonconforms.map((line, index) => {
                  const state = String(line['state'] ?? '');
                  const disposal = line['disposal'];
                  return (
                    <tr key={String(line['id'] ?? index)} className="border-b last:border-b-0">
                      <td className="py-2 pr-4 font-mono text-xs">{shortId(line['id'])}</td>
                      <td className="py-2 pr-4 text-xs">{nonconformStateLabel(state, t)}</td>
                      <td className="py-2 pr-4 text-xs">{String(line['quantity'] ?? '—')}</td>
                      <td className="py-2 pr-4 text-xs">
                        {typeof disposal === 'string' && disposal.length > 0
                          ? nonconformDisposalLabel(disposal, t)
                          : '—'}
                      </td>
                      <td className="py-2 pr-4 text-xs">{String(line['reason'] ?? '—')}</td>
                      <td className="py-2 pr-4 text-xs">
                        {line['disposedAt'] === null || line['disposedAt'] === undefined
                          ? '—'
                          : formatLocalDateTime(line['disposedAt'])}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {milestones.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('detail.milestones.heading')}</p>
          <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
            {milestones.map((milestone, index) => {
              const from = inspectionStateLabel(String(milestone['from'] ?? ''), t);
              const to = inspectionStateLabel(String(milestone['to'] ?? ''), t);
              const event = String(milestone['event'] ?? '');
              const at = formatLocalDateTime(milestone['occurredAt']);
              const actor = String(milestone['actor'] ?? '');
              return (
                <li key={index}>
                  {t('detail.milestones.entry', {
                    from,
                    to,
                    event: inspectionEventLabel(event, t),
                  })}
                  {at !== '—' ? ` · ${at}` : ''}
                  {actor.length > 0 ? ` · ${t('detail.milestones.operator')} ${shortId(actor)}` : ''}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function InspectionDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const { t } = useTranslation('inspection');
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['inspection', 'detail', id],
    queryFn: () => getInspectionDetail(id),
  });
  const concessionQuery = useQuery({
    queryKey: ['inspection', 'concession', id],
    queryFn: () => getConcessionView(id),
  });
  const [passedQty, setPassedQty] = useState('1');
  const [failedQty, setFailedQty] = useState('0');
  const [remark, setRemark] = useState('');
  const [concessionQty, setConcessionQty] = useState('1');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  // M2 R1：结果横幅来源（撤销失败时才追加"刷新核对、勿盲目重复提交"提示）。
  const [outcomeSource, setOutcomeSource] = useState<'action' | 'revoke' | null>(null);
  // M2 R1：判定撤销——原因留痕（留空提交 null）+ 两步确认。
  const [revokeRemark, setRevokeRemark] = useState('');
  const [revokeConfirming, setRevokeConfirming] = useState(false);

  // UX-QC-R2-02：切换质检行清除上一单操作结果（结果横幅跨单粘滞）；
  // M2 R1 同口径清除撤销的确认步与原因输入。
  useEffect(() => {
    setOutcome(null);
    setOutcomeSource(null);
    setRevokeConfirming(false);
    setRevokeRemark('');
  }, [id]);

  // 拒文呈现前把英文类别 id 映射中文（UX-QC-R2-01；判定/复检/特采共用此卡）。
  const outcomeOf = (result: CommandOutcomeView): CommandOutcomeView =>
    result.committed || result.reason === null
      ? result
      : { ...result, reason: humanizeKindTokens(result.reason, t) };

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcomeSource('action');
      setOutcome(outcomeOf(result));
      if (result.committed) onChanged();
    },
    onError: (error) => {
      setOutcomeSource('action');
      setOutcome(
        outcomeOf({
          committed: false,
          status: 'error',
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  // M2 R1：判定撤销提交（独立 mutation——成功后清原因输入并读回，失败仅呈现
  // 服务端 reason，不引导重复提交）。
  const revokeMutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcomeSource('revoke');
      setOutcome(outcomeOf(result));
      if (result.committed) {
        setRevokeRemark('');
        onChanged();
      }
    },
    onError: (error) => {
      setOutcomeSource('revoke');
      setOutcome(
        outcomeOf({
          committed: false,
          status: 'error',
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  const payload = () => ({
    passedQty: Number(passedQty),
    failedQty: Number(failedQty),
    ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
  });

  // 特采视图（UX-QC-03）：不合格/已特采/剩余可特采——按钮可提交性按剩余量闸。
  const concessionView = concessionQuery.data ?? null;
  const remainingConcession =
    concessionView === null ? null : Number(concessionView['remainingConcessionQty'] ?? 0);
  // UX-QC-R2-01：类别前端闸——特采仅适用于非标件采购质检单，其余类别按钮
  // 直接禁用（不再依赖服务端拒文兜底）。
  const rowKind = String(row['kind'] ?? '');
  const concessionAllowedByKind = rowKind === 'nonstandard_purchase';
  const concessionSummary = !concessionAllowedByKind
    ? t('detail.concession.kind-not-allowed', { kind: inspectionKindLabel(rowKind, t) })
    : concessionView === null
      ? concessionQuery.isPending
        ? t('detail.concession.loading')
        : t('detail.concession.unavailable')
      : t('detail.concession.summary', {
          failed: String(concessionView['failedQty'] ?? '—'),
          granted: String(concessionView['concessionQuantity'] ?? '—'),
          remaining: String(concessionView['remainingConcessionQty'] ?? '—'),
        });

  // M2 R1：判定撤销写权限闸（inspection:judge，与后端撤销端点同码）。照
  // UX-VW-R2-01 派工页写权限闸投影模式——会话权限未就绪按禁用兜底（写面
  // fail-closed），admin 通配 bypass 由 sessionHasPermission 内含。
  const { data: permissionData } = usePermissions({});
  const canJudge =
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), INSPECTION_JUDGE_CODE);
  // M2 R1：适用状态闸（口径同服务端拒文——仅已质检单可撤；pending 未质检、
  // closed 闭环终态直接禁用并给同口径说明，不依赖服务端拒绝兜底）。
  const rowState = String(row['state'] ?? '');
  const revokable = rowState === 'passed' || rowState === 'failed';
  const revokeSummary = !canJudge
    ? t('detail.revoke.no-permission')
    : rowState === 'pending'
      ? t('detail.revoke.pending-state')
      : rowState === 'closed'
        ? t('detail.revoke.closed-state')
        : revokable
          ? t('detail.revoke.effect')
          : t('detail.revoke.not-supported');

  // M2 R1：确认撤销提交——原因留空（trim 后为空）提交 null，走服务端默认留痕。
  const handleRevoke = () => {
    setRevokeConfirming(false);
    const trimmed = revokeRemark.trim();
    revokeMutation.mutate(() =>
      revokeInspection(id, row, { remark: trimmed.length > 0 ? trimmed : null }),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.title')}</CardTitle>
        <CardDescription>{t('detail.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <InspectionDetailView detail={detailQuery.data ?? {}} />
        </QueryState>
        <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-passed">{t('detail.judge.passed-qty')}</Label>
            <Input id="insp-passed" type="number" min="0" step="1" value={passedQty} onChange={(e) => setPassedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-failed">{t('detail.judge.failed-qty')}</Label>
            <Input id="insp-failed" type="number" min="0" step="1" value={failedQty} onChange={(e) => setFailedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-remark">{t('detail.judge.remark')}</Label>
            <Input id="insp-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => judgeInspectionOrder(id, row, payload()))}
          >
            {t('detail.judge.judge')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => recheckInspectionOrder(id, row, payload()))}
          >
            {t('detail.judge.recheck')}
          </Button>
        </div>
        <div className="grid gap-2 border-t pt-4 sm:grid-cols-[minmax(12rem,auto)_1fr] sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-concession-qty">{t('detail.concession.quantity-label')}</Label>
            <Input
              id="insp-concession-qty"
              type="number"
              min="1"
              step="1"
              value={concessionQty}
              onChange={(e) => setConcessionQty(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{concessionSummary}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={
                mutation.isPending ||
                !concessionAllowedByKind ||
                remainingConcession === null ||
                remainingConcession <= 0 ||
                !(Number(concessionQty) >= 1)
              }
              onClick={() =>
                mutation.mutate(() => confirmConcession(id, row, { quantity: Number(concessionQty) }))
              }
            >
              {t('detail.concession.submit')}
            </Button>
          </div>
        </div>
        <div
          className="grid gap-2 border-t pt-4 sm:grid-cols-[minmax(12rem,auto)_1fr] sm:items-start"
          data-permission-code="inspection:judge"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-revoke-remark">{t('detail.revoke.remark-label')}</Label>
            <Input
              id="insp-revoke-remark"
              maxLength={2000}
              value={revokeRemark}
              disabled={!canJudge || !revokable}
              onChange={(e) => setRevokeRemark(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{revokeSummary}</p>
            {revokeConfirming ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs">{t('detail.revoke.confirm-text')}</p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" disabled={revokeMutation.isPending} onClick={handleRevoke}>
                    {t('detail.revoke.confirm')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revokeMutation.isPending}
                    onClick={() => setRevokeConfirming(false)}
                  >
                    {t('detail.revoke.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={revokeMutation.isPending || !canJudge || !revokable}
                onClick={() => {
                  setOutcome(null);
                  setRevokeConfirming(true);
                }}
              >
                {t('detail.revoke.submit')}
              </Button>
            )}
          </div>
        </div>
        {outcome !== null && (
          <div className="flex flex-col gap-1">
            <CommandOutcomeHint outcome={outcome} />
            {outcomeSource === 'revoke' && !outcome.committed && (
              <p className="text-xs text-muted-foreground">{t('detail.revoke.retry-hint')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateInspectionCard({ onChanged }: { readonly onChanged: () => void }) {
  const { t } = useTranslation('inspection');
  const [kind, setKind] = useState<(typeof INSPECTION_KINDS)[number]['value']>('self_outsourced');
  const [quantity, setQuantity] = useState('1');
  const [sourceType, setSourceType] = useState('');
  const [sourceRefId, setSourceRefId] = useState('');
  const [itemId, setItemId] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createInspectionOrder({
        kind,
        quantity: Number(quantity),
        ...(sourceType.trim().length > 0 ? { sourceType: sourceType.trim() } : {}),
        ...(sourceRefId.trim().length > 0 ? { sourceRefId: sourceRefId.trim() } : {}),
        ...(itemId.trim().length > 0 ? { itemId: itemId.trim() } : {}),
        ...(drawingNo.trim().length > 0 ? { drawingNo: drawingNo.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        onChanged();
        setQuantity('1');
        setSourceType('');
        setSourceRefId('');
        setItemId('');
        setDrawingNo('');
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
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('create.title')}</CardTitle>
        <CardDescription>{t('create.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-kind">{t('create.kind-label')}</Label>
            <Select id="insp-new-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {INSPECTION_KINDS.map((entry) => (
                <option key={entry.value} value={entry.value}>{t(`kind.${entry.key}`)}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-qty">{t('create.quantity-label')}</Label>
            <Input id="insp-new-qty" type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-source-type">{t('create.source-type-label')}</Label>
            <Select id="insp-new-source-type" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              <option value="">{t('source.manual')}</option>
              <option value="report">{t('create.source-option.report')}</option>
              <option value="dispatch">{t('create.source-option.dispatch')}</option>
              <option value="receipt">{t('create.source-option.receipt')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-source-ref">{t('create.source-ref-label')}</Label>
            <Input id="insp-new-source-ref" value={sourceRefId} onChange={(e) => setSourceRefId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-item">{t('create.item-label')}</Label>
            <Input id="insp-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-drawing">{t('create.drawing-label')}</Label>
            <Input id="insp-new-drawing" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
          </div>
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={mutation.isPending || Number(quantity) < 0}>
              {t('create.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
