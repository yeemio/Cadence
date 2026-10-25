/**
 * 权限码（视图模型层）。
 *
 * 语义（ADR-0009 参照定案，代码从零写）：精确字符串匹配——没有前缀/后缀通配，
 * 唯一例外是 ADMIN_PERMISSION 的整体 bypass。
 * 词汇纪律（ADR-0010）：权限码用"通用模块:动词"形式（如 workorder:access），
 * 行业专属词不得入码。
 */
import type { Brand } from '@smes/business-core';

/** 品牌化权限码：与任意字符串互不隐式赋值。 */
export type PermissionCode = Brand<string, 'PermissionCode'>;

/** 管理员通配权限码：持有者绕过全部权限过滤（admin bypass）。 */
export const ADMIN_PERMISSION: PermissionCode = '*' as PermissionCode;

/** 构造权限码：非空、无空白、1~128 字符，否则抛错。 */
export function permissionCode(value: string): PermissionCode {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /\s/.test(value)
  ) {
    throw new Error(`invalid permission code: ${JSON.stringify(value)}`);
  }
  return value as PermissionCode;
}

/** 未知值是否为形状合法的权限码（不校验是否属于已知码表）。 */
export function isPermissionCode(value: unknown): value is PermissionCode {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\s/.test(value)
  );
}

/** 权限集合是否含管理员通配码。 */
export function isAdminPermissions(permissions: readonly PermissionCode[]): boolean {
  return permissions.includes(ADMIN_PERMISSION);
}

/** 权限集合的只读 Set 视图（过滤热路径用）。 */
export function permissionSetOf(permissions: readonly PermissionCode[]): ReadonlySet<PermissionCode> {
  return new Set(permissions);
}
