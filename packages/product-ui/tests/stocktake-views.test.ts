/**
 * 仓储作业视图模型测试（S3 移动呈现）：盘点台账/详情响应解析、仓储权限码
 * 常量（入库/调拨/盘点）。响应形状镜像 packages/application inventory-stores
 * Stocktake 投影行（四态 + 行载荷）。
 */
import { describe, expect, it } from 'vitest';
import {
  parseStocktakeDetailResponse,
  parseStocktakesResponse,
  STOCK_RECEIVE,
  STOCKTAKE_APPROVE,
  STOCKTAKE_READ,
  STOCKTAKE_RECORD,
  STOCK_TRANSFER,
  StocktakeViewsError,
} from '../src/index.js';

const stocktakeRow = {
  id: 'st-0001',
  tenant: 'tenant-e2e',
  warehouseId: 'wh-seed-0001',
  flowConfigId: 'flow-1',
  state: 'counting',
  objectVersion: 2,
  lines: [
    {
      itemId: 'itm-seed-0001',
      systemQty: 120,
      countedQty: null,
      countedAt: null,
      countedBy: null,
    },
    {
      itemId: 'itm-seed-0002',
      systemQty: 40,
      countedQty: 38,
      countedAt: '2026-10-25T02:00:00.000Z',
      countedBy: 'user-demo-operator',
    },
  ],
  openedBy: 'user-demo-operator',
  approvedBy: null,
  remark: null,
  createdAt: '2026-10-25T01:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
};

describe('盘点台账响应解析（GET /inventory/stocktakes）', () => {
  it('合法响应：信封 stocktakes 解包、行集含实盘可空字段', () => {
    const rows = parseStocktakesResponse({ stocktakes: [stocktakeRow] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('st-0001');
    expect(rows[0]?.state).toBe('counting');
    expect(rows[0]?.objectVersion).toBe(2);
    expect(rows[0]?.lines).toHaveLength(2);
    expect(rows[0]?.lines[0]).toEqual({
      itemId: 'itm-seed-0001',
      systemQty: 120,
      countedQty: null,
      countedAt: null,
      countedBy: null,
    });
    expect(rows[0]?.lines[1]?.countedQty).toBe(38);
  });

  it('非法形状拒绝：缺 stocktakes / 缺 lines / 坏行 / 坏乐观锁版本', () => {
    expect(() => parseStocktakesResponse({})).toThrow(StocktakeViewsError);
    const { lines: _lines, ...noLines } = stocktakeRow;
    expect(() => parseStocktakesResponse({ stocktakes: [noLines] })).toThrow(StocktakeViewsError);
    expect(() =>
      parseStocktakesResponse({
        stocktakes: [{ ...stocktakeRow, lines: [{ itemId: 'itm-1' }] }],
      }),
    ).toThrow(StocktakeViewsError);
    expect(() =>
      parseStocktakesResponse({ stocktakes: [{ ...stocktakeRow, objectVersion: 0 }] }),
    ).toThrow(StocktakeViewsError);
  });
});

describe('盘点详情响应解析（GET /inventory/stocktakes/:id）', () => {
  it('合法响应：stocktake 主单据 + milestones 里程碑', () => {
    const detail = parseStocktakeDetailResponse({
      stocktake: stocktakeRow,
      milestones: [
        { from: 'draft', to: 'counting', event: 'stocktake.start.v1', at: '2026-10-25T01:00:00.000Z', actor: 'user-demo-operator', objectVersion: 2 },
      ],
    });
    expect(detail.stocktake.id).toBe('st-0001');
    expect(detail.milestones).toEqual([
      {
        from: 'draft',
        to: 'counting',
        event: 'stocktake.start.v1',
        at: '2026-10-25T01:00:00.000Z',
        actor: 'user-demo-operator',
      },
    ]);
  });

  it('非法形状拒绝：缺 stocktake / 缺 milestones', () => {
    expect(() => parseStocktakeDetailResponse({})).toThrow(StocktakeViewsError);
    expect(() => parseStocktakeDetailResponse({ stocktake: stocktakeRow })).toThrow(
      StocktakeViewsError,
    );
  });
});

describe('仓储权限码常量（与后端端点一一对应）', () => {
  it('stock:receive / stock:transfer / stocktake:read|record|approve', () => {
    expect(STOCK_RECEIVE).toBe('stock:receive');
    expect(STOCK_TRANSFER).toBe('stock:transfer');
    expect(STOCKTAKE_READ).toBe('stocktake:read');
    expect(STOCKTAKE_RECORD).toBe('stocktake:record');
    expect(STOCKTAKE_APPROVE).toBe('stocktake:approve');
  });
});
