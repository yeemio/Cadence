/** 包内共享的形状判别（fail-fast 校验用，不外露）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
