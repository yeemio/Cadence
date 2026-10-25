/**
 * 组织管理视图模型（M1 增量 3-D）：类型 / 构造器 / 权限码。
 *
 * 取舍：本层只做"响应形状解析 + 请求载荷构造"（纯函数，测试钉死），
 * 不含 fetch 与 URL——那是 apps/web 装配层的事（薄数据层经 apiClient 注入
 * Bearer 会话头）。权限码常量与后端 org 端点一一对应（ADR-0010 通用词）。
 */
import { isPermissionCode, permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 组织管理权限码（与 apps/server org 端点的 @RequirePermission 一一对应）。 */
export const ORG_USER_READ: PermissionCode = permissionCode('user:read');
export const ORG_USER_WRITE: PermissionCode = permissionCode('user:write');
export const ORG_ROLE_READ: PermissionCode = permissionCode('role:read');
export const ORG_ROLE_WRITE: PermissionCode = permissionCode('role:write');

/** 用户列表行视图（服务端 UserAccount 的 UI 投影：不透出租户与时间细节）。 */
export interface OrgUserView {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly active: boolean;
}

/** 角色视图：元数据 + 已授权限码（管理页的授权编辑对象）。 */
export interface OrgRoleView {
  readonly name: string;
  readonly displayName: string;
  readonly permissions: readonly PermissionCode[];
}

export class OrgViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgViewError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OrgViewError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OrgViewError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalPermission(value: unknown, field: string): PermissionCode {
  if (typeof value !== 'string' || !isPermissionCode(value)) {
    throw new OrgViewError(`字段 '${field}' 不是合法权限码形状：${JSON.stringify(value)}`);
  }
  return permissionCode(value);
}

/** 解析单个用户视图（POST /org/users 响应）。 */
export function parseOrgUser(input: unknown): OrgUserView {
  const record = requireObject(input, '用户对象');
  return {
    id: requireString(record['id'], 'id'),
    username: requireString(record['username'], 'username'),
    displayName: requireString(record['displayName'], 'displayName'),
    active: record['active'] === true,
  };
}

/** 解析 GET /org/users 响应 { users: [...] }。 */
export function parseOrgUsersResponse(input: unknown): readonly OrgUserView[] {
  const record = requireObject(input, '用户列表响应');
  const users = record['users'];
  if (!Array.isArray(users)) {
    throw new OrgViewError("用户列表响应缺 'users' 数组");
  }
  return users.map(parseOrgUser);
}

/** 解析 GET /org/roles 响应 { roles: [...] }。 */
export function parseOrgRolesResponse(input: unknown): readonly OrgRoleView[] {
  const record = requireObject(input, '角色列表响应');
  const roles = record['roles'];
  if (!Array.isArray(roles)) {
    throw new OrgViewError("角色列表响应缺 'roles' 数组");
  }
  return roles.map((role) => {
    const row = requireObject(role, '角色对象');
    const permissions = row['permissions'];
    if (!Array.isArray(permissions)) {
      throw new OrgViewError("角色对象缺 'permissions' 数组");
    }
    return {
      name: requireString(row['name'], 'name'),
      displayName: requireString(row['displayName'], 'displayName'),
      permissions: permissions.map((code) => optionalPermission(code, 'permissions')),
    };
  });
}

/** 构造 POST /org/users 载荷（输入裁剪 + 基本校验，服务端仍全量校验）。 */
export function buildCreateUserPayload(input: {
  readonly username: string;
  readonly displayName: string;
}): { username: string; displayName: string } {
  return {
    username: requireString(input.username, 'username'),
    displayName: requireString(input.displayName, 'displayName'),
  };
}

/** 构造 POST /org/roles 载荷。 */
export function buildCreateRolePayload(input: {
  readonly name: string;
  readonly displayName: string;
}): { name: string; displayName: string } {
  return {
    name: requireString(input.name, 'name'),
    displayName: requireString(input.displayName, 'displayName'),
  };
}

/** 构造 PUT /org/roles/:name/permissions 载荷（逐码校验形状，剔除空白项）。 */
export function buildPermissionCodesPayload(codes: readonly string[]): { permissions: string[] } {
  const permissions = codes
    .map((code) => code.trim())
    .filter((code) => code.length > 0)
    .map((code) => {
      if (!isPermissionCode(code)) {
        throw new OrgViewError(`权限码 '${code}' 形状非法（<环节>:<动作>，无空白）`);
      }
      return code;
    });
  return { permissions: [...new Set(permissions)] };
}

/** 构造 PUT /org/users/:id/roles 载荷（角色名单一化）。 */
export function buildRoleNamesPayload(names: readonly string[]): { roles: string[] } {
  const roles = names
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      if (/\s/.test(name)) {
        throw new OrgViewError(`角色名 '${name}' 含空白`);
      }
      return name;
    });
  return { roles: [...new Set(roles)] };
}
