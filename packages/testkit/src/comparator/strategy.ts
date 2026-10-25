/**
 * 比对策略（夹具 `compare` 块的类型；语义默认值写明，供夹具作者依赖）。
 *
 * 默认语义（未声明任何策略时）：
 *   - 数值/字符串/布尔/null：精确相等；对象键序不参与相等；数组按索引有序比较
 *   - 无忽略路径、无形状断言、无时间戳容差（ISO 串也按字面精确比较）
 *
 * 显式策略：
 *   - tolerance.numeric：|实际-期望| <= absolute 或 |实际-期望| <= relative*|期望|
 *     （相对容差锚定期望值；期望为 0 时相对容差退化为 0，需配 absolute）
 *   - ignore：路径模式集（glob 语义见 paths.ts），命中即整体跳过（两侧都不比）
 *   - shape：路径模式 → 期望的 JSON 类型名；只断言实际值类型，不比值
 *     （随机值字段：token/流水号/时间戳等的"只比形状"）
 *   - arrays：数组自身路径（不含索引，如 `bySource`）→ 匹配规则
 *     （ordered = 默认按索引；unordered = 按 key 字段配对无序比较，
 *      无 key 时按元素值多集合匹配；仅精确路径命中生效）
 *   - timestamps.toleranceMs：两侧均为 ISO-8601 字符串时按时刻差比较
 *     （|实际时刻-期望时刻| <= toleranceMs；Z/+00:00 等表示差异归一为时刻）。
 *     toleranceMs 缺省 0 = 字面精确。
 */

/** JSON 类型名（shape 断言用；integer 是 number 的整数子型）。 */
export type JsonTypeName = 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';

export interface NumericTolerance {
  readonly relative?: number;
  readonly absolute?: number;
}

export interface ArrayRule {
  readonly match: 'ordered' | 'unordered';
  readonly key?: string;
}

export interface CompareStrategy {
  readonly tolerance?: {
    readonly numeric?: NumericTolerance;
  };
  readonly ignore?: readonly string[];
  readonly shape?: Readonly<Record<string, JsonTypeName>>;
  readonly arrays?: Readonly<Record<string, ArrayRule>>;
  readonly timestamps?: {
    readonly toleranceMs?: number;
  };
}

/** 实际 JSON 值的类型名（shape 断言的判定依据）。 */
export function jsonTypeName(value: unknown): JsonTypeName {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'string':
      return 'string';
    default:
      return 'object';
  }
}

/** shape 断言：声明类型为 number 时整数也满足；声明 integer 时非整数不满足。 */
export function matchesShapeType(value: unknown, declared: JsonTypeName): boolean {
  const actual = jsonTypeName(value);
  if (declared === actual) {
    return true;
  }
  return declared === 'number' && actual === 'integer';
}
