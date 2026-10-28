/**
 * 工作令管理页（S2 批次）：九态主列表（状态过滤）+ 建令表单 + 行选中详情面板
 * （详情/项目进度/机加工进度/装配调试进度 + 流转/关闭/附件/齐套刷新操作）+
 * 齐套看板。端点能力按 workorder.controllers.ts 实态，不造后端没有的功能。
 * 覆盖矩阵 #24 工作令信息 / #25 建令 / #27-29 进度 / #30 齐套看板。
 * UX-PLAN-01：建令表单补 项目经理/销售（用户 id）；详情人话展示两字段——
 * 配件申请一级审批人 = 项目经理（空回落销售），填齐即解锁配件 L1 审批链。
 * UX-PLAN-05：可见文案不出现接口路径/命令名/内部字段名/英文枚举原文。
 * M2-R1 岗位入口补齐：详情操作区新增「清单」「缺口核查」跳转入口——带所选
 * 工作令直达两目标页（目标页经 ?wo= 初始化），菜单同码权限闸
 * （listing:read / gap:read，会话权限未就绪或无权限不渲染入口）。
 * i18n 波 2（ADR-0012 / proposal §8）：系统 chrome 文案接 workorder namespace
 * t()（zh-CN 权威源=本文案原文；业务数据与服务端 message 不翻译）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
// i18n 波 2：workorder namespace 绑定（namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import {
  attachToWorkOrder,
  closeWorkOrder,
  createWorkOrder,
  getAssemblyProgress,
  getMachiningProgress,
  getWorkOrderDetail,
  getWorkOrderProgress,
  listWorkOrders,
  refreshKitCheck,
  transitionWorkOrder,
} from '../../data/workorderApi';
import { getKitBoard } from '../../data/workorderApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, type TableColumn } from '../../components/ModuleTable';
// D-WO-05：工作令详情挂图纸清单入口（钉版引用三态 + 图纸库跳转——行级改动）。
import { WorkOrderDrawingsCard } from '../drawing/WorkOrderDrawingsCard';
// P2 横切批：时刻本地化/长 id 截断显示（UX-PLAN-07/08；行数据不动，title 悬停全文）。
import { formatLocalDateTime } from '@/lib/format';
// UX-PLAN-R2-04：项目经理/销售候选（datalist）与展示名解析（目录缺失静默回退手填）。
import { useUserDirectory } from './userDirectory';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 九态（workorder-config WORK_ORDER_STATE_IDS 实态；中文标签词源同配置目录）。 */
const WORK_ORDER_STATES = [
  'not_started',
  'in_progress',
  'ready_to_ship',
  'shipped',
  'in_acceptance',
  'in_maintenance',
  'in_aftermarket',
  'completed',
  'closed',
] as const;

/** 九态标签 i18n key 映射（值取 workorder namespace；未知态回落原 id）。 */
const WO_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  not_started: 'state.not-started',
  in_progress: 'state.in-progress',
  ready_to_ship: 'state.ready-to-ship',
  shipped: 'state.shipped',
  in_acceptance: 'state.in-acceptance',
  in_maintenance: 'state.in-maintenance',
  in_aftermarket: 'state.in-aftermarket',
  completed: 'state.completed',
  closed: 'state.closed',
};

function woStateLabel(state: unknown, t: TFunction): string {
  const id = state === null || state === undefined ? '' : String(state);
  const key = WO_STATE_LABEL_KEYS[id];
  return key === undefined ? id : t(key);
}

/** M2-R1 清单/缺口核查入口门禁码（与菜单 listing-sheets / listing-gap-checks 同码）。 */
const LISTING_READ_CODE = permissionCode('listing:read');
const GAP_READ_CODE = permissionCode('gap:read');

/** 列头文案走 workorder namespace（i18n 波 2；列结构不变）。 */
function listColumns(t: TFunction): readonly TableColumn[] {
  return [
    { key: 'id', label: t('orders.columns.id'), mono: true, format: 'shortId' },
    { key: 'projectName', label: t('orders.columns.project-name') },
    { key: 'state', label: t('orders.columns.state') },
    { key: 'customerRef', label: t('orders.columns.customer-reference'), mono: true },
    { key: 'plannedDeliveryAt', label: t('orders.columns.planned-delivery'), format: 'datetime' },
    { key: 'objectVersion', label: t('orders.columns.version'), mono: true },
    { key: 'createdAt', label: t('orders.columns.created-at'), format: 'datetime' },
  ];
}

/** 列表行：状态列显示中文（其余字段原样）。 */
function displayOrderRows(
  rows: readonly Record<string, unknown>[],
  t: TFunction,
): readonly Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, state: woStateLabel(row['state'], t) }));
}

/** 键值说明列表（人话详情：标签取业务词汇，值缺省「—」）。 */
function LabeledList({ entries }: { readonly entries: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export function WorkOrdersPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('workorder');
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // UX-PLAN-R2-04：用户候选池（datalist——手填兼容，无 user:read/无数据时
  // 静默回退纯手填，不阻断建单；候选只做提示，不改变提交载荷语义）。
  const userDirectory = useUserDirectory();

  const ordersQuery = useQuery({
    queryKey: ['workorder', 'orders', stateFilter],
    queryFn: () => listWorkOrders(stateFilter === '' ? {} : { state: stateFilter }),
  });

  const createMutation = useMutation({
    mutationFn: createWorkOrder,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workorder'] }),
  });

  const [projectName, setProjectName] = useState('');
  const [customerRef, setCustomerRef] = useState('');
  const [manager, setManager] = useState('');
  const [salesRep, setSalesRep] = useState('');
  const [plannedDeliveryAt, setPlannedDeliveryAt] = useState('');

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      {
        projectName,
        ...(customerRef.trim().length > 0 ? { customerRef: customerRef.trim() } : {}),
        ...(manager.trim().length > 0 ? { manager: manager.trim() } : {}),
        ...(salesRep.trim().length > 0 ? { salesRep: salesRep.trim() } : {}),
        ...(plannedDeliveryAt.trim().length > 0 ? { plannedDeliveryAt: plannedDeliveryAt.trim() } : {}),
      },
      {
        onSuccess: () => {
          setProjectName('');
          setCustomerRef('');
          setManager('');
          setSalesRep('');
          setPlannedDeliveryAt('');
        },
      },
    );
  }

  const selectedRow =
    ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* UX-PLAN-R2-04：页面级用户候选池（datalist 由建令表单两输入以 list 属性引用） */}
      <datalist id="workorder-user-options">
        {[...userDirectory.entries()].map(([userId, displayName]) => (
          <option key={userId} value={userId}>
            {displayName}
          </option>
        ))}
      </datalist>
      <Card>
        <CardHeader>
          <CardTitle>{t('orders.title')}</CardTitle>
          <CardDescription>
            {t('orders.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="wo-state-filter">{t('orders.filter.label')}</Label>
            <Select
              id="wo-state-filter"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="">{t('orders.filter.all-states')}</option>
              {WORK_ORDER_STATES.map((state) => (
                <option key={state} value={state}>{woStateLabel(state, t)}</option>
              ))}
            </Select>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty={t('orders.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              rows={displayOrderRows(ordersQuery.data ?? [], t)}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <WorkOrderDetailPanel
          row={selectedRow}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['workorder'] })}
        />
      )}

      <KitBoardCard />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('create.title')}</CardTitle>
          <CardDescription>
            {t('create.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-project">{t('create.project-name')}</Label>
              <Input id="wo-project" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder={t('create.project-name-placeholder')} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-customer">{t('create.customer-reference')}</Label>
              <Input id="wo-customer" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} placeholder={t('create.customer-reference-placeholder')} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-manager">{t('create.manager')}</Label>
              <Input id="wo-manager" list="workorder-user-options" value={manager} onChange={(e) => setManager(e.target.value)} placeholder={t('create.candidate-placeholder')} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-sales">{t('create.sales-rep')}</Label>
              <Input id="wo-sales" list="workorder-user-options" value={salesRep} onChange={(e) => setSalesRep(e.target.value)} placeholder={t('create.candidate-placeholder')} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-delivery">{t('create.planned-delivery')}</Label>
              <Input id="wo-delivery" value={plannedDeliveryAt} onChange={(e) => setPlannedDeliveryAt(e.target.value)} placeholder={t('create.planned-delivery-placeholder')} />
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {t('create.failed', {
                  message: createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error),
                })}
              </p>
            )}
            {createMutation.data !== undefined && (
              <div className="sm:col-span-2">
                <CommandOutcomeHint outcome={createMutation.data} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || projectName.trim().length === 0}>
                {t('create.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** 选中工作令的操作/进度面板。 */
function WorkOrderDetailPanel({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const id = String(row['id']);
  const navigate = useNavigate();
  const { t } = useTranslation('workorder');
  // M2-R1：岗位入口权限闸（照 WorkbenchPage/DispatchOrdersPage 投影判定口径
  // ——会话权限未就绪按无权限兜底，入口不渲染；admin 通配由 sessionHasPermission 内含）。
  const { data: permissionData } = usePermissions({});
  const canOpenListings =
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), LISTING_READ_CODE);
  const canOpenGapChecks =
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), GAP_READ_CODE);
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  const [targetState, setTargetState] = useState('');
  const [remark, setRemark] = useState('');

  const detailQuery = useQuery({
    queryKey: ['workorder', 'detail', id],
    queryFn: () => getWorkOrderDetail(id),
  });
  const progressQuery = useQuery({
    queryKey: ['workorder', 'progress', id],
    queryFn: () => getWorkOrderProgress(id),
  });
  const machiningQuery = useQuery({
    queryKey: ['workorder', 'machining', id],
    queryFn: () => getMachiningProgress(id),
  });
  const assemblyQuery = useQuery({
    queryKey: ['workorder', 'assembly', id],
    queryFn: () => getAssemblyProgress(id),
  });

  const run = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) onChanged();
    },
    onError: (error) => setOutcome({
      committed: false,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    }),
  });

  function handleTransition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (targetState === '') return;
    run.mutate(() => transitionWorkOrder(id, row, { targetState, remark: remark.trim().length > 0 ? remark.trim() : undefined }));
  }

  const detail = detailQuery.data;
  const order = (detail?.['order'] ?? null) as Record<string, unknown> | null;
  const attachments = Array.isArray(detail?.['attachments'])
    ? (detail?.['attachments'] as readonly Record<string, unknown>[])
    : [];
  const latestKitCheck = (detail?.['latestKitCheck'] ?? null) as Record<string, unknown> | null;
  const milestones = Array.isArray(detail?.['milestones'])
    ? (detail?.['milestones'] as readonly Record<string, unknown>[])
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.title')}</CardTitle>
        <CardDescription>{t('detail.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          {order !== null && (
            <div className="flex flex-col gap-4">
              <LabeledList
                entries={[
                  [t('detail.fields.project-name'), textOf(order['projectName'])],
                  [t('detail.fields.customer'), textOf(detail?.['customerName'] ?? order['customerRef'])],
                  [t('detail.fields.manager'), textOf(order['manager'])],
                  [t('detail.fields.sales-rep'), textOf(order['salesRep'])],
                  [t('detail.fields.current-state'), woStateLabel(order['state'], t)],
                  [t('detail.fields.planned-delivery'), formatLocalDateTime(order['plannedDeliveryAt'])],
                  [t('detail.fields.packaging-arrival'), formatLocalDateTime(order['packagingArrivalAt'])],
                  [t('detail.fields.created-at'), formatLocalDateTime(order['createdAt'])],
                ]}
              />
              {(order['manager'] === null || order['salesRep'] === null) && (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  {order['manager'] === null && order['salesRep'] === null
                    ? t('detail.warning.both-missing')
                    : order['manager'] === null
                      ? t('detail.warning.manager-missing')
                      : t('detail.warning.sales-missing')}
                </p>
              )}
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t('detail.attachments.heading', { n: attachments.length })}</p>
                {attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('detail.attachments.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {attachments.map((attachment) => (
                      <li key={String(attachment['id'])} className="break-all">
                        {textOf(attachment['name'])}
                        <span className="text-muted-foreground">{t('detail.attachments.attached-at', { time: formatLocalDateTime(attachment['attachedAt']) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t('detail.kit-check.heading')}</p>
                {latestKitCheck === null ? (
                  <p className="text-sm text-muted-foreground">{t('detail.kit-check.empty')}</p>
                ) : (
                  <p className="text-sm">
                    {latestKitCheck['complete'] === true
                      ? t('detail.kit-check.complete')
                      : t('detail.kit-check.gaps', { n: Array.isArray(latestKitCheck['gapLines']) ? latestKitCheck['gapLines'].length : 0 })}
                    <span className="text-muted-foreground">{t('detail.kit-check.refreshed-at', { time: formatLocalDateTime(latestKitCheck['refreshedAt']) })}</span>
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t('detail.transitions-log.heading')}</p>
                {milestones.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('detail.transitions-log.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {milestones.map((milestone, index) => (
                      <li key={`${String(milestone['at'])}-${index}`}>
                        {woStateLabel(milestone['from'], t)} → {woStateLabel(milestone['to'], t)}
                        <span className="text-muted-foreground">{t('detail.transitions-log.entry-meta', { time: formatLocalDateTime(milestone['at']), actor: textOf(milestone['actor']) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {order === null && detail !== undefined && (
            <p className="text-sm text-muted-foreground">{t('detail.no-data')}</p>
          )}
        </QueryState>

        <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={handleTransition}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wo-transition-target">{t('detail.transition.target-state')}</Label>
            <Select id="wo-transition-target" value={targetState} onChange={(e) => setTargetState(e.target.value)}>
              <option value="">{t('detail.transition.target-state-placeholder')}</option>
              {WORK_ORDER_STATES.map((state) => (
                <option key={state} value={state}>{woStateLabel(state, t)}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wo-transition-remark">{t('detail.transition.remark')}</Label>
            <Input id="wo-transition-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={t('detail.transition.remark-placeholder')} />
          </div>
          <Button type="submit" disabled={run.isPending || targetState === ''}>{t('detail.transition.submit')}</Button>
        </form>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => closeWorkOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            {t('detail.actions.close')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => attachToWorkOrder(id, row, {
              name: `附件-${new Date().toISOString().slice(0, 10)}`,
              kind: 'drawing',
              ref: `web-attach-${id}`,
            }))}
          >
            {t('detail.actions.attach-drawing')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => refreshKitCheck(id, row))}
          >
            {t('detail.actions.refresh-kit-check')}
          </Button>
          {/* M2-R1：岗位入口——带所选工作令直达清单/缺口核查页（目标页 ?wo= 初始化，
              计划岗主路径无需手工查找、复制内部编号）。 */}
          {canOpenListings && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/listings/sheets?wo=${encodeURIComponent(id)}`)}
            >
              {t('detail.actions.listing')}
            </Button>
          )}
          {canOpenGapChecks && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/listings/gap-checks?wo=${encodeURIComponent(id)}`)}
            >
              {t('detail.actions.gap-check')}
            </Button>
          )}
        </div>

        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        {run.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('detail.action-failed', {
              message: run.error instanceof Error ? run.error.message : String(run.error),
            })}
          </p>
        )}

        <ProgressCards
          progress={progressQuery.data ?? null}
          progressPending={progressQuery.isPending}
          progressError={progressQuery.error}
          machining={machiningQuery}
          assembly={assemblyQuery}
        />

        {/* D-WO-05：图纸清单入口（消费 drawing 域端点；查看动作经图纸库留痕路径）。 */}
        <WorkOrderDrawingsCard workOrderId={id} />
      </CardContent>
    </Card>
  );
}

/** 进度三卡（项目进度说明列表 + 机加工/装配工序上卷表；状态列中文化）。 */
function ProgressCards({
  progress,
  progressPending,
  progressError,
  machining,
  assembly,
}: {
  readonly progress: Record<string, unknown> | null;
  readonly progressPending: boolean;
  readonly progressError: unknown;
  readonly machining: { readonly isPending: boolean; readonly error: unknown; readonly data: Record<string, unknown> | undefined };
  readonly assembly: { readonly isPending: boolean; readonly error: unknown; readonly data: Record<string, unknown> | undefined };
}) {
  const { t } = useTranslation('workorder');
  /** 进度三态标签 key 映射（progress-status.*；未知态回落原 id）。 */
  const PROGRESS_STATUS_LABEL_KEYS: Readonly<Record<string, string>> = {
    pending: 'progress-status.pending',
    in_progress: 'progress-status.in-progress',
    done: 'progress-status.done',
  };
  const progressStatus = (value: unknown): string => {
    const id = value === null || value === undefined ? '' : String(value);
    const key = PROGRESS_STATUS_LABEL_KEYS[id];
    return key === undefined ? id : t(key);
  };
  const machiningRows = machiningTable(machining.data);
  const assemblyRows = assemblyTable(assembly.data);
  return (
    <div className="flex flex-col gap-6">
      <QueryState isPending={progressPending} error={progressError} isEmpty={false}>
        {progress !== null && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('progress.project-heading')}</p>
            <LabeledList
              entries={[
                [t('progress.fields.project-name'), textOf(progress['projectName'])],
                [t('progress.fields.current-state'), woStateLabel(progress['state'], t)],
                // UX-PLAN-R2-01：进度卡时刻本地化（此前直出原始 …Z 串，W5 遗漏点）。
                [t('progress.fields.planned-delivery'), formatLocalDateTime(progress['plannedDeliveryAt'])],
                [t('progress.fields.packaging-arrival'), formatLocalDateTime(progress['packagingArrivalAt'])],
                [
                  t('progress.fields.days-to-delivery'),
                  progress['daysToDelivery'] === null || progress['daysToDelivery'] === undefined
                    ? '—'
                    : `${t('progress.days', { days: progress['daysToDelivery'] })}${Number(progress['daysToDelivery']) < 0 ? t('progress.overdue') : ''}`,
                ],
              ]}
            />
          </div>
        )}
      </QueryState>
      <QueryState isPending={machining.isPending} error={machining.error} isEmpty={false}>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('progress.machining-heading')}</p>
          {machiningRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('progress.machining-empty')}</p>
          ) : (
            <ModuleTable
              columns={[
                { key: 'drawingNo', label: t('progress.columns.drawing-no'), mono: true },
                { key: 'operationId', label: t('progress.columns.operation'), mono: true },
                { key: 'doneQty', label: t('progress.columns.done-quantity') },
                { key: 'totalQty', label: t('progress.columns.planned-quantity') },
                { key: 'status', label: t('progress.columns.status') },
              ]}
              rows={machiningRows.map((entry) => ({ ...entry, status: progressStatus(entry['status']) }))}
            />
          )}
        </div>
      </QueryState>
      <QueryState isPending={assembly.isPending} error={assembly.error} isEmpty={false}>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('progress.assembly-heading')}</p>
          {assemblyRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('progress.assembly-empty')}</p>
          ) : (
            <ModuleTable
              columns={[
                { key: 'operationId', label: t('progress.columns.operation'), mono: true },
                { key: 'doneQty', label: t('progress.columns.done-quantity') },
                { key: 'totalQty', label: t('progress.columns.planned-quantity') },
                { key: 'status', label: t('progress.columns.status') },
              ]}
              rows={assemblyRows.map((entry) => ({ ...entry, status: progressStatus(entry['status']) }))}
            />
          )}
        </div>
      </QueryState>
    </div>
  );
}

function machiningTable(view: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  return Array.isArray(view?.['rows']) ? (view?.['rows'] as readonly Record<string, unknown>[]) : [];
}

function assemblyTable(view: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  return Array.isArray(view?.['rows']) ? (view?.['rows'] as readonly Record<string, unknown>[]) : [];
}

/** 齐套看板（每工作令最新快照 + 缺口下钻）。 */
function KitBoardCard() {
  const { t } = useTranslation('workorder');
  const kitBoardQuery = useQuery({ queryKey: ['workorder', 'kit-board'], queryFn: getKitBoard });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('kit-board.title')}</CardTitle>
        <CardDescription>{t('kit-board.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState
          isPending={kitBoardQuery.isPending}
          error={kitBoardQuery.error}
          isEmpty={kitBoardQuery.data !== undefined && kitBoardQuery.data.length === 0}
          empty={t('kit-board.empty')}
        >
          <ModuleTable
            columns={[
              { key: 'workOrderId', label: t('kit-board.columns.work-order'), mono: true, format: 'shortId' },
              { key: 'projectName', label: t('kit-board.columns.project-name') },
              { key: 'complete', label: t('kit-board.columns.result') },
              { key: 'refreshedAt', label: t('kit-board.columns.refreshed-at'), format: 'datetime' },
              { key: 'gapLineCount', label: t('kit-board.columns.gap-lines') },
            ]}
            rows={(kitBoardQuery.data ?? []).map((row) => ({
              ...row,
              complete: row['complete'] === true
                ? t('kit-board.complete')
                : t('kit-board.gaps', { n: Array.isArray(row['gapLines']) ? row['gapLines'].length : 0 }),
              gapLineCount: Array.isArray(row['gapLines']) ? row['gapLines'].length : 0,
            }))}
          />
        </QueryState>
      </CardContent>
    </Card>
  );
}
