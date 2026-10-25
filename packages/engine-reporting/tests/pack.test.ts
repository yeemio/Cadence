import { describe, expect, it } from 'vitest';
import { defineMetricDefinition, defineMetricPack, findMetric } from '../src/index.js';

function metricRaw(metricId = 'verified-hours-by-person', version = 1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metricId,
    version,
    display: `口径 ${metricId} v${version}`,
    timeBasis: 'business',
    sourceKind: 'labor-entries',
    dimensions: [{ field: 'personId' }],
    measures: [{ measureId: 'total-hours', aggregation: 'sum', field: 'hours' }],
  };
}

function packRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packId: 'labor-metrics',
    version: 1,
    title: '工时口径包',
    description: '已核工时族口径（示例）',
    metrics: [metricRaw(), metricRaw('output-by-drawing', 1)],
  };
}

describe('defineMetricPack', () => {
  it('接受合法包：逐条口径校验冻结，整体深冻结', () => {
    const pack = defineMetricPack(packRaw());
    expect(pack.packId).toBe('labor-metrics');
    expect(pack.metrics.length).toBe(2);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.metrics)).toBe(true);
    expect(Object.isFrozen(pack.metrics[0])).toBe(true);
    // 接受已构造的冻结口径作为输入（再校验幂等）
    const prebuilt = defineMetricDefinition(metricRaw());
    const packWithPrebuilt = defineMetricPack({ ...packRaw(), metrics: [prebuilt] });
    expect(packWithPrebuilt.metrics[0]?.metricId).toBe('verified-hours-by-person');
  });

  it('拒绝：包内 metricId 重复 / 空口径清单 / 非法包字段 / 非法口径透传', () => {
    expect(() => defineMetricPack({ ...packRaw(), metrics: [metricRaw(), metricRaw()] })).toThrow(/duplicate metricId/);
    expect(() => defineMetricPack({ ...packRaw(), metrics: [] })).toThrow(/metrics/);
    expect(() => defineMetricPack({ ...packRaw(), packId: 'Labor Metrics' })).toThrow(/packId/);
    expect(() => defineMetricPack({ ...packRaw(), version: 0 })).toThrow(/version/);
    expect(() => defineMetricPack({ ...packRaw(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => defineMetricPack({ ...packRaw(), metrics: [{ ...metricRaw(), timeBasis: 'calendar' }] })).toThrow(
      /timeBasis/,
    );
  });

  it('跨版本不可变性：同 metricId+version 定义两次构造等价且冻结；整包两次构造等价', () => {
    const metricA = defineMetricDefinition(metricRaw('verified-hours-by-person', 1));
    const metricB = defineMetricDefinition(metricRaw('verified-hours-by-person', 1));
    expect(JSON.stringify(metricA)).toBe(JSON.stringify(metricB));
    expect(Object.isFrozen(metricA)).toBe(true);
    expect(Object.isFrozen(metricB)).toBe(true);

    const packA = defineMetricPack(packRaw());
    const packB = defineMetricPack(packRaw());
    expect(JSON.stringify(packA)).toBe(JSON.stringify(packB));
    expect(Object.isFrozen(packA)).toBe(true);
  });
});

describe('findMetric', () => {
  it('按 metricId+version 命中；版本不符返回 undefined', () => {
    const pack = defineMetricPack(packRaw());
    expect(findMetric(pack, 'verified-hours-by-person', 1)?.sourceKind).toBe('labor-entries');
    expect(findMetric(pack, 'verified-hours-by-person', 2)).toBeUndefined();
    expect(findMetric(pack, 'missing', 1)).toBeUndefined();
  });
});
