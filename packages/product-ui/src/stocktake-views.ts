/**
 * 仓储作业视图模型（S3 移动呈现：m.receipt 三类入库 / m.transfer 调拨移库 /
 * m.stocktake 库存盘点，覆盖矩阵 §3.2 #128-130 三类入库 / #132 调拨和移库 /
 * #133 库存盘点）。与 hours.ts/inventory.ts 同一取舍：纯函数视图模型（测试
 * 钉死），fetch 与 URL 在 apps/web 装配层（命令复用 inventoryApi 既有函数，
 * 类型化读取经 data/mobile-ops.ts）。
 *
 * 后端合同（packages/application/src/inventory/，M2-W5）：
 * - POST /inventory/stock/receipts（stock.receive.v1；stock:receive）——三类
 *   入库 kind：inspection（放行入库，须带质检单）/ purchase（采购入库，须带
 *   receiptKey 幂等键）/ production（生产入库）；
 * - POST /inventory/stock/transfers（stock.transfer.v1；stock:transfer）——
 *   跨仓调拨与仓内移库同命令；
 * - GET /inventory/stocktakes?state= → { stocktakes: [...] }（stocktake:read
 *   台账，createdAt 降序）；
 * - GET /inventory/stocktakes/:id → { stocktake, milestones }（stocktake:read
 *   详情，含行集）；
 * - POST /inventory/stocktakes（stocktake.open.v1；stocktake:record）——开单
 *   进盘点；
 * - POST /inventory/stocktakes/:id/records（stocktake.record.v1；
 *   stocktake:record）——实盘录入（complete=true 提交差异）；
 * - POST /inventory/stocktakes/:id/approval（stocktake.approve-adjust.v1；
 *   stocktake:approve）——审核调账；
 *   命令 expectedRevision 取行 objectVersion（record 录行不推版本，approval
 *   推版本——后端口径，本视图只透传锚点）。
 *
 * Stocktake 投影行状态：draft/counting/reconciled/adjusted。权限码
 * stock:receive|transfer、stocktake:read|record|approve 与后端端点一一对应
 * （ADR-0010 通用词 stock/stocktake）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 入库权限码（与 POST /inventory/stock/receipts 端点同码）。 */
export const STOCK_RECEIVE: PermissionCode = permissionCode('stock:receive');

/** 调拨/移库权限码（与 POST /inventory/stock/transfers 端点同码）。 */
export const STOCK_TRANSFER: PermissionCode = permissionCode('stock:transfer');

/** 盘点读取权限码（与 GET /inventory/stocktakes 端点同码）。 */
export const STOCKTAKE_READ: PermissionCode = permissionCode('stocktake:read');

/** 盘点开单/录实盘权限码（与 POST /inventory/stocktakes、:id/records 端点同码）。 */
export const STOCKTAKE_RECORD: PermissionCode = permissionCode('stocktake:record');

/** 盘点审核权限码（与 POST /inventory/stocktakes/:id/approval 端点同码）。 */
export const STOCKTAKE_APPROVE: PermissionCode = permissionCode('stocktake:approve');

/** 盘点行视图（开单快照 systemQty + 可空实盘 countedQty）。 */
export interface StocktakeLineView {
  readonly itemId: string;
  readonly systemQty: number;
  /** 实盘量（null = 未盘）。 */
  readonly countedQty: number | null;
  readonly countedAt: string | null;
  readonly countedBy: string | null;
}

/** 盘点单行视图（四态机投影 + 行集 + 乐观锁锚点）。 */
export interface StocktakeRowView {
  readonly id: string;
  readonly warehouseId: string;
  /** draft/counting/reconciled/adjusted。 */
  readonly state: string;
  /** 乐观锁锚点（record/approval 的 expectedRevision）。 */
  readonly objectVersion: number;
  readonly lines: readonly StocktakeLineView[];
  readonly openedBy: string;
  readonly approvedBy: string | null;
  readonly remark: string | null;
  readonly createdAt: string;
}

/** 迁移里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface StocktakeMilestoneView {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
}

/** 盘点单详情视图（主单据 + 迁移里程碑）。 */
export interface StocktakeDetailView {
  readonly stocktake: StocktakeRowView;
  readonly milestones: readonly StocktakeMilestoneView[];
}

export class StocktakeViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StocktakeViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StocktakeViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StocktakeViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new StocktakeViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StocktakeViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new StocktakeViewsError("字段 'objectVersion' 须为 ≥1 的整数");
  }
  return value;
}

function parseStocktakeRow(row: unknown, what: string): StocktakeRowView {
  const item = requireObject(row, what);
  const lines = item['lines'];
  if (!Array.isArray(lines)) {
    throw new StocktakeViewsError(`${what}缺 'lines' 数组`);
  }
  return {
    id: requireString(item['id'], 'id'),
    warehouseId: requireString(item['warehouseId'], 'warehouseId'),
    state: requireString(item['state'], 'state'),
    objectVersion: requireVersion(item['objectVersion']),
    lines: lines.map((line) => {
      const lineItem = requireObject(line, 'lines 行');
      return {
        itemId: requireString(lineItem['itemId'], 'lines.itemId'),
        systemQty: requireFiniteQty(lineItem['systemQty'], 'lines.systemQty'),
        countedQty:
          lineItem['countedQty'] === undefined || lineItem['countedQty'] === null
            ? null
            : requireFiniteQty(lineItem['countedQty'], 'lines.countedQty'),
        countedAt: optionalString(lineItem['countedAt'], 'lines.countedAt'),
        countedBy: optionalString(lineItem['countedBy'], 'lines.countedBy'),
      };
    }),
    openedBy: requireString(item['openedBy'], 'openedBy'),
    approvedBy: optionalString(item['approvedBy'], 'approvedBy'),
    remark: optionalString(item['remark'], 'remark'),
    createdAt: requireString(item['createdAt'], 'createdAt'),
  };
}

/** 解析 GET /inventory/stocktakes 响应 { stocktakes: [...] }。 */
export function parseStocktakesResponse(input: unknown): readonly StocktakeRowView[] {
  const envelope = requireObject(input, '盘点台账响应');
  const rows = envelope['stocktakes'];
  if (!Array.isArray(rows)) {
    throw new StocktakeViewsError("盘点台账响应缺 'stocktakes' 数组");
  }
  return rows.map((row) => parseStocktakeRow(row, 'stocktakes 行'));
}

/** 解析 GET /inventory/stocktakes/:id 响应 { stocktake, milestones }。 */
export function parseStocktakeDetailResponse(input: unknown): StocktakeDetailView {
  const envelope = requireObject(input, '盘点详情响应');
  const milestones = envelope['milestones'];
  if (!Array.isArray(milestones)) {
    throw new StocktakeViewsError("盘点详情响应缺 'milestones' 数组");
  }
  return {
    stocktake: parseStocktakeRow(envelope['stocktake'], '盘点详情对象'),
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
