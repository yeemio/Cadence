/** 不可变快照纪律（ADR-0003 #4）：信封与事件在构造时深冻结。 */

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<string | symbol, unknown>)[key]);
    }
  }
  return value;
}
