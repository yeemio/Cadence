/**
 * inspection 薄数据层（S2 批次）：四类质检队列/判定/复检 + 汇总 + 不合格处置面。
 * 端点/权限码/载荷形状按 inspection.controllers.ts 与 inspection-input.ts 实态映射。
 */
import { fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';

export interface InspectionFilters {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
}

export async function listInspectionOrders(
  filters: InspectionFilters = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/inspection/orders${queryString([['kind', filters.kind], ['state', filters.state]])}`,
    'orders',
  );
}

/** 质检单详情（直返对象）。 */
export async function getInspectionDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/inspection/orders/${encodeURIComponent(id)}`);
}

/** 汇总事实（直返对象：待检/合格率/未闭环）。 */
export async function getInspectionSummary(): Promise<Record<string, unknown>> {
  return fetchRawObject('/inspection/summary');
}

/** 手工建单（sourceType 与 sourceRefId 须成对，缺省=手工）。 */
export function createInspectionOrder(input: {
  readonly kind: 'self_outsourced' | 'nonstandard_purchase' | 'standard_purchase' | 'equipment_purchase';
  readonly quantity: number;
  readonly sourceType?: string | undefined;
  readonly sourceRefId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly drawingNo?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inspection/orders', 'inspection.create.v1', {
    kind: input.kind,
    quantity: input.quantity,
    sourceType: input.sourceType ?? null,
    sourceRefId: input.sourceRefId ?? null,
    itemId: input.itemId ?? null,
    drawingNo: input.drawingNo ?? null,
    remark: input.remark ?? null,
  });
}

/** 判定（合格/不合格数量；放行→入库咬合）。 */
export function judgeInspectionOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly passedQty: number; readonly failedQty: number; readonly remark?: string | undefined },
) {
  return postCommand(
    `/inspection/orders/${encodeURIComponent(id)}/judgment`,
    'inspection.judge.v1',
    { passedQty: input.passedQty, failedQty: input.failedQty, remark: input.remark ?? null },
    revisionOf(row, '质检单行'),
  );
}

/** 复检（同判定载荷形状）。 */
export function recheckInspectionOrder(
  id: string,
  row: Record<string, unknown>,
  input: { readonly passedQty: number; readonly failedQty: number; readonly remark?: string | undefined },
) {
  return postCommand(
    `/inspection/orders/${encodeURIComponent(id)}/recheck`,
    'inspection.recheck.v1',
    { passedQty: input.passedQty, failedQty: input.failedQty, remark: input.remark ?? null },
    revisionOf(row, '质检单行'),
  );
}

// ---- 特采（让步接收确认，RQ-035；既有命令通道 inspection.concession.v1） ----

/** 特采视图（前置读：不合格/已特采/剩余可特采；直返对象）。 */
export async function getConcessionView(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/inspection/orders/${encodeURIComponent(id)}/concession`);
}

/**
 * 特采确认（inspection.concession.v1）：仅非标件采购质检单的不合格量，
 * 1 ≤ quantity ≤ 不合格 − 已特采（服务层校验拒绝并给中文 reason）。
 */
export function confirmConcession(
  id: string,
  row: Record<string, unknown>,
  input: { readonly quantity: number },
) {
  return postCommand(
    `/inspection/orders/${encodeURIComponent(id)}/concession`,
    'inspection.concession.v1',
    { quantity: input.quantity },
    revisionOf(row, '质检单行'),
  );
}

// ---- 判定撤销（RQ-037：passed/failed 单回退待检 + 不合格明细作废 + 特采清零） ----

/**
 * 判定撤销（inspection.revoke.v1）：仅已质检单（passed/failed）可撤；pending
 * （未质检）/closed（闭环终态）由服务层拒绝并给中文 reason；三项跨域闸门
 * （关联入库未完成/下道工序已报工/工时已审核）可能拦截。
 * remark = 撤销原因（1..2000 可选留痕；null 时服务端用默认留痕口径）。
 */
export function revokeInspection(
  id: string,
  row: Record<string, unknown>,
  input: { readonly remark: string | null },
) {
  return postCommand(
    `/inspection/orders/${encodeURIComponent(id)}/revocation`,
    'inspection.revoke.v1',
    { remark: input.remark },
    revisionOf(row, '质检单行'),
  );
}

/** 闭环超时点名（IM 推送联动）。 */
export function scanInspectionOverdue() {
  return postCommand('/inspection/overdue-scans', 'inspection.overdue.scan.v1', {});
}

// ---- 不合格处置面 ----

export interface NonconformityFilters {
  readonly state?: string | undefined;
  readonly inspectionId?: string | undefined;
}

export async function listNonconformities(
  filters: NonconformityFilters = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/inspection/nonconformities${queryString([['state', filters.state], ['inspectionId', filters.inspectionId]])}`,
    'nonconforms',
  );
}

/** 不合格处置详情（直返对象：闭环追踪）。 */
export async function getNonconformityDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/inspection/nonconformities/${encodeURIComponent(id)}`);
}

/** 处置（返工/让步/报废 + 原因必填）。 */
export function disposeNonconformity(
  id: string,
  row: Record<string, unknown>,
  input: {
    readonly disposal: 'rework' | 'concession' | 'scrap';
    readonly reason: string;
    readonly remark?: string | undefined;
  },
) {
  return postCommand(
    `/inspection/nonconformities/${encodeURIComponent(id)}/disposal`,
    'nonconform.dispose.v1',
    { disposal: input.disposal, reason: input.reason, remark: input.remark ?? null },
    revisionOf(row, '不合格处置行'),
  );
}

/** 闭环。 */
export function closeNonconformity(id: string, row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/inspection/nonconformities/${encodeURIComponent(id)}/close`,
    'nonconform.close.v1',
    { remark: remark ?? null },
    revisionOf(row, '不合格处置行'),
  );
}
