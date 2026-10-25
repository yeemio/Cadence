/**
 * 报工单读取视图模型（S3 移动呈现：m.verify 核查页 + m.mine 我的报工页，
 * 覆盖矩阵 §3.2 的 111-114 四类报工核查 + §3.4 #116/§3.2 #136 记录列表）。
 * 与 hours.ts/inventory.ts 同一取舍：纯函数视图模型（测试钉死），fetch 与
 * URL 在 apps/web 装配层（data/mobile-ops.ts）。
 *
 * 后端合同（packages/application/src/reporting/，M2-W7）：
 * - GET /reports/pending-verification → { reports: WorkReport[] }（reported 链尾
 *   按 createdAt 升序——先进先核；权限码 report:read）；
 * - GET /reports/mine → { reports: WorkReport[] }（本人双键 (tenant, reporter)
 *   ——"仅本人完成"数据权限边界；权限码 report:read）；
 * - POST /reports/:id/verify（report.verify.v1；权限码 report:verify）——
 *   expectedRevision 取行 objectVersion（本视图原样透传，乐观锁锚点）。
 *
 * 两个读取端点同键（reports）同行形状（WorkReport 投影行），共用一套解析。
 * 权限码 report:read / report:verify 与后端端点一一对应（ADR-0010 内核白名单词
 * report）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 报工读取权限码（与 apps/server GET /reports/mine、GET /reports/pending-verification 端点同码）。 */
export const REPORT_READ: PermissionCode = permissionCode('report:read');

/** 报工核查权限码（与 POST /reports/:id/verify 端点同码）。 */
export const REPORT_VERIFY: PermissionCode = permissionCode('report:verify');

/** 报工单行视图（WorkReport 投影行的移动呈现子集 + 乐观锁锚点）。 */
export interface WorkReportRowView {
  readonly id: string;
  /** 五类 kind：part/assembly/electrical/aftermarket/oddjob。 */
  readonly kind: string;
  /** pending/reported/verified/revoked。 */
  readonly state: string;
  readonly dispatchId: string;
  readonly doneQty: number;
  readonly laborMinutes: number;
  readonly reporter: string;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  /** 乐观锁锚点（POST :id/verify 的 expectedRevision）。 */
  readonly objectVersion: number;
  readonly businessTime: string;
  readonly remark: string | null;
  readonly createdAt: string;
}

export class ReportViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ReportViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReportViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ReportViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReportViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ReportViewsError("字段 'objectVersion' 须为 ≥1 的整数");
  }
  return value;
}

/** 解析 GET /reports/mine、GET /reports/pending-verification 响应 { reports: [...] }。 */
export function parseWorkReportsResponse(input: unknown): readonly WorkReportRowView[] {
  const envelope = requireObject(input, '报工单列表响应');
  const rows = envelope['reports'];
  if (!Array.isArray(rows)) {
    throw new ReportViewsError("报工单列表响应缺 'reports' 数组");
  }
  return rows.map((row) => {
    const item = requireObject(row, 'reports 行');
    return {
      id: requireString(item['id'], 'id'),
      kind: requireString(item['kind'], 'kind'),
      state: requireString(item['state'], 'state'),
      dispatchId: requireString(item['dispatchId'], 'dispatchId'),
      doneQty: requireFiniteQty(item['doneQty'], 'doneQty'),
      laborMinutes: requireFiniteQty(item['laborMinutes'], 'laborMinutes'),
      reporter: requireString(item['reporter'], 'reporter'),
      workOrderId: optionalString(item['workOrderId'], 'workOrderId'),
      drawingNo: optionalString(item['drawingNo'], 'drawingNo'),
      operationCode: optionalString(item['operationCode'], 'operationCode'),
      objectVersion: requireVersion(item['objectVersion']),
      businessTime: requireString(item['businessTime'], 'businessTime'),
      remark: optionalString(item['remark'], 'remark'),
      createdAt: requireString(item['createdAt'], 'createdAt'),
    };
  });
}
