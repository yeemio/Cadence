/**
 * 配件申请页（S2 批次）：配件列表（状态/工作令过滤）+ 申请表单 + 行内
 * 审批（approve/reject）与发货（联动出库）操作。覆盖矩阵 #26 配件申请。
 * UX-PLAN-04：行选中详情展示当前审批级（一级=工作令项目经理，空回落销售；
 * 多级链二/三级为配置角色）与本级审批人——审批人缺失时给出警示。
 * UX-PLAN-05：可见文案不出现接口路径/命令名/内部字段名/英文枚举原文。
 * i18n 波 2（ADR-0012 / proposal §8）：系统 chrome 文案接 workorder namespace
 * t()（zh-CN 权威源=本文案原文；业务数据与服务端 message 不翻译）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：workorder namespace 绑定（namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  createPartsRequest,
  decidePartsRequest,
  getPartsRequestDetail,
  listPartsRequests,
  shipPartsRequest,
} from '../../data/workorderApi';
import { listItems } from '../../data/masterdataApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, type TableColumn } from '../../components/ModuleTable';
// P2 横切批：时刻本地化/长 id 截断显示（UX-PLAN-07/08；行数据不动，title 悬停全文）。
import { formatLocalDateTime } from '@/lib/format';
// UX-PLAN-R2-04：审批人技术用户 id 处显示 displayName（目录缺失静默回退 id）。
import { displayUserName, useUserDirectory } from './userDirectory';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 配件状态（workorder-config PARTS_REQUEST_STATE_IDS 实态）。UX-VW-R2-06/
 * UX-PLAN-R2-03：三个审批中间态按级细分标签（此前同名「审批中」致过滤下拉
 * 三个不可区分选项；与详情「第 N 级」、流转记录「一/二/三级审批」口径一致）。 */
const PARTS_STATES = [
  'draft',
  'submitted',
  'level2_review',
  'level3_review',
  'approved',
  'rejected',
  'shipped',
  'received',
] as const;

/** 配件状态标签 i18n key 映射（parts-state.*；未知态回落原 id）。 */
const PARTS_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  draft: 'parts-state.draft',
  submitted: 'parts-state.submitted',
  level2_review: 'parts-state.level2-review',
  level3_review: 'parts-state.level3-review',
  approved: 'parts-state.approved',
  rejected: 'parts-state.rejected',
  shipped: 'parts-state.shipped',
  received: 'parts-state.received',
};

function partsStateLabel(state: unknown, t: TFunction): string {
  const id = state === null || state === undefined ? '' : String(state);
  const key = PARTS_STATE_LABEL_KEYS[id];
  return key === undefined ? id : t(key);
}

/** 列头文案走 workorder namespace（i18n 波 2；列结构不变）。 */
function listColumns(t: TFunction): readonly TableColumn[] {
  return [
    { key: 'id', label: t('parts.columns.id'), mono: true, format: 'shortId' },
    { key: 'workOrderId', label: t('parts.columns.work-order'), mono: true, format: 'shortId' },
    { key: 'itemId', label: t('parts.columns.item'), mono: true, format: 'shortId' },
    { key: 'quantity', label: t('parts.columns.quantity') },
    { key: 'state', label: t('parts.columns.state') },
    { key: 'requester', label: t('parts.columns.requester'), mono: true },
    { key: 'shipmentRef', label: t('parts.columns.shipment-ref'), mono: true, format: 'shortId' },
    { key: 'objectVersion', label: t('parts.columns.version'), mono: true },
  ];
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export function PartsRequestsPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('workorder');
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const partsQuery = useQuery({
    queryKey: ['workorder', 'parts', stateFilter, workOrderIdFilter],
    queryFn: () =>
      listPartsRequests({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
      }),
  });

  const [workOrderId, setWorkOrderId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [remark, setRemark] = useState('');

  // UX-PLAN-R2-04：物品候选（datalist——编码+名称提示、选中填入物料 id；
  // 无 item:read/无数据时静默回退纯手填，不阻断申请）。
  const itemOptionsQuery = useQuery({
    queryKey: ['masterdata', 'items', 'options'],
    queryFn: () => listItems().catch(() => []),
    staleTime: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: createPartsRequest,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workorder', 'parts'] }),
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      {
        workOrderId: workOrderId.trim(),
        itemId: itemId.trim(),
        quantity: Number(quantity),
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      },
      {
        onSuccess: () => {
          setWorkOrderId('');
          setItemId('');
          setQuantity('1');
          setRemark('');
        },
      },
    );
  }

  const [decisionRemark, setDecisionRemark] = useState('');
  const [targetId, setTargetId] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const actionMutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['workorder', 'parts'] });
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function runOnTarget(fn: (row: Record<string, unknown>) => Promise<CommandOutcomeView>): void {
    const target = (partsQuery.data ?? []).find((row) => String(row['id']) === targetId.trim());
    if (target === undefined) {
      setOutcome(errorOutcomeOf(t('parts.errors.target-not-in-list')));
      return;
    }
    actionMutation.mutate(() => fn(target));
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('parts.title')}</CardTitle>
          <CardDescription>
            {t('parts.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-state-filter">{t('parts.filter.state-label')}</Label>
              <Select id="parts-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">{t('parts.filter.all-states')}</option>
                {PARTS_STATES.map((state) => (
                  <option key={state} value={state}>{partsStateLabel(state, t)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-wo-filter">{t('parts.filter.wo-label')}</Label>
              <Input
                id="parts-wo-filter"
                value={workOrderIdFilter}
                onChange={(e) => setWorkOrderIdFilter(e.target.value)}
                placeholder={t('parts.filter.wo-placeholder')}
              />
            </div>
          </div>
          <QueryState
            isPending={partsQuery.isPending}
            error={partsQuery.error}
            isEmpty={partsQuery.data !== undefined && partsQuery.data.length === 0}
            empty={t('parts.empty')}
          >
            <div className="flex flex-col gap-3">
              <ModuleTable
                columns={listColumns(t)}
                rows={(partsQuery.data ?? []).map((row) => ({ ...row, state: partsStateLabel(row['state'], t) }))}
                selectedId={selectedId}
                onSelect={(row) => {
                  const id = String(row['id']);
                  setSelectedId(id);
                  // 编号列截断显示后，点行同步完整 id 到目标输入（复制场景不受影响）。
                  setTargetId(id);
                }}
              />
              {/* UX-PLAN-10：内嵌审批/发货操作的角色语境标注（呈现层理清，不改
                  业务）——批准/驳回是审批人动作，发货是发货环节动作；无对应
                  权限的账号操作会被服务端拒绝。 */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('parts.role-note')}
              </p>
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto_auto_auto] lg:items-end">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="parts-action-id">{t('parts.action.target-id')}</Label>
                  <Input id="parts-action-id" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder={t('parts.action.target-id-placeholder')} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="parts-decision-remark">{t('parts.action.decision-remark')}</Label>
                  <Input
                    id="parts-decision-remark"
                    value={decisionRemark}
                    onChange={(e) => setDecisionRemark(e.target.value)}
                    placeholder={t('parts.action.decision-remark-placeholder')}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionMutation.isPending || targetId.trim().length === 0}
                  onClick={() =>
                    runOnTarget((row) =>
                      decidePartsRequest(String(row['id']), row, {
                        decision: 'approve',
                        remark: decisionRemark.trim() || '同意',
                      }),
                    )
                  }
                >
                  {t('parts.action.approve')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionMutation.isPending || targetId.trim().length === 0}
                  onClick={() =>
                    runOnTarget((row) =>
                      decidePartsRequest(String(row['id']), row, {
                        decision: 'reject',
                        remark: decisionRemark.trim() || '驳回',
                      }),
                    )
                  }
                >
                  {t('parts.action.reject')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionMutation.isPending || !(partsQuery.data ?? []).some((row) => String(row['id']) === targetId.trim() && row['state'] === 'approved')}
                  title="仅已批准的配件申请可发货"
                  onClick={() =>
                    runOnTarget((row) =>
                      shipPartsRequest(String(row['id']), row, {
                        remark: decisionRemark.trim().length > 0 ? decisionRemark.trim() : undefined,
                      }),
                    )
                  }
                >
                  {t('parts.action.ship')}
                </Button>
              </div>
            </div>
          </QueryState>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {actionMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('parts.errors.action-failed', {
                message: actionMutation.error instanceof Error ? actionMutation.error.message : String(actionMutation.error),
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {selectedId !== null && <PartsApprovalCard id={selectedId} />}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('parts.create.title')}</CardTitle>
          <CardDescription>
            {t('parts.create.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* UX-PLAN-R2-04：物品候选池（编码/名称提示 → 选中回填物料 id，
              消除「列表见编码、表单要 id」的映射困惑；数据缺失静默手填）。 */}
          <datalist id="parts-item-options">
            {(itemOptionsQuery.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </datalist>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-wo">{t('parts.create.wo-label')}</Label>
              <Input id="parts-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-item">{t('parts.create.item-label')}</Label>
              <Input
                id="parts-new-item"
                list="parts-item-options"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-qty">{t('parts.create.quantity-label')}</Label>
              <Input
                id="parts-new-qty"
                type="number"
                min="0.000001"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-remark">{t('parts.create.remark-label')}</Label>
              <Input id="parts-new-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {t('parts.errors.create-failed', {
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
              <Button
                type="submit"
                disabled={
                  createMutation.isPending ||
                  workOrderId.trim().length === 0 ||
                  itemId.trim().length === 0 ||
                  Number(quantity) <= 0
                }
              >
                {t('parts.create.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 选中申请的审批进度卡（UX-PLAN-04）：当前审批级 + 本级审批人（实时解析）。
 * 审批人名单为空时显示服务端给出的原因（如工作令未配项目经理与销售）。
 * 决策操作在主页列表尾触发后，列表与详情查询键同前缀失效、一并刷新。
 */
function PartsApprovalCard({ id }: { readonly id: string }) {
  const { t } = useTranslation('workorder');
  const detailQuery = useQuery({
    queryKey: ['workorder', 'parts', 'detail', id],
    queryFn: () => getPartsRequestDetail(id),
  });
  // UX-PLAN-R2-04：本级审批人显示 displayName（目录未命中回退原 id）。
  const userDirectory = useUserDirectory();

  const detail = detailQuery.data;
  const request = (detail?.['partsRequest'] ?? null) as Record<string, unknown> | null;
  const pendingApproval = (detail?.['pendingApproval'] ?? null) as Record<string, unknown> | null;
  const milestones = Array.isArray(detail?.['milestones'])
    ? (detail?.['milestones'] as readonly Record<string, unknown>[])
    : [];
  const approvers = Array.isArray(pendingApproval?.['approvers'])
    ? (pendingApproval?.['approvers'] as readonly unknown[])
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('parts.approval.title')}</CardTitle>
        <CardDescription>{t('parts.approval.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          {request !== null && (
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.id')}</dt>
                <dd className="break-all">{textOf(request['id'])}</dd>
              </div>
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.work-order')}</dt>
                <dd className="break-all">{textOf(request['workOrderId'])}</dd>
              </div>
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.item')}</dt>
                <dd className="break-all">{textOf(request['itemId'])}</dd>
              </div>
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.quantity')}</dt>
                <dd>{textOf(request['quantity'])}</dd>
              </div>
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.requester')}</dt>
                <dd className="break-all">{textOf(request['requester'])}</dd>
              </div>
              <div className="contents">
                <dt className="text-muted-foreground">{t('parts.approval.fields.current-state')}</dt>
                <dd>{partsStateLabel(request['state'], t)}</dd>
              </div>
            </dl>
          )}
          {pendingApproval !== null && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                {t('parts.approval.current-level', { level: textOf(pendingApproval['level']) })}
              </p>
              {approvers.length > 0 ? (
                <p className="text-sm">
                  {t('parts.approval.approvers', { names: approvers.map((approver) => displayUserName(userDirectory, approver)).join('、') })}
                </p>
              ) : (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  {t('parts.approval.no-approver', { note: textOf(pendingApproval['note']) })}
                </p>
              )}
            </div>
          )}
          {request !== null && pendingApproval === null && (
            <p className="text-sm text-muted-foreground">{t('parts.approval.no-pending')}</p>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('parts.approval.flow-heading')}</p>
            {milestones.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('parts.approval.flow-empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {milestones.map((milestone, index) => (
                  <li key={`${String(milestone['at'])}-${index}`}>
                    {partsFlowLabel(milestone['from'], t)} → {partsFlowLabel(milestone['to'], t)}
                    <span className="text-muted-foreground">{t('parts.approval.flow-entry-meta', { time: formatLocalDateTime(milestone['at']), actor: textOf(milestone['actor']) })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** 流转历史节点名 key 映射（parts-flow.*；与列表态文案不同：历史须区分一/二/三级审批节点，链路才可读；未知态回落原 id）。 */
const PARTS_FLOW_LABEL_KEYS: Readonly<Record<string, string>> = {
  draft: 'parts-flow.draft',
  submitted: 'parts-flow.submitted',
  level2_review: 'parts-flow.level2-review',
  level3_review: 'parts-flow.level3-review',
  approved: 'parts-flow.approved',
  rejected: 'parts-flow.rejected',
  shipped: 'parts-flow.shipped',
  received: 'parts-flow.received',
};

function partsFlowLabel(state: unknown, t: TFunction): string {
  const id = state === null || state === undefined ? '' : String(state);
  const key = PARTS_FLOW_LABEL_KEYS[id];
  return key === undefined ? id : t(key);
}
