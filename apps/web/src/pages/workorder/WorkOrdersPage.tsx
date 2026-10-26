/**
 * 工作令管理页（S2 批次）：九态主列表（状态过滤）+ 建令表单 + 行选中详情面板
 * （详情/项目进度/机加工进度/装配调试进度 + 流转/关闭/附件/齐套刷新操作）+
 * 齐套看板。端点能力按 workorder.controllers.ts 实态，不造后端没有的功能。
 * 覆盖矩阵 #24 工作令信息 / #25 建令 / #27-29 进度 / #30 齐套看板。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
// D-WO-05：工作令详情挂图纸清单入口（钉版引用三态 + 图纸库跳转——行级改动）。
import { WorkOrderDrawingsCard } from '../drawing/WorkOrderDrawingsCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 九态（workorder-config.ts WORK_ORDER_STATE_IDS 实态）。 */
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

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'projectName', label: '项目名' },
  { key: 'state', label: '状态', mono: true },
  { key: 'customerRef', label: '客户引用', mono: true },
  { key: 'plannedDeliveryAt', label: '计划交付' },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻' },
];

export function WorkOrdersPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const [plannedDeliveryAt, setPlannedDeliveryAt] = useState('');

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      {
        projectName,
        ...(customerRef.trim().length > 0 ? { customerRef: customerRef.trim() } : {}),
        ...(plannedDeliveryAt.trim().length > 0 ? { plannedDeliveryAt: plannedDeliveryAt.trim() } : {}),
      },
      {
        onSuccess: () => {
          setProjectName('');
          setCustomerRef('');
          setPlannedDeliveryAt('');
        },
      },
    );
  }

  const selectedRow =
    ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>工作令列表</CardTitle>
          <CardDescription>
            九态主单据（真实 workorder API 读回；列表 ?state= 过滤）。点行选中后在下方执行流转/进度查看。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-2">
            <Label htmlFor="wo-state-filter">状态过滤</Label>
            <Select
              id="wo-state-filter"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              {WORK_ORDER_STATES.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </Select>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty="当前过滤条件下无工作令"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={ordersQuery.data ?? []}
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
          <CardTitle>创建工作令</CardTitle>
          <CardDescription>
            workorder.create.v1 建令（含四类清单骨架提示事件）；项目名必填，客户引用/计划交付可留空。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-project">项目名</Label>
              <Input id="wo-project" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Proj-2026-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-customer">客户引用（可选）</Label>
              <Input id="wo-customer" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} placeholder="CUST-01" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wo-delivery">计划交付日期（可选，ISO 8601）</Label>
              <Input id="wo-delivery" value={plannedDeliveryAt} onChange={(e) => setPlannedDeliveryAt(e.target.value)} placeholder="2026-12-01" />
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                建令失败：{createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error)}
              </p>
            )}
            {createMutation.data !== undefined && (
              <div className="sm:col-span-2">
                <CommandOutcomeHint outcome={createMutation.data} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || projectName.trim().length === 0}>
                创建工作令
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>工作令详情与操作</CardTitle>
        <CardDescription>主单据/进度读回 + 流转（19 迁移）/关闭/附件挂接/齐套刷新命令。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} title="详情（order/附件/最新齐套/迁移里程碑）" />
        </QueryState>

        <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={handleTransition}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wo-transition-target">流转目标态</Label>
            <Select id="wo-transition-target" value={targetState} onChange={(e) => setTargetState(e.target.value)}>
              <option value="">选择目标态…</option>
              {WORK_ORDER_STATES.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wo-transition-remark">流转备注（可选）</Label>
            <Input id="wo-transition-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="备注留痕" />
          </div>
          <Button type="submit" disabled={run.isPending || targetState === ''}>执行流转</Button>
        </form>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => closeWorkOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            关闭工作令
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
            挂接图纸附件（示例）
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => refreshKitCheck(id, row))}
          >
            刷新齐套检查
          </Button>
        </div>

        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
        {run.isError && (
          <p role="alert" className="text-sm text-destructive">
            命令失败：{run.error instanceof Error ? run.error.message : String(run.error)}
          </p>
        )}

        <QueryState isPending={progressQuery.isPending} error={progressQuery.error} isEmpty={false}>
          <RowDetail row={progressQuery.data ?? {}} title="项目进度（计划 vs 实际 + 里程碑）" />
        </QueryState>
        <QueryState isPending={machiningQuery.isPending} error={machiningQuery.error} isEmpty={false}>
          <RowDetail row={machiningQuery.data ?? {}} title="机加工进度（图号 × 工序上卷）" />
        </QueryState>
        <QueryState isPending={assemblyQuery.isPending} error={assemblyQuery.error} isEmpty={false}>
          <RowDetail row={assemblyQuery.data ?? {}} title="装配调试进度（工序上卷）" />
        </QueryState>

        {/* D-WO-05：图纸清单入口（消费 drawing 域端点；查看动作经图纸库留痕路径）。 */}
        <WorkOrderDrawingsCard workOrderId={id} />
      </CardContent>
    </Card>
  );
}

/** 齐套看板（GET /workorder/kit-board：每工作令最新快照 + 缺口下钻）。 */
function KitBoardCard() {
  const kitBoardQuery = useQuery({ queryKey: ['workorder', 'kit-board'], queryFn: getKitBoard });
  return (
    <Card>
      <CardHeader>
        <CardTitle>齐套看板</CardTitle>
        <CardDescription>每工作令最新齐套快照（缺口 = 三类清单 × 库存可用量；装配/电气派工齐套硬拦截联动）。</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState
          isPending={kitBoardQuery.isPending}
          error={kitBoardQuery.error}
          isEmpty={kitBoardQuery.data !== undefined && kitBoardQuery.data.length === 0}
          empty="尚无齐套快照（选中工作令执行「刷新齐套检查」后生成）"
        >
          <ModuleTable
            columns={[
              { key: 'workOrderId', label: '工作令', mono: true },
              { key: 'projectName', label: '项目名' },
              { key: 'complete', label: '齐套完成' },
              { key: 'refreshedAt', label: '刷新时刻' },
              { key: 'gapLines', label: '缺口行' },
            ]}
            rows={kitBoardQuery.data ?? []}
          />
        </QueryState>
      </CardContent>
    </Card>
  );
}
