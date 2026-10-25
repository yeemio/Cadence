/**
 * 配件申请视图模型（S3 移动呈现：m.parts 配件申请页 + m.parts-approval 配件
 * 审批页，覆盖矩阵 §3.2 #117 配件申请 / #118 配件审批）。
 * 与 hours.ts/inventory.ts 同一取舍：纯函数视图模型（测试钉死），fetch 与
 * URL 在 apps/web 装配层（申请命令复用 workorderApi.createPartsRequest，
 * 审批列表经 data/mobile-ops.ts 类型化读取）。
 *
 * 后端合同（packages/application/src/workorder/，M2-W1 配件申请面）：
 * - POST /workorder/parts-requests（workorder.parts.request.v1；parts:request）
 *   ——workOrderId/itemId/quantity/remark；
 * - GET /workorder/parts-requests?state=&workOrderId= → { partsRequests: [...] }
 *   （parts:read；审批页取 state=submitted 待审队列）；
 * - POST /workorder/parts-requests/:id/approval（workorder.parts.approve.v1；
 *   parts:approve）——approve/reject，expectedRevision 取行 objectVersion。
 *
 * PartsRequest 投影行状态：draft/submitted/approved/rejected/shipped/received。
 * 权限码 parts:request|read|approve 与后端端点一一对应（ADR-0010 通用词 parts）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 配件申请权限码（与 POST /workorder/parts-requests 端点同码）。 */
export const PARTS_REQUEST: PermissionCode = permissionCode('parts:request');

/** 配件读取权限码（与 GET /workorder/parts-requests 端点同码）。 */
export const PARTS_READ: PermissionCode = permissionCode('parts:read');

/** 配件审批权限码（与 POST /workorder/parts-requests/:id/approval 端点同码）。 */
export const PARTS_APPROVE: PermissionCode = permissionCode('parts:approve');

/** 配件申请行视图（PartsRequest 投影行 + 乐观锁锚点）。 */
export interface PartsRequestRowView {
  readonly id: string;
  readonly workOrderId: string;
  /** draft/submitted/approved/rejected/shipped/received。 */
  readonly state: string;
  /** 乐观锁锚点（POST :id/approval 的 expectedRevision）。 */
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: string;
  readonly remark: string | null;
  readonly shipmentRef: string | null;
  readonly createdAt: string;
}

export class PartsViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartsViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PartsViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PartsViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new PartsViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PartsViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new PartsViewsError("字段 'objectVersion' 须为 ≥1 的整数");
  }
  return value;
}

/** 解析 GET /workorder/parts-requests 响应 { partsRequests: [...] }。 */
export function parsePartsRequestsResponse(input: unknown): readonly PartsRequestRowView[] {
  const envelope = requireObject(input, '配件申请列表响应');
  const rows = envelope['partsRequests'];
  if (!Array.isArray(rows)) {
    throw new PartsViewsError("配件申请列表响应缺 'partsRequests' 数组");
  }
  return rows.map((row) => {
    const item = requireObject(row, 'partsRequests 行');
    return {
      id: requireString(item['id'], 'id'),
      workOrderId: requireString(item['workOrderId'], 'workOrderId'),
      state: requireString(item['state'], 'state'),
      objectVersion: requireVersion(item['objectVersion']),
      itemId: requireString(item['itemId'], 'itemId'),
      quantity: requireFiniteQty(item['quantity'], 'quantity'),
      requester: requireString(item['requester'], 'requester'),
      remark: optionalString(item['remark'], 'remark'),
      shipmentRef: optionalString(item['shipmentRef'], 'shipmentRef'),
      createdAt: requireString(item['createdAt'], 'createdAt'),
    };
  });
}
