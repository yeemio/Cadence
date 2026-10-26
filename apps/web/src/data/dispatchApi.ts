/**
 * dispatch 薄数据层（S2 批次）：六类派工单面 + 外协面。端点/权限码/载荷形状按
 * dispatch.controllers.ts 与 dispatch-input.ts 实态映射。
 * fix-wave-6 6a-1 增量：转单/导出/状态统计/批操作/取消外协明细行。
 */
import { request } from './apiClient';
import {
  ModuleApiError,
  fetchObject,
  fetchRawObject,
  fetchRows,
  newOperationId,
  postCommand,
  queryString,
  revisionOf,
} from './commandClient';

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

/** 转单（6a-1：executing 单换执行人/工序；至少其一，审计事件随命令落账）。 */
export function transferDispatchOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly assignee?: string | undefined; readonly operationCode?: string | undefined; readonly remark?: string | undefined },
) {
  return postCommand(
    `/dispatch/orders/${encodeURIComponent(id)}/transfer`,
    'dispatch.transfer.v1',
    {
      assignee: input.assignee ?? null,
      operationCode: input.operationCode ?? null,
      remark: input.remark ?? null,
    },
    revisionOf(row, '派工单行'),
  );
}

// ---- 导出 / 状态统计 / 批操作（6a-1：RREQ-DP-026 / DP-032） ----

/** 派工单 Excel 导出（GET——仅导出不写库；返回 ExcelExport：json-tables / xlsx-base64）。 */
export async function exportDispatchOrders(filters: DispatchFilters = {}): Promise<Record<string, unknown>> {
  return fetchRawObject(
    `/dispatch/orders/export${queryString([
      ['kind', filters.kind],
      ['state', filters.state],
      ['workOrderId', filters.workOrderId],
      ['assignee', filters.assignee],
    ])}`,
  );
}

/** 页眉五态计数（口径随当前搜索——state 维不参与）。 */
export async function getDispatchOrderStats(
  filters: Omit<DispatchFilters, 'state'> = {},
): Promise<Record<string, unknown>> {
  return fetchObject(
    `/dispatch/orders/stats${queryString([
      ['kind', filters.kind],
      ['workOrderId', filters.workOrderId],
      ['assignee', filters.assignee],
    ])}`,
    'counts',
  );
}

/** 批操作单行（行级乐观锁）。 */
export interface DispatchBatchItemInput {
  readonly id: string;
  readonly expectedRevision: number;
}

export interface DispatchBatchOutcomeView {
  readonly committed: boolean;
  readonly status: string;
  readonly reason: string | null;
  readonly items: readonly Record<string, unknown>[];
}

/** 批量端点共用提交（非 smes.command.v1 单聚合信封——服务端逐单组子命令信封）。 */
async function postBatch(
  path: string,
  body: Record<string, unknown>,
): Promise<DispatchBatchOutcomeView> {
  const outcome = await request(path, { method: 'POST', body: JSON.stringify(body) });
  if (typeof outcome !== 'object' || outcome === null || !('status' in outcome)) {
    throw new ModuleApiError(undefined, `批量端点响应形状非法（缺 status 字段）：${path}`);
  }
  const record = outcome as { status?: unknown; reason?: unknown; items?: unknown };
  return {
    committed: record.status === 'committed',
    status: typeof record.status === 'string' ? record.status : String(record.status),
    reason: typeof record.reason === 'string' ? record.reason : null,
    items: Array.isArray(record.items) ? (record.items as Record<string, unknown>[]) : [],
  };
}

/** 批量派工下发（勾选均须待下发——非待下发整批拒绝；整批统一派到同一执行人）。 */
export function batchAssignDispatchOrders(input: {
  readonly assignee: string;
  readonly remark?: string | undefined;
  readonly items: readonly DispatchBatchItemInput[];
}): Promise<DispatchBatchOutcomeView> {
  return postBatch('/dispatch/orders/batch-assign', {
    operationId: newOperationId('dispatch.batch-assign'),
    assignee: input.assignee,
    remark: input.remark ?? null,
    items: input.items,
  });
}

/** 批量删除（仅待下发且零件/外协——装配/电气/零工/售后豁免；落撤销终态）。 */
export function batchCancelDispatchOrders(input: {
  readonly remark?: string | undefined;
  readonly items: readonly DispatchBatchItemInput[];
}): Promise<DispatchBatchOutcomeView> {
  return postBatch('/dispatch/orders/batch-cancel', {
    operationId: newOperationId('dispatch.batch-cancel'),
    remark: input.remark ?? null,
    items: input.items,
  });
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

/** 取消外协明细行（6a-1：仅已派工/执行中单的已派工行；原因选填 ≤200 字）。 */
export function cancelOutsourcingLine(
  lineId: string,
  row: Record<string, unknown>,
  input: { readonly reason?: string | undefined },
) {
  return postCommand(
    `/outsourcing/lines/${encodeURIComponent(lineId)}/cancel`,
    'outsourcing.line.cancel.v1',
    { reason: input.reason ?? null, remark: null },
    revisionOf(row, '外协明细行'),
  );
}

/** 外协加工单打印数据（{document}）。 */
export async function getOutsourcingPrintData(orderId: string): Promise<Record<string, unknown>> {
  return fetchObject(`/outsourcing/orders/${encodeURIComponent(orderId)}/print-data`, 'document');
}
