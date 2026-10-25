/**
 * 库存视图模型测试（M5 首波）：GET /inventory/stock 响应解析、权限码常量。
 * 响应形状镜像 packages/application inventory.service StockLevelView
 * （可用量口径 availableQty = qtyOnHand − qtyReserved——M2-W5 合同）。
 */
import { describe, expect, it } from 'vitest';
import {
  InventoryViewError,
  parseStockLevelsResponse,
  STOCK_READ,
} from '../src/index.js';

const levelsBody = [
  {
    itemId: 'itm-seed-0001',
    warehouseId: 'wh-seed-0001',
    qtyOnHand: 120,
    qtyReserved: 20,
    availableQty: 100,
  },
];

describe('实时库存响应解析', () => {
  it('合法响应：信封 levels 解包、行字段全保留', () => {
    const levels = parseStockLevelsResponse({ levels: levelsBody });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual({
      itemId: 'itm-seed-0001',
      warehouseId: 'wh-seed-0001',
      qtyOnHand: 120,
      qtyReserved: 20,
      availableQty: 100,
    });
  });

  it('空数组合法（无库存记录）', () => {
    expect(parseStockLevelsResponse({ levels: [] })).toEqual([]);
  });

  it('非法形状拒绝：缺 levels / 坏行 / 非数值数量', () => {
    expect(() => parseStockLevelsResponse({})).toThrow(InventoryViewError);
    expect(() => parseStockLevelsResponse({ levels: [{ itemId: 'itm-1' }] })).toThrow(
      InventoryViewError,
    );
    expect(() =>
      parseStockLevelsResponse({
        levels: [{ ...levelsBody[0], qtyOnHand: '120' }],
      }),
    ).toThrow(InventoryViewError);
    expect(() => parseStockLevelsResponse('levels')).toThrow(InventoryViewError);
  });
});

describe('库存权限码常量（与后端端点一一对应）', () => {
  it('stock:read', () => {
    expect(STOCK_READ).toBe('stock:read');
  });
});
