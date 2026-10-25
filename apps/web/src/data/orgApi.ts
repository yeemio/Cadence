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
