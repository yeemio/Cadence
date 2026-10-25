/** 运行时收窄/校验工具（internal：不导出包外）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`integration-im: ${label} must be a non-empty string`);
  }
  return value;
}

export function isSecretRefShape(value: unknown): value is { kind: 'secret-ref'; ref: string } {
  return isRecord(value) && value['kind'] === 'secret-ref' && typeof value['ref'] === 'string' && value['ref'].length > 0;
}
