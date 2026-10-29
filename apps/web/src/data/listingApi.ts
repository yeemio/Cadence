/**
 * listing 薄数据层（S2 批次）：清单面（sheets/import/line.update/gap-checks）+
 * 采购面（requests/orders/returns/overdue/details）。端点/权限码/载荷形状按
 * listing.controllers.ts 与 listing-input.ts 实态映射。
 */
import { fetchObject, fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';

// ---- 清单面 ----

/** 四类清单按工作令（workOrderId 查询参数必填——控制器实态）。 */
export async function listSheets(workOrderId: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/listing/sheets${queryString([['workOrderId', workOrderId]])}`, 'sheets');
}

/** 清单详情（直返视图对象，含行）。 */
export async function getSheetDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/listing/sheets/${encodeURIComponent(id)}`);
}

/** 骨架导入（source=workorder：工作令骨架四类清单）。 */
export function importSkeleton(workOrderId: string) {
  return postCommand('/listing/imports', 'listing.import.v1', { source: 'workorder', workOrderId });
}

/** 清单行新增类型（四类清单 kind；词源 listing-config LISTING_KINDS）。 */
export type ListingKindId = 'part' | 'standard' | 'electrical' | 'equipment';

/**
 * 手工新增清单行（复用行导入通道：单行结构化表——表头走后端既有别名集，
 * 物料编码自动比对物料库；无该类目清单时自动创建）。
 */
export function addListingLine(input: {
  readonly equipmentRef?: string | undefined;
  readonly origin?: 'production' | 'aftermarket';
  readonly workOrderId: string;
  readonly kind: ListingKindId;
  readonly drawingNo?: string | undefined;
  readonly code?: string | undefined;
  readonly name?: string | undefined;
  readonly spec?: string | undefined;
  readonly requiredQty: number;
  readonly neededBy?: string | undefined;
}) {
  const row = [
    input.drawingNo?.trim() ?? '',
    input.code?.trim() ?? '',
    input.name?.trim() ?? '',
    input.spec?.trim() ?? '',
    String(input.requiredQty),
    input.neededBy?.trim() ?? '',
  ];
  return postCommand('/listing/imports', 'listing.import.v1', {
    source: 'excel',
    equipmentRef: input.equipmentRef?.trim() || null,
    origin: input.origin ?? 'production',
    workOrderId: input.workOrderId,
    kind: input.kind,
    excel: {
      kind: 'json-tables',
      sheets: [
        { name: '手工录入', header: ['图号', '物料编码', '物料名称', '规格型号', '数量', '需求日期'], rows: [row] },
      ],
    },
  });
}

/** 清单行修订（expectedRevision = 行 objectVersion）。 */
export function updateListingLine(
  lineId: string,
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  return postCommand(
    `/listing/lines/${encodeURIComponent(lineId)}/update`,
    'listing.line.update.v1',
    fields,
    revisionOf(row, '清单行'),
  );
}

/** 缺口核查动作（产出不可变快照；expectedRevision = 'initial'——测试实态）。 */
export function runGapCheck(workOrderId: string) {
  return postCommand(`/listing/work-orders/${encodeURIComponent(workOrderId)}/gap-checks`, 'gap.check.v1', {});
}

/** 最新缺口核查结果（{gapCheck}；无核查记录时服务端回 gapCheck=null → 本函数返回 null）。 */
export async function getLatestGapCheck(workOrderId: string): Promise<Record<string, unknown> | null> {
  const body = await fetchRawObject(`/listing/work-orders/${encodeURIComponent(workOrderId)}/gap-checks/latest`);
  const value = body['gapCheck'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---- 采购申请面 ----

export interface PurchaseRequestFilters {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
}

export async function listPurchaseRequests(
  filters: PurchaseRequestFilters = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/purchase/requests${queryString([
      ['state', filters.state],
      ['workOrderId', filters.workOrderId],
      ['purchaseOrderId', filters.purchaseOrderId],
    ])}`,
    'requests',
  );
}

export function createPurchaseRequest(input: {
  readonly kind: 'nonstandard' | 'standard' | 'equipment';
  readonly itemId: string;
  readonly quantity: number;
  readonly workOrderId?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/purchase/requests', 'purchase.request.create.v1', {
    kind: input.kind,
    itemId: input.itemId,
    quantity: input.quantity,
    workOrderId: input.workOrderId ?? null,
    remark: input.remark ?? null,
    // 服务端契约（UX-PUR-R2-06）：source 省略/null = 手工发起；显式对象仅接受
    // 缺口一键发起锚点 {type:'gap', gapCheckId, listingLineId}。手工建单不得
    // 传 {type:'manual'}（会被拒「source.type 非法：须为 'gap'」）。
    source: null,
  });
}

// ---- 采购订单面 ----

export interface PurchaseOrderFilters {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
}

export async function listPurchaseOrders(
  filters: PurchaseOrderFilters = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/purchase/orders${queryString([['state', filters.state], ['workOrderId', filters.workOrderId]])}`,
    'orders',
  );
}

/** 订单全流程视图（直返对象）。 */
export async function getPurchaseOrderDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/purchase/orders/${encodeURIComponent(id)}`);
}

export function submitPurchaseOrder(input: {
  readonly promisedAt: string;
  readonly lines: ReadonlyArray<{
    readonly itemId: string;
    readonly quantity: number;
    readonly unitPriceMinor?: number | undefined;
  }>;
  readonly supplierRef?: string | undefined;
  readonly supplierName?: string | undefined;
  readonly workOrderId?: string | undefined;
}) {
  return postCommand('/purchase/orders', 'purchase.order.submit.v1', {
    promisedAt: input.promisedAt,
    lines: input.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      drawingNo: null,
      unitPriceMinor: line.unitPriceMinor ?? null,
    })),
    supplierRef: input.supplierRef ?? null,
    supplierName: input.supplierName ?? null,
    workOrderId: input.workOrderId ?? null,
    requestIds: [],
    buyer: null,
    remark: null,
  });
}

/** 订单审批（remark 必填——决策可回溯）。 */
export function approvePurchaseOrder(id: string, row: Record<string, unknown>, remark: string) {
  return postCommand(
    `/purchase/orders/${encodeURIComponent(id)}/approval`,
    'purchase.order.approve.v1',
    { remark },
    revisionOf(row, '采购订单行'),
  );
}

export function issuePurchaseOrder(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/purchase/orders/${encodeURIComponent(id)}/issue`,
    'purchase.order.issue.v1',
    { remark: remark ?? null },
    revisionOf(row, '采购订单行'),
  );
}

/** 收货（lines=[{lineNo, receivedQty}]；联动库存 receiptKey 幂等入库）。 */
export function receivePurchaseOrder(
  id: string,
  row: Record<string, unknown>,
  input: {
    readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly receivedQty: number }>;
    readonly receiptRef?: string | undefined;
    readonly remark?: string | undefined;
  },
) {
  return postCommand(
    `/purchase/orders/${encodeURIComponent(id)}/receipts`,
    'purchase.order.receive.v1',
    {
      lines: input.lines,
      receiptRef: input.receiptRef ?? null,
      remark: input.remark ?? null,
    },
    revisionOf(row, '采购订单行'),
  );
}

// ---- 采购退货面 ----

export async function listPurchaseReturns(purchaseOrderId: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/purchase/returns${queryString([['purchaseOrderId', purchaseOrderId]])}`, 'returns');
}

export function createPurchaseReturn(
  input: {
    readonly purchaseOrderId: string;
    readonly lines: ReadonlyArray<{
      readonly lineNo: number;
      readonly returnedQty: number;
      readonly reason?: string | undefined;
    }>;
    readonly remark?: string | undefined;
  },
) {
  return postCommand('/purchase/returns', 'purchase.return.create.v1', {
    purchaseOrderId: input.purchaseOrderId,
    lines: input.lines.map((line) => ({
      lineNo: line.lineNo,
      returnedQty: line.returnedQty,
      reason: line.reason ?? null,
    })),
    remark: input.remark ?? null,
  });
}

export function revokePurchaseReturn(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/purchase/returns/${encodeURIComponent(id)}/revoke`,
    'purchase.return.revoke.v1',
    { remark: remark ?? null },
    revisionOf(row, '退货单行'),
  );
}

// ---- 采购明细/逾期面 ----

/** 逾期未交明细（{overdue}）。 */
export async function listOverdue(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/purchase/overdue', 'overdue');
}

/** 逾期事实扫描（催货触发面）。 */
export function scanOverdue() {
  return postCommand('/purchase/overdue-scan', 'purchase.overdue.scan.v1', {});
}

/** 采购明细（直返对象）。 */
export async function getPurchaseDetails(workOrderId?: string | undefined): Promise<Record<string, unknown>> {
  return fetchRawObject(`/purchase/details${queryString([['workOrderId', workOrderId]])}`);
}

/** 采购明细导出（直返导出载荷对象）。 */
export async function exportPurchaseDetails(workOrderId?: string | undefined): Promise<Record<string, unknown>> {
  return fetchRawObject(`/purchase/details/export${queryString([['workOrderId', workOrderId]])}`);
}

export const receivingWarehouseOptions = () => fetchRows('/purchase/receiving-warehouses', 'warehouses');

/** 收货动作自己的最小订单读面（无价格/审批信息）。 */
export function listReceivingOrders() { return fetchRows('/purchase/receiving-orders', 'orders'); }
