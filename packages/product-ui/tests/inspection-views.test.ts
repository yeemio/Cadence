/**
 * 质检队列视图模型测试（S3 移动呈现）：GET /inspection/orders 响应解析、
 * 权限码常量。响应形状镜像 packages/application inspection-stores
 * InspectionOrder 投影行（四类 kind 一队列）。
 */
import { describe, expect, it } from 'vitest';
import {
  INSPECTION_JUDGE,
  INSPECTION_READ,
  InspectionViewsError,
  parseInspectionOrdersResponse,
} from '../src/index.js';

const inspectionRow = {
  id: 'ins-0001',
  tenant: 'tenant-e2e',
  flowConfigId: 'flow-1',
  state: 'pending',
  objectVersion: 1,
  kind: 'self_outsourced',
  sourceType: 'report',
  sourceRefId: 'wr-0192',
  itemId: 'itm-seed-0001',
  drawingNo: 'DWG-A01',
  quantity: 20,
  passedQty: null,
  failedQty: null,
  judgeRemark: null,
  judgedBy: null,
  judgedAt: null,
  closeDueAt: null,
  overdueNotifiedAt: null,
  createdAt: '2026-10-25T01:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
};

describe('质检队列响应解析（四类 kind 同队列）', () => {
  it('合法响应：信封 orders 解包、行子集与乐观锁锚点保留', () => {
    const rows = parseInspectionOrdersResponse({ orders: [inspectionRow] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'ins-0001',
      state: 'pending',
      objectVersion: 1,
      kind: 'self_outsourced',
      sourceType: 'report',
      sourceRefId: 'wr-0192',
      itemId: 'itm-seed-0001',
      drawingNo: 'DWG-A01',
      quantity: 20,
      passedQty: null,
      failedQty: null,
      judgeRemark: null,
      closeDueAt: null,
      createdAt: '2026-10-25T01:00:00.000Z',
    });
  });

  it('判定后 passedQty/failedQty 数值读回（failed 态含 closeDueAt）', () => {
    const rows = parseInspectionOrdersResponse({
      orders: [
        {
          ...inspectionRow,
          state: 'failed',
          objectVersion: 2,
          passedQty: 15,
          failedQty: 5,
          judgeRemark: '尺寸超差',
          closeDueAt: '2026-10-28T01:00:00.000Z',
        },
      ],
    });
    expect(rows[0]?.passedQty).toBe(15);
    expect(rows[0]?.failedQty).toBe(5);
    expect(rows[0]?.closeDueAt).toBe('2026-10-28T01:00:00.000Z');
  });

  it('非法形状拒绝：缺 orders / 坏行 / 非数值送检量 / 坏乐观锁版本', () => {
    expect(() => parseInspectionOrdersResponse({})).toThrow(InspectionViewsError);
    expect(() => parseInspectionOrdersResponse({ orders: [null] })).toThrow(InspectionViewsError);
    expect(() =>
      parseInspectionOrdersResponse({ orders: [{ ...inspectionRow, quantity: '20' }] }),
    ).toThrow(InspectionViewsError);
    expect(() =>
      parseInspectionOrdersResponse({ orders: [{ ...inspectionRow, objectVersion: 0 }] }),
    ).toThrow(InspectionViewsError);
  });
});

describe('质检权限码常量（与后端端点一一对应）', () => {
  it('inspection:read / inspection:judge', () => {
    expect(INSPECTION_READ).toBe('inspection:read');
    expect(INSPECTION_JUDGE).toBe('inspection:judge');
  });
});
