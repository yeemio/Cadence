/**
 * 质检队列视图模型（S3 移动呈现：m.inspection 四类质检页，覆盖矩阵 §3.2
 * #119 自制外协质检 / #120 非标件采购质检 / #121 标准配件采购质检 /
 * #122 设备采购质检）。与 hours.ts/inventory.ts 同一取舍：纯函数视图模型
 * （测试钉死），fetch 与 URL 在 apps/web 装配层。
 *
 * 后端合同（packages/application/src/inspection/，M2-W4）：
 * - GET /inspection/orders?kind=&state= → { orders: [...] }（inspection:read；
 *   四类 kind 一队列，页面按 kind 徽标/过滤区分四项功能拆解）；
 * - POST /inspection/orders/:id/judgment（inspection.judge.v1；inspection:judge）
 *   ——passedQty/failedQty 判定；
 * - POST /inspection/orders/:id/recheck（inspection.recheck.v1；
 *   inspection:judge）——failed 态复检；
 *   两者 expectedRevision 取行 objectVersion（本视图原样透传）。
 *
 * InspectionOrder 投影行状态：pending/passed/failed/closed；kind 四类
 * （self_outsourced / nonstandard_purchase / standard_purchase /
 * equipment_purchase）。权限码 inspection:read|judge 与后端端点一一对应
 * （ADR-0010 通用词 inspection）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 质检读取权限码（与 GET /inspection/orders 端点同码）。 */
export const INSPECTION_READ: PermissionCode = permissionCode('inspection:read');

/** 质检判定权限码（与 POST /inspection/orders/:id/judgment、:id/recheck 端点同码）。 */
export const INSPECTION_JUDGE: PermissionCode = permissionCode('inspection:judge');

/** 质检单行视图（InspectionOrder 投影行 + 乐观锁锚点）。 */
export interface InspectionOrderRowView {
  readonly id: string;
  /** pending/passed/failed/closed。 */
  readonly state: string;
  /** 乐观锁锚点（judgment/recheck 的 expectedRevision）。 */
  readonly objectVersion: number;
  /** 四类 kind：self_outsourced/nonstandard_purchase/standard_purchase/equipment_purchase。 */
  readonly kind: string;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 送检数量（正数）。 */
  readonly quantity: number;
  /** 判定结果（判定前 null）。 */
  readonly passedQty: number | null;
  readonly failedQty: number | null;
  readonly judgeRemark: string | null;
  /** 闭环时限（failed 判定时定）。 */
  readonly closeDueAt: string | null;
  readonly createdAt: string;
}

export class InspectionViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InspectionViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InspectionViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new InspectionViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InspectionViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InspectionViewsError("字段 'objectVersion' 须为 ≥1 的整数");
  }
  return value;
}

/** 解析 GET /inspection/orders 响应 { orders: [...] }。 */
export function parseInspectionOrdersResponse(input: unknown): readonly InspectionOrderRowView[] {
  const envelope = requireObject(input, '质检队列响应');
  const rows = envelope['orders'];
  if (!Array.isArray(rows)) {
    throw new InspectionViewsError("质检队列响应缺 'orders' 数组");
  }
  return rows.map((row) => {
    const item = requireObject(row, 'orders 行');
    return {
      id: requireString(item['id'], 'id'),
      state: requireString(item['state'], 'state'),
      objectVersion: requireVersion(item['objectVersion']),
      kind: requireString(item['kind'], 'kind'),
      sourceType: optionalString(item['sourceType'], 'sourceType'),
      sourceRefId: optionalString(item['sourceRefId'], 'sourceRefId'),
      itemId: optionalString(item['itemId'], 'itemId'),
      drawingNo: optionalString(item['drawingNo'], 'drawingNo'),
      quantity: requireFiniteQty(item['quantity'], 'quantity'),
      passedQty:
        item['passedQty'] === undefined || item['passedQty'] === null
          ? null
          : requireFiniteQty(item['passedQty'], 'passedQty'),
      failedQty:
        item['failedQty'] === undefined || item['failedQty'] === null
          ? null
          : requireFiniteQty(item['failedQty'], 'failedQty'),
      judgeRemark: optionalString(item['judgeRemark'], 'judgeRemark'),
      closeDueAt: optionalString(item['closeDueAt'], 'closeDueAt'),
      createdAt: requireString(item['createdAt'], 'createdAt'),
    };
  });
}
