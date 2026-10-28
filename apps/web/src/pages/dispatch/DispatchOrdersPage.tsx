/**
 * 派工管理页（S2 批次）：六类派工单列表（kind/状态/工作令/执行人过滤）+ 建单
 * 表单（六类判别）+ 选中单详情 + 派工/开工/完工/撤销操作 + 按人任务视图。
 * 覆盖矩阵 #38-43（零件/外协/装配/电气/售后/零工派工）。
 * fix-wave-6 6a-1：页眉五态状态统计（不可点击筛选）+ 多单批量派工下发/批量删除
 * （非待下发置灰、装配/电气/零工/售后批量删除豁免）+ 执行中转单（换执行人/工序）。
 *
 * W10b Round-2 缺陷批：创建派工单卡写权限闸（UX-VW-R2-01——无 dispatch:write
 * 会话表单禁用+人话说明，权限码只留 data 属性；照 WorkbenchPage/m pageAccess
 * usePermissions 投影模式，会话权限未就绪按禁用兜底）；列表/批操作/任务视图
 * 类别与状态列中文（UX-PRD-R2-01/03——W9 只改了状态，类别补齐）；详情创建/
 * 更新与流转时刻本地化（UX-PRD-R2-02，formatLocalDateTime）；页面英文/技术词
 * 扫尾（UX-PRD-R2-03——状态链路/撤销按钮/列头/占位/说明）；建单成功回显短码
 * 单号（UX-PRD-R2-04，W9 移动报工同模式，title 悬停全文）。
 *
 * i18n 波 2（ADR-0012 / proposal §8）：页面 chrome 文案接 dispatch namespace
 * t()（zh-CN 权威源=本文案原文；业务数据与服务端 message 不翻译；namespace
 * 注册与 shell init 由总控统一接线）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：dispatch namespace 绑定（namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import {
  assignDispatchOrder,
  batchAssignDispatchOrders,
  batchCancelDispatchOrders,
  cancelDispatchOrder,
  completeDispatchOrder,
  createDispatchOrder,
  dispatchEquipmentOptions,
  getDispatchDetail,
  getDispatchOrderStats,
  listDispatchOrders,
  listTasksByAssignee,
  listTasksByWorkOrder,
  startDispatchOrder,
  transferDispatchOrder,
} from '../../data/dispatchApi';
import { listWorkOrders } from '../../data/workorderApi';
import { listOrgUsers } from '../../data/orgApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, type TableColumn } from '../../components/ModuleTable';
import { formatLocalDateTime, shortId } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 建单写权限码（UX-VW-R2-01：与后端 POST /dispatch/orders @RequirePermission 同码）。 */
const DISPATCH_WRITE_CODE = permissionCode('dispatch:write');

/** 六类 id（i18n 波 2：label 经 dispatch namespace kind.* 取文案）。 */
const DISPATCH_KINDS = ['part', 'outsourcing', 'assembly', 'electrical', 'aftermarket', 'oddjob'] as const;

const DISPATCH_STATES = ['draft', 'assigned', 'executing', 'done', 'cancelled'] as const;

/** 批量删除豁免集（RREQ-DP-032 逐类豁免口径：仅零件/外协提供批量删除）。 */
const BATCH_DELETABLE_KINDS = new Set(['part', 'outsourcing']);

/** 六类 label key 映射（未知 id 原样返回；与建单表单同口径）。 */
const KIND_LABEL_KEYS: Readonly<Record<string, string>> = {
  part: 'kind.part',
  outsourcing: 'kind.outsourcing',
  assembly: 'kind.assembly',
  electrical: 'kind.electrical',
  aftermarket: 'kind.aftermarket',
  oddjob: 'kind.oddjob',
};

/** 五态 label key 映射（未知 id 原样返回；与后端 dispatch-config 状态目录同口径）。 */
const STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  draft: 'state.draft',
  assigned: 'state.assigned',
  executing: 'state.executing',
  done: 'state.done',
  cancelled: 'state.cancelled',
};

/** 迁移事件 label key 映射（未知 id 原样返回；与后端派工状态机五条迁移同口径）。 */
const EVENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  ASSIGN: 'event.assign',
  START: 'event.start',
  COMPLETE: 'event.complete',
  CANCEL: 'event.cancel',
};

function dispatchStateLabel(state: string, t: TFunction): string {
  const key = STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function dispatchEventLabel(event: string, t: TFunction): string {
  const key = EVENT_LABEL_KEYS[event];
  return key === undefined ? event : t(key);
}

function dispatchKindLabel(kind: string, t: TFunction): string {
  const key = KIND_LABEL_KEYS[kind];
  return key === undefined ? kind : t(key);
}

/** 列表列（i18n 波 2：label 经 t() 取 dispatch namespace column.*）。 */
function listColumns(t: TFunction): readonly TableColumn[] {
  return [
    { key: 'id', label: t('column.id'), mono: true, format: 'shortId' },
    { key: 'kind', label: t('column.kind'), mono: true },
    { key: 'state', label: t('column.state'), mono: true },
    { key: 'workOrderId', label: t('column.work-order'), mono: true },
    { key: 'drawingNo', label: t('column.drawing-number'), mono: true },
    { key: 'operationCode', label: t('column.operation'), mono: true },
    { key: 'assignee', label: t('column.assignee'), mono: true },
    { key: 'quantity', label: t('column.quantity') },
    { key: 'objectVersion', label: t('column.version'), mono: true },
  ];
}

/**
 * 列表显示行：状态+类别列翻中文（UX-PRD-04 状态 / UX-PRD-R2-01 类别；i18n
 * 波 2 经 t() 取文案）。显示层替换——行选中取 id、详情/批操作读原始行，乐观锁
 * 与操作资格判断不受影响。
 */
function dispatchDisplayRowOf(row: Record<string, unknown>, t: TFunction): Record<string, unknown> {
  const mapText = (key: string, labelOf: (value: string, t: TFunction) => string): unknown => {
    const value = row[key];
    return typeof value === 'string' && value.length > 0 ? labelOf(value, t) : value;
  };
  return {
    ...row,
    kind: mapText('kind', dispatchKindLabel),
    state: mapText('state', dispatchStateLabel),
  };
}

export function DispatchOrdersPage() {
  const { t } = useTranslation('dispatch');
  const queryClient = useQueryClient();
  const { data: lookupPermissions } = usePermissions({});
  const lookupCodes = toPermissionCodes(lookupPermissions);
  const canReadWorkorders = sessionHasPermission(lookupCodes, permissionCode('workorder:read'));
  const canReadUsers = sessionHasPermission(lookupCodes, permissionCode('user:read'));
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // UX-PRD-09：工作令/执行人业务选择器候选（datalist——手填兼容，权限不足/无数据
  // 静默回退纯手填，不阻断建单）。候选只做提示，不改变提交载荷语义。
  const workOrderOptionsQuery = useQuery({
    queryKey: ['workorder', 'orders', 'options'],
    queryFn: () => listWorkOrders().catch(() => []),
    enabled: canReadWorkorders,
    staleTime: 60_000,
  });
  const userOptionsQuery = useQuery({
    queryKey: ['org', 'users', 'options'],
    queryFn: () => listOrgUsers().catch(() => []),
    enabled: canReadUsers,
    staleTime: 60_000,
  });

  const ordersQuery = useQuery({
    queryKey: ['dispatch', 'orders', kindFilter, stateFilter, workOrderIdFilter, assigneeFilter],
    queryFn: () =>
      listDispatchOrders({
        ...(kindFilter === '' ? {} : { kind: kindFilter }),
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
        ...(assigneeFilter.trim() === '' ? {} : { assignee: assigneeFilter.trim() }),
      }),
  });

  const selectedRow = ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['dispatch'] });
  };

  return (
    <div className="flex flex-col gap-6">
      {(!canReadWorkorders || !canReadUsers) && <p role="note" className="text-sm text-muted-foreground">当前账号缺少部分候选读取权限，请由计划或管理员提供工作令和人员编号；提交仍按原业务权限校验。</p>}
      {/* UX-PRD-09：页面级候选池（datalist 由各手填输入以 list 属性引用） */}
      <datalist id="dispatch-wo-options">
        {(workOrderOptionsQuery.data ?? []).map((row) => (
          <option key={String(row['id'])} value={String(row['id'])}>
            {String(row['projectName'] ?? row['title'] ?? '')}
          </option>
        ))}
      </datalist>
      <datalist id="dispatch-user-options">
        {(userOptionsQuery.data ?? []).map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName || user.username}
          </option>
        ))}
      </datalist>
      <StatusStatsCard
        filters={{
          ...(kindFilter === '' ? {} : { kind: kindFilter }),
          ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
          ...(assigneeFilter.trim() === '' ? {} : { assignee: assigneeFilter.trim() }),
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t('list.title')}</CardTitle>
          <CardDescription>{t('list.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-kind-filter">{t('list.kind-filter')}</Label>
              <Select id="disp-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">{t('list.kind-all')}</option>
                {DISPATCH_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{dispatchKindLabel(kind, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-state-filter">{t('list.state-filter')}</Label>
              <Select id="disp-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">{t('list.state-all')}</option>
                {/* UX-PRD-04：选项中文与详情视图状态映射同源（option value 仍为状态 id，过滤语义不变） */}
                {DISPATCH_STATES.map((state) => (
                  <option key={state} value={state}>{dispatchStateLabel(state, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-wo-filter">{t('list.wo-filter')}</Label>
              <Input id="disp-wo-filter" value={workOrderIdFilter} list="dispatch-wo-options" onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-assignee-filter">{t('list.assignee-filter')}</Label>
              <Input id="disp-assignee-filter" value={assigneeFilter} list="dispatch-user-options" onChange={(e) => setAssigneeFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty={t('list.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              /* UX-PRD-04/UX-PRD-R2-01：状态+类别列中文（同详情视图映射；显示层替换
               * ——行选中取 id、详情/批操作读原始行 state/kind，乐观锁与操作资格
               * 判断不受影响）。单号列短码（UX-PRD-R2-04），title 悬停全文。 */
              rows={(ordersQuery.data ?? []).map((row) => dispatchDisplayRowOf(row, t))}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      <BatchOperationsCard rows={ordersQuery.data ?? []} onChanged={invalidate} />

      {selectedRow !== null && (
        <DispatchDetailCard
          row={selectedRow}
          onChanged={invalidate}
        />
      )}

      <CreateDispatchCard onChanged={invalidate} />
      <TasksCard />
    </div>
  );
}

/** 页眉状态统计（RREQ-DP-032：五态计数、不可点击筛选、口径随当前搜索）。 */
function StatusStatsCard({
  filters,
}: {
  readonly filters: { readonly kind?: string; readonly workOrderId?: string; readonly assignee?: string };
}) {
  const { t } = useTranslation('dispatch');
  const statsQuery = useQuery({
    queryKey: ['dispatch', 'stats', filters.kind ?? '', filters.workOrderId ?? '', filters.assignee ?? ''],
    queryFn: () => getDispatchOrderStats(filters),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stats.title')}</CardTitle>
        <CardDescription>{t('stats.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState isPending={statsQuery.isPending} error={statsQuery.error} isEmpty={false}>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {DISPATCH_STATES.map((key) => (
              <span key={key}>
                {dispatchStateLabel(key, t)}：<span className="font-mono">{String(statsQuery.data?.[key] ?? '—')}</span>
              </span>
            ))}
          </div>
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** 批操作面（RREQ-DP-032）：多单批量派工下发 / 批量删除——非待下发行勾选即置灰。 */
function BatchOperationsCard({
  rows,
  onChanged,
}: {
  readonly rows: readonly Record<string, unknown>[];
  readonly onChanged: () => void;
}) {
  const { t } = useTranslation('dispatch');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);
  const [assignee, setAssignee] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);

  const selectedIds = new Set(selected.map((row) => String(row['id'])));
  const allDraft = selected.length > 0 && selected.every((row) => String(row['state']) === 'draft');
  const allDeletable =
    allDraft && selected.every((row) => BATCH_DELETABLE_KINDS.has(String(row['kind'])));

  const toggle = (row: Record<string, unknown>): void => {
    setSelected((current) =>
      current.some((item) => String(item['id']) === String(row['id']))
        ? current.filter((item) => String(item['id']) !== String(row['id']))
        : [...current, row],
    );
  };

  const itemsOf = (): { id: string; expectedRevision: number }[] =>
    selected.map((row) => ({
      id: String(row['id']),
      expectedRevision: Number(row['objectVersion']),
    }));

  const assignMutation = useMutation({
    mutationFn: () => batchAssignDispatchOrders({ assignee: assignee.trim(), items: itemsOf() }),
    onSuccess: (result) => {
      setOutcome(
        result.committed
          ? t('batch.assign-done', {
              ok: result.items.filter((item) => item['status'] === 'committed').length,
              total: result.items.length,
            })
          : t('batch.assign-rejected', { reason: result.reason ?? t('batch.unknown-reason') }),
      );
      if (result.committed) {
        setSelected([]);
        setAssignee('');
        onChanged();
      }
    },
    onError: (error) =>
      setOutcome(t('batch.assign-failed', { message: error instanceof Error ? error.message : String(error) })),
  });

  const cancelMutation = useMutation({
    mutationFn: () => batchCancelDispatchOrders({ items: itemsOf() }),
    onSuccess: (result) => {
      setOutcome(
        result.committed
          ? t('batch.delete-done', {
              ok: result.items.filter((item) => item['status'] === 'committed').length,
              total: result.items.length,
            })
          : t('batch.delete-rejected', { reason: result.reason ?? t('batch.unknown-reason') }),
      );
      if (result.committed) {
        setSelected([]);
        onChanged();
      }
    },
    onError: (error) =>
      setOutcome(t('batch.delete-failed', { message: error instanceof Error ? error.message : String(error) })),
  });

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('batch.title')}</CardTitle>
        <CardDescription>{t('batch.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">{t('column.select')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.id')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.kind')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.state')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.drawing-number')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.operation')}</th>
                <th className="py-2 pr-4 font-medium">{t('column.batch-eligibility')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = String(row['id']);
                const draft = String(row['state']) === 'draft';
                const deletable = draft && BATCH_DELETABLE_KINDS.has(String(row['kind']));
                return (
                  <tr key={id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">
                      <input
                        type="checkbox"
                        aria-label={t('batch.select-aria', { id })}
                        checked={selectedIds.has(id)}
                        disabled={!draft}
                        onChange={() => toggle(row)}
                      />
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs" title={id}>{shortId(id)}</td>
                    <td className="py-2 pr-4 text-xs">{dispatchKindLabel(String(row['kind']), t)}</td>
                    <td className="py-2 pr-4 text-xs">{dispatchStateLabel(String(row['state']), t)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['drawingNo'] ?? '—')}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['operationCode'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {!draft
                        ? t('batch.eligibility.not-draft')
                        : deletable
                          ? t('batch.eligibility.deletable')
                          : t('batch.eligibility.exempt')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-batch-assignee">{t('batch.assignee-label')}</Label>
            <Input id="disp-batch-assignee" value={assignee} list="dispatch-user-options" onChange={(e) => setAssignee(e.target.value)} placeholder={t('batch.assignee-placeholder')} />
          </div>
          <Button
            variant="outline"
            disabled={assignMutation.isPending || !allDraft || assignee.trim().length === 0}
            onClick={() => assignMutation.mutate()}
          >
            {t('batch.assign-button')}
          </Button>
          <Button
            variant="outline"
            disabled={cancelMutation.isPending || !allDeletable}
            onClick={() => cancelMutation.mutate()}
          >
            {t('batch.delete-button')}
          </Button>
        </div>
        {outcome !== null && <p className="text-sm text-muted-foreground">{outcome}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * 派工单详情结构化读面（UX-PRD-06：结构化中文字段 + 中文状态/迁移记录，不裸 JSON）。
 * 后端详情形状 = { order, outsourcingLines, milestones }（dispatch.service.dispatchDetail）。
 * i18n 波 2：字段/表头/流转文案经 t() 取 dispatch namespace。
 */
function DispatchDetailView({ detail }: { readonly detail: Record<string, unknown> }) {
  const { t } = useTranslation('dispatch');
  const order = (detail['order'] ?? null) !== null && typeof detail['order'] === 'object'
    ? (detail['order'] as Record<string, unknown>)
    : {};
  const outsourcingLines = Array.isArray(detail['outsourcingLines'])
    ? (detail['outsourcingLines'] as readonly Record<string, unknown>[])
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
      { label: t('detail.field.id'), value: text('id'), mono: true },
      { label: t('detail.field.kind'), value: dispatchKindLabel(text('kind'), t) },
      { label: t('detail.field.state'), value: dispatchStateLabel(text('state'), t) },
      { label: t('detail.field.work-order'), value: text('workOrderId'), mono: true },
      { label: t('detail.field.title'), value: text('title') },
      { label: t('detail.field.drawing-number'), value: text('drawingNo'), mono: true },
      { label: t('detail.field.operation'), value: text('operationCode'), mono: true },
      { label: t('detail.field.assignee'), value: text('assignee'), mono: true },
      { label: t('detail.field.quantity'), value: text('quantity') },
      { label: t('detail.field.done-qty'), value: text('doneQty') },
      { label: t('detail.field.remark'), value: text('remark') },
      { label: t('detail.field.created-at'), value: datetime('createdAt') },
      { label: t('detail.field.updated-at'), value: datetime('updatedAt') },
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
      {outsourcingLines.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('detail.outsourcing-title')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t('detail.line.line-no')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.line.operation')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.line.supplier')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.line.quantity')}</th>
                  <th className="py-2 pr-4 font-medium">{t('detail.line.state')}</th>
                </tr>
              </thead>
              <tbody>
                {outsourcingLines.map((line, index) => (
                  <tr key={String(line['lineNo'] ?? index)} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 text-xs">{String(line['lineNo'] ?? index + 1)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(line['processCode'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">{String(line['supplierName'] ?? line['supplierRef'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">{String(line['quantity'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">{String(line['statusLabel'] ?? line['status'] ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {milestones.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('detail.milestones-title')}</p>
          <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
            {milestones.map((milestone, index) => {
              const from = dispatchStateLabel(String(milestone['from'] ?? ''), t);
              const to = dispatchStateLabel(String(milestone['to'] ?? ''), t);
              const event = dispatchEventLabel(String(milestone['event'] ?? ''), t);
              // UX-PRD-R2-02：流转时刻本地化（照质检单详情 milestones 同模式）。
              const at = formatLocalDateTime(milestone['at']);
              const actor = String(milestone['actor'] ?? '');
              return (
                <li key={index}>
                  {t('detail.milestone-line', { from, to, event })}
                  {at !== '—' ? ` · ${at}` : ''}
                  {actor.length > 0 ? ` · ${t('detail.milestone-actor', { actor })}` : ''}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function DispatchDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const { t } = useTranslation('dispatch');
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['dispatch', 'detail', id],
    queryFn: () => getDispatchDetail(id),
  });
  const [assignee, setAssignee] = useState('');
  const [remark, setRemark] = useState('');
  const [doneQty, setDoneQty] = useState('');
  const [transferAssignee, setTransferAssignee] = useState('');
  const [transferOperation, setTransferOperation] = useState('');
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
          <DispatchDetailView detail={detailQuery.data ?? {}} />
        </QueryState>
        <div className="grid gap-4 lg:grid-cols-3 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-assignee">{t('detail.assignee-label')}</Label>
            <Input id="disp-op-assignee" value={assignee} list="dispatch-user-options" onChange={(e) => setAssignee(e.target.value)} placeholder={t('detail.assignee-placeholder')} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-remark">{t('detail.remark-label')}</Label>
            <Input id="disp-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-qty">{t('detail.qty-label')}</Label>
            <Input id="disp-op-qty" type="number" min="0.000001" step="any" value={doneQty} onChange={(e) => setDoneQty(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || assignee.trim().length === 0}
            onClick={() =>
              mutation.mutate(() =>
                assignDispatchOrder(id, row, {
                  assignee: assignee.trim(),
                  ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
                }),
              )
            }
          >
            {t('detail.assign-button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => startDispatchOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            {t('detail.start-button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(() =>
                completeDispatchOrder(id, row, {
                  ...(doneQty.trim().length > 0 ? { doneQty: Number(doneQty) } : {}),
                  ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
                }),
              )
            }
          >
            {t('detail.complete-button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => cancelDispatchOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            {t('detail.cancel-button')}
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-3 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-transfer-assignee">{t('detail.transfer-assignee-label')}</Label>
            <Input
              id="disp-op-transfer-assignee"
              value={transferAssignee}
              list="dispatch-user-options"
              onChange={(e) => setTransferAssignee(e.target.value)}
              placeholder={t('detail.assignee-placeholder')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-transfer-op">{t('detail.transfer-op-label')}</Label>
            <Input
              id="disp-op-transfer-op"
              value={transferOperation}
              onChange={(e) => setTransferOperation(e.target.value)}
              placeholder={t('detail.transfer-op-placeholder')}
            />
          </div>
          <Button
            variant="outline"
            disabled={
              mutation.isPending ||
              String(row['state']) !== 'executing' ||
              (transferAssignee.trim().length === 0 && transferOperation.trim().length === 0)
            }
            onClick={() =>
              mutation.mutate(() =>
                transferDispatchOrder(id, row, {
                  ...(transferAssignee.trim().length > 0 ? { assignee: transferAssignee.trim() } : {}),
                  ...(transferOperation.trim().length > 0 ? { operationCode: transferOperation.trim() } : {}),
                  ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
                }),
              )
            }
          >
            {t('detail.transfer-button')}
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

function CreateDispatchCard({ onChanged }: { readonly onChanged: () => void }) {
  const { t } = useTranslation('dispatch');
  // UX-VW-R2-01：写权限闸（dispatch:write，与后端建单端点同码）。照
  // WorkbenchPage/m pageAccess 投影模式——会话权限未就绪按禁用兜底（写面
  // fail-closed），admin 通配 bypass 由 sessionHasPermission 内含。
  const { data: permissionData } = usePermissions({});
  const canCreate =
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), DISPATCH_WRITE_CODE);

  const [kind, setKind] = useState<(typeof DISPATCH_KINDS)[number]>('part');
  const [workOrderId, setWorkOrderId] = useState('');
  const [equipmentRefs, setEquipmentRefs] = useState<string[]>([]);
  const [rollup, setRollup] = useState(false);
  const equipmentQuery = useQuery({ queryKey: ['dispatch', 'equipment-options', workOrderId], queryFn: () => dispatchEquipmentOptions(workOrderId), enabled: canCreate && workOrderId.trim().length > 0 });
  const [title, setTitle] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [operationCode, setOperationCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [assignee, setAssignee] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  // UX-PRD-R2-04：建单成功回执的派工单号（短码显示 + title 悬停全文）。
  const [createdId, setCreatedId] = useState<string | null>(null);

  const createdIdOf = (result: CommandOutcomeView): string | null => {
    const body = result.body;
    if (typeof body !== 'object' || body === null) return null;
    const order = (body as Record<string, unknown>)['dispatchOrder'];
    if (typeof order !== 'object' || order === null) return null;
    const id = (order as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  };

  const mutation = useMutation({
    mutationFn: () =>
      createDispatchOrder({
        kind,
        equipmentRefs,
        rollup: kind === 'assembly' && rollup,
        quantity: Number(quantity),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        ...(drawingNo.trim().length > 0 ? { drawingNo: drawingNo.trim() } : {}),
        ...(operationCode.trim().length > 0 ? { operationCode: operationCode.trim() } : {}),
        ...(assignee.trim().length > 0 ? { assignee: assignee.trim() } : {}),
        // UX-PRD-07：建单备注随单落库（dispatch.create 载荷 remark 原生支持，
        // 详情视图「备注」字段直读同值）。
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
        ...(kind === 'outsourcing' && supplierRef.trim().length > 0 && operationCode.trim().length > 0
          ? { lines: [{ processCode: operationCode.trim(), supplierRef: supplierRef.trim(), quantity: Number(quantity) }] }
          : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      setCreatedId(result.committed ? createdIdOf(result) : null);
      if (result.committed) {
        onChanged();
        setTitle('');
        setDrawingNo('');
        setOperationCode('');
        setAssignee('');
        setSupplierRef('');
        setRemark('');
      }
    },
    onError: (error) => {
      setOutcome(errorOutcomeOf(error));
      setCreatedId(null);
    },
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
        {!canCreate && (
          <p className="mb-4 text-sm text-muted-foreground" data-permission-code="dispatch:write">
            {t('create.no-permission')}
          </p>
        )}
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          {(kind === 'assembly' || kind === 'electrical') && <div className="flex flex-col gap-2 sm:col-span-2"><Label>派工自制设备（可多选）</Label>{(equipmentQuery.data ?? []).filter((row) => row['kind'] === 'self-made').map((row) => <label key={String(row['id'])} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={equipmentRefs.includes(String(row['id']))} onChange={(e) => setEquipmentRefs((prev) => e.target.checked ? [...prev, String(row['id'])] : prev.filter((id) => id !== String(row['id'])))} />{String(row['code'])} · {String(row['name'])}</label>)}{kind === 'assembly' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rollup} onChange={(e) => setRollup(e.target.checked)} />生成整线外购设备归拢任务（仅外购设备行）</label>}<p className="text-xs text-muted-foreground">先填工作令，再选择本令真实自制设备；无设备时不能用图号代替。</p></div>}
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-kind">{t('create.kind-label')}</Label>
            <Select id="disp-new-kind" value={kind} disabled={!canCreate} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {DISPATCH_KINDS.map((entry) => (
                <option key={entry} value={entry}>{dispatchKindLabel(entry, t)}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-qty">{t('create.qty-label')}</Label>
            <Input id="disp-new-qty" type="number" min="0.000001" step="any" value={quantity} disabled={!canCreate} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-wo">{t('create.wo-label')}</Label>
            <Input id="disp-new-wo" value={workOrderId} list="dispatch-wo-options" disabled={!canCreate} onChange={(e) => { setWorkOrderId(e.target.value); setEquipmentRefs([]); }} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-title">{t('create.title-label')}</Label>
            <Input id="disp-new-title" value={title} disabled={!canCreate} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-drawing">{t('create.drawing-label')}</Label>
            <Input id="disp-new-drawing" value={drawingNo} disabled={!canCreate} onChange={(e) => setDrawingNo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-op">{t('create.op-label')}</Label>
            <Input id="disp-new-op" value={operationCode} disabled={!canCreate} onChange={(e) => setOperationCode(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-assignee">{t('create.assignee-label')}</Label>
            <Input id="disp-new-assignee" value={assignee} list="dispatch-user-options" disabled={!canCreate} onChange={(e) => setAssignee(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-supplier">{t('create.supplier-label')}</Label>
            <Input id="disp-new-supplier" value={supplierRef} disabled={!canCreate} onChange={(e) => setSupplierRef(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="disp-new-remark">{t('create.remark-label')}</Label>
            <Input id="disp-new-remark" value={remark} disabled={!canCreate} onChange={(e) => setRemark(e.target.value)} placeholder={t('create.remark-placeholder')} />
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {t('create.failed', { message: mutation.error instanceof Error ? mutation.error.message : String(mutation.error) })}
            </p>
          )}
          {outcome !== null && (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <CommandOutcomeHint outcome={outcome} />
              {/* UX-PRD-R2-04：新建成功回显短码单号（W9 移动报工同模式，悬停全文）。 */}
              {createdId !== null && (
                <p className="text-xs text-muted-foreground">
                  {t('create.created-id')}{' '}
                  <span className="font-mono" title={createdId}>
                    {shortId(createdId)}
                  </span>
                </p>
              )}
            </div>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={!canCreate || mutation.isPending || Number(quantity) <= 0}>
              {t('create.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** 任务视图（按人 + 按工作令）。 */
function TasksCard() {
  const { t } = useTranslation('dispatch');
  const [assignee, setAssignee] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [loadedAssignee, setLoadedAssignee] = useState<string | null>(null);
  const [loadedWorkOrderId, setLoadedWorkOrderId] = useState<string | null>(null);

  const byAssigneeQuery = useQuery({
    queryKey: ['dispatch', 'tasks-assignee', loadedAssignee],
    queryFn: () => listTasksByAssignee(loadedAssignee as string),
    enabled: loadedAssignee !== null,
  });
  const byWorkOrderQuery = useQuery({
    queryKey: ['dispatch', 'tasks-wo', loadedWorkOrderId],
    queryFn: () => listTasksByWorkOrder(loadedWorkOrderId as string),
    enabled: loadedWorkOrderId !== null,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tasks.title')}</CardTitle>
        <CardDescription>{t('tasks.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-tasks-assignee">{t('tasks.assignee-label')}</Label>
            <Input id="disp-tasks-assignee" value={assignee} list="dispatch-user-options" onChange={(e) => setAssignee(e.target.value)} placeholder={t('tasks.assignee-placeholder')} />
          </div>
          <Button variant="outline" disabled={assignee.trim().length === 0} onClick={() => setLoadedAssignee(assignee.trim())}>
            {t('tasks.by-assignee')}
          </Button>
        </div>
        {loadedAssignee !== null && (
          <QueryState
            isPending={byAssigneeQuery.isPending}
            error={byAssigneeQuery.error}
            isEmpty={byAssigneeQuery.data !== undefined && byAssigneeQuery.data.length === 0}
            empty={t('tasks.empty-assignee')}
          >
            <ModuleTable
              columns={[
                { key: 'dispatchId', label: t('column.dispatch-order'), mono: true },
                { key: 'kind', label: t('column.kind'), mono: true },
                { key: 'state', label: t('column.state'), mono: true },
                { key: 'quantity', label: t('column.quantity') },
              ]}
              rows={(byAssigneeQuery.data ?? []).map((row) => dispatchDisplayRowOf(row, t))}
            />
          </QueryState>
        )}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-tasks-wo">{t('tasks.wo-label')}</Label>
            <Input id="disp-tasks-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} placeholder={t('tasks.wo-placeholder')} />
          </div>
          <Button variant="outline" disabled={workOrderId.trim().length === 0} onClick={() => setLoadedWorkOrderId(workOrderId.trim())}>
            {t('tasks.by-wo')}
          </Button>
        </div>
        {loadedWorkOrderId !== null && (
          <QueryState
            isPending={byWorkOrderQuery.isPending}
            error={byWorkOrderQuery.error}
            isEmpty={byWorkOrderQuery.data !== undefined && byWorkOrderQuery.data.length === 0}
            empty={t('tasks.empty-wo')}
          >
            <ModuleTable
              columns={[
                { key: 'dispatchId', label: t('column.dispatch-order'), mono: true },
                { key: 'kind', label: t('column.kind'), mono: true },
                { key: 'state', label: t('column.state'), mono: true },
                { key: 'quantity', label: t('column.quantity') },
              ]}
              rows={(byWorkOrderQuery.data ?? []).map((row) => dispatchDisplayRowOf(row, t))}
            />
          </QueryState>
        )}
      </CardContent>
    </Card>
  );
}
