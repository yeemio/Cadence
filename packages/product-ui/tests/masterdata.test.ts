/**
 * 基础数据视图模型测试（M1 增量 4-I）：响应解析、载荷构造、权限码常量。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCreateItemPayload,
  buildCreateResourcePayload,
  ITEM_READ,
  ITEM_WRITE,
  MasterdataViewError,
  parseItem,
  parseItemsResponse,
  parseResource,
  parseResourcesResponse,
  RESOURCE_READ,
  RESOURCE_WRITE,
} from '../src/index.js';

describe('基础数据响应解析', () => {
  it('物品列表：合法响应解析为视图（可空字段归一 null）；缺 items / 非法行抛错', () => {
    const items = parseItemsResponse({
      items: [
        { id: 'i-1', code: 'P-1001', name: '轴承', spec: '6204', unit: '个', category: 'part', active: true },
        { id: 'i-2', code: 'P-1002', name: '轴套', spec: null, unit: null, category: null, active: false },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[1]?.spec).toBeNull();
    expect(items[1]?.active).toBe(false);
    expect(() => parseItemsResponse({})).toThrow(MasterdataViewError);
    expect(() =>
      parseItemsResponse({ items: [{ id: '', code: 'x', name: 'x', active: true }] }),
    ).toThrow(MasterdataViewError);
  });

  it('单个物品（POST 响应）与资源列表同语义', () => {
    const item = parseItem({ id: 'i-1', code: 'P-1001', name: '轴承', spec: '6204', unit: '个', category: 'part', active: true });
    expect(item.code).toBe('P-1001');
    const resources = parseResourcesResponse({
      resources: [{ id: 'r-1', code: 'M-01', name: '一号铣床', type: 'machine', active: true }],
    });
    expect(resources[0]?.type).toBe('machine');
    expect(() => parseResource({ id: 'r-1', code: '', name: 'x', active: true })).toThrow(
      MasterdataViewError,
    );
  });
});

describe('基础数据请求载荷构造', () => {
  it('创建物品：trim、可选字段纯空白剔除、空 code/name 拒绝', () => {
    expect(buildCreateItemPayload({ code: ' P-1001 ', name: ' 轴承 ', spec: '  ', unit: '个' })).toEqual({
      code: 'P-1001',
      name: '轴承',
      unit: '个',
    });
    expect(() => buildCreateItemPayload({ code: '', name: 'x' })).toThrow(MasterdataViewError);
    expect(() => buildCreateItemPayload({ code: 'P-1', name: ' ' })).toThrow(MasterdataViewError);
  });

  it('创建资源：同语义', () => {
    expect(buildCreateResourcePayload({ code: 'M-01', name: '一号铣床', type: 'machine' })).toEqual({
      code: 'M-01',
      name: '一号铣床',
      type: 'machine',
    });
    expect(buildCreateResourcePayload({ code: 'M-02', name: '工位', type: ' ' })).toEqual({
      code: 'M-02',
      name: '工位',
    });
  });
});

describe('基础数据权限码常量（与后端端点一一对应）', () => {
  it('四个码：item:read / item:write / resource:read / resource:write', () => {
    expect(ITEM_READ).toBe('item:read');
    expect(ITEM_WRITE).toBe('item:write');
    expect(RESOURCE_READ).toBe('resource:read');
    expect(RESOURCE_WRITE).toBe('resource:write');
  });
});
