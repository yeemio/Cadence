/**
 * Comparator——字段级深度比对（纯函数，对账框架的核心件，ADR-0002 #3）。
 *
 * 输入：期望值（reference）+ 实际值（target 响应）+ 比对策略。
 * 输出：diff 列表，每条精确到路径（`a.b[2].c: 期望 5 实际 6`）。
 * 策略语义与默认值见 strategy.ts 文件头。
 */
import {
  canonicalStringify,
  hasPath,
  isPlainObject,
  parsePath,
  pathMatches,
  pathMatchesAny,
  renderPath,
} from '../paths.js';
import { matchesShapeType, type CompareStrategy, type JsonTypeName } from './strategy.js';

export type DiffKind =
  | 'missing' // 期望有、实际无
  | 'unexpected' // 实际有、期望无
  | 'type' // 类型不同
  | 'value' // 值不同（无容差适用）
  | 'tolerance' // 数值在容差外
  | 'timestamp' // 时间戳在容差外
  | 'shape' // 形状断言不满足
  | 'unmatched'; // 无序数组无法配对的元素

export interface DiffEntry {
  readonly kind: DiffKind;
  readonly path: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly note?: string;
}

const MAX_VALUE_LENGTH = 120;

/** 渲染值（截断长串，保证 diff 行可读）。 */
export function renderValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = JSON.stringify(value);
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  if (text.length > MAX_VALUE_LENGTH) {
    return `${text.slice(0, MAX_VALUE_LENGTH)}…`;
  }
  return text;
}

const ISO_LIKE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** 严格 ISO-8601 日期时间串 → epoch 毫秒；否则 undefined。 */
function asEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_LIKE.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface NormalizedStrategy {
  readonly ignore: readonly string[];
  readonly shape: readonly [string, JsonTypeName][];
  readonly arrays: Readonly<Record<string, { match: 'ordered' | 'unordered'; key?: string }>>;
  readonly relative: number;
  readonly absolute: number;
  readonly timestampToleranceMs: number;
}

function normalizeStrategy(strategy: CompareStrategy): NormalizedStrategy {
  return {
    ignore: strategy.ignore ?? [],
    shape: Object.entries(strategy.shape ?? {}),
    arrays: strategy.arrays ?? {},
    relative: strategy.tolerance?.numeric?.relative ?? 0,
    absolute: strategy.tolerance?.numeric?.absolute ?? 0,
    timestampToleranceMs: strategy.timestamps?.toleranceMs ?? 0,
  };
}

/** 深度比对期望与实际，返回字段级 diff（空数组 = 行为等价）。 */
export function compareJson(
  expected: unknown,
  actual: unknown,
  strategy: CompareStrategy = {},
): readonly DiffEntry[] {
  const normalized = normalizeStrategy(strategy);
  const diffs: DiffEntry[] = [];
  diffValue(expected, actual, normalized, '', diffs);
  checkConcreteShapePresence(expected, actual, normalized, diffs);
  return diffs;
}

/**
 * 形状存在性后置检查：不含通配符的 shape 声明是"实际侧必须有该字段"——
 * 两侧都没有（录制脱敏后参考缺字段、实现也漏了字段）时 diffObject 不会
 * 走到该路径，这里补报 shape diff（实际缺字段）。
 */
function checkConcreteShapePresence(
  expected: unknown,
  actual: unknown,
  s: NormalizedStrategy,
  diffs: DiffEntry[],
): void {
  for (const [pattern, declared] of s.shape) {
    if (pattern.includes('*')) {
      continue; // 通配模式是条件断言（命中才检查存在性）
    }
    const segments = parsePath(pattern);
    if (!hasPath(actual, segments) && !hasPath(expected, segments)) {
      diffs.push({ kind: 'shape', path: pattern, note: `期望形状 ${declared}，实际缺字段` });
    }
  }
}

function diffValue(
  expected: unknown,
  actual: unknown,
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  // 忽略路径：整体跳过（两侧都不比）
  if (path !== '' && pathMatchesAny(path, s.ignore)) {
    return;
  }
  // 形状断言：只断言实际值类型，期望值不参与
  const shapeRule = findShapeRule(path, s);
  if (shapeRule !== undefined) {
    checkShape(actual, shapeRule, path, diffs);
    return;
  }

  // null / 类型分派
  if (expected === null || actual === null) {
    if (expected !== actual) {
      diffs.push({ kind: 'type', path, expected: renderValue(expected), actual: renderValue(actual) });
    }
    return;
  }
  const expectedKind = kindOf(expected);
  const actualKind = kindOf(actual);
  if (expectedKind !== actualKind) {
    diffs.push({
      kind: 'type',
      path,
      expected: `${renderValue(expected)}（${expectedKind}）`,
      actual: `${renderValue(actual)}（${actualKind}）`,
    });
    return;
  }
  switch (expectedKind) {
    case 'number':
      diffNumber(expected as number, actual as number, s, path, diffs);
      return;
    case 'string':
      diffString(expected as string, actual as string, s, path, diffs);
      return;
    case 'boolean':
      if (expected !== actual) {
        diffs.push({ kind: 'value', path, expected: String(expected), actual: String(actual) });
      }
      return;
    case 'array':
      diffArray(expected as unknown[], actual as unknown[], s, path, diffs);
      return;
    case 'object':
      diffObject(expected as Record<string, unknown>, actual as Record<string, unknown>, s, path, diffs);
      return;
  }
}

function kindOf(value: unknown): 'number' | 'string' | 'boolean' | 'array' | 'object' {
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    default:
      return Array.isArray(value) ? 'array' : 'object';
  }
}

function diffNumber(
  expected: number,
  actual: number,
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  if (expected === actual) {
    return;
  }
  const delta = Math.abs(actual - expected);
  const allowed = Math.max(s.absolute, s.relative * Math.abs(expected));
  if (delta <= allowed) {
    return;
  }
  if (allowed === 0) {
    // 未配置容差：普通值差异（kind=value，与字符串/布尔一致）
    diffs.push({ kind: 'value', path, expected: String(expected), actual: String(actual) });
    return;
  }
  diffs.push({
    kind: 'tolerance',
    path,
    expected: String(expected),
    actual: String(actual),
    note: `|Δ|=${formatNumber(delta)} > 容差 ${formatNumber(allowed)}`,
  });
}

/** 消除浮点噪声的数字显示（6 位有效数字内取短表示）。 */
function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function diffString(
  expected: string,
  actual: string,
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  if (expected === actual) {
    return;
  }
  const expectedMs = asEpochMs(expected);
  const actualMs = asEpochMs(actual);
  if (expectedMs !== undefined && actualMs !== undefined) {
    const delta = Math.abs(actualMs - expectedMs);
    if (delta <= s.timestampToleranceMs) {
      return;
    }
    diffs.push({
      kind: 'timestamp',
      path,
      expected,
      actual,
      note: `时刻差 ${delta}ms > 容差 ${s.timestampToleranceMs}ms`,
    });
    return;
  }
  diffs.push({ kind: 'value', path, expected: renderValue(expected), actual: renderValue(actual) });
}

function diffObject(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  for (const key of Object.keys(expected)) {
    const keyPath = childPath(path, key);
    if (pathMatchesAny(keyPath, s.ignore)) {
      continue;
    }
    const shapeRule = findShapeRule(keyPath, s);
    if (!(key in actual)) {
      // 形状断言声明的路径（录制脱敏后参考缺该字段是常态）：缺字段 = 形状不满足
      if (shapeRule !== undefined) {
        diffs.push({ kind: 'shape', path: keyPath, note: `期望形状 ${shapeRule}，实际缺字段` });
      } else {
        diffs.push({
          kind: 'missing',
          path: keyPath,
          expected: renderValue(expected[key]),
          note: '期望有、实际缺',
        });
      }
      continue;
    }
    if (shapeRule !== undefined) {
      checkShape(actual[key], shapeRule, keyPath, diffs);
      continue; // 形状断言路径不比值（随机值/时间戳等）
    }
    diffValue(expected[key], actual[key], s, keyPath, diffs);
  }
  for (const key of Object.keys(actual)) {
    if (key in expected) {
      continue;
    }
    const keyPath = childPath(path, key);
    if (pathMatchesAny(keyPath, s.ignore)) {
      continue;
    }
    const shapeRule = findShapeRule(keyPath, s);
    if (shapeRule !== undefined) {
      // 参考被脱敏、实际有值：只做形状断言，不报"多出字段"
      checkShape(actual[key], shapeRule, keyPath, diffs);
      continue;
    }
    diffs.push({
      kind: 'unexpected',
      path: keyPath,
      actual: renderValue(actual[key]),
      note: '实际有、期望无',
    });
  }
}

/** 命中 path 的第一条形状声明（无 → undefined）。 */
function findShapeRule(path: string, s: NormalizedStrategy): JsonTypeName | undefined {
  for (const [pattern, declared] of s.shape) {
    if (pathMatches(path, pattern)) {
      return declared;
    }
  }
  return undefined;
}

function checkShape(
  actual: unknown,
  declared: JsonTypeName,
  path: string,
  diffs: DiffEntry[],
): void {
  if (!matchesShapeType(actual, declared)) {
    diffs.push({
      kind: 'shape',
      path,
      actual: renderValue(actual),
      note: `期望形状 ${declared}`,
    });
  }
}

function diffArray(
  expected: unknown[],
  actual: unknown[],
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  const rule = s.arrays[path];
  if (rule === undefined || rule.match === 'ordered') {
    diffArrayOrdered(expected, actual, s, path, diffs);
    return;
  }
  diffArrayUnordered(expected, actual, s, path, rule.key, diffs);
}

function diffArrayOrdered(
  expected: unknown[],
  actual: unknown[],
  s: NormalizedStrategy,
  path: string,
  diffs: DiffEntry[],
): void {
  const shared = Math.min(expected.length, actual.length);
  for (let i = 0; i < shared; i += 1) {
    diffValue(expected[i], actual[i], s, indexChildPath(path, i), diffs);
  }
  for (let i = shared; i < expected.length; i += 1) {
    diffs.push({
      kind: 'missing',
      path: indexChildPath(path, i),
      expected: renderValue(expected[i]),
      note: '期望有、实际缺（数组更短）',
    });
  }
  for (let i = shared; i < actual.length; i += 1) {
    diffs.push({
      kind: 'unexpected',
      path: indexChildPath(path, i),
      actual: renderValue(actual[i]),
      note: '实际有、期望无（数组更长）',
    });
  }
}

/**
 * 无序数组匹配：
 *   - 有 key：按 key 字段值分组配对（同 key 多个按出现顺序配对），
 *     配对成功递归比对其余字段；无法配对 → unmatched
 *   - 无 key：按元素值多集合匹配（规范化序列化后相等即配对）
 */
function diffArrayUnordered(
  expected: unknown[],
  actual: unknown[],
  s: NormalizedStrategy,
  path: string,
  key: string | undefined,
  diffs: DiffEntry[],
): void {
  if (key === undefined) {
    diffArrayUnorderedByValue(expected, actual, path, diffs);
    return;
  }
  const expectedGroups = groupByKey(expected, key);
  const actualGroups = groupByKey(actual, key);
  for (const [keyValue, expectedIndexes] of expectedGroups) {
    const actualIndexes = actualGroups.get(keyValue);
    if (actualIndexes === undefined) {
      for (const i of expectedIndexes) {
        diffs.push({
          kind: 'unmatched',
          path: indexChildPath(path, i),
          expected: renderValue(expected[i]),
          note: `实际侧无 key ${keyValue} 的元素`,
        });
      }
      continue;
    }
    const pairs = Math.min(expectedIndexes.length, actualIndexes.length);
    for (let n = 0; n < pairs; n += 1) {
      const i = expectedIndexes[n] as number;
      const j = actualIndexes[n] as number;
      diffValue(expected[i], actual[j], s, `${indexChildPath(path, i)}→[${j}]`, diffs);
    }
    for (let n = pairs; n < expectedIndexes.length; n += 1) {
      const i = expectedIndexes[n] as number;
      diffs.push({
        kind: 'unmatched',
        path: indexChildPath(path, i),
        expected: renderValue(expected[i]),
        note: `key ${keyValue} 期望多于实际`,
      });
    }
    for (let n = pairs; n < actualIndexes.length; n += 1) {
      const j = actualIndexes[n] as number;
      diffs.push({
        kind: 'unexpected',
        path: indexChildPath(path, j),
        actual: renderValue(actual[j]),
        note: `key ${keyValue} 实际多于期望`,
      });
    }
  }
  for (const [keyValue, actualIndexes] of actualGroups) {
    if (!expectedGroups.has(keyValue)) {
      for (const j of actualIndexes) {
        diffs.push({
          kind: 'unexpected',
          path: indexChildPath(path, j),
          actual: renderValue(actual[j]),
          note: `期望侧无 key ${keyValue} 的元素`,
        });
      }
    }
  }
}

function groupByKey(values: readonly unknown[], key: string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < values.length; i += 1) {
    const element = values[i];
    const keyValue = isPlainObject(element) && key in element ? element[key] : undefined;
    const groupKey = `${typeof keyValue}:${canonicalStringify(keyValue)}`;
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, [i]);
    } else {
      group.push(i);
    }
  }
  return groups;
}

function diffArrayUnorderedByValue(
  expected: unknown[],
  actual: unknown[],
  path: string,
  diffs: DiffEntry[],
): void {
  const pool = [...actual];
  for (let i = 0; i < expected.length; i += 1) {
    const canonical = canonicalStringify(expected[i]);
    const matchedIndex = pool.findIndex((candidate) => canonicalStringify(candidate) === canonical);
    if (matchedIndex === -1) {
      diffs.push({
        kind: 'unmatched',
        path: indexChildPath(path, i),
        expected: renderValue(expected[i]),
        note: '实际侧无等值元素',
      });
      continue;
    }
    pool.splice(matchedIndex, 1);
  }
  for (const leftover of pool) {
    diffs.push({
      kind: 'unexpected',
      path: `${path}[?]`,
      actual: renderValue(leftover),
      note: '实际侧多出元素（无序值匹配后剩余）',
    });
  }
}

function childPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function indexChildPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

// renderPath 供报告与测试复用（保持单一来源）
export { renderPath };
