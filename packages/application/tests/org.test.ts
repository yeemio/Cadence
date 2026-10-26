/**
 * 组织/用户/角色管理用例测试（M1 增量 3-D）：
 * 端口内存实现、OrgService 期望态授权 diff 语义、控制器权限码元数据、
 * PermissionService 新增 revoke / permissionsOfRole 的端口级语义。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import {
  AuthCredentialsError,
  AuthService,
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

describe('用户口令（D-2：建用户可选初始口令 + 管理员设置/重置口令）', () => {
  function newOrgWithAuth(): {
    org: OrgService;
    users: InMemoryUserStore;
    sessions: InMemorySessionStore;
    auth: AuthService;
  } {
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const permissions = new PermissionService(new InMemoryPolicyStore());
    const org = new OrgService(users, new InMemoryRoleStore(), permissions, sessions);
    const auth = new AuthService(users, sessions, permissions);
    return { org, users, sessions, auth };
  }

  it('带初始口令建用户 → 登录成功（scrypt 落 hash，明文不入库）；不带口令 → 未设口令态，登录 401', async () => {
    const { org, users, auth } = newOrgWithAuth();
    const created = await org.createUser(t1, {
      username: 'li-ming',
      displayName: '李明',
      password: 'init-pass-1',
    });
    const issued = await auth.login(t1, { username: 'li-ming', password: 'init-pass-1' });
    expect(issued.user.id).toBe(created.id);
    // 落库是 scrypt 自述串而非明文
    const stored = (await users.findByUsername(t1, 'li-ming'))?.passwordHash;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('init-pass-1');

    await org.createUser(t1, { username: 'wang', displayName: '王工' }); // 不带口令
    expect((await users.findByUsername(t1, 'wang'))?.passwordHash).toBeNull();
    await expect(auth.login(t1, { username: 'wang', password: 'x' })).rejects.toThrow(
      AuthCredentialsError, // → HTTP 401（四种拒绝同一错误，不泄漏差异）
    );
  });

  it('setUserPassword 首设口令：未设口令用户（D-2 缺口主体）设口令后即可登录', async () => {
    const { org, auth } = newOrgWithAuth();
    const created = await org.createUser(t1, { username: 'wang', displayName: '王工' });
    await expect(auth.login(t1, { username: 'wang', password: 'x' })).rejects.toThrow(
      AuthCredentialsError,
    );
    await org.setUserPassword(t1, created.id, { password: 'first-pass' });
    const issued = await auth.login(t1, { username: 'wang', password: 'first-pass' });
    expect(issued.user.id).toBe(created.id);
  });

  it('重置口令：旧口令即刻 401、新口令 200；存量会话写时全端撤销（对齐 active 启停先例）', async () => {
    const { org, auth, sessions } = newOrgWithAuth();
    await org.createUser(t1, { username: 'li-ming', displayName: '李明', password: 'old-pass' });
    const issued = await auth.login(t1, { username: 'li-ming', password: 'old-pass' });
    // 并存第二会话（模拟多端登录）
    await sessions.create({
      id: 'session-x',
      tenant: t1,
      userId: issued.user.id,
      tokenDigest: 'digest-x',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      refreshExpiresAt: new Date(Date.now() + 1000),
    });

    await org.setUserPassword(t1, issued.user.id, { password: 'new-pass' });

    await expect(auth.login(t1, { username: 'li-ming', password: 'old-pass' })).rejects.toThrow(
      AuthCredentialsError, // 旧口令 401
    );
    const relogged = await auth.login(t1, { username: 'li-ming', password: 'new-pass' }); // 新口令 200
    expect(relogged.user.username).toBe('li-ming');
    expect(await auth.resolveSession(issued.token)).toBeNull(); // 重置即撤会话
    expect((await sessions.findByTokenDigest('digest-x'))?.revokedAt).not.toBeNull(); // 全端
  });

  it('输入校验：口令空串/超长(>128)/非字符串/缺体 → OrgInputError；128 字符含端点', async () => {
    const { org } = newOrgWithAuth();
    await expect(
      org.createUser(t1, { username: 'a', displayName: '甲', password: '' }),
    ).rejects.toThrow(OrgInputError);
    await expect(
      org.createUser(t1, { username: 'a', displayName: '甲', password: 'x'.repeat(129) }),
    ).rejects.toThrow(OrgInputError);
    await expect(
      org.createUser(t1, { username: 'a', displayName: '甲', password: 123456 }),
    ).rejects.toThrow(OrgInputError);
    const bounded = await org.createUser(t1, {
      username: 'c',
      displayName: '丙',
      password: 'x'.repeat(128),
    });
    expect(bounded.username).toBe('c');

    const user = await org.createUser(t1, { username: 'b', displayName: '乙' });
    await expect(org.setUserPassword(t1, user.id, { password: '' })).rejects.toThrow(
      OrgInputError,
    );
    await expect(
      org.setUserPassword(t1, user.id, { password: 'x'.repeat(129) }),
    ).rejects.toThrow(OrgInputError);
    await expect(org.setUserPassword(t1, user.id, null)).rejects.toThrow(OrgInputError);
  });

  it('租户收口：t2 管理员视角对 t1 用户重置 → OrgNotFoundError（404，不泄漏存在性）且原口令不失效', async () => {
    const { org, auth } = newOrgWithAuth();
    const user = await org.createUser(t1, {
      username: 'li-ming',
      displayName: '李明',
      password: 'keep-pass',
    });
    await expect(org.setUserPassword(t2, user.id, { password: 'evil-pass' })).rejects.toThrow(
      OrgNotFoundError,
    );
    await expect(
      org.setUserPassword(t1, 'user-missing', { password: 'x' }),
    ).rejects.toThrow(OrgNotFoundError);
    // 跨租户重置未生效：t1 原口令仍可登录
    expect((await auth.login(t1, { username: 'li-ming', password: 'keep-pass' })).user.id).toBe(
      user.id,
    );
  });

  it('updatePassword 端口（内存实现）：覆写哈希写回；目标不存在/跨租户返回 null', async () => {
    const users = new InMemoryUserStore();
    const created = await users.create({
      tenant: t1,
      username: 'u',
      displayName: 'U',
      passwordHash: 'scrypt$1$1$1$ab$cd',
    });
    const updated = await users.updatePassword(t1, created.id, 'scrypt$2$2$2$ef$gh');
    expect(updated?.id).toBe(created.id);
    expect((await users.findByUsername(t1, 'u'))?.passwordHash).toBe('scrypt$2$2$2$ef$gh');
    expect(await users.updatePassword(t2, created.id, 'scrypt$3$3$3$ij$kl')).toBeNull();
    expect(await users.updatePassword(t1, UserId.create('user-missing'), 'x')).toBeNull();
  });

  it('hasPassword 只读投影（D-2 P3）：未设口令 false / 带口令与首设后 true；哈希本体不出任何账户视图', async () => {
    const { org, users } = newOrgWithAuth();
    const bare = await org.createUser(t1, { username: 'wang', displayName: '王工' }); // 未设口令
    const withPass = await org.createUser(t1, {
      username: 'li-ming',
      displayName: '李明',
      password: 'init-pass-3',
    });

    // 建号即投影（单用户详情视图 = create 返回）：带初始口令 true / 不带 false
    expect(bare.hasPassword).toBe(false);
    expect(withPass.hasPassword).toBe(true);

    // 列表视图：管理员按行区分"未设口令"用户
    const listed = await org.listUsers(t1);
    const byName = new Map(listed.map((row) => [row.username, row]));
    expect(byName.get('wang')?.hasPassword).toBe(false);
    expect(byName.get('li-ming')?.hasPassword).toBe(true);

    // 首设口令后投影翻转（setUserPassword 单用户视图 + 列表读回一致）
    const firstSet = await org.setUserPassword(t1, bare.id, { password: 'first-pass' });
    expect(firstSet.hasPassword).toBe(true);
    expect((await org.listUsers(t1)).find((row) => row.username === 'wang')?.hasPassword).toBe(true);

    // 哈希本体不出任何账户视图：投影依据真实存在（存储侧确有 scrypt 哈希），
    // 但 list/详情视图的序列化面既无 passwordHash 字段名、也无哈希串本体。
    const storedHash = (await users.findByUsername(t1, 'li-ming'))?.passwordHash;
    expect(storedHash).toMatch(/^scrypt\$/);
    const serialized = JSON.stringify({ listed: await org.listUsers(t1), created: bare, firstSet });
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(storedHash!);
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

  it('users 路由：list=user:read、create/setRoles/setStatus/setPassword=user:write', () => {
    expect(routePermissions(OrgUsersController, 'list')).toBe('user:read');
    expect(routePermissions(OrgUsersController, 'create')).toBe('user:write');
    expect(routePermissions(OrgUsersController, 'setRoles')).toBe('user:write');
    expect(routePermissions(OrgUsersController, 'setStatus')).toBe('user:write');
    // D-2：设置/重置口令沿 user:write——viewer（无该码）经 AuthGuard 判定 403
    expect(routePermissions(OrgUsersController, 'setPassword')).toBe('user:write');
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
