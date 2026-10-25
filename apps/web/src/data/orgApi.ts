/**
 * 组织管理薄数据层（M1 增量 3-D）：fetch 直连 server org 端点。
 *
 * 数据层取舍：TanStack Query 直连（非 refine dataProvider）——org 端点是
 * 自定义 REST 形状（按角色的权限集合 PUT / 按用户的角色集合 PUT），不是
 * 资源型 CRUD，dataProvider 的全协议面（getList/getOne/update/deleteMany…）
 * 大半用不上且需造 meta 约定；TanStack Query 对任意端点形状零假设，
 * 缓存/失效语义现成。fetch 封装在本文件（装配层），视图模型
 * （解析/构造/权限码）在 @smes/product-ui。
 *
 * 身份（收尾波-③ 起真实认证）：经共享 apiClient 注入 Authorization: Bearer
 * <token>（含 401 清会话与保活换新重试语义——会话规则集中在 apiClient，
 * 本文件不再自带第二份 fetch）。
 */
import {
  buildCreateRolePayload,
  buildCreateUserPayload,
  buildPermissionCodesPayload,
  buildRoleNamesPayload,
  parseOrgRolesResponse,
  parseOrgUser,
  parseOrgUsersResponse,
  type OrgRoleView,
  type OrgUserView,
} from '@smes/product-ui';
import { ApiError, request as sharedRequest } from './apiClient';
import { fetchRows } from './commandClient';

export class OrgApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OrgApiError';
  }
}

/** 共享请求 + 本文件历史错误类型映射（页面 ApiErrorHint 识别 OrgApiError）。 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  try {
    return await sharedRequest(path, init);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new OrgApiError(error.status, error.message);
    }
    throw error;
  }
}

export async function listOrgUsers(): Promise<readonly OrgUserView[]> {
  return parseOrgUsersResponse(await request('/org/users'));
}

export async function createOrgUser(input: {
  readonly username: string;
  readonly displayName: string;
}): Promise<OrgUserView> {
  return parseOrgUser(
    await request('/org/users', {
      method: 'POST',
      body: JSON.stringify(buildCreateUserPayload(input)),
    }),
  );
}

export async function setOrgUserRoles(userId: string, roles: readonly string[]): Promise<void> {
  await request(`/org/users/${encodeURIComponent(userId)}/roles`, {
    method: 'PUT',
    body: JSON.stringify(buildRoleNamesPayload(roles)),
  });
}

export async function listOrgRoles(): Promise<readonly OrgRoleView[]> {
  return parseOrgRolesResponse(await request('/org/roles'));
}

export async function createOrgRole(input: {
  readonly name: string;
  readonly displayName: string;
}): Promise<void> {
  await request('/org/roles', {
    method: 'POST',
    body: JSON.stringify(buildCreateRolePayload(input)),
  });
}

export async function setOrgRolePermissions(name: string, codes: readonly string[]): Promise<void> {
  await request(`/org/roles/${encodeURIComponent(name)}/permissions`, {
    method: 'PUT',
    body: JSON.stringify(buildPermissionCodesPayload(codes)),
  });
}

// ---- 机构/岗位（S3-a：0920 #3/#7 管理页；org.controllers.ts 实态） ----
// 与上面用户/角色的差别：这两组是普通 REST 资源（GET 列表/POST 创建/PUT 期望态
// 更新直返实体，无命令信封、无乐观锁）——按 S2 批次管理页的裸行风格走
// fetchRows + 直连 POST/PUT，行形状以 DepartmentMaster/PositionMaster 为准。

/** GET /org/departments → { departments: [...] }（平铺全量；组树是页面呈现取舍）。 */
export async function listDepartments(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/org/departments', 'departments');
}

/** POST /org/departments（code/name 必填；parentId 可选引用，空白不送）。 */
export async function createDepartment(input: {
  readonly code: string;
  readonly name: string;
  readonly parentId?: string;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { code: input.code.trim(), name: input.name.trim() };
  const parentId = input.parentId?.trim();
  if (parentId) payload.parentId = parentId;
  return (await request('/org/departments', {
    method: 'POST',
    body: JSON.stringify(payload),
  })) as Record<string, unknown>;
}

/** PUT /org/departments/:id（字段级期望态；软停用 = { active: false }）。 */
export async function updateDepartment(
  id: string,
  patch: { readonly name?: string; readonly parentId?: string | null; readonly active?: boolean },
): Promise<Record<string, unknown>> {
  return (await request(`/org/departments/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as Record<string, unknown>;
}

/** GET /org/positions → { positions: [...] }。 */
export async function listPositions(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/org/positions', 'positions');
}

/** POST /org/positions（code/name 必填；departmentRef 可选引用）。 */
export async function createPosition(input: {
  readonly code: string;
  readonly name: string;
  readonly departmentRef?: string;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { code: input.code.trim(), name: input.name.trim() };
  const departmentRef = input.departmentRef?.trim();
  if (departmentRef) payload.departmentRef = departmentRef;
  return (await request('/org/positions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })) as Record<string, unknown>;
}

/** PUT /org/positions/:id（字段级期望态；软停用 = { active: false }）。 */
export async function updatePosition(
  id: string,
  patch: { readonly name?: string; readonly departmentRef?: string | null; readonly active?: boolean },
): Promise<Record<string, unknown>> {
  return (await request(`/org/positions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as Record<string, unknown>;
}
