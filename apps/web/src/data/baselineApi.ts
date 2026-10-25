/**
 * baseline 薄数据层（S2 批次）：工序/设备/工艺路线/额定工时/外协计价/物料校验/
 * 故障上报七面。端点/权限码/载荷形状按 baseline.controllers.ts 与
 * baseline-input.ts 实态映射。命令经各资源 commands 端点提交（P2/P3 端点
 * kind 绑定；define→'initial'，revise→当前版 objectVersion）。
 */
import { fetchRawObject, fetchRows, postCommand, queryString, revisionOf } from './commandClient';

// ---- 工序 ----

export async function listProcesses(status?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/baseline/processes${queryString([['status', status]])}`, 'processes');
}

export function defineProcess(input: {
  readonly code: string;
  readonly name: string;
  readonly category?: string | undefined;
  readonly description?: string | undefined;
}) {
  return postCommand('/baseline/processes/commands', 'baseline.process.define.v1', {
    code: input.code,
    name: input.name,
    ...(input.category !== undefined && input.category.trim().length > 0 ? { category: input.category.trim() } : {}),
    ...(input.description !== undefined && input.description.trim().length > 0 ? { description: input.description.trim() } : {}),
  });
}

export function reviseProcess(
  row: Record<string, unknown>,
  fields: { readonly name?: string | undefined; readonly status?: 'draft' | 'active' | undefined },
) {
  return postCommand(
    '/baseline/processes/commands',
    'baseline.process.revise.v1',
    { code: String(row['code']), ...fields },
    revisionOf(row, '工序行'),
  );
}

// ---- 设备档案 ----

export async function listEquipment(status?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/baseline/equipment${queryString([['status', status]])}`, 'equipment');
}

export function registerEquipment(input: {
  readonly code: string;
  readonly name: string;
  readonly type?: string | undefined;
  readonly location?: string | undefined;
}) {
  return postCommand('/baseline/equipment/commands', 'baseline.equipment.register.v1', {
    code: input.code,
    name: input.name,
    ...(input.type !== undefined && input.type.trim().length > 0 ? { type: input.type.trim() } : {}),
    ...(input.location !== undefined && input.location.trim().length > 0 ? { location: input.location.trim() } : {}),
  });
}

// ---- 工艺路线 ----

export async function listRoutings(status?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/baseline/routings${queryString([['status', status]])}`, 'routings');
}

/** 按图号查工艺路线（直返对象）。 */
export async function getRouting(drawingNo: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/baseline/routings/${encodeURIComponent(drawingNo)}`);
}

/** 定义（steps 为有序工序码数组；数组位置即工序顺序）。 */
export function defineRouting(input: {
  readonly drawingNo: string;
  readonly steps: readonly string[];
  readonly name?: string | undefined;
}) {
  return postCommand('/baseline/routings/commands', 'baseline.routing.define.v1', {
    drawingNo: input.drawingNo,
    steps: input.steps.map((processCode) => ({ processCode })),
    ...(input.name !== undefined && input.name.trim().length > 0 ? { name: input.name.trim() } : {}),
  });
}

// ---- 额定工时 ----

export async function listStandardTimes(params: {
  readonly status?: string | undefined;
  readonly scope?: string | undefined;
  readonly targetCode?: string | undefined;
} = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/baseline/standard-times${queryString([
      ['status', params.status],
      ['scope', params.scope],
      ['targetCode', params.targetCode],
    ])}`,
    'standardTimes',
  );
}

export function defineStandardTime(input: {
  readonly code: string;
  readonly scope: 'process' | 'product';
  readonly targetCode: string;
  readonly standardSeconds: number;
  readonly preparationSeconds?: number | undefined;
}) {
  return postCommand('/baseline/standard-times/commands', 'baseline.standardtime.define.v1', {
    code: input.code,
    scope: input.scope,
    targetCode: input.targetCode,
    standardSeconds: input.standardSeconds,
    ...(input.preparationSeconds !== undefined ? { preparationSeconds: input.preparationSeconds } : {}),
  });
}

// ---- 外协计价规则 ----

export async function listOutsourcingRules(status?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/baseline/outsourcing-rules${queryString([['status', status]])}`, 'rules');
}

export function setOutsourcingRule(input: {
  readonly code: string;
  readonly processCode: string;
  /** 工序单价（十进制串，如 '12.50'——解析为分）。 */
  readonly unitPrice: string;
  /** 利润率（万分比整数，1500=15%）。 */
  readonly marginPermyriad: number;
}) {
  return postCommand('/baseline/outsourcing-rules/commands', 'baseline.outsourcing.rule.set.v1', input);
}

// ---- 物料校验（HTTP 只读两径） ----

export async function listValidationRuns(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/baseline/material-validations', 'runs');
}

export async function getValidationRun(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/baseline/material-validations/${encodeURIComponent(id)}`);
}

// ---- 故障上报 ----

export async function listFaultReports(state?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/baseline/fault-reports${queryString([['state', state]])}`, 'faultReports');
}

export function reportFault(input: {
  readonly equipmentCode: string;
  readonly description: string;
  readonly assignee: string;
}) {
  return postCommand('/baseline/fault-reports/commands', 'baseline.fault.report.v1', input);
}

/** 闭环（assigned→resolved；expectedRevision = 故障单 objectVersion）。 */
export function resolveFault(row: Record<string, unknown>, remark?: string | undefined) {
  return postCommand(
    `/baseline/fault-reports/${encodeURIComponent(String(row['id']))}/resolution`,
    'baseline.fault.resolve.v1',
    remark !== undefined && remark.trim().length > 0 ? { remark: remark.trim() } : {},
    revisionOf(row, '故障单行'),
  );
}
