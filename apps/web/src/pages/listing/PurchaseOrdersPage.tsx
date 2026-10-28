/**
 * 采购订单页（S2 批次）：五态订单列表（状态/工作令过滤）+ 建单提交表单 + 选中
 * 订单全流程视图 + 审批/下发/收货/退货回退操作。覆盖矩阵 #59 采购订单、#60 采购收货。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import {
  approvePurchaseOrder,
  createPurchaseReturn,
  getPurchaseOrderDetail,
  issuePurchaseOrder,
  listPurchaseOrders,
  listPurchaseRequests,
  receivingWarehouseOptions,
} from '../../data/listingApi';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf, postCommand, revisionOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, type TableColumn } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { formatLocalDateTime, shortId } from '@/lib/format';

const ORDER_STATES = ['draft', 'submitted', 'approved', 'issued', 'received'] as const;

/** 词源逐词对齐 listing-config.ts PURCHASE_ORDER_STATES 官方中文，不自造词。 */
const PO_STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交待审',
  approved: '已审核',
  issued: '已下发',
  received: '已收货',
};

const poStateLabel = (state: string): string => PO_STATE_LABELS[state] ?? state;

/** 迁移事件中文（未知 id 原样返回；与 listing-config.ts DEFAULT_PURCHASE_ORDER_FLOW_CONFIG 五条迁移同口径）。 */
const PO_EVENT_LABELS: Readonly<Record<string, string>> = {
  SUBMIT: '提交',
  APPROVE: '审批通过',
  ISSUE: '下发',
  RECEIVE: '收货',
  RETURN: '退货回退',
};

function poEventLabel(event: string): string {
  return PO_EVENT_LABELS[event] ?? event;
}

/** 采购申请 kind → 中文名（词源 listing-config PURCHASE_REQUEST_KINDS 三类，不自造词）。 */
const REQUEST_KIND_LABELS: Readonly<Record<string, string>> = {
  nonstandard: '非标件',
  standard: '标准配件',
  equipment: '设备',
};

function requestKindLabel(kind: string): string {
  return REQUEST_KIND_LABELS[kind] ?? kind;
}

/**
 * 审批权限码（UX-PUR-R2-04，W2 模式）：与后端 POST /purchase/orders/:id/approval
 * 端点 @RequirePermission 同码。呈现层按会话权限闸「审批通过」按钮——无权限
 * 禁用 + 人话提示，权限码只进 data-permission-code 供排查（不出现在可见文案）。
 */
const PURCHASE_APPROVE_PERMISSION = permissionCode('purchase:approve');

/**
 * 采购订单详情结构化读面（UX-PUR-05：白名单键 + 中文标签 + 时刻本地化，替代裸键值
 * RowDetail——嵌套对象原以紧凑 JSON 同屏堆积不可读）。
 * 后端详情形状 = { order, milestones, requests }（listing.service.PurchaseOrderDetail：
 * order 含 lines 行集）。状态/事件中文与 listing-config.ts 同口径，不臆造。
 */
function PurchaseOrderDetailView({ detail }: { readonly detail: Record<string, unknown> }) {
  const order = (detail['order'] ?? null) !== null && typeof detail['order'] === 'object'
    ? (detail['order'] as Record<string, unknown>)
    : {};
  const milestones = Array.isArray(detail['milestones'])
    ? (detail['milestones'] as readonly Record<string, unknown>[])
    : [];
  const requests = Array.isArray(detail['requests'])
    ? (detail['requests'] as readonly Record<string, unknown>[])
    : [];
  const lines = Array.isArray(order['lines'])
    ? (order['lines'] as readonly Record<string, unknown>[])
    : [];

  const text = (key: string): string => {
    const value = order[key];
    return value === undefined || value === null ? '' : String(value);
  };

  // UX-PUR-R2-08：采购负责人是用户 id，无采购侧姓名读面（用户列表读需 org 权限，
  // 采购岗无权）——按长 id 截断口径显示，悬停 title 保留全量 id 供复制排查。
  const buyerText = text('buyer');

  const fields = (
    [
      { label: '订单号', value: text('id'), mono: true },
      { label: '状态', value: poStateLabel(text('state')) },
      { label: '供应商', value: text('supplierName') || text('supplierRef') },
      { label: '工作令', value: text('workOrderId'), mono: true },
      { label: '交期', value: formatLocalDateTime(text('promisedAt')) },
      { label: '采购负责人', value: shortId(buyerText), mono: true, title: buyerText },
      { label: '备注', value: text('remark') },
      { label: '收货单号', value: text('receiptRef'), mono: true },
      { label: '创建时刻', value: formatLocalDateTime(text('createdAt')) },
      { label: '更新时刻', value: formatLocalDateTime(text('updatedAt')) },
    ] satisfies ReadonlyArray<{
      readonly label: string;
      readonly value: string;
      readonly mono?: boolean;
      readonly title?: string;
    }>
  ).filter((field) => field.value.length > 0 && field.value !== '—');

  const requestIds = requests.map((request) => String(request['id'])).filter((id) => id.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-xs text-muted-foreground">{field.label}</dt>
            <dd
              className={field.mono === true ? 'break-all font-mono text-xs' : 'break-all text-xs'}
              title={field.title}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      {lines.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">订单行</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">行号</th>
                  <th className="py-2 pr-4 font-medium">物料</th>
                  <th className="py-2 pr-4 font-medium">图号</th>
                  <th className="py-2 pr-4 font-medium">数量</th>
                  <th className="py-2 pr-4 font-medium">已收数量</th>
                  <th className="py-2 pr-4 font-medium">单价（分）</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={String(line['lineNo'] ?? index)} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 text-xs">{String(line['lineNo'] ?? index + 1)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(line['itemId'] ?? '—')}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(line['drawingNo'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">{String(line['quantity'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">{String(line['receivedQty'] ?? '—')}</td>
                    <td className="py-2 pr-4 text-xs">
                      {line['unitPriceMinor'] === null || line['unitPriceMinor'] === undefined
                        ? '未定价'
                        : String(line['unitPriceMinor'])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {requestIds.length > 0 && (
        <p className="break-all text-xs text-muted-foreground">
          来源采购申请：<span className="font-mono">{requestIds.join('、')}</span>
        </p>
      )}
      {milestones.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">流转记录</p>
          <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
            {milestones.map((milestone, index) => {
              const from = poStateLabel(String(milestone['from'] ?? ''));
              const to = poStateLabel(String(milestone['to'] ?? ''));
              const event = poEventLabel(String(milestone['event'] ?? ''));
              const at = formatLocalDateTime(String(milestone['at'] ?? ''));
              const actor = String(milestone['actor'] ?? '');
              return (
                <li key={index}>
                  {from} → {to}（{event}）
                  {at !== '—' ? ` · ${at}` : ''}
                  {actor.length > 0 ? ` · 操作人 ${actor}` : ''}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'supplierName', label: '供应商' },
  { key: 'state', label: '状态', mono: true },
  { key: 'promisedAt', label: '交期', format: 'datetime' },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
  { key: 'createdAt', label: '创建时刻', format: 'datetime' },
] satisfies readonly TableColumn[];

export function PurchaseOrdersPage() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('');
  const [workOrderIdFilter, setWorkOrderIdFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ordersQuery = useQuery({
    queryKey: ['purchase', 'orders', stateFilter, workOrderIdFilter],
    queryFn: () =>
      listPurchaseOrders({
        ...(stateFilter === '' ? {} : { state: stateFilter }),
        ...(workOrderIdFilter.trim() === '' ? {} : { workOrderId: workOrderIdFilter.trim() }),
      }),
  });

  const selectedRow = ordersQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>采购订单列表</CardTitle>
          <CardDescription>五态全链（draft→submitted→approved→issued→received）；点行选中订单后，收货在其详情卡内操作。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div className="flex flex-col gap-2">
              <Label htmlFor="po-state-filter">状态过滤</Label>
              <Select id="po-state-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部状态</option>
                {ORDER_STATES.map((state) => (
                  <option key={state} value={state}>{poStateLabel(state)}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="po-wo-filter">工作令过滤（可选）</Label>
              <Input id="po-wo-filter" value={workOrderIdFilter} onChange={(e) => setWorkOrderIdFilter(e.target.value)} />
            </div>
          </div>
          <QueryState
            isPending={ordersQuery.isPending}
            error={ordersQuery.error}
            isEmpty={ordersQuery.data !== undefined && ordersQuery.data.length === 0}
            empty="当前过滤条件下无采购订单"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={(ordersQuery.data ?? []).map((row) => ({ ...row, state: poStateLabel(String(row['state'])) }))}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedRow !== null && (
        <OrderDetailCard
          key={String(selectedRow['id'])}
          row={selectedRow}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['purchase'] })}
        />
      )}

      <SubmitOrderCard onChanged={() => queryClient.invalidateQueries({ queryKey: ['purchase'] })} />
    </div>
  );
}

function OrderDetailCard({
  row,
  onChanged,
}: {
  readonly row: Record<string, unknown>;
  readonly onChanged: () => void;
}) {
  const id = String(row['id']);
  const detailQuery = useQuery({
    queryKey: ['purchase', 'order-detail', id],
    queryFn: () => getPurchaseOrderDetail(id),
  });
  // UX-PUR-06：操作按钮按订单状态呈现层禁用（不改服务端校验）——迁移口径 =
  // listing-config.ts DEFAULT_PURCHASE_ORDER_FLOW_CONFIG：submitted 可审批
  // （APPROVE）、approved 可下发（ISSUE）、issued 可收货（RECEIVE；received 经
  // RETURN 回退到 issued 后可重新收货——同为 issued 态放行）。草稿须先提交。
  const state = String(row['state']);
  const canApprove = state === 'submitted';
  const canIssue = state === 'approved';
  const canReceive = state === 'issued';
  // UX-PUR-R2-07：received 态放开退货回退（return.create 驱动 received→issued，
  // 回退后可重新收货——流转记录可见「退货回退」里程碑）。
  const canReturn = state === 'received';
  // UX-PUR-R2-04：审批按会话权限闸（W2 模式；与端点 @RequirePermission 同码）。
  const { data: permissionData } = usePermissions({});
  const hasApprovePermission =
    permissionData !== undefined &&
    sessionHasPermission(toPermissionCodes(permissionData), PURCHASE_APPROVE_PERMISSION);
  const STATE_HINTS: Readonly<Record<string, string>> = {
    draft: '当前为草稿：须先提交进入待审后才可审批（建单表单提交后即进入待审）。',
    submitted: '当前为已提交待审：可「审批通过」；审批通过后才可下发，下发后才可收货。',
    approved: '当前为已审核：可「下发订单」；下发后才可收货。',
    issued: '当前为已下发：可「收货入库」。',
    received: '当前为已收货：可按行号×数量「退货回退」，订单回到已下发后可重新收货。',
  };
  const [remark, setRemark] = useState('');
  const [lineNo, setLineNo] = useState('1');
  const [receivedQty, setReceivedQty] = useState('1');
  const [receiptRef, setReceiptRef] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  // UX-PUR-R2-02：收货仓库下拉（listWarehouses，值落 warehouseId，留空=默认仓）。
  // 仓库列表读需仓库查看权限——无权限/加载失败时降级回文本框（可手填仓库 id），
  // 收货动作不被选择器阻断。
  const warehousesQuery = useQuery({ queryKey: ['purchase', 'receiving-warehouses'], queryFn: receivingWarehouseOptions });
  const warehouseOptions = warehousesQuery.data ?? [];

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
        <CardTitle>订单全流程视图与操作</CardTitle>
        <CardDescription>
          审批（理由必填）/下发/收货（按行号×数量，联动库存幂等入库，可选指定收货仓库）；
          已收货订单可退货回退（回到已下发后可重新收货，流转记录可查）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
          <PurchaseOrderDetailView detail={detailQuery.data ?? {}} />
        </QueryState>

        <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1fr_1fr] lg:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-remark">决策理由（审批必填）</Label>
            <Input id="po-op-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="审批理由" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-lineno">收货行号</Label>
            <Input id="po-op-lineno" type="number" min="1" step="1" value={lineNo} onChange={(e) => setLineNo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-qty">收货数量</Label>
            <Input id="po-op-qty" type="number" min="0.000001" step="any" value={receivedQty} onChange={(e) => setReceivedQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-receipt">收货单号（可选）</Label>
            <Input id="po-op-receipt" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-op-warehouse">收货仓库（可选，留空入默认仓）</Label>
            {warehouseOptions.length > 0 ? (
              <Select
                id="po-op-warehouse"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                <option value="">默认仓</option>
                {warehouseOptions.map((warehouse) => {
                  const warehouseRowId = String(warehouse['id']);
                  const code = String(warehouse['code'] ?? '');
                  const name = String(warehouse['name'] ?? '');
                  return (
                    <option key={warehouseRowId} value={warehouseRowId}>
                      {name.length > 0 ? `${code} · ${name}` : code}
                    </option>
                  );
                })}
              </Select>
            ) : (
              <Input
                id="po-op-warehouse"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                placeholder="仓库 id"
              />
            )}
            {warehousesQuery.isError && (
              <p className="text-xs text-muted-foreground">
                收货仓库选项加载失败，请刷新后重试；留空按默认仓规则处理。
              </p>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {state === 'submitted' && !hasApprovePermission ? '订单待审核，请由具有采购审批权限的人员处理。' : STATE_HINTS[state] ?? `当前状态：${poStateLabel(state)}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-permission-code="purchase:approve"
            disabled={mutation.isPending || !canApprove || !hasApprovePermission}
            title={
              !hasApprovePermission
                ? '当前账号没有采购审批权限，须由持审批权限的账号操作（可联系管理员开通）'
                : canApprove
                  ? undefined
                  : '仅「已提交待审」的订单可审批'
            }
            onClick={() => mutation.mutate(() => approvePurchaseOrder(id, row, remark.trim() || '同意'))}
          >
            审批通过
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || !canIssue}
            title={canIssue ? undefined : '仅「已审核」的订单可下发'}
            onClick={() =>
              mutation.mutate(() => issuePurchaseOrder(id, row, remark.trim().length > 0 ? remark.trim() : undefined))
            }
          >
            下发订单
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || !canReceive || Number(receivedQty) <= 0}
            title={canReceive ? undefined : '仅「已下发」的订单可收货'}
            onClick={() =>
              mutation.mutate(() =>
                postCommand(
                  `/purchase/orders/${encodeURIComponent(id)}/receipts`,
                  'purchase.order.receive.v1',
                  {
                    lines: [{ lineNo: Number(lineNo), receivedQty: Number(receivedQty) }],
                    warehouseId: warehouseId.trim().length > 0 ? warehouseId.trim() : null,
                    receiptRef: receiptRef.trim().length > 0 ? receiptRef.trim() : null,
                    remark: null,
                  },
                  revisionOf(row, '采购订单行'),
                ),
              )
            }
          >
            收货入库
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || !canReturn || Number(receivedQty) <= 0}
            title={
              canReturn
                ? '按上方行号×数量登记退货，订单回退到「已下发」后可重新收货（退货原因可填在决策理由框）'
                : '仅「已收货」的订单可退货回退'
            }
            onClick={() =>
              mutation.mutate(() =>
                createPurchaseReturn({
                  purchaseOrderId: id,
                  lines: [
                    {
                      lineNo: Number(lineNo),
                      returnedQty: Number(receivedQty),
                      ...(remark.trim().length > 0 ? { reason: remark.trim() } : {}),
                    },
                  ],
                }),
              )
            }
          >
            退货回退
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}

/**
 * 单价输入（元，精确到分）→ 载荷分整数（UX-PUR-07：表单按业务货币单位填写，
 * 提交前换算——载荷单位仍为分，服务端校验不变）。
 * 空串 → null（未定价）；非法（≤0 / 非数 / 超服务端上限 2e9 分）→ NaN（提交前拦截，不静默降级）。
 */
function parseUnitPriceMinorInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  const minor = Math.round(value * 100);
  return minor > 2_000_000_000 ? Number.NaN : minor;
}

function SubmitOrderCard({ onChanged }: { readonly onChanged: () => void }) {
  const [supplierRef, setSupplierRef] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [promisedAt, setPromisedAt] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPriceInput, setUnitPriceInput] = useState('');
  const [remark, setRemark] = useState('');
  // UX-PUR-03/R2-01：关联配件申请改选择器（多选勾选）——数据源 = 采购申请列表，
  // 承接约束与服务端一致：草稿态且未被其他订单承接（state=draft 过滤 +
  // purchaseOrderId 空客户端过滤）；选中值仍落 requestIds，载荷契约不变。
  const [selectedRequestIds, setSelectedRequestIds] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const linkableQuery = useQuery({
    queryKey: ['purchase', 'requests', 'linkable'],
    queryFn: () => listPurchaseRequests({ state: 'draft' }),
  });
  const linkableRequests = (linkableQuery.data ?? []).filter(
    (request) => (request['purchaseOrderId'] ?? null) === null,
  );

  function toggleRequestId(requestId: string): void {
    setSelectedRequestIds((current) =>
      current.includes(requestId) ? current.filter((entry) => entry !== requestId) : [...current, requestId],
    );
  }

  const unitPriceMinor = parseUnitPriceMinorInput(unitPriceInput);
  const unitPriceInvalid = Number.isNaN(unitPriceMinor);

  const mutation = useMutation({
    mutationFn: () =>
      postCommand(
        '/purchase/orders',
        'purchase.order.submit.v1',
        {
          promisedAt: promisedAt.trim(),
          lines: [
            {
              itemId: itemId.trim(),
              quantity: Number(quantity),
              drawingNo: null,
              unitPriceMinor,
            },
          ],
          supplierRef: supplierRef.trim().length > 0 ? supplierRef.trim() : null,
          supplierName: supplierName.trim().length > 0 ? supplierName.trim() : null,
          workOrderId: workOrderId.trim().length > 0 ? workOrderId.trim() : null,
          requestIds: [...selectedRequestIds],
          buyer: null,
          remark: remark.trim().length > 0 ? remark.trim() : null,
        },
        'initial',
      ),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        onChanged();
        setSupplierRef('');
        setSupplierName('');
        setPromisedAt('');
        setWorkOrderId('');
        setItemId('');
        setQuantity('1');
        setUnitPriceInput('');
        setRemark('');
        setSelectedRequestIds([]);
      }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unitPriceInvalid) return; // UX-PUR-07：非法单价不提交（回车提交路径同样被拦）
    mutation.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>建单并提交采购订单</CardTitle>
        <CardDescription>
          交期必填（逾期事实口径锚点）；单价按元填写（精确到分，可留空=暂未定价）；
          可勾选关联需求来源的配件申请（仅草稿态且未被其他订单承接的申请可选，承接后不再可被其他订单关联）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-supplier-ref">供应商引用（可选）</Label>
            <Input id="po-new-supplier-ref" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="SUP-01" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-supplier-name">供应商名称（可选）</Label>
            <Input id="po-new-supplier-name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-promised">交期（必填，ISO 8601）</Label>
            <Input id="po-new-promised" value={promisedAt} onChange={(e) => setPromisedAt(e.target.value)} placeholder="2026-12-01" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-wo">工作令（可选）</Label>
            <Input id="po-new-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-item">行 1 物料 id</Label>
            <Input id="po-new-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-qty">行 1 数量</Label>
            <Input id="po-new-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="po-new-price">行 1 单价（元，精确到分，可选）</Label>
            <Input
              id="po-new-price"
              type="number"
              min="0.01"
              step="0.01"
              value={unitPriceInput}
              onChange={(e) => setUnitPriceInput(e.target.value)}
              placeholder="如 128.50"
            />
            {unitPriceInvalid && (
              <p role="alert" className="text-xs text-destructive">
                单价须为大于 0 的金额（可留空表示暂未定价）
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium leading-none">关联配件申请（可选，多选）</span>
            {linkableQuery.isPending ? (
              <p className="text-xs text-muted-foreground">正在加载可关联的配件申请…</p>
            ) : linkableQuery.isError ? (
              <p className="text-xs text-destructive">
                可关联申请加载失败：{linkableQuery.error instanceof Error ? linkableQuery.error.message : String(linkableQuery.error)}
              </p>
            ) : linkableRequests.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                暂无可关联的配件申请（仅草稿态、未被其他订单承接的申请可关联）。
              </p>
            ) : (
              <fieldset className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-lg border p-3">
                {linkableRequests.map((request) => {
                  const requestId = String(request['id']);
                  const checked = selectedRequestIds.includes(requestId);
                  return (
                    <label key={requestId} className="flex items-center gap-2 text-xs" title={requestId}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRequestId(requestId)}
                      />
                      <span className="font-mono">{shortId(requestId)}</span>
                      <span className="text-muted-foreground">
                        {requestKindLabel(String(request['kind']))} · 物料 {shortId(request['itemId'])} ×{' '}
                        {String(request['quantity'] ?? '—')}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="po-new-remark">备注（可选）</Label>
            <Input id="po-new-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="采购说明、用途等" />
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              建单失败：{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </p>
          )}
          {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                promisedAt.trim().length === 0 ||
                itemId.trim().length === 0 ||
                Number(quantity) <= 0 ||
                unitPriceInvalid
              }
            >
              建单并提交
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
