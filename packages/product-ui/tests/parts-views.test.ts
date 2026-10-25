/**
 * 配件申请视图模型测试（S3 移动呈现）：GET /workorder/parts-requests 响应
 * 解析、权限码常量。响应形状镜像 packages/application workorder-stores
 * PartsRequest 投影行。
 */
import { describe, expect, it } from 'vitest';
import {
  parsePartsRequestsResponse,
  PARTS_APPROVE,
  PARTS_READ,
  PARTS_REQUEST,
  PartsViewsError,
} from '../src/index.js';

const partsRow = {
  id: 'pr-0001',
  tenant: 'tenant-e2e',
  workOrderId: 'wo-0001',
  flowConfigId: 'flow-1',
  state: 'submitted',
  objectVersion: 2,
  itemId: 'itm-seed-0001',
  quantity: 5,
  requester: 'user-demo-operator',
  remark: null,
  shipmentRef: null,
  createdAt: '2026-10-25T01:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
};

describe('配件申请列表响应解析', () => {
  it('合法响应：信封 partsRequests 解包、行子集与乐观锁锚点保留', () => {
    const rows = parsePartsRequestsResponse({ partsRequests: [partsRow] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'pr-0001',
      workOrderId: 'wo-0001',
      state: 'submitted',
      objectVersion: 2,
      itemId: 'itm-seed-0001',
      quantity: 5,
      requester: 'user-demo-operator',
      remark: null,
      shipmentRef: null,
      createdAt: '2026-10-25T01:00:00.000Z',
    });
  });

  it('非法形状拒绝：缺 partsRequests / 坏行 / 非数值数量 / 坏乐观锁版本', () => {
    expect(() => parsePartsRequestsResponse({})).toThrow(PartsViewsError);
    expect(() => parsePartsRequestsResponse({ partsRequests: ['pr-1'] })).toThrow(PartsViewsError);
    expect(() =>
      parsePartsRequestsResponse({ partsRequests: [{ ...partsRow, quantity: '5' }] }),
    ).toThrow(PartsViewsError);
    expect(() =>
      parsePartsRequestsResponse({ partsRequests: [{ ...partsRow, objectVersion: -1 }] }),
    ).toThrow(PartsViewsError);
    expect(() => parsePartsRequestsResponse([])).toThrow(PartsViewsError);
  });
});

describe('配件权限码常量（与后端端点一一对应）', () => {
  it('parts:request / parts:read / parts:approve', () => {
    expect(PARTS_REQUEST).toBe('parts:request');
    expect(PARTS_READ).toBe('parts:read');
    expect(PARTS_APPROVE).toBe('parts:approve');
  });
});
