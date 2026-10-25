/**
 * 库存视图模型（M5 首波：移动端"库存查询"页，功能拆解 128~133 移动仓储的
 * 查询呈现项）。与 workbench.ts 同一取舍：纯函数视图模型（测试钉死），
 * fetch 与 URL 在 apps/web 装配层。
 *
 * 后端合同（packages/application/src/inventory/，M2-W5）：
 * GET /inventory/stock?itemId= → { levels: StockLevelView[] }——实时库存
 * 可用量口径（availableQty = qtyOnHand − qtyReserved，机器计算非存储列）；
 * 移动端库存查询与桌面逻辑面同径（?itemId= 扫码查询，后端注释明示不设镜像
 * 端点、呈现归 M5 PWA——本视图模型即该呈现的形状）。
 *
 * 权限码 stock:read 与后端端点一一对应（ADR-0010 通用词：stock/inventory）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 库存读取权限码（与 apps/server GET /inventory/stock 端点同码）。 */
export const STOCK_READ: PermissionCode = permissionCode('stock:read');

/** 实时库存行视图（可用量口径：availableQty = qtyOnHand − qtyReserved）。 */
export interface StockLevelView {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly availableQty: number;
}

export class InventoryViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryViewError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InventoryViewError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InventoryViewError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function requireFiniteQty(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InventoryViewError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

/** 解析 GET /inventory/stock 响应 { levels: [...] }。 */
export function parseStockLevelsResponse(input: unknown): readonly StockLevelView[] {
  const envelope = requireObject(input, '实时库存响应');
  const levels = envelope['levels'];
  if (!Array.isArray(levels)) {
    throw new InventoryViewError("实时库存响应缺 'levels' 数组");
  }
  return levels.map((row) => {
    const item = requireObject(row, 'levels 行');
    return {
      itemId: requireString(item['itemId'], 'itemId'),
      warehouseId: requireString(item['warehouseId'], 'warehouseId'),
      qtyOnHand: requireFiniteQty(item['qtyOnHand'], 'qtyOnHand'),
      qtyReserved: requireFiniteQty(item['qtyReserved'], 'qtyReserved'),
      availableQty: requireFiniteQty(item['availableQty'], 'availableQty'),
    };
  });
}
