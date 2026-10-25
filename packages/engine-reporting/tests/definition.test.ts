import { describe, expect, it } from 'vitest';
import { METRIC_DEFINITION_SCHEMA_VERSION, defineMetricDefinition, type MetricDefinition } from '../src/index.js';

function baseRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metricId: 'verified-hours-by-person',
    version: 1,
    display: '已核工时·按人',
    timeBasis: 'business',
    sourceKind: 'labor-entries',
    dimensions: [{ field: 'personId' }],
    measures: [{ measureId: 'total-hours', aggregation: 'sum', field: 'hours' }],
  };
}

describe('defineMetricDefinition', () => {
  it('接受合法定义并深冻结（含嵌套维度/度量/过滤）', () => {
    const raw = baseRaw();
    raw.filter = { kind: 'and', parts: [{ kind: 'compare', op: 'eq', field: 'laborKind', value: 'machining' }] };
    raw.dimensions = [{ field: 'personId', label: '人员', filter: { kind: 'compare', op: 'ne', field: 'personId', value: null } }];
    const definition = defineMetricDefinition(raw) as MetricDefinition;
    expect(definition.schemaVersion).toBe(METRIC_DEFINITION_SCHEMA_VERSION);
    expect(definition.timeBasis).toBe('business');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.dimensions)).toBe(true);
    expect(Object.isFrozen(definition.dimensions[0])).toBe(true);
    expect(Object.isFrozen(definition.dimensions[0]?.filter)).toBe(true);
    expect(Object.isFrozen(definition.measures)).toBe(true);
    expect(Object.isFrozen(definition.measures[0])).toBe(true);
    expect(Object.isFrozen(definition.filter)).toBe(true);
    expect(Object.isFrozen(((definition.filter ?? {}) as unknown as { parts: unknown[] }).parts[0])).toBe(true);
  });

  it('接受空维度口径（无维度总量）', () => {
    const definition = defineMetricDefinition({ ...baseRaw(), dimensions: [] });
    expect(definition.dimensions).toEqual([]);
  });

  it('拒绝非法 metricId / version / display / timeBasis / sourceKind', () => {
    expect(() => defineMetricDefinition({ ...baseRaw(), metricId: 'Hours X' })).toThrow(/metricId/);
    expect(() => defineMetricDefinition({ ...baseRaw(), version: 0 })).toThrow(/version/);
    expect(() => defineMetricDefinition({ ...baseRaw(), version: 1.5 })).toThrow(/version/);
    expect(() => defineMetricDefinition({ ...baseRaw(), display: '' })).toThrow(/display/);
    expect(() => defineMetricDefinition({ ...baseRaw(), timeBasis: 'calendar' })).toThrow(/timeBasis/);
    expect(() => defineMetricDefinition({ ...baseRaw(), sourceKind: 'LaborEntries' })).toThrow(/sourceKind/);
    expect(() => defineMetricDefinition({ ...baseRaw(), schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('拒绝重复维度字段与非法字段引用', () => {
    expect(() =>
      defineMetricDefinition({ ...baseRaw(), dimensions: [{ field: 'personId' }, { field: 'personId' }] }),
    ).toThrow(/duplicate dimension/);
    expect(() => defineMetricDefinition({ ...baseRaw(), dimensions: [{ field: 'Person' }] })).toThrow(/dimension/);
    expect(() => defineMetricDefinition({ ...baseRaw(), dimensions: [{ field: 'payload.qty' }] })).not.toThrow();
  });

  it('拒绝空度量 / 重复 measureId / 非法聚合 / 字段规则违背', () => {
    expect(() => defineMetricDefinition({ ...baseRaw(), measures: [] })).toThrow(/measures/);
    expect(() =>
      defineMetricDefinition({
        ...baseRaw(),
        measures: [
          { measureId: 'total-hours', aggregation: 'sum', field: 'hours' },
          { measureId: 'total-hours', aggregation: 'count' },
        ],
      }),
    ).toThrow(/duplicate measureId/);
    expect(() =>
      defineMetricDefinition({ ...baseRaw(), measures: [{ measureId: 'median-hours', aggregation: 'median', field: 'hours' }] }),
    ).toThrow(/aggregation/);
    expect(() =>
      defineMetricDefinition({ ...baseRaw(), measures: [{ measureId: 'total-hours', aggregation: 'sum' }] }),
    ).toThrow(/requires field/);
    expect(() =>
      defineMetricDefinition({
        ...baseRaw(),
        measures: [{ measureId: 'row-count', aggregation: 'count', field: 'hours' }],
      }),
    ).toThrow(/must not declare field/);
    expect(() =>
      defineMetricDefinition({
        ...baseRaw(),
        measures: [{ measureId: 'total-hours', aggregation: 'sum', field: 'hours', format: { minimumFractionDigits: 99 } }],
      }),
    ).toThrow(/minimumFractionDigits/);
  });

  it('拒绝非法过滤谓词（未知 kind / 空组合 / 非标量值）', () => {
    expect(() => defineMetricDefinition({ ...baseRaw(), filter: { kind: 'xor', field: 'a', value: 1 } })).toThrow(
      /filter kind/,
    );
    expect(() => defineMetricDefinition({ ...baseRaw(), filter: { kind: 'and', parts: [] } })).toThrow(/and/);
    expect(() =>
      defineMetricDefinition({ ...baseRaw(), filter: { kind: 'compare', op: 'eq', field: 'a', value: { x: 1 } } }),
    ).toThrow(/compare filter/);
    expect(() => defineMetricDefinition({ ...baseRaw(), filter: { kind: 'range', field: 'a' } })).toThrow(/range/);
  });

  it('版本不变性：同一输入构造两次，产出冻结等价（固定键序）', () => {
    const first = defineMetricDefinition(baseRaw());
    const second = defineMetricDefinition(baseRaw());
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
