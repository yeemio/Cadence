/**
 * 派工管理页（S2 批次）：六类派工单列表（kind/状态/工作令/执行人过滤）+ 建单
 * 表单（六类判别）+ 选中单详情 + 派工/开工/完工/撤销操作 + 按人任务视图。
 * 覆盖矩阵 #38-43（零件/外协/装配/电气/售后/零工派工）。
 * fix-wave-6 6a-1：页眉五态状态统计（不可点击筛选）+ 多单批量派工下发/批量删除
 * （非待下发置灰、装配/电气/零工/售后批量删除豁免）+ 执行中转单（换执行人/工序）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignDispatchOrder,
  batchAssignDispatchOrders,
  batchCancelDispatchOrders,
  cancelDispatchOrder,
  completeDispatchOrder,
  createDispatchOrder,
  getDispatchDetail,
  getDispatchOrderStats,
  listDispatchOrders,
  listTasksByAssignee,
  listTasksByWorkOrder,
  startDispatchOrder,
  transferDispatchOrder,
} from '../../data/dispatchApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const DISPATCH_KINDS = [
  { value: 'part', label: '零件' },
  { value: 'outsourcing', label: '外协' },
  { value: 'assembly', label: '装配' },
  { value: 'electrical', label: '电气' },
  { value: 'aftermarket', label: '售后' },
  { value: 'oddjob', label: '零工' },
] as const;

const DISPATCH_STATES = ['draft', 'assigned', 'executing', 'done', 'cancelled'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类别', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'drawingNo', label: '图号', mono: true },
  { key: 'operationCode', label: '工序', mono: true },
  { key: 'assignee', label: '执行人', mono: true },
  { key: 'quantity', label: '数量' },
  { key: 'objectVersion', label: '版本', mono: true },
];

/** 页眉状态统计键序（RREQ-DP-032：五态计数——不可点击筛选）。 */
const STATS_ENTRIES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'draft', label: '草稿（待下发）' },
  { key: 'assigned', label: '已派工' },
  { key: 'executing', label: '执行中' },
  { key: 'done', label: '完工' },
  { key: 'cancelled', label: '已撤销' },
];

/** 批量删除豁免集（RREQ-DP-032 逐类豁免口径：仅零件/外协提供批量删除）。 */
const BATCH_DELETABLE_KINDS = new Set(['part', 'outsourcing']);

export function DispatchOrdersPage() {
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
      <StatusStatsCard
        filters={{
          ...(kindFilter === '' ? {} : { kind: kindFilter }),
          ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
          ...(assigneeFilter.trim() === '' ? {} : { assignee: assigneeFilter.trim() }),
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>派工单列表</CardTitle>
          <CardDescription>
            四态全链（draft→assigned→executing→done + cancelled）；点行选中后操作（装配/电气派工受齐套硬拦截）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-kind-filter">类别过滤</Label>
              <Select id="disp-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">全部类别</option>
                {DISPATCH_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-state-filter">状态过滤</Label>
              <Select id="disp-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {DISPATCH_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-wo-filter">工作令（可选）</Label>
              <Input id="disp-wo-filter" value={workOrderIdFilter} onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="disp-assignee-filter">执行人（可选）</Label>
              <Input id="disp-assignee-filter" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty="当前过滤条件下无派工单"
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
  const statsQuery = useQuery({
    queryKey: ['dispatch', 'stats', filters.kind ?? '', filters.workOrderId ?? '', filters.assignee ?? ''],
    queryFn: () => getDispatchOrderStats(filters),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>状态统计</CardTitle>
        <CardDescription>计数随当前搜索口径（不含状态维）；仅展示，不可点击筛选。</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState isPending={statsQuery.isPending} error={statsQuery.error} isEmpty={false}>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {STATS_ENTRIES.map((entry) => (
              <span key={entry.key}>
                {entry.label}：<span className="font-mono">{String(statsQuery.data?.[entry.key] ?? '—')}</span>
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
          ? `批量派工下发完成：${result.items.filter((item) => item['status'] === 'committed').length}/${result.items.length} 张成功`
          : `批量派工下发整批拒绝：${result.reason ?? '未知原因'}`,
      );
      if (result.committed) {
        setSelected([]);
        setAssignee('');
        onChanged();
      }
    },
    onError: (error) => setOutcome(`批量派工下发失败：${error instanceof Error ? error.message : String(error)}`),
  });

  const cancelMutation = useMutation({
    mutationFn: () => batchCancelDispatchOrders({ items: itemsOf() }),
    onSuccess: (result) => {
      setOutcome(
        result.committed
          ? `批量删除完成：${result.items.filter((item) => item['status'] === 'committed').length}/${result.items.length} 张成功`
          : `批量删除整批拒绝：${result.reason ?? '未知原因'}`,
      );
      if (result.committed) {
        setSelected([]);
        onChanged();
      }
    },
    onError: (error) => setOutcome(`批量删除失败：${error instanceof Error ? error.message : String(error)}`),
  });

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>列表批操作</CardTitle>
        <CardDescription>
          批量派工下发（勾选均须待下发，整批统一派到同一执行人）；批量删除仅待下发且零件/外协（装配/电气/零工/售后豁免）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">选</th>
                <th className="py-2 pr-4 font-medium">id</th>
                <th className="py-2 pr-4 font-medium">类别</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">图号</th>
                <th className="py-2 pr-4 font-medium">工序</th>
                <th className="py-2 pr-4 font-medium">批操作资格</th>
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
                        aria-label={`选择派工单 ${id}`}
                        checked={selectedIds.has(id)}
                        disabled={!draft}
                        onChange={() => toggle(row)}
                      />
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{id}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['kind'])}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['state'])}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['drawingNo'] ?? '—')}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row['operationCode'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {!draft ? '非待下发（置灰）' : deletable ? '可批量删除' : '豁免批量删除'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-batch-assignee">批量派发执行人（勾选单统一派到）</Label>
            <Input id="disp-batch-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="用户 id" />
          </div>
          <Button
            variant="outline"
            disabled={assignMutation.isPending || !allDraft || assignee.trim().length === 0}
            onClick={() => assignMutation.mutate()}
          >
            批量派工下发
          </Button>
          <Button
            variant="outline"
            disabled={cancelMutation.isPending || !allDeletable}
            onClick={() => cancelMutation.mutate()}
          >
            批量删除（撤销）
          </Button>
        </div>
        {outcome !== null && <p className="text-sm text-muted-foreground">{outcome}</p>}
      </CardContent>
    </Card>
  );
}

function DispatchDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
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
        <CardTitle>派工单详情与操作</CardTitle>
        <CardDescription>外协单完工回厂联动质检触发；装配/电气完工进度上卷工作令。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} />
        </QueryState>
        <div className="grid gap-4 lg:grid-cols-3 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-assignee">派工执行人（assign 命令）</Label>
            <Input id="disp-op-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="用户 id" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-remark">备注（可选）</Label>
            <Input id="disp-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-qty">完工数量（可选，缺省整单）</Label>
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
            派工到人
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => startDispatchOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            开工
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
            完工
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => cancelDispatchOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))}
          >
            撤销（draft/assigned）
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-3 lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-transfer-assignee">转单新执行人（至少与转单新工序携其一）</Label>
            <Input
              id="disp-op-transfer-assignee"
              value={transferAssignee}
              onChange={(e) => setTransferAssignee(e.target.value)}
              placeholder="用户 id"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-op-transfer-op">转单新工序</Label>
            <Input
              id="disp-op-transfer-op"
              value={transferOperation}
              onChange={(e) => setTransferOperation(e.target.value)}
              placeholder="工序码"
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
            转单（仅执行中）
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

function CreateDispatchCard({ onChanged }: { readonly onChanged: () => void }) {
  const [kind, setKind] = useState<(typeof DISPATCH_KINDS)[number]['value']>('part');
  const [workOrderId, setWorkOrderId] = useState('');
  const [title, setTitle] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [operationCode, setOperationCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [assignee, setAssignee] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createDispatchOrder({
        kind,
        quantity: Number(quantity),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        ...(drawingNo.trim().length > 0 ? { drawingNo: drawingNo.trim() } : {}),
        ...(operationCode.trim().length > 0 ? { operationCode: operationCode.trim() } : {}),
        ...(assignee.trim().length > 0 ? { assignee: assignee.trim() } : {}),
        ...(kind === 'outsourcing' && supplierRef.trim().length > 0 && operationCode.trim().length > 0
          ? { lines: [{ processCode: operationCode.trim(), supplierRef: supplierRef.trim(), quantity: Number(quantity) }] }
          : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        onChanged();
        setTitle('');
        setDrawingNo('');
        setOperationCode('');
        setAssignee('');
        setSupplierRef('');
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
        <CardTitle>创建派工单</CardTitle>
        <CardDescription>
          六类判别：零件需图号+工序；外协需明细行（供应商+工序+数量）；装配/电气需工序；售后/零工需标题或工序。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-kind">派工类别</Label>
            <Select id="disp-new-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {DISPATCH_KINDS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-qty">数量</Label>
            <Input id="disp-new-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-wo">工作令（可选）</Label>
            <Input id="disp-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-title">标题（售后/零工可用）</Label>
            <Input id="disp-new-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-drawing">图号（零件必填）</Label>
            <Input id="disp-new-drawing" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-op">工序（多类必填；外协行=工序码）</Label>
            <Input id="disp-new-op" value={operationCode} onChange={(e) => setOperationCode(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-assignee">执行人（可选）</Label>
            <Input id="disp-new-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="disp-new-supplier">供应商引用（外协行=supplierRef）</Label>
            <Input id="disp-new-supplier" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              建单失败：{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </p>
          )}
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={mutation.isPending || Number(quantity) <= 0}>
              创建派工单
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** 任务视图（按人 + 按工作令）。 */
function TasksCard() {
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
        <CardTitle>任务视图</CardTitle>
        <CardDescription>按执行人（assignee 必填）或按工作令查任务（dispatch.tasks 双视图）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-tasks-assignee">执行人</Label>
            <Input id="disp-tasks-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="用户 id" />
          </div>
          <Button variant="outline" disabled={assignee.trim().length === 0} onClick={() => setLoadedAssignee(assignee.trim())}>
            按人查询
          </Button>
        </div>
        {loadedAssignee !== null && (
          <QueryState
            isPending={byAssigneeQuery.isPending}
            error={byAssigneeQuery.error}
            isEmpty={byAssigneeQuery.data !== undefined && byAssigneeQuery.data.length === 0}
            empty="该执行人当前无任务"
          >
            <ModuleTable
              columns={[
                { key: 'dispatchId', label: '派工单', mono: true },
                { key: 'kind', label: '类别', mono: true },
                { key: 'state', label: '状态', mono: true },
                { key: 'quantity', label: '数量' },
              ]}
              rows={byAssigneeQuery.data ?? []}
            />
          </QueryState>
        )}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="disp-tasks-wo">工作令</Label>
            <Input id="disp-tasks-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} placeholder="工作令 id" />
          </div>
          <Button variant="outline" disabled={workOrderId.trim().length === 0} onClick={() => setLoadedWorkOrderId(workOrderId.trim())}>
            按工作令查询
          </Button>
        </div>
        {loadedWorkOrderId !== null && (
          <QueryState
            isPending={byWorkOrderQuery.isPending}
            error={byWorkOrderQuery.error}
            isEmpty={byWorkOrderQuery.data !== undefined && byWorkOrderQuery.data.length === 0}
            empty="该工作令当前无任务"
          >
            <ModuleTable
              columns={[
                { key: 'dispatchId', label: '派工单', mono: true },
                { key: 'kind', label: '类别', mono: true },
                { key: 'state', label: '状态', mono: true },
                { key: 'quantity', label: '数量' },
              ]}
              rows={byWorkOrderQuery.data ?? []}
            />
          </QueryState>
        )}
      </CardContent>
    </Card>
  );
}
