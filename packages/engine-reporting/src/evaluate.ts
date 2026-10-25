/**
 * 引擎求值：MetricQuery（口径引用 + 维度切片 + 时间窗 + 过滤）× 源数据行
 * → MetricResult（行列结果 + 口径溯源）。evaluateMetric 是纯函数——同定义、同查询、
 * 同行序必得同结果（无时钟、无随机、无 IO）。
 *
 * 正确性归属：引擎对传入行重复施加全部谓词（根过滤 + 维度值域 + 查询过滤 + 时间窗），
 * 数据源下推（buildSourceRequest → MetricSource.read）只是优化，不改变结果。
 */
import { deepFreeze } from './internal/freeze.js';
import { isPlainObject } from './internal/checks.js';
import {
  evaluateMetricFilter,
  readRowField,
  validateMetricFilter,
  type FilterValue,
  type MetricFilter,
} from './filter.js';
import { TIME_BASES, type MeasureDef, type MetricDefinition, type TimeBasis } from './definition.js';
import { parseIsoTime, rowTimeIso, type MetricSourceRequest, type MetricSourceRow } from './source.js';

/** 口径查询：引用口径（metricId + version，钉死定义），可切片、限窗、加过滤、换时间口径。 */
export interface MetricQuery {
  readonly metricId: string;
  readonly version: number;
  /** ISO 8601；含下界（缺省无下界） */
  readonly from?: string;
  /** ISO 8601；含上界（缺省无上界） */
  readonly to?: string;
  /**
   * 时间口径覆盖：缺省用口径定义的 timeBasis（版本化口径的一部分）；
   * 显式指定用于对账场景（business vs available 同口径比对）。
   * 结果回显实际生效口径。
   */
  readonly timeBasis?: TimeBasis;
  /** 维度切片：仅保留指定维度值的分组（字段须为已声明维度） */
  readonly dimensionSlice?: Readonly<Record<string, readonly FilterValue[]>>;
  /** 查询期过滤：与口径定义根过滤 AND（口径内不变量不因此漂移） */
  readonly filter?: MetricFilter;
}

export interface MetricResultRow {
  /** 维度键：声明维度的字段 → 分组值（无维度口径 = 空键） */
  readonly key: Readonly<Record<string, FilterValue>>;
  /** 度量值：measureId → 聚合结果（avg/min/max 空集为 null，sum/count/distinct-count 空集为 0） */
  readonly values: Readonly<Record<string, number | null>>;
}

export interface MetricResult {
  /** 口径溯源：用了哪个定义、哪个版本 */
  readonly metric: { readonly metricId: string; readonly version: number };
  /** 实际生效的时间口径（定义缺省 or 查询覆盖） */
  readonly timeBasis: TimeBasis;
  readonly window: { readonly from?: string; readonly to?: string };
  readonly dimensionFields: readonly string[];
  readonly measureIds: readonly string[];
  readonly rows: readonly MetricResultRow[];
}

function assertQueryBinding(definition: MetricDefinition, query: MetricQuery): void {
  if (!isPlainObject(query)) {
    throw new Error('invalid metric query: expected a plain object');
  }
  if (query.metricId !== definition.metricId) {
    throw new Error(
      `invalid metric query: metricId mismatch (query "${String(query.metricId)}" vs definition "${definition.metricId}")`,
    );
  }
  if (query.version !== definition.version) {
    throw new Error(
      `invalid metric query: version mismatch (query ${String(query.version)} vs definition ${String(definition.version)})`,
    );
  }
}

function effectiveBasis(definition: MetricDefinition, query: MetricQuery): TimeBasis {
  const basis = query.timeBasis ?? definition.timeBasis;
  if (typeof basis !== 'string' || !TIME_BASES.includes(basis as TimeBasis)) {
    throw new Error(`invalid timeBasis: expected one of ${TIME_BASES.join('/')}, got "${String(basis)}"`);
  }
  return basis;
}

function normalizeDimensionSlice(
  definition: MetricDefinition,
  slice: MetricQuery['dimensionSlice'],
): Map<string, Set<FilterValue>> {
  const slices = new Map<string, Set<FilterValue>>();
  if (slice === undefined) {
    return slices;
  }
  if (!isPlainObject(slice)) {
    throw new Error('invalid dimensionSlice: expected a plain object of dimension field -> values');
  }
  const declared = new Set(definition.dimensions.map((dimension) => dimension.field));
  for (const [field, values] of Object.entries(slice)) {
    if (!declared.has(field)) {
      throw new Error(`invalid dimensionSlice: "${field}" is not a declared dimension`);
    }
    if (!Array.isArray(values)) {
      throw new Error(`invalid dimensionSlice["${field}"]: expected an array of scalar values`);
    }
    const allowed = new Set<FilterValue>();
    for (const value of values) {
      if (
        !(
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        )
      ) {
        throw new Error(`invalid dimensionSlice["${field}"]: values must be string / finite number / boolean / null`);
      }
      allowed.add(value);
    }
    slices.set(field, allowed);
  }
  return slices;
}

function normalizeDimensionValue(value: unknown): FilterValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null; // 非标量维度值（对象/数组/缺失）归 null 组
}

function encodeGroupKey(key: Readonly<Record<string, FilterValue>>, fields: readonly string[]): string {
  return fields.map((field) => `t${typeof key[field]}:${String(key[field])}`).join('\u0000');
}

function requireNumber(value: unknown, measure: MeasureDef): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `invalid source row value for measure "${measure.measureId}" (${String(measure.field)}): expected a finite number, got ${String(value)}`,
    );
  }
  return value;
}

function foldMeasure(measure: MeasureDef, rows: readonly unknown[]): number | null {
  if (measure.aggregation === 'count') {
    return rows.length;
  }
  const field = measure.field as string; // 校验保证非 count 聚合必有 field
  // 行在主循环已过 isPlainObject 校验后才入组，此处按索引签名读取安全
  const values = rows
    .map((row) => readRowField(row as Readonly<Record<string, unknown>>, field))
    .filter((value) => value !== null);

  switch (measure.aggregation) {
    case 'sum':
      return values.reduce<number>((acc, value) => acc + requireNumber(value, measure), 0);
    case 'avg': {
      if (values.length === 0) return null;
      const numbers = values.map((value) => requireNumber(value, measure));
      return numbers.reduce((acc, n) => acc + n, 0) / numbers.length;
    }
    case 'min': {
      if (values.length === 0) return null;
      return Math.min(...values.map((value) => requireNumber(value, measure)));
    }
    case 'max': {
      if (values.length === 0) return null;
      return Math.max(...values.map((value) => requireNumber(value, measure)));
    }
    case 'distinct-count': {
      const distinct = new Set<FilterValue>();
      for (const value of values) {
        if (value === null) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          distinct.add(value);
        } else {
          throw new Error(
            `invalid source row value for measure "${measure.measureId}" (${field}): distinct-count requires scalar values, got ${typeof value}`,
          );
        }
      }
      return distinct.size;
    }
  }
}

/** 组装数据源请求（下推接缝）：源种类 + 生效时间口径 + 时间窗 + 根过滤∧查询过滤。 */
export function buildSourceRequest(definition: MetricDefinition, query: MetricQuery): MetricSourceRequest {
  assertQueryBinding(definition, query);
  const basis = effectiveBasis(definition, query);
  const fromMs = query.from === undefined ? undefined : parseIsoTime(query.from, 'query from');
  const toMs = query.to === undefined ? undefined : parseIsoTime(query.to, 'query to');
  const queryFilter = query.filter === undefined ? undefined : validateMetricFilter(query.filter);

  const parts: MetricFilter[] = [];
  if (definition.filter !== undefined) parts.push(definition.filter);
  if (queryFilter !== undefined) parts.push(queryFilter);
  const filter =
    parts.length === 0
      ? undefined
      : parts.length === 1
        ? parts[0]
        : deepFreeze<MetricFilter>({ kind: 'and', parts: Object.freeze(parts) });

  return deepFreeze<MetricSourceRequest>({
    sourceKind: definition.sourceKind,
    timeBasis: basis,
    ...(fromMs !== undefined ? { from: query.from } : {}),
    ...(toMs !== undefined ? { to: query.to } : {}),
    ...(filter !== undefined ? { filter } : {}),
  });
}

/**
 * 求值（纯函数）。行处理顺序 = 输入顺序；分组按首次出现排序；结果深冻结。
 *
 * @throws 口径引用错位（metricId/version 不符）、非法查询形状（切片字段未声明、
 *         非法时间窗/过滤/时间口径）、行数据非法（缺时间列、非 ISO 时间、聚合值非数值）。
 */
export function evaluateMetric(
  definition: MetricDefinition,
  query: MetricQuery,
  rows: readonly MetricSourceRow[],
): MetricResult {
  assertQueryBinding(definition, query);
  const basis = effectiveBasis(definition, query);
  const slices = normalizeDimensionSlice(definition, query.dimensionSlice);
  const queryFilter = query.filter === undefined ? undefined : validateMetricFilter(query.filter);
  const fromMs = query.from === undefined ? undefined : parseIsoTime(query.from, 'query from');
  const toMs = query.to === undefined ? undefined : parseIsoTime(query.to, 'query to');

  const dimensionFields = definition.dimensions.map((dimension) => dimension.field);
  const groups = new Map<string, { key: Record<string, FilterValue>; rows: unknown[] }>();
  if (dimensionFields.length === 0) {
    groups.set('', { key: {}, rows: [] }); // 无维度口径：恒一行总量（空集亦然）
  }

  for (const row of rows) {
    if (!isPlainObject(row)) {
      throw new Error('invalid source row: expected a plain object');
    }
    if (fromMs !== undefined || toMs !== undefined) {
      const ms = parseIsoTime(rowTimeIso(row, basis), `source row ${basis} time`);
      if (fromMs !== undefined && ms < fromMs) continue;
      if (toMs !== undefined && ms > toMs) continue;
    }
    if (definition.filter !== undefined && !evaluateMetricFilter(definition.filter, row)) continue;
    let dimensionBlocked = false;
    for (const dimension of definition.dimensions) {
      if (dimension.filter !== undefined && !evaluateMetricFilter(dimension.filter, row)) {
        dimensionBlocked = true;
        break;
      }
    }
    if (dimensionBlocked) continue;
    if (queryFilter !== undefined && !evaluateMetricFilter(queryFilter, row)) continue;

    const key: Record<string, FilterValue> = {};
    for (const dimension of definition.dimensions) {
      key[dimension.field] = normalizeDimensionValue(readRowField(row, dimension.field));
    }
    const groupKey = encodeGroupKey(key, dimensionFields);
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { key, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }

  const resultRows: { key: Record<string, FilterValue>; values: Record<string, number | null> }[] = [];
  for (const group of groups.values()) {
    let keep = true;
    for (const [field, allowed] of slices) {
      if (!allowed.has(group.key[field] ?? null)) {
        keep = false;
        break;
      }
    }
    if (!keep) continue;
    const values: Record<string, number | null> = {};
    for (const measure of definition.measures) {
      values[measure.measureId] = foldMeasure(measure, group.rows);
    }
    resultRows.push({ key: group.key, values });
  }

  // 不做中间 Object.freeze：deepFreeze 只对未冻结对象递归，预冻结会挡住元素级冻结
  return deepFreeze<MetricResult>({
    metric: { metricId: definition.metricId, version: definition.version },
    timeBasis: basis,
    window: {
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    },
    dimensionFields: dimensionFields.slice(),
    measureIds: definition.measures.map((measure) => measure.measureId),
    rows: resultRows,
  });
}
