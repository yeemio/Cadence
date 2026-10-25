import { describe, expect, it } from 'vitest';
import { evaluateMetricFilter, readRowField, validateMetricFilter, type MetricFilter } from '../src/index.js';

const row = {
  personId: 'p-1',
  laborKind: 'machining',
  hours: 8,
  active: true,
  note: null,
  payload: { qty: 12, flags: { late: false } },
};

describe('validateMetricFilter', () => {
  it('规范化并深冻结（嵌套组合）', () => {
    const filter = validateMetricFilter({
      kind: 'and',
      parts: [
        { kind: 'compare', op: 'gt', field: 'hours', value: 0 },
        { kind: 'not', inner: { kind: 'in-set', field: 'laborKind', values: ['outsourced'] } },
      ],
    }) as MetricFilter;
    expect(Object.isFrozen(filter)).toBe(true);
    expect((filter as unknown as { parts: unknown[] }).parts.length).toBe(2);
  });

  it('拒绝未知 kind / 空组合 / 空集合 / 无界区间 / 非标量与 NaN 值 / 非法字段', () => {
    expect(() => validateMetricFilter({ kind: 'regex', field: 'a', value: 1 })).toThrow(/filter kind/);
    expect(() => validateMetricFilter({ kind: 'or', parts: [] })).toThrow(/or/);
    expect(() => validateMetricFilter({ kind: 'in-set', field: 'a', values: [] })).toThrow(/in-set/);
    expect(() => validateMetricFilter({ kind: 'range', field: 'a' })).toThrow(/range/);
    expect(() => validateMetricFilter({ kind: 'compare', op: 'eq', field: 'a', value: NaN })).toThrow(/compare filter/);
    expect(() => validateMetricFilter({ kind: 'compare', op: 'eq', field: 'a', value: [1] })).toThrow(/compare filter/);
    expect(() => validateMetricFilter({ kind: 'compare', op: 'eq', field: 'Bad.Field', value: 1 })).toThrow(/field/);
    expect(() => validateMetricFilter({ kind: 'not' })).toThrow(/inner/);
  });

  it('幂等：已冻结谓词再次校验产出等价冻结结果', () => {
    const raw = { kind: 'compare', op: 'eq', field: 'personId', value: 'p-1' };
    const first = validateMetricFilter(raw);
    const second = validateMetricFilter(first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(second)).toBe(true);
  });
});

describe('readRowField', () => {
  it('按 dot-path 读取；缺失/穿出对象/穿进数组 → null', () => {
    expect(readRowField(row, 'personId')).toBe('p-1');
    expect(readRowField(row, 'payload.qty')).toBe(12);
    expect(readRowField(row, 'payload.flags.late')).toBe(false);
    expect(readRowField(row, 'payload.missing')).toBe(null);
    expect(readRowField(row, 'personId.deeper')).toBe(null);
    expect(readRowField(row, 'payload.flags.late.x')).toBe(null);
    expect(readRowField({ arr: [1, 2] }, 'arr.0')).toBe(null);
  });
});

describe('evaluateMetricFilter', () => {
  it('比较：eq/ne 对标量与 null；排序仅同族成立', () => {
    expect(evaluateMetricFilter({ kind: 'compare', op: 'eq', field: 'personId', value: 'p-1' }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'eq', field: 'note', value: null }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'eq', field: 'missing', value: null }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'ne', field: 'personId', value: 'p-2' }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'gt', field: 'hours', value: 7 }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'lte', field: 'hours', value: 8 }, row)).toBe(true);
    // 跨族与不可排序类型：判不匹配（不抛错）
    expect(evaluateMetricFilter({ kind: 'compare', op: 'gt', field: 'personId', value: 1 }, row)).toBe(false);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'gt', field: 'active', value: true }, row)).toBe(false);
    expect(evaluateMetricFilter({ kind: 'compare', op: 'eq', field: 'hours', value: '8' }, row)).toBe(false);
    // ISO 时间串字典序 = 时间序
    const timeRow = { occurredAt: '2026-10-15T08:00:00Z' };
    expect(
      evaluateMetricFilter(
        { kind: 'compare', op: 'gte', field: 'occurredAt', value: '2026-10-15T08:00:00Z' },
        timeRow,
      ),
    ).toBe(true);
    expect(
      evaluateMetricFilter({ kind: 'compare', op: 'lt', field: 'occurredAt', value: '2026-10-15T08:00:00Z' }, timeRow),
    ).toBe(false);
  });

  it('在集合内：含 null 成员；无成员匹配为 false', () => {
    expect(evaluateMetricFilter({ kind: 'in-set', field: 'laborKind', values: ['machining', 'assembly'] }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'in-set', field: 'note', values: [null] }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'in-set', field: 'laborKind', values: ['outsourced'] }, row)).toBe(false);
  });

  it('区间：双端含界、单端、跨族不匹配', () => {
    expect(evaluateMetricFilter({ kind: 'range', field: 'hours', min: 8, max: 8 }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'range', field: 'hours', min: 9 }, row)).toBe(false);
    expect(evaluateMetricFilter({ kind: 'range', field: 'hours', max: 7 }, row)).toBe(false);
    expect(evaluateMetricFilter({ kind: 'range', field: 'personId', min: 'p-0', max: 'p-2' }, row)).toBe(true);
    expect(evaluateMetricFilter({ kind: 'range', field: 'hours', min: '0', max: '99' }, row)).toBe(false);
  });

  it('与或非组合（嵌套）', () => {
    const filter: MetricFilter = {
      kind: 'and',
      parts: [
        { kind: 'or', parts: [{ kind: 'compare', op: 'eq', field: 'laborKind', value: 'machining' }, { kind: 'compare', op: 'eq', field: 'laborKind', value: 'assembly' }] },
        { kind: 'not', inner: { kind: 'compare', op: 'eq', field: 'personId', value: 'p-2' } },
      ],
    };
    expect(evaluateMetricFilter(filter, row)).toBe(true);
    expect(evaluateMetricFilter(filter, { ...row, laborKind: 'outsourced' })).toBe(false);
    expect(evaluateMetricFilter(filter, { ...row, personId: 'p-2' })).toBe(false);
    expect(evaluateMetricFilter({ kind: 'not', inner: { kind: 'not', inner: { kind: 'compare', op: 'eq', field: 'hours', value: 8 } } }, row)).toBe(true);
  });
});
