/**
 * 口径过滤谓词：纯数据、可序列化（比较 / 在集合内 / 区间 / 与或非组合）。
 *
 * 设计边界（ADR-0010 自证）：谓词是**数据不是表达式**——无函数引用、无 SQL 片段、
 * 无求值器注入；可整体进 JSON、随口径定义版本化。求值器 evaluateMetricFilter 是
 * 本包唯一的纯函数实现，端口适配器（business-store 侧下推）复用同一语义。
 *
 * 字段引用：dot-path（如 `payload.quantity`、`dispatchId`），段为 camelCase；
 * 缺失字段读作 null。排序比较仅在同族类型间成立（number×number / string×string，
 * ISO 8601 时间串字典序即时间序）；跨族比较不抛错、判不匹配（false）。
 */
import { deepFreeze } from './internal/freeze.js';
import { isPlainObject } from './internal/checks.js';

export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** 谓词可携带的标量值（可 JSON 序列化；null 表示"字段缺失/为空"）。 */
export type FilterValue = string | number | boolean | null;

export interface MetricCompareFilter {
  readonly kind: 'compare';
  readonly op: FilterOperator;
  readonly field: string;
  readonly value: FilterValue;
}

export interface MetricInSetFilter {
  readonly kind: 'in-set';
  readonly field: string;
  readonly values: readonly FilterValue[];
}

export interface MetricRangeFilter {
  readonly kind: 'range';
  readonly field: string;
  /** 含下界（字符串按字典序） */
  readonly min?: string | number;
  /** 含上界 */
  readonly max?: string | number;
}

export interface MetricAndFilter {
  readonly kind: 'and';
  readonly parts: readonly MetricFilter[];
}

export interface MetricOrFilter {
  readonly kind: 'or';
  readonly parts: readonly MetricFilter[];
}

export interface MetricNotFilter {
  readonly kind: 'not';
  readonly inner: MetricFilter;
}

export type MetricFilter =
  | MetricCompareFilter
  | MetricInSetFilter
  | MetricRangeFilter
  | MetricAndFilter
  | MetricOrFilter
  | MetricNotFilter;

const FIELD_PATTERN = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$/;
const OPERATORS: readonly FilterOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];

function isFilterValue(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function assertField(field: unknown, where: string): string {
  if (typeof field !== 'string' || !FIELD_PATTERN.test(field) || field.length > 128) {
    throw new Error(`${where}: invalid field "${String(field)}" (expected dot-path of camelCase segments, max 128 chars)`);
  }
  return field;
}

function assertValue(value: unknown, where: string): FilterValue {
  if (!isFilterValue(value)) {
    throw new Error(`${where}: values must be string / finite number / boolean / null (serializable)`);
  }
  return value;
}

/**
 * 校验并规范化一份过滤谓词：结构合法即按固定键序重建并深冻结返回。
 * 已通过校验的冻结谓词再次输入亦幂等（同输入同输出，见版本不变性测试）。
 */
export function validateMetricFilter(raw: unknown): MetricFilter {
  if (!isPlainObject(raw)) {
    throw new Error('invalid metric filter: expected a plain object');
  }
  switch (raw.kind) {
    case 'compare': {
      const { op, field, value } = raw;
      if (!OPERATORS.includes(op as FilterOperator)) {
        throw new Error(`compare filter: invalid op "${String(op)}" (expected one of ${OPERATORS.join('/')})`);
      }
      return deepFreeze({
        kind: 'compare' as const,
        op: op as FilterOperator,
        field: assertField(field, 'compare filter'),
        value: assertValue(value, 'compare filter'),
      });
    }
    case 'in-set': {
      const { field, values } = raw;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error('in-set filter: values must be a non-empty array');
      }
      for (const value of values) {
        assertValue(value, 'in-set filter');
      }
      return deepFreeze({
        kind: 'in-set' as const,
        field: assertField(field, 'in-set filter'),
        values: Object.freeze(values.slice()) as readonly FilterValue[],
      });
    }
    case 'range': {
      const { field, min, max } = raw;
      if (min === undefined && max === undefined) {
        throw new Error('range filter: at least one of min / max is required');
      }
      for (const bound of [min, max]) {
        if (
          bound !== undefined &&
          !(typeof bound === 'string' || (typeof bound === 'number' && Number.isFinite(bound)))
        ) {
          throw new Error('range filter: bounds must be string or finite number');
        }
      }
      return deepFreeze({
        kind: 'range' as const,
        field: assertField(field, 'range filter'),
        ...(min !== undefined ? { min: min as string | number } : {}),
        ...(max !== undefined ? { max: max as string | number } : {}),
      });
    }
    case 'and':
    case 'or': {
      const { parts } = raw;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error(`${String(raw.kind)} filter: parts must be a non-empty array`);
      }
      return deepFreeze({
        kind: raw.kind as 'and' | 'or',
        parts: Object.freeze(parts.map((part) => validateMetricFilter(part))) as readonly MetricFilter[],
      });
    }
    case 'not': {
      if (raw.inner === undefined) {
        throw new Error('not filter: inner is required');
      }
      return deepFreeze({ kind: 'not' as const, inner: validateMetricFilter(raw.inner) });
    }
    default:
      throw new Error(`invalid metric filter kind: "${String(raw.kind)}"`);
  }
}

/** 读取行字段（dot-path）；缺失 / 中途穿出对象 / 穿进数组 → null。 */
export function readRowField(row: Readonly<Record<string, unknown>>, field: string): unknown {
  let current: unknown = row;
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

function strictEquals(expected: FilterValue, actual: unknown): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  if (actual === null || actual === undefined) {
    return false;
  }
  return typeof actual === typeof expected && actual === expected;
}

function compareOrdered(op: 'gt' | 'gte' | 'lt' | 'lte', value: FilterValue, actual: unknown): boolean {
  if (typeof value === 'number' && typeof actual === 'number') {
    switch (op) {
      case 'gt':
        return actual > value;
      case 'gte':
        return actual >= value;
      case 'lt':
        return actual < value;
      case 'lte':
        return actual <= value;
    }
  }
  if (typeof value === 'string' && typeof actual === 'string') {
    switch (op) {
      case 'gt':
        return actual > value;
      case 'gte':
        return actual >= value;
      case 'lt':
        return actual < value;
      case 'lte':
        return actual <= value;
    }
  }
  return false;
}

function inRange(actual: unknown, min: string | number | undefined, max: string | number | undefined): boolean {
  if (typeof actual === 'number') {
    if (typeof min === 'number' && actual < min) return false;
    if (typeof max === 'number' && actual > max) return false;
    if (typeof min === 'string' || typeof max === 'string') return false;
    return true;
  }
  if (typeof actual === 'string') {
    if (typeof min === 'string' && actual < min) return false;
    if (typeof max === 'string' && actual > max) return false;
    if (typeof min === 'number' || typeof max === 'number') return false;
    return true;
  }
  return false;
}

/** 谓词求值（纯函数）：row 为任意事实/事件行（含保留时间列）。 */
export function evaluateMetricFilter(filter: MetricFilter, row: Readonly<Record<string, unknown>>): boolean {
  switch (filter.kind) {
    case 'compare': {
      const actual = readRowField(row, filter.field);
      switch (filter.op) {
        case 'eq':
          return strictEquals(filter.value, actual);
        case 'ne':
          return !strictEquals(filter.value, actual);
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
          return compareOrdered(filter.op, filter.value, actual);
      }
    }
    case 'in-set': {
      const actual = readRowField(row, filter.field);
      return filter.values.some((value) => strictEquals(value, actual));
    }
    case 'range': {
      const actual = readRowField(row, filter.field);
      return inRange(actual, filter.min, filter.max);
    }
    case 'and':
      return filter.parts.every((part) => evaluateMetricFilter(part, row));
    case 'or':
      return filter.parts.some((part) => evaluateMetricFilter(part, row));
    case 'not':
      return !evaluateMetricFilter(filter.inner, row);
  }
}
