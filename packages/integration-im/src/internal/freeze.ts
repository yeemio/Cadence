/**
 * 深冻结（对齐 business-core internal/freeze 纪律：ADR-0003 #4 构造即冻结）。
 * 只用于本包自有的纯数据结构；外部引用（如回调 raw 原文）不进本函数，保持宿主证据原样。
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, object>)) {
      deepFreeze((value as Record<string, object>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
