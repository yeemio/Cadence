/**
 * 组织/用户/角色管理用例测试（M1 增量 3-D）：
 * 端口内存实现、OrgService 期望态授权 diff 语义、控制器权限码元数据、
 * PermissionService 新增 revoke / permissionsOfRole 的端口级语义。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import {
  InMemoryPolicyStore,
  InMemoryRoleStore,
  InMemorySessionStore,
  InMemoryUserStore,
  OrgConflictError,
  OrgInputError,
  OrgModule,
  OrgNotFoundError,
  OrgService,
  PermissionService,
  PERMISSION_METADATA_KEY,
  roleName,
  permissionCode,
} from '../src/index.js';
import {
  OrgDepartmentsController,
  OrgPositionsController,
  OrgRolesController,
  OrgUsersController,
} from '../src/org/org.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newOrg(): { org: OrgService; policyStore: InMemoryPolicyStore } {
  const policyStore = new InMemoryPolicyStore();
  const org = new OrgService(
    new InMemoryUserStore(),
    new InMemoryRoleStore(),
    new PermissionService(policyStore),
  );
  return { org, policyStore };
}

describe('组织元数据端口（内存实现先行）', () => {
  it('用户：create/list/find 租户内收口；username 冲突抛 OrgConflictError', async () => {
    const users = new InMemoryUserStore();
    const created = await users.create({
      tenant: t1,
      username: 'li-ming',
      displayName: '李明',
    });
    expect(created.active).toBe(true);
    expect((await users.list(t1)).map((user) => user.username)).toEqual(['li-ming']);
    expect(await users.find(t1, created.id)).not.toBeNull();
    expect(await users.find(t2, created.id)).toBeNull(); // 跨租户不可见
    await expect(
      users.create({ tenant: t1, username: 'li-ming', displayName: '重名' }),
    ).rejects.toThrow(OrgConflictError);
    await users.create({ tenant: t2, username: 'li-ming', displayName: '他租户同名的李明' }); // 他租户不冲突
  });

  it('角色：create/list/find；角色名冲突抛 OrgConflictError', async () => {
    const roles = new InMemoryRoleStore();
    await roles.create({ tenant: t1, name: roleName('planner'), displayName: '计划员' });
    expect((await roles.list(t1)).map((role) => role.name)).toEqual(['planner']);
    expect(await roles.find(t1, roleName('planner'))).not.toBeNull();
    expect(await roles.find(t2, roleName('planner'))).toBeNull();
    await expect(
      roles.create({ tenant: t1, name: roleName('planner'), displayName: '重名' }),
    ).rejects.toThrow(OrgConflictError);
  });
});

describe('输入解析（OrgInputError 边界）', () => {
  it('创建用户：非法 username / displayName / active 拒绝', async () => {
    const { org } = newOrg();
    await expect(org.createUser(t1, { username: 'Li_Ming', displayName: '李明' })).rejects.toThrow(
      OrgInputError,
    );
    await expect(org.createUser(t1, { username: 'ok', displayName: '  ' })).rejects.toThrow(
      OrgInputError,
    );
    await expect(
      org.createUser(t1, { username: 'ok', displayName: '名', active: 'yes' }),
    ).rejects.toThrow(OrgInputError);
  });

  it('创建角色：非法角色名拒绝（单段小写形状）', async () => {
    const { org } = newOrg();
    await expect(org.createRole(t1, { name: 'Planner', displayName: '计划员' })).rejects.toThrow(
      OrgInputError,
    );
  });

  it('权限码集合：非法码/非数组拒绝；通配拒绝', async () => {
    const { org } = newOrg();
    await org.createRole(t1, { name: 'planner', displayName: '计划员' });
    await expect(
      org.setRolePermissions(t1, 'planner', { permissions: ['demo:read', 'demo:*'] }),
    ).rejects.toThrow(OrgInputError);
    await expect(org.setRolePermissions(t1, 'planner', { permissions: 'demo:read' })).rejects.toThrow(
      OrgInputError,
    );
  });
});

describe('OrgService 期望态授权（apply/revoke diff 写通同一 PolicyStore）', () => {
  it('setRolePermissions：授予→读回→收敛（revoke 移除侧）', async () => {
    const { org } = newOrg();
    await org.createRole(t1, { name: 'planner', displayName: '计划员' });

    const first = await org.setRolePermissions(t1, 'planner', {
      permissions: ['demo:read', 'demo:write'],
    });
    expect(first).toEqual({ granted: 2, revoked: 0 });
    const rolesView = await org.listRoles(t1);
    expect(rolesView[0]?.permissions).toEqual([
      permissionCode('demo:read'),
      permissionCode('demo:write'),
    ]);

    const second = await org.setRolePermissions(t1, 'planner', { permissions: ['demo:read'] });
    expect(second).toEqual({ granted: 0, revoked: 1 });
    expect((await org.listRoles(t1))[0]?.permissions).toEqual([permissionCode('demo:read')]);

    // 幂等：重复提交同一期望态零变更
    const third = await org.setRolePermissions(t1, 'planner', { permissions: ['demo:read'] });
    expect(third).toEqual({ granted: 0, revoked: 0 });
  });

  it('setRolePermissions：租户收口 + 未知角色 404 语义', async () => {
    const { org } = newOrg();
    await org.createRole(t1, { name: 'planner', displayName: '计划员' });
    await org.setRolePermissions(t1, 'planner', { permissions: ['demo:read'] });
    expect((await org.listRoles(t2))).toEqual([]); // t2 无角色元数据
    await expect(
      org.setRolePermissions(t2, 'planner', { permissions: ['demo:read'] }),
    ).rejects.toThrow(OrgNotFoundError);
  });

  it('setUserRoles：用户-角色绑定走策略存储，判定链路真实生效', async () => {
    const { org, policyStore } = newOrg();
    const user = await org.createUser(t1, { username: 'wang', displayName: '王工' });
    await org.createRole(t1, { name: 'planner', displayName: '计划员' });
    await org.setRolePermissions(t1, 'planner', { permissions: ['demo:read'] });

    const grant = await org.setUserRoles(t1, user.id, { roles: ['planner'] });
    expect(grant).toEqual({ granted: 1, revoked: 0 });

    // 判定链路真实生效：同一策略存储上新建 enforcer（模拟重启后加载）
    const judge = new PermissionService(policyStore);
    expect(await judge.authorize(t1, user.id, permissionCode('demo:read'))).toBe(true);
    expect(await judge.authorize(t1, user.id, permissionCode('demo:write'))).toBe(false);

    const shrink = await org.setUserRoles(t1, user.id, { roles: [] });
    expect(shrink).toEqual({ granted: 0, revoked: 1 });
    // 再以存储重建（模拟再次重启）：移除已持久化生效
    const reborn = new PermissionService(policyStore);
    expect(await reborn.authorize(t1, user.id, permissionCode('demo:read'))).toBe(false);
  });

  it('setUserRoles：未知用户/未知角色 404 语义', async () => {
    const { org } = newOrg();
    await org.createRole(t1, { name: 'planner', displayName: '计划员' });
    await expect(org.setUserRoles(t1, 'nobody', { roles: ['planner'] })).rejects.toThrow(
      OrgNotFoundError,
    );
    const user = await org.createUser(t1, { username: 'wang', displayName: '王工' });
    await expect(org.setUserRoles(t1, user.id, { roles: ['ghost'] })).rejects.toThrow(
      OrgNotFoundError,
    );
  });
});

describe('users.active 启停（收尾波-③：findByUsername / updateStatus / setUserStatus）', () => {
  const actor = UserId.create('user-other-admin');

  function newOrgWithSessions(): {
    org: OrgService;
    users: InMemoryUserStore;
    sessions: InMemorySessionStore;
  } {
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const org = new OrgService(
      users,
      new InMemoryRoleStore(),
      new PermissionService(new InMemoryPolicyStore()),
      sessions,
    );
    return { org, users, sessions };
  }

  it('findByUsername：租户内收口 + 凭据哈希读取（认证端口扩展）', async () => {
    const users = new InMemoryUserStore();
    const created = await users.create({ tenant: t1, username: 'li-ming', displayName: '李明' });
    const found = await users.findByUsername(t1, 'li-ming');
    expect(found?.account.id).toBe(created.id);
    expect(found?.passwordHash).toBeNull(); // 组织端点创建 = 未设口令，不能登录
    expect(await users.findByUsername(t2, 'li-ming')).toBeNull(); // 跨租户不可见
    await users.create({
      tenant: t1,
      username: 'with-hash',
      displayName: '带口令',
      passwordHash: 'scrypt$1$1$1$ab$cd',
    });
    expect((await users.findByUsername(t1, 'with-hash'))?.passwordHash).toBe('scrypt$1$1$1$ab$cd');
  });

  it('updateStatus：期望态写回；目标不存在返回 null（用例层转 404）', async () => {
    const users = new InMemoryUserStore();
    const created = await users.create({ tenant: t1, username: 'li-ming', displayName: '李明' });
    const updated = await users.updateStatus(t1, created.id, false);
    expect(updated?.active).toBe(false);
    expect((await users.find(t1, created.id))?.active).toBe(false);
    expect(await users.updateStatus(t1, UserId.create('user-missing'), true)).toBeNull();
  });

  it('setUserStatus 输入：active 非布尔 / 缺体拒绝', async () => {
    const { org, users } = newOrgWithSessions();
    const user = await users.create({ tenant: t1, username: 'li-ming', displayName: '李明' });
    await expect(org.setUserStatus(t1, user.id, actor, { active: 'yes' })).rejects.toThrow(
      OrgInputError,
    );
    await expect(org.setUserStatus(t1, user.id, actor, null)).rejects.toThrow(OrgInputError);
  });

  it('setUserStatus：停用 → 撤销该用户全部会话（写时全端下线）；恢复 → 撤销不可逆', async () => {
    const { org, users, sessions } = newOrgWithSessions();
    const target = await users.create({ tenant: t1, username: 'victim', displayName: '被停用户' });
    for (const suffix of ['a', 'b']) {
      await sessions.create({
        id: `session-${suffix}`,
        tenant: t1,
        userId: target.id,
        tokenDigest: `digest-${suffix}`,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        refreshExpiresAt: new Date(Date.now() + 1000),
      });
    }

    const stopped = await org.setUserStatus(t1, target.id, actor, { active: false });
    expect(stopped.active).toBe(false);
    expect((await sessions.findByTokenDigest('digest-a'))?.revokedAt).not.toBeNull();
    expect((await sessions.findByTokenDigest('digest-b'))?.revokedAt).not.toBeNull();

    const resumed = await org.setUserStatus(t1, target.id, actor, { active: true });
    expect(resumed.active).toBe(true);
    expect((await sessions.findByTokenDigest('digest-a'))?.revokedAt).not.toBeNull();
  });

  it('setUserStatus：管理员不能停自己（OrgInputError）；重新激活自己不受限；未知用户 404', async () => {
    const { org, users } = newOrgWithSessions();
    const admin = await users.create({ tenant: t1, username: 'admin', displayName: '管理员' });
    await expect(org.setUserStatus(t1, admin.id, admin.id, { active: false })).rejects.toThrow(
      OrgInputError,
    );
    expect((await org.setUserStatus(t1, admin.id, admin.id, { active: true })).active).toBe(true);
    await expect(
      org.setUserStatus(t1, 'user-missing', admin.id, { active: false }),
    ).rejects.toThrow(OrgNotFoundError);
  });

  it('无会话撤销依赖（sessions=null）：停用照常，只是不撤会话（单模块装配形态）', async () => {
    const { org } = newOrg();
    const user = await org.createUser(t1, { username: 'solo', displayName: '独立装配' });
    const stopped = await org.setUserStatus(t1, user.id, actor, { active: false });
    expect(stopped.active).toBe(false);
  });
});

describe('PermissionService 扩展（revoke / permissionsOfRole，M1 增量 3-D）', () => {
  it('permissionsOfRole 只投影域内直接授予；跨域不泄漏', async () => {
    const store = new InMemoryPolicyStore();
    const service = new PermissionService(store);
    await service.apply([
      { kind: 'grant-permission', tenant: t1, role: roleName('operator'), resource: 'demo', action: 'read' },
      { kind: 'grant-permission', tenant: t2, role: roleName('operator'), resource: 'demo', action: 'write' },
    ]);
    expect(await service.permissionsOfRole(t1, roleName('operator'))).toEqual([
      permissionCode('demo:read'),
    ]);
    expect(await service.permissionsOfRole(t2, roleName('operator'))).toEqual([
      permissionCode('demo:write'),
    ]);
  });

  it('revoke 经存储写通：重建 enforcer（模拟重启）后移除仍成立；幂等', async () => {
    const store = new InMemoryPolicyStore();
    const service = new PermissionService(store);
    const alice = UserId.create('alice');
    await service.apply([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
      { kind: 'grant-permission', tenant: t1, role: roleName('operator'), resource: 'demo', action: 'read' },
    ]);
    await service.revoke([
      { kind: 'grant-permission', tenant: t1, role: roleName('operator'), resource: 'demo', action: 'read' },
    ]);
    await service.revoke([
      { kind: 'grant-permission', tenant: t1, role: roleName('operator'), resource: 'demo', action: 'read' },
    ]); // 不存在的规则：幂等跳过

    const reborn = new PermissionService(store);
    expect(await reborn.authorize(t1, alice, permissionCode('demo:read'))).toBe(false);
    expect(await reborn.rolesOf(t1, alice)).toEqual(['operator']); // g 绑定仍在
    expect(await store.load()).toHaveLength(1);
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('users 路由：list=user:read、create/setRoles/setStatus=user:write', () => {
    expect(routePermissions(OrgUsersController, 'list')).toBe('user:read');
    expect(routePermissions(OrgUsersController, 'create')).toBe('user:write');
    expect(routePermissions(OrgUsersController, 'setRoles')).toBe('user:write');
    expect(routePermissions(OrgUsersController, 'setStatus')).toBe('user:write');
  });

  it('roles 路由：list=role:read、create/setPermissions=role:write', () => {
    expect(routePermissions(OrgRolesController, 'list')).toBe('role:read');
    expect(routePermissions(OrgRolesController, 'create')).toBe('role:write');
    expect(routePermissions(OrgRolesController, 'setPermissions')).toBe('role:write');
  });

  it('OrgModule.register 装配四个控制器（users/roles + S1 机构/岗位 backfill），缺省回落内存存储', () => {
    const dynamic = OrgModule.register();
    // 注：register() 返回的字面量 DynamicModule 不带 reflect-metadata——断言
    // 直读 controllers 属性（真实属性，非 metadata 空真）。
    expect(dynamic.module).toBe(OrgModule);
    expect(dynamic.controllers).toHaveLength(4);
    expect(dynamic.controllers).toContain(OrgUsersController);
    expect(dynamic.controllers).toContain(OrgRolesController);
    expect(dynamic.controllers).toContain(OrgDepartmentsController);
    expect(dynamic.controllers).toContain(OrgPositionsController);
  });
});
