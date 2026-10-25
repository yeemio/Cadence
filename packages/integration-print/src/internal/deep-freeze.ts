/**
 * 深冻结工具（ADR-0003 #4 不可变快照纪律）
 *
 * 仅用于纯数据对象（字符串/数字/布尔/数组/普通对象）；
 * 含函数、Date、Map 等复杂值的结构不适用（doc-definition 等载荷应保持纯数据形状）。
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
