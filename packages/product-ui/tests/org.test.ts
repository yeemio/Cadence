/**
 * 组织管理视图模型测试（M1 增量 3-D）：响应解析、载荷构造、身份表增补。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION,
  buildCreateUserPayload,
  buildPermissionCodesPayload,
  buildRoleNamesPayload,
  OrgViewError,
  ORG_ROLE_READ,
  ORG_USER_READ,
  parseOrgRolesResponse,
  parseOrgUsersResponse,
  DEMO_IDENTITIES,
} from '../src/index.js';

describe('组织响应解析', () => {
  it('用户列表：合法响应解析为视图；缺 users / 非法行抛 OrgViewError', () => {
    const users = parseOrgUsersResponse({
      users: [
        { id: 'user-1', username: 'admin', displayName: '管理员', active: true },
        { id: 'user-2', username: 'viewer', displayName: '访客', active: false },
      ],
    });
    expect(users).toHaveLength(2);
    expect(users[1]?.active).toBe(false);
    expect(() => parseOrgUsersResponse({})).toThrow(OrgViewError);
    expect(() =>
      parseOrgUsersResponse({ users: [{ id: '', username: 'x', displayName: 'x', active: true }] }),
    ).toThrow(OrgViewError);
  });

  it('角色列表：权限码逐项校验；非法码抛错', () => {
    const roles = parseOrgRolesResponse({
      roles: [
        { name: 'planner', displayName: '计划员', permissions: ['demo:read', 'demo:write'] },
      ],
    });
    expect(roles[0]?.permissions).toEqual(['demo:read', 'demo:write']);
    expect(() =>
      parseOrgRolesResponse({ roles: [{ name: 'x', displayName: 'x', permissions: ['not a code'] }] }),
    ).toThrow(OrgViewError);
  });
});

describe('组织请求载荷构造', () => {
  it('创建用户载荷：空字段拒绝', () => {
    expect(buildCreateUserPayload({ username: 'wang', displayName: '王工' })).toEqual({
      username: 'wang',
      displayName: '王工',
    });
    expect(() => buildCreateUserPayload({ username: '', displayName: '王工' })).toThrow(
      OrgViewError,
    );
  });

  it('权限码载荷：去空白、去重、非法码拒绝', () => {
    expect(buildPermissionCodesPayload([' demo:read ', 'demo:read', 'demo:write'])).toEqual({
      permissions: ['demo:read', 'demo:write'],
    });
    expect(() => buildPermissionCodesPayload(['demo read'])).toThrow(OrgViewError);
  });

  it('角色名载荷：去空白、去重', () => {
    expect(buildRoleNamesPayload(['planner', 'planner', ''])).toEqual({ roles: ['planner'] });
  });
});

describe('组织权限码常量与演示身份（M1 增量 3-D）', () => {
  it('四个权限码与后端 org 端点一一对应', () => {
    expect(ORG_USER_READ).toBe('user:read');
    expect(ORG_ROLE_READ).toBe('role:read');
  });

  it('DEMO_IDENTITIES 含组织管理员（精确码，无通配）', () => {
    const orgAdmin = DEMO_IDENTITIES.find((id) => id.email === 'org-admin@demo.local');
    expect(orgAdmin?.permissions).toEqual([
      'user:read',
      'user:write',
      'role:read',
      'role:write',
    ]);
    expect(orgAdmin?.permissions.includes(ADMIN_PERMISSION)).toBe(false);
  });
});
