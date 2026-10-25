import { describe, expect, it } from 'vitest';
import {
  buildSourceRequest,
  createInMemoryMetricSource,
  defineMetricDefinition,
  evaluateMetric,
  type MetricDefinition,
  type MetricQuery,
  type MetricSourceRow,
} from '../src/index.js';

/** 三行人工夹具：三时间列错月放置（business 9 月 / occurred 10 月 / available 11 月）+ 一行无补录列。 */
const rows: MetricSourceRow[] = [
  { occurredAt: '2026-10-01T08:00:00Z', businessTime: '2026-09-30T09:00:00Z', availableTime: '2026-11-01T00:00:00Z', personId: 'p1', laborKind: 'machining', hours: 8, qty: 10 },
  { occurredAt: '2026-10-02T08:00:00Z', businessTime: '2026-10-02T09:00:00Z', availableTime: '2026-11-02T00:00:00Z', personId: 'p2', laborKind: 'assembly', hours: 6, qty: 4 },
  { occurredAt: '2026-10-03T08:00:00Z', personId: 'p1', laborKind: 'machining', hours: 4, qty: 5 },
  { occurredAt: '2026-10-04T08:00:00Z', personId: 'p3', laborKind: 'outsourced', hours: null, qty: 2 },
];

function defRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metricId: 'verified-hours-by-person',
    version: 1,
    display: '已核工时·按人',
    timeBasis: 'business',
    sourceKind: 'labor-entries',
    dimensions: [{ field: 'personId' }],
    measures: [{ measureId: 'total-hours', aggregation: 'sum', field: 'hours' }],
    ...overrides,
  };
}

const OCTOBER = { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' };
const SEPTEMBER = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' };
const NOVEMBER = { from: '2026-11-01T00:00:00Z', to: '2026-11-30T23:59:59Z' };

describe('evaluateMetric · 聚合正确性', () => {
  it('sum/count/avg/min/max/distinct-count 全语义（null 跳过、count 数行）', () => {
    const definition = defineMetricDefinition(
      defRaw({
        dimensions: [{ field: 'laborKind' }],
        measures: [
          { measureId: 'rows', aggregation: 'count' },
          { measureId: 'hours-sum', aggregation: 'sum', field: 'hours' },
          { measureId: 'hours-avg', aggregation: 'avg', field: 'hours' },
          { measureId: 'hours-min', aggregation: 'min', field: 'hours' },
          { measureId: 'hours-max', aggregation: 'max', field: 'hours' },
          { measureId: 'distinct-persons', aggregation: 'distinct-count', field: 'personId' },
        ],
      }),
    );
    const result = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, rows);
    const machining = result.rows.find((r) => r.key.laborKind === 'machining');
    // machining 组：p1 两行（hours 8/4）
    expect(machining?.values).toEqual({
      rows: 2,
      'hours-sum': 12,
      'hours-avg': 6,
      'hours-min': 4,
      'hours-max': 8,
      'distinct-persons': 1,
    });
    // outsourced 组：hours 为 null 的行——count 计入、sum/avg/min/max 跳过 null
    const outsourced = result.rows.find((r) => r.key.laborKind === 'outsourced');
    expect(outsourced?.values).toEqual({
      rows: 1,
      'hours-sum': 0,
      'hours-avg': null,
      'hours-min': null,
      'hours-max': null,
      'distinct-persons': 1,
    });
    // 分组按首次出现排序
    expect(result.rows.map((r) => r.key.laborKind)).toEqual(['machining', 'assembly', 'outsourced']);
    expect(result.dimensionFields).toEqual(['laborKind']);
    expect(result.measureIds).toEqual(['rows', 'hours-sum', 'hours-avg', 'hours-min', 'hours-max', 'distinct-persons']);
  });

  it('distinct-count 对标量去重（同值多行计 1）；复合维度键', () => {
    const definition = defineMetricDefinition(
      defRaw({
        dimensions: [{ field: 'personId' }, { field: 'laborKind' }],
        measures: [{ measureId: 'entries', aggregation: 'count' }, { measureId: 'distinct-persons', aggregation: 'distinct-count', field: 'personId' }],
      }),
    );
    const result = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, rows);
    expect(result.rows.length).toBe(3); // p1×machining / p2×assembly / p3×outsourced
    const p1machining = result.rows.find((r) => r.key.personId === 'p1' && r.key.laborKind === 'machining');
    expect(p1machining?.values).toEqual({ entries: 2, 'distinct-persons': 1 });
  });

  it('空集：无维度口径恒一行——sum/count/distinct-count 为 0，avg/min/max 为 null', () => {
    const definition = defineMetricDefinition(
      defRaw({
        dimensions: [],
        measures: [
          { measureId: 'rows', aggregation: 'count' },
          { measureId: 'total-hours', aggregation: 'sum', field: 'hours' },
          { measureId: 'avg-hours', aggregation: 'avg', field: 'hours' },
          { measureId: 'min-hours', aggregation: 'min', field: 'hours' },
          { measureId: 'persons', aggregation: 'distinct-count', field: 'personId' },
        ],
      }),
    );
    const result = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, []);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.key).toEqual({});
    expect(result.rows[0]?.values).toEqual({
      rows: 0,
      'total-hours': 0,
      'avg-hours': null,
      'min-hours': null,
      persons: 0,
    });
  });

  it('结果深冻结（不可变快照）', () => {
    const definition = defineMetricDefinition(defRaw());
    const result = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, rows);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
    expect(Object.isFrozen(result.metric)).toBe(true);
  });
});

describe('evaluateMetric · 时间口径三态', () => {
  it('business/available/occurred 三列各按所选口径列落窗；缺列回落 occurredAt', () => {
    const definition = defineMetricDefinition(defRaw()); // timeBasis: business
    const query = { metricId: 'verified-hours-by-person', version: 1, ...OCTOBER };

    // business 口径（定义缺省）：row1 business=9/30 出窗，row2/3/4 business 回落 occurredAt 在 10 月
    const businessResult = evaluateMetric(definition, query, rows);
    expect(businessResult.timeBasis).toBe('business');
    expect(businessResult.rows.map((r) => r.key.personId).sort()).toEqual(['p1', 'p2', 'p3']);

    // occurred 口径（查询覆盖）：全部四行 occurredAt 均在 10 月
    const occurredResult = evaluateMetric(definition, { ...query, timeBasis: 'occurred' }, rows);
    expect(occurredResult.timeBasis).toBe('occurred');
    expect(occurredResult.rows.length).toBe(3);

    // available 口径：row1/2 available=11 月出窗，row3/4 无列回落 occurredAt（10 月在窗）
    const availableResult = evaluateMetric(definition, { ...query, timeBasis: 'available' }, rows);
    expect(availableResult.rows.map((r) => r.key.personId).sort()).toEqual(['p1', 'p3']);

    // 同窗口 9 月：仅 business 口径下 row1（businessTime=9/30）入窗
    const september = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1, ...SEPTEMBER }, rows);
    expect(september.rows.map((r) => r.key.personId)).toEqual(['p1']);
    // 同窗口 11 月：仅 available 口径下 row1/2 入窗
    const november = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1, timeBasis: 'available', ...NOVEMBER }, rows);
    expect(november.rows.map((r) => r.key.personId).sort()).toEqual(['p1', 'p2']);
  });

  it('窗口端点含界；无窗口不过滤时间', () => {
    const definition = defineMetricDefinition(defRaw());
    const fromEdge = evaluateMetric(
      definition,
      { metricId: 'verified-hours-by-person', version: 1, timeBasis: 'occurred', from: '2026-10-01T08:00:00Z', to: '2026-10-01T08:00:00Z' },
      rows,
    );
    expect(fromEdge.rows.map((r) => r.key.personId)).toEqual(['p1']);
    const noWindow = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1, timeBasis: 'occurred' }, rows);
    expect(noWindow.rows.length).toBe(3);
  });
});

describe('evaluateMetric · 过滤与切片', () => {
  it('根过滤 + 维度值域 + 查询过滤 AND 生效', () => {
    const definition = defineMetricDefinition(
      defRaw({
        dimensions: [{ field: 'personId' }, { field: 'laborKind', filter: { kind: 'in-set', field: 'laborKind', values: ['machining', 'assembly'] } }],
        filter: { kind: 'compare', op: 'gt', field: 'qty', value: 2 },
      }),
    );
    // 维度值域剔除 outsourced；根过滤剔除 qty<=2 的行（无）→ p1(2)/p2(1)
    const base = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, rows);
    expect(base.rows.map((r) => `${r.key.personId}:${r.key.laborKind}`).sort()).toEqual(['p1:machining', 'p2:assembly']);
    // 查询过滤再 AND：仅 assembly
    const filtered = evaluateMetric(
      definition,
      { metricId: 'verified-hours-by-person', version: 1, filter: { kind: 'compare', op: 'eq', field: 'laborKind', value: 'assembly' } },
      rows,
    );
    expect(filtered.rows.map((r) => r.key.personId)).toEqual(['p2']);
  });

  it('维度切片：仅保留指定维度值的分组', () => {
    const definition = defineMetricDefinition(defRaw());
    const result = evaluateMetric(
      definition,
      { metricId: 'verified-hours-by-person', version: 1, dimensionSlice: { personId: ['p2'] } },
      rows,
    );
    expect(result.rows.map((r) => r.key.personId)).toEqual(['p2']);
    expect(result.rows[0]?.values['total-hours']).toBe(6);
    // 切到空集：零行
    const empty = evaluateMetric(
      definition,
      { metricId: 'verified-hours-by-person', version: 1, dimensionSlice: { personId: [] } },
      rows,
    );
    expect(empty.rows.length).toBe(0);
  });

  it('口径溯源与 fail-fast：metricId/version 错位、未声明切片字段、非法窗口/覆盖口径均抛', () => {
    const definition = defineMetricDefinition(defRaw());
    const result = evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1 }, rows);
    expect(result.metric).toEqual({ metricId: 'verified-hours-by-person', version: 1 });

    expect(() => evaluateMetric(definition, { metricId: 'other-metric', version: 1 }, rows)).toThrow(/metricId mismatch/);
    expect(() => evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 2 }, rows)).toThrow(
      /version mismatch/,
    );
    expect(() =>
      evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1, dimensionSlice: { laborKind: ['x'] } }, rows),
    ).toThrow(/not a declared dimension/);
    expect(() =>
      evaluateMetric(definition, { metricId: 'verified-hours-by-person', version: 1, from: 'yesterday' }, rows),
    ).toThrow(/from/);
    // 非法值经 unknown 注入：模拟不受信查询到达引擎（类型层拦截在先，运行时校验兜底）
    const badBasis = {
      metricId: 'verified-hours-by-person',
      version: 1,
      timeBasis: 'calendar',
    } as unknown as MetricQuery;
    expect(() => evaluateMetric(definition, badBasis, rows)).toThrow(/timeBasis/);
    const badFilter = {
      metricId: 'verified-hours-by-person',
      version: 1,
      filter: { kind: 'xor' },
    } as unknown as MetricQuery;
    expect(() => evaluateMetric(definition, badFilter, rows)).toThrow(/filter kind/);
  });
});

describe('evaluateMetric · 全流程（mock 源数据 + 下推一致）', () => {
  it('buildSourceRequest → in-memory source.read → evaluateMetric 与直接全量求值等价', async () => {
    const definition = defineMetricDefinition(
      defRaw({
        filter: { kind: 'compare', op: 'gt', field: 'qty', value: 0 },
      }),
    ) as MetricDefinition;
    const query = {
      metricId: 'verified-hours-by-person',
      version: 1,
      ...OCTOBER,
      filter: { kind: 'compare', op: 'eq', field: 'laborKind', value: 'machining' } as const,
    };
    const request = buildSourceRequest(definition, query);
    expect(request.sourceKind).toBe('labor-entries');
    expect(request.timeBasis).toBe('business');
    expect(request.filter).toEqual({
      kind: 'and',
      parts: [
        { kind: 'compare', op: 'gt', field: 'qty', value: 0 },
        { kind: 'compare', op: 'eq', field: 'laborKind', value: 'machining' },
      ],
    });

    const source = createInMemoryMetricSource('labor-entries', rows);
    const fetched = await source.read(request);
    const viaSource = evaluateMetric(definition, query, fetched);
    const direct = evaluateMetric(definition, query, rows);
    expect(JSON.stringify(viaSource)).toBe(JSON.stringify(direct));
    expect(viaSource.rows.map((r) => r.key.personId)).toEqual(['p1']);
    // business 口径 10 月窗排除 row1（businessTime=9/30），machining 只剩 row3（hours 4）
    expect(viaSource.rows[0]?.values['total-hours']).toBe(4);
  });

  it('buildSourceRequest：无过滤时 filter 缺省；仅根过滤时不下垂组合', () => {
    const noFilters = defineMetricDefinition(defRaw());
    expect(buildSourceRequest(noFilters, { metricId: 'verified-hours-by-person', version: 1 }).filter).toBeUndefined();
    const withRoot = defineMetricDefinition(defRaw({ filter: { kind: 'compare', op: 'eq', field: 'laborKind', value: 'machining' } }));
    expect(buildSourceRequest(withRoot, { metricId: 'verified-hours-by-person', version: 1 }).filter).toEqual({
      kind: 'compare',
      op: 'eq',
      field: 'laborKind',
      value: 'machining',
    });
  });
});
