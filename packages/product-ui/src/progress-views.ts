/**
 * 进度查询视图模型（S3 移动呈现：m.progress 工作令进度查询 / m.op-progress
 * 图号工序进度查询，覆盖矩阵 §3.2 #134 / #135）。与 hours.ts/inventory.ts
 * 同一取舍：纯函数视图模型（测试钉死），fetch 与 URL 在 apps/web 装配层
 * （data/mobile-ops.ts）。
 *
 * 后端合同：
 * - GET /workorder/work-orders/:id/progress（workorder:read）→
 *   WorkOrderProgressView 直返对象（计划 vs 实际：计划日期 + 当前态 + 迁移
 *   里程碑 + 交付倒计时，workorder.service.ts:1030）；
 * - GET /reporting/drawings/:drawingNo/operation-progress（report:read）→
 *   { rows: DrawingOperationProgressRow[] }（图号 × 工序净报工聚合：
 *   netDoneQty/netLaborMinutes = reported+verified 链尾合计，revoked 不计，
 *   reporting.service.ts:846）。
 *
 * 权限码 workorder:read / report:read 与后端端点一一对应（ADR-0010 通用词
 * workorder/report）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 工作令读取权限码（与 GET /workorder/work-orders/:id/progress 端点同码）。 */
export const WORKORDER_READ: PermissionCode = permissionCode('workorder:read');

/** 工作令迁移里程碑视图（机器账本 transitioned 事件的时序读法）。 */
export interface WorkOrderMilestoneView {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
}

/** 工作令项目进度视图（计划 vs 实际）。 */
export interface WorkOrderProgressView {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly state: string;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
  /** 交付倒计时（日历日；正数=未到期，负数=已逾期；无计划交付=null）。 */
  readonly daysToDelivery: number | null;
  readonly milestones: readonly WorkOrderMilestoneView[];
}

/** 图号 × 工序进度行（净报工聚合口径）。 */
export interface OperationProgressRowView {
  readonly drawingNo: string;
  /** null = 未挂工序的报工归集行。 */
  readonly operationCode: string | null;
  readonly netDoneQty: number;
  readonly verifiedQty: number;
  readonly netLaborMinutes: number;
  readonly verifiedLaborMinutes: number;
  readonly reportCount: number;
  readonly lastReportedAt: string | null;
}

export class ProgressViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProgressViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProgressViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ProgressViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProgressViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

function optionalFiniteQty(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requireFiniteQty(value, field);
}

/** 解析 GET /workorder/work-orders/:id/progress 响应（直返视图对象）。 */
export function parseWorkOrderProgressResponse(input: unknown): WorkOrderProgressView {
  const record = requireObject(input, '工作令进度响应');
  const milestones = record['milestones'];
  if (!Array.isArray(milestones)) {
    throw new ProgressViewsError("工作令进度响应缺 'milestones' 数组");
  }
  return {
    workOrderId: requireString(record['workOrderId'], 'workOrderId'),
    projectName: requireString(record['projectName'], 'projectName'),
    state: requireString(record['state'], 'state'),
    plannedDeliveryAt: optionalString(record['plannedDeliveryAt'], 'plannedDeliveryAt'),
    packagingArrivalAt: optionalString(record['packagingArrivalAt'], 'packagingArrivalAt'),
    daysToDelivery: optionalFiniteQty(record['daysToDelivery'], 'daysToDelivery'),
    milestones: milestones.map((row) => {
      const item = requireObject(row, 'milestones 行');
      return {
        from: requireString(item['from'], 'from'),
        to: requireString(item['to'], 'to'),
        event: requireString(item['event'], 'event'),
        at: requireString(item['at'], 'at'),
        actor: requireString(item['actor'], 'actor'),
      };
    }),
  };
}

/** 解析 GET /reporting/drawings/:drawingNo/operation-progress 响应 { rows: [...] }。 */
export function parseOperationProgressResponse(input: unknown): readonly OperationProgressRowView[] {
  const envelope = requireObject(input, '图号工序进度响应');
  const rows = envelope['rows'];
  if (!Array.isArray(rows)) {
    throw new ProgressViewsError("图号工序进度响应缺 'rows' 数组");
  }
  return rows.map((row) => {
    const item = requireObject(row, 'rows 行');
    return {
      drawingNo: requireString(item['drawingNo'], 'drawingNo'),
      operationCode: optionalString(item['operationCode'], 'operationCode'),
      netDoneQty: requireFiniteQty(item['netDoneQty'], 'netDoneQty'),
      verifiedQty: requireFiniteQty(item['verifiedQty'], 'verifiedQty'),
      netLaborMinutes: requireFiniteQty(item['netLaborMinutes'], 'netLaborMinutes'),
      verifiedLaborMinutes: requireFiniteQty(item['verifiedLaborMinutes'], 'verifiedLaborMinutes'),
      reportCount: requireFiniteQty(item['reportCount'], 'reportCount'),
      lastReportedAt: optionalString(item['lastReportedAt'], 'lastReportedAt'),
    };
  });
}
