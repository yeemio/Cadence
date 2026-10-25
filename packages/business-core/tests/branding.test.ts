import { describe, expect, it } from 'vitest';
import { defineId, WorkOrderId } from '../src/index.js';

describe('品牌化 ID', () => {
  it('create 接受非空字符串', () => {
    expect(WorkOrderId.create('wo-001')).toBe('wo-001');
  });

  it('create 拒绝空串 / 纯空白 / 超长值', () => {
    expect(() => WorkOrderId.create('')).toThrow();
    expect(() => WorkOrderId.create('   ')).toThrow();
    expect(() => WorkOrderId.create('x'.repeat(129))).toThrow();
  });

  it('is() 做同款运行时校验', () => {
    expect(WorkOrderId.is('wo-001')).toBe(true);
    expect(WorkOrderId.is('')).toBe(false);
    expect(WorkOrderId.is(42)).toBe(false);
  });

  it('defineId 记录品牌名', () => {
    expect(defineId('FooId').name).toBe('FooId');
  });
});
