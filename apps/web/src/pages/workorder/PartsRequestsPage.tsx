/**
 * 配件申请页（S2 批次）：配件五态列表（状态/工作令过滤）+ 申请表单 + 行内
 * 审批（approve/reject）与发货（联动出库）操作。覆盖矩阵 #26 配件申请。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPartsRequest,
  decidePartsRequest,
  listPartsRequests,
  shipPartsRequest,
} from '../../data/workorderApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 配件五态（workorder-config.ts PARTS_REQUEST_STATE_IDS 实态）。 */
const PARTS_STATES = ['draft', 'submitted', 'approved', 'rejected', 'shipped', 'received'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'itemId', label: '物料', mono: true },
  { key: 'quantity', label: '数量' },
  { key: 'state', label: '状态', mono: true },
  { key: 'requester', label: '申请人', mono: true },
  { key: 'shipmentRef', label: '发货单号', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function PartsRequestsPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');

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
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function runOnTarget(fn: (row: Record<string, unknown>) => Promise<CommandOutcomeView>): void {
    const target = (partsQuery.data ?? []).find((row) => String(row['id']) === targetId.trim());
    if (target === undefined) {
      setOutcome({ committed: false, status: 'error', reason: '目标申请 id 不在当前列表中' });
      return;
    }
    actionMutation.mutate(() => fn(target));
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>配件申请列表</CardTitle>
          <CardDescription>
            配件五态（draft→submitted→approved/rejected→shipped→received）；审批与发货操作在行尾。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-state-filter">状态过滤</Label>
              <Select id="parts-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {PARTS_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-wo-filter">工作令过滤（可选）</Label>
              <Input
                id="parts-wo-filter"
                value={workOrderIdFilter}
                onChange={(e) => setWorkOrderIdFilter(e.target.value)}
                placeholder="工作令 id"
              />
            </div>
          </div>
          <QueryState
            isPending={partsQuery.isPending}
            error={partsQuery.error}
            isEmpty={partsQuery.data !== undefined && partsQuery.data.length === 0}
            empty="当前过滤条件下无配件申请"
          >
            <div className="flex flex-col gap-3">
              <ModuleTable columns={LIST_COLUMNS} rows={partsQuery.data ?? []} />
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto_auto_auto] lg:items-end">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="parts-action-id">目标申请 id（取上表 id）</Label>
                  <Input id="parts-action-id" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="粘贴上表 id" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="parts-decision-remark">决策理由（审批必填）</Label>
                  <Input
                    id="parts-decision-remark"
                    value={decisionRemark}
                    onChange={(e) => setDecisionRemark(e.target.value)}
                    placeholder="决策理由"
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
                  批准
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
                  驳回
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionMutation.isPending || targetId.trim().length === 0}
                  onClick={() =>
                    runOnTarget((row) =>
                      shipPartsRequest(String(row['id']), row, {
                        remark: decisionRemark.trim().length > 0 ? decisionRemark.trim() : undefined,
                      }),
                    )
                  }
                >
                  发货（联动出库）
                </Button>
              </div>
            </div>
          </QueryState>
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {actionMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              操作失败：{actionMutation.error instanceof Error ? actionMutation.error.message : String(actionMutation.error)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>新建配件申请</CardTitle>
          <CardDescription>workorder.parts.request.v1：建单即提交（落 submitted 待审态）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-wo">工作令 id</Label>
              <Input id="parts-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-item">物料 id</Label>
              <Input id="parts-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parts-new-qty">数量（正数）</Label>
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
              <Label htmlFor="parts-new-remark">备注（可选）</Label>
              <Input id="parts-new-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                申请失败：{createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error)}
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
                提交配件申请
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
