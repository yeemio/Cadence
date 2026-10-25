/**
 * workorder 薄数据层（S2 批次）：fetch 直连 server workorder 端点，经共享
 * apiClient 注入 Bearer；端点/权限码/信封形状按 workorder.controllers.ts 实态
 * 映射（GET /workorder/work-orders ?state=、GET :id、:id/progress、
 * :id/machining-progress、:id/assembly-progress、GET kit-board、delivery-situation；
 * POST 建令/update/transitions/close/attachments/kit-checks；parts-requests 面）。
 */
import { fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';

export interface WorkOrderFilters {
  readonly state?: string | undefined;
}

export async function listWorkOrders(filters: WorkOrderFilters = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/workorder/work-orders${queryString([['state', filters.state]])}`, 'orders');
}

/** 详情（直返视图对象：order/attachments/latestKitCheck/milestones/customerName）。 */
export async function getWorkOrderDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/workorder/work-orders/${encodeURIComponent(id)}`);
}

/** 项目进度（直返视图对象）。 */
export async function getWorkOrderProgress(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/workorder/work-orders/${encodeURIComponent(id)}/progress`);
}

/** 机加工进度（直返 { workOrderId, rows }）。 */
export async function getMachiningProgress(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/workorder/work-orders/${encodeURIComponent(id)}/machining-progress`);
}

/** 装配调试进度（直返 { workOrderId, rows }）。 */
export async function getAssemblyProgress(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/workorder/work-orders/${encodeURIComponent(id)}/assembly-progress`);
}

export async function getKitBoard(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/workorder/kit-board', 'snapshots');
}

// ---- 命令（信封形状见 commandClient；载荷键按 workorder-input.ts 实态） ----

export function createWorkOrder(input: {
  readonly projectName: string;
  readonly customerRef?: string | undefined;
  readonly salesRep?: string | undefined;
  readonly manager?: string | undefined;
  readonly plannedDeliveryAt?: string | undefined;
  readonly packagingArrivalAt?: string | undefined;
}) {
  return postCommand('/workorder/work-orders', 'workorder.create.v1', {
    projectName: input.projectName,
    customerRef: input.customerRef ?? null,
    salesRep: input.salesRep ?? null,
    manager: input.manager ?? null,
    plannedDeliveryAt: input.plannedDeliveryAt ?? null,
    packagingArrivalAt: input.packagingArrivalAt ?? null,
  });
}

export function transitionWorkOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly targetState: string; readonly remark?: string | undefined },
) {
  return postCommand(
    `/workorder/work-orders/${encodeURIComponent(id)}/transitions`,
    'workorder.transition.v1',
    { targetState: input.targetState, remark: input.remark ?? null, evidence: [] },
    revisionOf(row, '工作令行'),
  );
}

export function closeWorkOrder(id: string, row: Record<string, unknown>, remark?: string) {
  return postCommand(
    `/workorder/work-orders/${encodeURIComponent(id)}/close`,
    'workorder.close.v1',
    { remark: remark ?? null },
    revisionOf(row, '工作令行'),
  );
}

export function attachToWorkOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly name: string; readonly kind: string; readonly ref: string },
) {
  return postCommand(
    `/workorder/work-orders/${encodeURIComponent(id)}/attachments`,
    'workorder.attach.v1',
    input,
    revisionOf(row, '工作令行'),
  );
}

export function refreshKitCheck(id: string, row: Record<string, unknown>) {
  return postCommand(
    `/workorder/work-orders/${encodeURIComponent(id)}/kit-checks`,
    'workorder.kit.refresh.v1',
    {},
    revisionOf(row, '工作令行'),
  );
}

// ---- 配件申请面（POST /workorder/parts-requests 系） ----

export interface PartsFilters {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
}

export async function listPartsRequests(filters: PartsFilters = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/workorder/parts-requests${queryString([['state', filters.state], ['workOrderId', filters.workOrderId]])}`,
    'partsRequests',
  );
}

/** 配件申请详情（直返视图对象：partsRequest + milestones）。 */
export async function getPartsRequestDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/workorder/parts-requests/${encodeURIComponent(id)}`);
}

export function createPartsRequest(input: {
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly remark?: string | undefined;
}) {
  return postCommand('/workorder/parts-requests', 'workorder.parts.request.v1', {
    workOrderId: input.workOrderId,
    itemId: input.itemId,
    quantity: input.quantity,
    remark: input.remark ?? null,
  });
}

export function decidePartsRequest(
  id: string,
  row: Record<string, unknown>,
  input: { readonly decision: 'approve' | 'reject'; readonly remark: string },
) {
  return postCommand(
    `/workorder/parts-requests/${encodeURIComponent(id)}/approval`,
    'workorder.parts.approve.v1',
    input,
    revisionOf(row, '配件申请行'),
  );
}

export function shipPartsRequest(
  id: string,
  row: Record<string, unknown>,
  input: { readonly shipmentRef?: string | undefined; readonly remark?: string | undefined },
) {
  return postCommand(
    `/workorder/parts-requests/${encodeURIComponent(id)}/shipment`,
    'workorder.parts.ship.v1',
    { shipmentRef: input.shipmentRef ?? null, remark: input.remark ?? null },
    revisionOf(row, '配件申请行'),
  );
}
