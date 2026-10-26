/**
 * 组织管理输入解析（HTTP body / 路径参数 → 业务输入；M1 增量 3-D）。
 *
 * 与 parsePolicyRule 同一纪律：违规抛 OrgInputError（组合根映射 400），
 * 绝不静默丢弃。词汇形状与权限码段共用 PERMISSION_SEGMENT_PATTERN
 * （ADR-0010：小写通用词，无行业词）。
 */
import { UserId } from '@smes/business-core';
import { PERMISSION_SEGMENT_PATTERN } from '../core/auth/permission-code.js';
import { permissionCode, type PermissionCode } from '../core/auth/permission-code.js';
import { roleName, type RoleName } from '../core/auth/policy-store.js';
import { OrgInputError } from './org-errors.js';

const USERNAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * 口令长度上界（D-2）：auth 域既有校验（parseLoginInput）只查非空字符串、
 * 无上界先例——本域取 1..128 并登记（scrypt 对长度无要求，上界只防
 * 无意超长输入耗散哈希算力；不 trim——口令的前后空白是合法字符，
 * 与 login 侧口径一致）。
 */
const PASSWORD_MAX_LENGTH = 128;

function requirePassword(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PASSWORD_MAX_LENGTH) {
    throw new OrgInputError(
      `${what} 须为 1~${PASSWORD_MAX_LENGTH} 字符的非空字符串：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export interface CreateUserPayload {
  readonly username: string;
  readonly displayName: string;
  readonly active?: boolean;
  /**
   * 初始口令（可选，D-2）：明文只到用例层——OrgService 哈希后落
   * passwordHash；缺省 = 未设口令态（登录 401，管理员可后补设）。
   */
  readonly password?: string;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OrgInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OrgInputError(`显示名必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new OrgInputError(`显示名须为 1~128 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** 解析 POST /org/users 请求体（password 可选：带 = 设初始口令；不带 = 未设口令态）。 */
export function parseCreateUserInput(input: unknown): CreateUserPayload {
  const record = requireObject(input, '创建用户请求体');
  const username = record['username'];
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new OrgInputError(
      `用户名 '${JSON.stringify(username)}' 非法：须为小写字母开头的小写字母/数字/连字符（1~64 字符）`,
    );
  }
  const displayName = requireDisplayName(record['displayName']);
  const active = record['active'];
  if (active !== undefined && typeof active !== 'boolean') {
    throw new OrgInputError(`active 须为布尔：${JSON.stringify(active)}`);
  }
  const password = record['password'];
  const payload: { username: string; displayName: string; active?: boolean; password?: string } = {
    username,
    displayName,
  };
  if (active !== undefined) payload.active = active;
  if (password !== undefined) payload.password = requirePassword(password, "字段 'password'");
  return payload;
}

export interface CreateRolePayload {
  readonly name: RoleName;
  readonly displayName: string;
}

/** 解析 POST /org/roles 请求体（角色名复用 roleName 段形状校验）。 */
export function parseCreateRoleInput(input: unknown): CreateRolePayload {
  const record = requireObject(input, '创建角色请求体');
  const name = record['name'];
  if (typeof name !== 'string' || !PERMISSION_SEGMENT_PATTERN.test(name)) {
    throw new OrgInputError(
      `角色名 '${JSON.stringify(name)}' 非法：须为单段小写形状（小写字母/数字/连字符）`,
    );
  }
  return { name: roleName(name), displayName: requireDisplayName(record['displayName']) };
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OrgInputError(`字段 '${field}' 须为字符串数组：${JSON.stringify(value)}`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new OrgInputError(`字段 '${field}' 含非字符串项：${JSON.stringify(item)}`);
    }
  }
  return value;
}

/** 解析 PUT /org/roles/:name/permissions 请求体 { permissions: [...] }。 */
export function parsePermissionCodesInput(input: unknown): readonly PermissionCode[] {
  const record = requireObject(input, '授权请求体');
  const raw = requireStringArray(record['permissions'], 'permissions');
  return raw.map((code) => {
    try {
      return permissionCode(code);
    } catch {
      throw new OrgInputError(
        `权限码 '${code}' 非法：须为 <环节>:<动作> 两段小写形状，无通配`,
      );
    }
  });
}

/** 解析 PUT /org/users/:id/roles 请求体 { roles: [...] }。 */
export function parseRoleNamesInput(input: unknown): readonly RoleName[] {
  const record = requireObject(input, '授予角色请求体');
  const raw = requireStringArray(record['roles'], 'roles');
  return raw.map((name) => {
    if (!PERMISSION_SEGMENT_PATTERN.test(name)) {
      throw new OrgInputError(`角色名 '${name}' 非法：须为单段小写形状`);
    }
    return roleName(name);
  });
}

/** 路径参数 user id 解析（UserId 品牌构造自带 1~128 非空校验）。 */
export function parseUserIdParam(value: string): UserId {
  try {
    return UserId.create(value);
  } catch {
    throw new OrgInputError(`用户 id 非法：${JSON.stringify(value)}`);
  }
}

export interface UserStatusPayload {
  readonly active: boolean;
}

/** 解析 PUT /org/users/:id/status 请求体 { active: boolean }（收尾波-③）。 */
export function parseUserStatusInput(input: unknown): UserStatusPayload {
  const record = requireObject(input, '用户状态请求体');
  const active = record['active'];
  if (typeof active !== 'boolean') {
    throw new OrgInputError(`active 须为布尔：${JSON.stringify(active)}`);
  }
  return { active };
}

export interface UserPasswordPayload {
  readonly password: string;
}

/** 解析 PUT /org/users/:id/password 请求体 { password: string }（D-2：设置/重置口令）。 */
export function parseUserPasswordInput(input: unknown): UserPasswordPayload {
  const record = requireObject(input, '用户口令请求体');
  return { password: requirePassword(record['password'], "字段 'password'") };
}

/** 路径参数角色名解析。 */
export function parseRoleNameParam(value: string): RoleName {
  if (!PERMISSION_SEGMENT_PATTERN.test(value)) {
    throw new OrgInputError(`角色名 '${value}' 非法：须为单段小写形状`);
  }
  return roleName(value);
}

// ---------------------------------------------------------------------------
// 机构/岗位输入解析（S1 backfill：0920 #3/#7）。code 形状与 masterdata 主数据
// 稳定码同宽（字母/数字开头 + 字母/数字/点/下划线/连字符，如 ORG-01/POS-12）。
// ---------------------------------------------------------------------------

const BACKFILL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireBackfillCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || !BACKFILL_CODE_PATTERN.test(value)) {
    throw new OrgInputError(
      `${what} '${JSON.stringify(value)}' 非法：须为字母/数字开头，仅含字母/数字/点/下划线/连字符（1~64 字符）`,
    );
  }
  return value;
}

/** 可选引用 id：undefined → 缺省不动；null → 显式清空（挂顶层/去归属）；字符串即引用。 */
function optionalRef(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new OrgInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new OrgInputError(`字段 '${field}' 引用 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function optionalActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new OrgInputError(`active 须为布尔：${JSON.stringify(value)}`);
  }
  return value;
}

export interface CreateDepartmentPayload {
  readonly code: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly active?: boolean;
}

/** 解析 POST /org/departments 请求体。 */
export function parseCreateDepartmentInput(input: unknown): CreateDepartmentPayload {
  const record = requireObject(input, '创建机构请求体');
  const payload: {
    code: string;
    name: string;
    parentId?: string | null;
    active?: boolean;
  } = {
    code: requireBackfillCode(record['code'], '机构 code'),
    name: requireDisplayName(record['name']),
  };
  const parentId = optionalRef(record['parentId'], 'parentId');
  if (parentId !== undefined) payload.parentId = parentId;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdateDepartmentPayload {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly active?: boolean;
}

/** 解析 PUT /org/departments/:id 请求体（字段级期望态；code 不可变）。 */
export function parseUpdateDepartmentInput(input: unknown): UpdateDepartmentPayload {
  const record = requireObject(input, '更新机构请求体');
  if (record['code'] !== undefined) {
    throw new OrgInputError('机构 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; parentId?: string | null; active?: boolean } = {};
  if (record['name'] !== undefined) payload.name = requireDisplayName(record['name']);
  const parentId = optionalRef(record['parentId'], 'parentId');
  if (parentId !== undefined) payload.parentId = parentId;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface CreatePositionPayload {
  readonly code: string;
  readonly name: string;
  readonly departmentRef?: string | null;
  readonly active?: boolean;
}

/** 解析 POST /org/positions 请求体。 */
export function parseCreatePositionInput(input: unknown): CreatePositionPayload {
  const record = requireObject(input, '创建岗位请求体');
  const payload: {
    code: string;
    name: string;
    departmentRef?: string | null;
    active?: boolean;
  } = {
    code: requireBackfillCode(record['code'], '岗位 code'),
    name: requireDisplayName(record['name']),
  };
  const departmentRef = optionalRef(record['departmentRef'], 'departmentRef');
  if (departmentRef !== undefined) payload.departmentRef = departmentRef;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdatePositionPayload {
  readonly name?: string;
  readonly departmentRef?: string | null;
  readonly active?: boolean;
}

/** 解析 PUT /org/positions/:id 请求体（字段级期望态；code 不可变）。 */
export function parseUpdatePositionInput(input: unknown): UpdatePositionPayload {
  const record = requireObject(input, '更新岗位请求体');
  if (record['code'] !== undefined) {
    throw new OrgInputError('岗位 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; departmentRef?: string | null; active?: boolean } = {};
  if (record['name'] !== undefined) payload.name = requireDisplayName(record['name']);
  const departmentRef = optionalRef(record['departmentRef'], 'departmentRef');
  if (departmentRef !== undefined) payload.departmentRef = departmentRef;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseBackfillIdParam(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new OrgInputError(`${what} id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
