/**
 * 质检队列页（S2 批次）：四类质检队列（类别/状态过滤）+ 汇总事实 + 手工建单 +
 * 行选中判定/复检 + 超时点名。覆盖矩阵 #63-66（自制外协/非标件采购/标准配件
 * 采购/设备采购质检）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createInspectionOrder,
  getInspectionDetail,
  getInspectionSummary,
  judgeInspectionOrder,
  listInspectionOrders,
  recheckInspectionOrder,
  scanInspectionOverdue,
} from '../../data/inspectionApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const INSPECTION_KINDS = [
  { value: 'self_outsourced', label: '自制外协' },
  { value: 'nonstandard_purchase', label: '非标件采购' },
  { value: 'standard_purchase', label: '标准配件采购' },
  { value: 'equipment_purchase', label: '设备采购' },
] as const;

const INSPECTION_STATES = ['pending', 'passed', 'failed', 'closed'] as const;

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类别', mono: true },
  { key: 'state', label: '状态', mono: true },
  { key: 'sourceType', label: '来源', mono: true },
  { key: 'itemId', label: '物料', mono: true },
  { key: 'drawingNo', label: '图号', mono: true },
  { key: 'quantity', label: '送检数量' },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function InspectionOrdersPage() {
  const queryClient = useQueryClient();
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
          <CardTitle>质检队列</CardTitle>
          <CardDescription>
            四类来源（reporting 末道/dispatch 外协回厂自动建单 + 手工）；放行→入库咬合。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="insp-kind-filter">类别过滤</Label>
              <Select id="insp-kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">全部类别</option>
                {INSPECTION_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="insp-state-filter">状态过滤</Label>
              <Select id="insp-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {INSPECTION_STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty="当前过滤条件下无质检单"
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>质检汇总</CardTitle>
            <CardDescription>待检/合格率/未闭环（inspection.summary，工作台 KPI 同源）。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={summaryQuery.isPending} error={summaryQuery.error} isEmpty={false}>
              <RowDetail row={summaryQuery.data ?? {}} />
            </QueryState>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={scanMutation.isPending}
                onClick={() => scanMutation.mutate()}
              >
                闭环超时点名（IM 推送）
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

function InspectionDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['inspection', 'detail', id],
    queryFn: () => getInspectionDetail(id),
  });
  const [passedQty, setPassedQty] = useState('1');
  const [failedQty, setFailedQty] = useState('0');
  const [remark, setRemark] = useState('');
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

  const payload = () => ({
    passedQty: Number(passedQty),
    failedQty: Number(failedQty),
    ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>质检单详情与判定</CardTitle>
        <CardDescription>判定（合格/不合格数量）；不合格自动生成处置单；复检可重判。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <RowDetail row={detailQuery.data ?? {}} />
        </QueryState>
        <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-passed">合格数量</Label>
            <Input id="insp-passed" type="number" min="0" step="1" value={passedQty} onChange={(e) => setPassedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-failed">不合格数量</Label>
            <Input id="insp-failed" type="number" min="0" step="1" value={failedQty} onChange={(e) => setFailedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-remark">备注（可选）</Label>
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
            判定
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(() => recheckInspectionOrder(id, row, payload()))}
          >
            复检
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

function CreateInspectionCard({ onChanged }: { readonly onChanged: () => void }) {
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
        <CardTitle>手工建质检单</CardTitle>
        <CardDescription>来源类型与来源对象须成对（report/dispatch/receipt；缺省=手工建单）。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-kind">质检类别</Label>
            <Select id="insp-new-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {INSPECTION_KINDS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-qty">送检数量</Label>
            <Input id="insp-new-qty" type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-source-type">来源类型（可选）</Label>
            <Select id="insp-new-source-type" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              <option value="">手工建单</option>
              <option value="report">report（末道报工）</option>
              <option value="dispatch">dispatch（外协回厂）</option>
              <option value="receipt">receipt（采购收货）</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-source-ref">来源对象 id（与来源类型成对）</Label>
            <Input id="insp-new-source-ref" value={sourceRefId} onChange={(e) => setSourceRefId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-item">物料 id（可选）</Label>
            <Input id="insp-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="insp-new-drawing">图号（可选）</Label>
            <Input id="insp-new-drawing" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
          </div>
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={mutation.isPending || Number(quantity) < 0}>
              建质检单
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
