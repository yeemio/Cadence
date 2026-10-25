/**
 * 口径定义（MetricDefinition）：纯数据、版本化、不可变——"口径定义即数据"
 * （决策簿：口径包=商业资产，不做通用 BI）。
 *
 * 与 engine-flow 配置同一哲学：定义经 defineMetricDefinition 校验即深冻结；
 * 换一份定义即换一个口径，引擎（evaluate.ts）不含任何硬编码口径。
 */
import { deepFreeze } from './internal/freeze.js';
import { isPlainObject } from './internal/checks.js';
import { validateMetricFilter, type MetricFilter } from './filter.js';

export const METRIC_DEFINITION_SCHEMA_VERSION = 1 as const;
export type MetricDefinitionSchemaVersion = typeof METRIC_DEFINITION_SCHEMA_VERSION;

/**
 * 时间口径三态——对齐证据标准两时间列与事件 occurredAt（evidence-columns.v1.md + BusinessEvent）
 * （architecture/contracts/evidence-columns.v1.md；business-core EvidenceColumns）：
 * - `business`   → business_time（业务时间，可补录；**缺省回落 occurredAt**）
 * - `available`  → available_time（对外可见口径，对账/连接器读取锚；缺省回落 occurredAt）
 * - `occurred`   → occurredAt（事实发生时刻，事件行必有列）
 *
 * 回落取舍：证据列两时间列均可空（补录/入账时补），行缺失时以 occurredAt 兜底，
 * 保证任一口径下每行都有可比较时间锚（详见 README「时间口径」）。
 */
export type TimeBasis = 'business' | 'available' | 'occurred';
export const TIME_BASES: readonly TimeBasis[] = ['business', 'available', 'occurred'];

/** 聚合语义全集（通用词；无表达式聚合、无自定义函数）。 */
export type AggregationKind = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'distinct-count';
const AGGREGATIONS: readonly AggregationKind[] = ['sum', 'count', 'avg', 'min', 'max', 'distinct-count'];

/** 数值格式：纯展示提示（单位/小数位），不参与计算、不是图表定义。 */
export interface NumberFormat {
  readonly unit?: string;
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
}

/**
 * 维度：分组字段引用 + 可选值域限制。
 * filter 语义 = 该维度的**值域声明**：不过滤的贡献行被整行剔除（等价于与根过滤 AND，
 * 但跟随维度 authored，见 README「维度过滤」）。
 */
export interface DimensionDef {
  /** 行字段引用（dot-path；分组值须为标量，非标量归 null 组） */
  readonly field: string;
  /** 展示名（缺省取 field） */
  readonly label?: string;
  /** 维度值域限制（纯数据谓词） */
  readonly filter?: MetricFilter;
}

/** 度量：聚合语义 + 字段引用 + 数值格式。count 数行数（不允许带 field）。 */
export interface MeasureDef {
  /** kebab-case，定义内唯一 */
  readonly measureId: string;
  readonly aggregation: AggregationKind;
  /** 聚合字段；count 不允许声明，其余聚合必填 */
  readonly field?: string;
  readonly format?: NumberFormat;
}

export interface MetricDefinition {
  readonly schemaVersion: MetricDefinitionSchemaVersion;
  /** kebab-case，包内唯一（演进 = 新版本号，同 id 不同版本不并存于一个口径包） */
  readonly metricId: string;
  /** 口径版本，整数 >= 1 */
  readonly version: number;
  readonly display: string;
  readonly description?: string;
  readonly timeBasis: TimeBasis;
  /** 数据源种类（kebab-case；由 MetricSource 按名绑定，如 labor-entries） */
  readonly sourceKind: string;
  /** 维度集：空 = 无维度总量口径（结果恒一行） */
  readonly dimensions: readonly DimensionDef[];
  /** 度量集：至少一个 */
  readonly measures: readonly MeasureDef[];
  /** 根过滤：贡献行谓词（与维度过滤、查询过滤 AND） */
  readonly filter?: MetricFilter;
}

const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_PATTERN = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$/;

function assertKebab(value: unknown, where: string, max = 64): string {
  if (typeof value !== 'string' || !KEBAB_PATTERN.test(value) || value.length > max) {
    throw new Error(`${where}: expected kebab-case (max ${max} chars), got "${String(value)}"`);
  }
  return value;
}

function assertFieldRef(value: unknown, where: string): string {
  if (typeof value !== 'string' || !FIELD_PATTERN.test(value) || value.length > 128) {
    throw new Error(`${where}: invalid field reference "${String(value)}" (dot-path of camelCase segments, max 128 chars)`);
  }
  return value;
}

function assertNumberFormat(raw: unknown, where: string): NumberFormat {
  if (!isPlainObject(raw)) {
    throw new Error(`${where}: expected a plain object`);
  }
  const { unit, minimumFractionDigits, maximumFractionDigits } = raw;
  if (unit !== undefined && (typeof unit !== 'string' || unit.length === 0 || unit.length > 16)) {
    throw new Error(`${where}.unit: expected a non-empty string (max 16 chars)`);
  }
  for (const [name, digits] of [
    ['minimumFractionDigits', minimumFractionDigits],
    ['maximumFractionDigits', maximumFractionDigits],
  ] as const) {
    if (
      digits !== undefined &&
      (!Number.isSafeInteger(digits as number) || (digits as number) < 0 || (digits as number) > 12)
    ) {
      throw new Error(`${where}.${name}: expected an integer in 0..12`);
    }
  }
  const format: NumberFormat = {
    ...(unit !== undefined ? { unit: unit as string } : {}),
    ...(minimumFractionDigits !== undefined ? { minimumFractionDigits: minimumFractionDigits as number } : {}),
    ...(maximumFractionDigits !== undefined ? { maximumFractionDigits: maximumFractionDigits as number } : {}),
  };
  return deepFreeze(format);
}

/**
 * 校验并固化一份口径定义：结构合法即深冻结返回（不可变快照，ADR-0003 #4）。
 * 非法定义立即抛错（fail-fast），不产生半合法引擎输入。
 * 幂等：已冻结的合法定义再次输入，产出等价冻结结果（版本不变性测试）。
 */
export function defineMetricDefinition(raw: unknown): MetricDefinition {
  if (!isPlainObject(raw)) {
    throw new Error('invalid metric definition: expected a plain object');
  }
  const { schemaVersion, metricId, version, display, description, timeBasis, sourceKind, dimensions, measures, filter } =
    raw;

  if (schemaVersion !== METRIC_DEFINITION_SCHEMA_VERSION) {
    throw new Error(
      `invalid schemaVersion: expected ${String(METRIC_DEFINITION_SCHEMA_VERSION)}, got ${String(schemaVersion)}`,
    );
  }
  assertKebab(metricId, 'invalid metricId');
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error(`invalid version: expected an integer >= 1, got ${String(version)}`);
  }
  if (typeof display !== 'string' || display.length === 0 || display.length > 128) {
    throw new Error(`invalid display: expected a non-empty string (max 128 chars), got "${String(display)}"`);
  }
  if (description !== undefined && (typeof description !== 'string' || description.length === 0 || description.length > 2000)) {
    throw new Error('invalid description: expected a non-empty string (max 2000 chars)');
  }
  if (typeof timeBasis !== 'string' || !TIME_BASES.includes(timeBasis as TimeBasis)) {
    throw new Error(`invalid timeBasis: expected one of ${TIME_BASES.join('/')}, got "${String(timeBasis)}"`);
  }
  assertKebab(sourceKind, 'invalid sourceKind');

  if (!Array.isArray(dimensions)) {
    throw new Error('invalid dimensions: expected an array (may be empty for a dimensionless total)');
  }
  const seenDimensionFields = new Set<string>();
  const normalizedDimensions = dimensions.map((dimension, index) => {
    if (!isPlainObject(dimension)) {
      throw new Error(`invalid dimension #${index}: expected a plain object`);
    }
    const field = assertFieldRef(dimension.field, `invalid dimension #${index}`);
    if (seenDimensionFields.has(field)) {
      throw new Error(`invalid dimensions: duplicate dimension field "${field}"`);
    }
    seenDimensionFields.add(field);
    if (dimension.label !== undefined && (typeof dimension.label !== 'string' || dimension.label.length === 0 || dimension.label.length > 64)) {
      throw new Error(`invalid dimension "${field}": label must be a non-empty string (max 64 chars)`);
    }
    return deepFreeze({
      field,
      ...(dimension.label !== undefined ? { label: dimension.label } : {}),
      ...(dimension.filter !== undefined ? { filter: validateMetricFilter(dimension.filter) } : {}),
    });
  });

  if (!Array.isArray(measures) || measures.length === 0) {
    throw new Error('invalid measures: expected a non-empty array');
  }
  const seenMeasureIds = new Set<string>();
  const normalizedMeasures = measures.map((measure, index) => {
    if (!isPlainObject(measure)) {
      throw new Error(`invalid measure #${index}: expected a plain object`);
    }
    const measureId = assertKebab(measure.measureId, `invalid measure #${index} measureId`);
    if (seenMeasureIds.has(measureId)) {
      throw new Error(`invalid measures: duplicate measureId "${measureId}"`);
    }
    seenMeasureIds.add(measureId);
    if (!AGGREGATIONS.includes(measure.aggregation as AggregationKind)) {
      throw new Error(
        `invalid measure "${measureId}": aggregation must be one of ${AGGREGATIONS.join('/')}, got "${String(measure.aggregation)}"`,
      );
    }
    const aggregation = measure.aggregation as AggregationKind;
    if (aggregation === 'count' && measure.field !== undefined) {
      throw new Error(`invalid measure "${measureId}": count aggregates row count and must not declare field`);
    }
    if (aggregation !== 'count' && measure.field === undefined) {
      throw new Error(`invalid measure "${measureId}": ${aggregation} requires field`);
    }
    if (measure.field !== undefined) {
      assertFieldRef(measure.field, `invalid measure "${measureId}" field`);
    }
    return deepFreeze({
      measureId,
      aggregation,
      ...(measure.field !== undefined ? { field: measure.field } : {}),
      ...(measure.format !== undefined ? { format: assertNumberFormat(measure.format, `invalid measure "${measureId}" format`) } : {}),
    });
  });

  return deepFreeze<MetricDefinition>({
    schemaVersion: schemaVersion as MetricDefinitionSchemaVersion,
    metricId: metricId as string,
    version: version as number,
    display: display as string,
    ...(description !== undefined ? { description: description as string } : {}),
    timeBasis: timeBasis as TimeBasis,
    sourceKind: sourceKind as string,
    dimensions: Object.freeze(normalizedDimensions) as readonly DimensionDef[],
    measures: Object.freeze(normalizedMeasures) as readonly MeasureDef[],
    ...(filter !== undefined ? { filter: validateMetricFilter(filter) } : {}),
  });
}
