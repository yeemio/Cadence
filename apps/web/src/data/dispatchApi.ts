/**
 * dispatch 薄数据层（S2 批次）：六类派工单面 + 外协面。端点/权限码/载荷形状按
 * dispatch.controllers.ts 与 dispatch-input.ts 实态映射。
 */
import { fetchObject, fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';

export interface DispatchFilters {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly assignee?: string | undefined;
}

export async function listDispatchOrders(
  filters: DispatchFilters = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/dispatch/orders${queryString([
      ['kind', filters.kind],
      ['state', filters.state],
      ['workOrderId', filters.workOrderId],
      ['assignee', filters.assignee],
    ])}`,
    'orders',
  );
}

/** 派工单详情（直返对象：外协行 + 里程碑）。 */
export async function getDispatchDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/dispatch/orders/${encodeURIComponent(id)}`);
}

/** 六类派工创建（载荷判别按 dispatch-input：part 需图号+工序；outsourcing 需行集；
 *  assembly/electrical 需工序；aftermarket/oddjob 需标题或工序）。 */
export function createDispatchOrder(input: {
  readonly kind: 'part' | 'outsourcing' | 'assembly' | 'electrical' | 'aftermarket' | 'oddjob';
  readonly quantity: number;
  readonly workOrderId?: string | undefined;
  readonly title?: string | undefined;
  readonly drawingNo?: string | undefined;
  readonly operationCode?: string | undefined;
  readonly assignee?: string | undefined;
  readonly dueAt?: string | undefined;
  readonly remark?: string | undefined;
  readonly lines?: ReadonlyArray<{
    readonly processCode: string;
    readonly supplierRef: string;
    readonly quantity: number;
    readonly supplierName?: string | undefined;
    readonly drawingNo?: string | undefined;
    readonly unitPriceMinor?: number | undefined;
    readonly promisedAt?: string | undefined;
  }>;
}) {
  return postCommand('/dispatch/orders', 'dispatch.create.v1', {
    kind: input.kind,
    quantity: input.quantity,
    workOrderId: input.workOrderId ?? null,
    title: input.title ?? null,
    drawingNo: input.drawingNo ?? null,
    operationCode: input.operationCode ?? null,
    material: null,
    sizeSpec: null,
    assignee: input.assignee ?? null,
    dueAt: input.dueAt ?? null,
    remark: input.remark ?? null,
    lines: (input.lines ?? []).map((line) => ({
      processCode: line.processCode,
      drawingNo: line.drawingNo ?? null,
      supplierRef: line.supplierRef,
      supplierName: line.supplierName ?? null,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor ?? null,
      promisedAt: line.promisedAt ?? null,
      sourceListingLineId: null,
    })),
  });
}

export function assignDispatchOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly assignee: string; readonly remark?: string | undefined },
) {
  return postCommand(
    `/dispatch/orders/${encodeURIComponent(id)}/assign`,
    'dispatch.assign.v1',
    { assignee: input.assignee, remark: input.remark ?? null },
    revisionOf(row, '派工单行'),
  );
}

export function startDispatchOrder(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/dispatch/orders/${encodeURIComponent(id)}/start`,
    'dispatch.start.v1',
    { remark: remark ?? null },
    revisionOf(row, '派工单行'),
  );
}

export function completeDispatchOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly doneQty?: number | undefined; readonly remark?: string | undefined },
) {
  return postCommand(
    `/dispatch/orders/${encodeURIComponent(id)}/complete`,
    'dispatch.complete.v1',
    { doneQty: input.doneQty ?? null, remark: input.remark ?? null },
    revisionOf(row, '派工单行'),
  );
}

export function cancelDispatchOrder(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/dispatch/orders/${encodeURIComponent(id)}/cancel`,
    'dispatch.cancel.v1',
    { remark: remark ?? null },
    revisionOf(row, '派工单行'),
  );
}

// ---- 任务/进度面 ----

/** 按人任务视图（assignee 必填）。 */
export async function listTasksByAssignee(assignee: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/dispatch/tasks${queryString([['assignee', assignee]])}`, 'tasks');
}

/** 按序任务视图（工作令维度）。 */
export async function listTasksByWorkOrder(workOrderId: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/dispatch/work-orders/${encodeURIComponent(workOrderId)}/tasks`, 'tasks');
}

/** 进度事实（工作令维度）。 */
export async function listProgressFacts(workOrderId: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/dispatch/work-orders/${encodeURIComponent(workOrderId)}/progress-facts`, 'facts');
}

// ---- 外协面 ----

/** 供应商维度外协明细（supplierRef 必填）。 */
export async function listOutsourcingLines(supplierRef: string): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/outsourcing/lines${queryString([['supplierRef', supplierRef]])}`, 'lines');
}

/** 单价补录（expectedRevision = 外协明细行 objectVersion）。 */
export function backfillOutsourcingPrice(
  lineId: string,
  row: Record<string, unknown>,
  input: { readonly unitPriceMinor: number; readonly promisedAt?: string | undefined; readonly remark?: string | undefined },
) {
  return postCommand(
    `/outsourcing/lines/${encodeURIComponent(lineId)}/price-backfill`,
    'outsourcing.price.backfill.v1',
    {
      unitPriceMinor: input.unitPriceMinor,
      promisedAt: input.promisedAt ?? null,
      remark: input.remark ?? null,
    },
    revisionOf(row, '外协明细行'),
  );
}

/** 外协加工单打印数据（{document}）。 */
export async function getOutsourcingPrintData(orderId: string): Promise<Record<string, unknown>> {
  return fetchObject(`/outsourcing/orders/${encodeURIComponent(orderId)}/print-data`, 'document');
}
