/**
 * costing 薄数据层（S2 批次）：口径版本链 + 工作令成本视图 + 重算/导出命令。
 * 端点/权限码/载荷形状按 costing.controllers.ts 与 costing-input.ts 实态映射。
 */
import { fetchObject, fetchRows, postCommand, queryString } from './commandClient';

export async function listCostingModels(code?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/costing/models${queryString([['code', code]])}`, 'models');
}

/** 口径版本链详情（{detail}）。 */
export async function getCostingModelDetail(code: string): Promise<Record<string, unknown>> {
  return fetchObject(`/costing/models/${encodeURIComponent(code)}`, 'detail');
}

/** 口径发布（hourlyRates=工种→分/小时映射；同码升版）。 */
export function publishCostingModel(input: {
  readonly code: string;
  readonly hourlyRates: Record<string, number>;
  readonly name?: string | undefined;
}) {
  return postCommand('/costing/models', 'costing.model.publish.v1', {
    code: input.code,
    hourlyRates: input.hourlyRates,
    name: input.name ?? null,
  });
}

/** 工作令三分类汇总（{summary}）。 */
export async function getWorkOrderCostSummary(
  workOrderId: string,
  params: { readonly modelCode?: string | undefined; readonly modelVersion?: string | undefined } = {},
): Promise<Record<string, unknown>> {
  return fetchObject(
    `/costing/work-orders/${encodeURIComponent(workOrderId)}/summary${queryString([
      ['modelCode', params.modelCode],
      ['modelVersion', params.modelVersion],
    ])}`,
    'summary',
  );
}

/** 构成明细下钻（{entries}）。 */
export async function getWorkOrderCostDetails(
  workOrderId: string,
  category?: string | undefined,
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/costing/work-orders/${encodeURIComponent(workOrderId)}/details${queryString([['category', category]])}`,
    'entries',
  );
}

/** 快照版本回看（{snapshots}）。 */
export async function getWorkOrderCostSnapshots(
  workOrderId: string,
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/costing/work-orders/${encodeURIComponent(workOrderId)}/snapshots`, 'snapshots');
}

/** 口径版本对比（{comparison}）。 */
export async function compareCostingModels(input: {
  readonly workOrderId: string;
  readonly code: string;
  readonly a: number;
  readonly b: number;
}): Promise<Record<string, unknown>> {
  return fetchObject(
    `/costing/models/compare${queryString([
      ['workOrderId', input.workOrderId],
      ['code', input.code],
      ['a', String(input.a)],
      ['b', String(input.b)],
    ])}`,
    'comparison',
  );
}

/** 重算（工作令×口径；幂等）。 */
export function rebuildCosting(input: {
  readonly workOrderId: string;
  readonly modelCode?: string | undefined;
}) {
  return postCommand('/costing/rebuild', 'costing.rebuild.v1', {
    workOrderId: input.workOrderId,
    ...(input.modelCode !== undefined && input.modelCode.trim().length > 0 ? { modelCode: input.modelCode.trim() } : {}),
  });
}

/** 快照导出（ExcelPort；响应直返命令三分结果）。 */
export function exportCosting(input: { readonly workOrderId: string; readonly modelCode?: string | undefined }) {
  return postCommand('/costing/export', 'costing.export.v1', {
    workOrderId: input.workOrderId,
    ...(input.modelCode !== undefined && input.modelCode.trim().length > 0 ? { modelCode: input.modelCode.trim() } : {}),
  });
}

/** 事件审计读（{events}）。 */
export async function listCostingEvents(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/costing/events', 'events');
}
