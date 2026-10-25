/**
 * 不可变快照纪律（ADR-0003 #4，与 business-core / engine-flow 同一纪律）。
 *
 * business-core 的 deepFreeze 位于其 internal/、未导出（纯域包不外露内部件），
 * 本包按"图纸对齐，零件各造"（ADR-0003）在包内镜像同一实现；
 * 冻结语义与 business-core/src/internal/freeze.ts 行为等价。
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<string | symbol, unknown>)[key]);
    }
  }
  return value;
}
