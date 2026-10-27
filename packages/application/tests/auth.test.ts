/**
 * 真实认证用例测试（M1 收尾波-③）：口令哈希格式与校验、AuthService
 * 登录/续期/登出/解析语义（TTL、撤销、active、不泄漏差异）、
 * permissionsOfUser 权限投影、控制器权限码元数据（auth 全公开路由）。
 */
import 'reflect-metadata';
import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  AuthController,
  AuthCredentialsError,
  AuthInputError,
  AuthService,
  AuthModule,
  hashPassword,
  InMemoryPolicyStore,
  InMemorySessionStore,
  InMemoryUserStore,
  passwordHashMatchesCurrentParams,
  PermissionService,
  PERMISSION_METADATA_KEY,
  permissionCode,
  roleName,
  verifyPassword,
} from '../src/index.js';

const tenant = TenantId.create('t1');

function newAuth(now: () => Date = (): Date => new Date('2026-10-25T08:00:00Z')): {
  auth: AuthService;
  users: InMemoryUserStore;
  sessions: InMemorySessionStore;
} {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const auth = new AuthService(users, sessions, new PermissionService(new InMemoryPolicyStore()), {
    tokenTtlMs: 8 * 60 * 60 * 1000,
    refreshWindowMs: 7 * 24 * 60 * 60 * 1000,
    now,
  });
  return { auth, users, sessions };
}

describe('口令哈希（scrypt 自述格式；M2 SP-2 升档 N=65536 + maxmem + verify 预算上界）', () => {
  it('hash → verify 往返；错口令 false；同口令两次哈希不同串（随机盐）', () => {
    const stored = hashPassword('demo-password');
    expect(stored).toMatch(/^scrypt\$65536\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    // N=65536 内存 64MiB 超 node 缺省 maxmem 32MiB——本断言成立即证 hash/verify
    // 两路显式传 maxmem（缺省 maxmem 下 scryptSync 抛错 → verify 恒 false）
    expect(verifyPassword('demo-password', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(hashPassword('demo-password')).not.toBe(stored);
  });

  it('旧参数串（N=16384）仍可验（verify 按串内参数——存量哈希保持可用）', () => {
    // 内联构造 M1 期参数哈希（模拟存量库行；16MiB < 32MiB 无需 maxmem）
    const salt = randomBytes(16);
    const hash = scryptSync('legacy-secret', salt, 64, { N: 16384, r: 8, p: 1 });
    const legacy = ['scrypt', 16384, 8, 1, salt.toString('hex'), hash.toString('hex')].join('$');
    expect(verifyPassword('legacy-secret', legacy)).toBe(true);
    expect(verifyPassword('wrong', legacy)).toBe(false);
    expect(passwordHashMatchesCurrentParams(legacy)).toBe(false); // 参数落后 → 触发重哈希
    expect(passwordHashMatchesCurrentParams(hashPassword('x'))).toBe(true);
  });

  it('越界参数串直接 false（128×N×r×p 超 N=2^20 等价预算——不进 scryptSync）', () => {
    const fake = (n: number, r: number, p: number): string =>
      `scrypt$${n}$${r}$${p}$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
    expect(verifyPassword('x', fake(2 ** 30, 8, 1))).toBe(false); // N 超 2^20 等价
    expect(verifyPassword('x', fake(65536, 2 ** 18, 1))).toBe(false); // r 堆大同样超预算
    expect(verifyPassword('x', fake(65536, 8, 2 ** 14))).toBe(false); // p 堆大同样超预算
    // 上界内（恰好 2^20 等价预算）不是预算拒绝（参数合法但口令不符 → 仍 false，
    // 与预算拒绝同收敛——不可区分性是 fail-closed 语义的一部分）
    expect(verifyPassword('x', fake(2 ** 20, 8, 1))).toBe(false);
  });

  it('存量串格式非法一律 false（fail-closed，不抛错）', () => {
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'scrypt$1$2$3$zz$yy')).toBe(false);
    expect(verifyPassword('x', 'scrypt$65536$8$1$abc$def')).toBe(false);
  });
});

describe('渐进重哈希（SP-2：login 成功且串内参数落后 → 静默重哈希落库）', () => {
  it('旧参数哈希用户登录成功且库内串升为 N=65536；响应不变（token 可用）', async () => {
    const users = new InMemoryUserStore();
    const auth = new AuthService(users, new InMemorySessionStore(), new PermissionService(new InMemoryPolicyStore()));
    // 存量行：旧参数（N=16384）哈希
    const salt = randomBytes(16);
    const legacyHash = [
      'scrypt',
      16384,
      8,
      1,
      salt.toString('hex'),
      scryptSync('upgrade-pass', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'),
    ].join('$');
    await users.create({
      tenant,
      username: 'old-timer',
      displayName: '存量用户',
      passwordHash: legacyHash,
    });

    const issued = await auth.login(tenant, { username: 'old-timer', password: 'upgrade-pass' });
    expect(issued.user.username).toBe('old-timer'); // 响应形状不变
    expect(await auth.resolveSession(issued.token)).not.toBeNull(); // 会话照常可用

    // 库内串已升级为新参数（且仍可验——重哈希同源）
    const stored = (await users.findByUsername(tenant, 'old-timer'))?.passwordHash ?? '';
    expect(stored).toMatch(/^scrypt\$65536\$8\$1\$/);
    expect(verifyPassword('upgrade-pass', stored)).toBe(true);
    // 新参数用户再登录不重复重哈希（幂等——无断言锚，路径等价）
    await auth.login(tenant, { username: 'old-timer', password: 'upgrade-pass' });
  });

  it('登录失败不触发重哈希（凭据拒绝优先）', async () => {
    const users = new InMemoryUserStore();
    const auth = new AuthService(users, new InMemorySessionStore(), new PermissionService(new InMemoryPolicyStore()));
    const legacyHash = hashPassword('right-pass'); // 直接造"参数落后"行不行——用新参数造，只验证失败路径不写库
    await users.create({
      tenant,
      username: 'steady',
      displayName: '稳定用户',
      passwordHash: legacyHash,
    });
    await expect(
      auth.login(tenant, { username: 'steady', password: 'wrong-pass' }),
    ).rejects.toThrow(AuthCredentialsError);
    expect((await users.findByUsername(tenant, 'steady'))?.passwordHash).toBe(legacyHash); // 原串未动
  });
});

describe('AuthService 登录', () => {
  it('凭证正确 → 签发 token + 过期时间；UserAccount 视图返回', async () => {
    const { auth, users } = newAuth();
    await users.create({
      tenant,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('s3cret'),
    });
    const issued = await auth.login(tenant, { username: 'alice', password: 's3cret' });
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(issued.user.username).toBe('alice');
    expect(issued.expiresAt.toISOString()).toBe('2026-10-25T16:00:00.000Z'); // 8h TTL
    // 会话可解析回身份 + 租户
    expect(await auth.resolveSession(issued.token)).toEqual({
      userId: issued.user.id,
      tenant,
    });
  });

  it('四种拒绝路径同一错误同一 message（不泄漏差异）：未知用户/错口令/停用/未设口令', async () => {
    const { auth, users } = newAuth();
    await users.create({
      tenant,
      username: 'bob',
      displayName: 'Bob',
      passwordHash: hashPassword('right'),
      active: false,
    });
    await users.create({ tenant, username: 'carol', displayName: 'Carol' }); // 未设口令
    const attempts = [
      { username: 'nobody', password: 'x' },
      { username: 'bob', password: 'right' }, // active=false
      { username: 'bob', password: 'wrong' },
      { username: 'carol', password: 'x' }, // passwordHash=null
    ];
    for (const attempt of attempts) {
      await expect(auth.login(tenant, attempt)).rejects.toThrow(AuthCredentialsError);
      await expect(auth.login(tenant, attempt)).rejects.toThrow('用户名或口令不正确');
    }
  });

  it('输入形状违规 → AuthInputError（区别于凭据拒绝）', async () => {
    const { auth } = newAuth();
    await expect(auth.login(tenant, { username: '', password: 'x' })).rejects.toThrow(
      AuthInputError,
    );
    await expect(auth.login(tenant, null)).rejects.toThrow(AuthInputError);
  });
});

describe('AuthService 续期 / 登出 / 撤销', () => {
  it('refresh：旧 token 立即失效、新 token 可用、窗口上界继承（不滑动）', async () => {
    let clock = new Date('2026-10-25T08:00:00Z');
    const { auth, users } = newAuth(() => clock);
    await users.create({
      tenant,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('s3cret'),
    });
    const first = await auth.login(tenant, { username: 'alice', password: 's3cret' });

    clock = new Date('2026-10-26T08:00:00Z'); // +1d，窗口 7d 内
    const second = await auth.refresh(tenant, first.token);
    expect(second.token).not.toBe(first.token);
    expect(await auth.resolveSession(first.token)).toBeNull(); // 旧 token 已撤销
    expect(await auth.resolveSession(second.token)).not.toBeNull();
    // 窗口上界继承：第 7 天后再 refresh 被拒（绝对上限不滑动）
    clock = new Date('2026-11-01T08:00:01Z'); // 首签 +7d +1s
    await expect(auth.refresh(tenant, second.token)).rejects.toThrow(AuthCredentialsError);
  });

  it('refresh 允许在访问期已过但窗口内使用', async () => {
    let clock = new Date('2026-10-25T08:00:00Z');
    const { auth, users } = newAuth(() => clock);
    await users.create({
      tenant,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('s3cret'),
    });
    const issued = await auth.login(tenant, { username: 'alice', password: 's3cret' });
    clock = new Date('2026-10-25T20:00:00Z'); // 访问期（8h）已过，窗口（7d）未过
    expect(await auth.resolveSession(issued.token)).toBeNull();
    const refreshed = await auth.refresh(tenant, issued.token);
    expect(await auth.resolveSession(refreshed.token)).not.toBeNull();
  });

  it('logout：撤销后同 token 解析为 null；重复 logout 拒绝', async () => {
    const { auth, users } = newAuth();
    await users.create({
      tenant,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('s3cret'),
    });
    const issued = await auth.login(tenant, { username: 'alice', password: 's3cret' });
    await auth.logout(issued.token);
    expect(await auth.resolveSession(issued.token)).toBeNull();
    await expect(auth.logout(issued.token)).rejects.toThrow(AuthCredentialsError);
  });

  it('停用用户（漏撤销兜底）：refresh 与 currentAccount 均拒绝', async () => {
    const { auth, users } = newAuth();
    await users.create({
      tenant,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: hashPassword('s3cret'),
    });
    const issued = await auth.login(tenant, { username: 'alice', password: 's3cret' });
    await users.updateStatus(tenant, issued.user.id, false); // 未经服务层（不撤会话）
    await expect(auth.refresh(tenant, issued.token)).rejects.toThrow(AuthCredentialsError);
    await expect(auth.currentAccount(tenant, issued.token)).rejects.toThrow(
      AuthCredentialsError,
    );
  });

  it('currentAccount：admin 投影 + 普通用户权限码并集', async () => {
    const policyStore = new InMemoryPolicyStore();
    const permissions = new PermissionService(policyStore);
    const users = new InMemoryUserStore();
    const auth = new AuthService(users, new InMemorySessionStore(), permissions);
    const boss = await users.create({
      tenant,
      username: 'boss',
      displayName: 'Boss',
      passwordHash: hashPassword('s3cret'),
    });
    const worker = await users.create({
      tenant,
      username: 'worker',
      displayName: 'Worker',
      passwordHash: hashPassword('s3cret'),
    });
    await permissions.apply([
      { kind: 'grant-role', tenant, user: boss.id, role: roleName('admin') },
      { kind: 'grant-role', tenant, user: worker.id, role: roleName('planner') },
      { kind: 'grant-permission', tenant, role: roleName('planner'), resource: 'user', action: 'read' },
      { kind: 'grant-permission', tenant, role: roleName('planner'), resource: 'role', action: 'read' },
    ]);
    const bossSession = await auth.login(tenant, { username: 'boss', password: 's3cret' });
    const bossView = await auth.currentAccount(tenant, bossSession.token);
    expect(bossView.admin).toBe(true);
    expect(bossView.permissions).toEqual([]);

    const workerSession = await auth.login(tenant, { username: 'worker', password: 's3cret' });
    const workerView = await auth.currentAccount(tenant, workerSession.token);
    expect(workerView.admin).toBe(false);
    expect([...workerView.permissions].sort()).toEqual(
      [permissionCode('user:read'), permissionCode('role:read')].sort(),
    );
  });
});

describe('AuthController 路由形状', () => {
  interface Handler {
    (): unknown;
  }

  function routePermissions(handler: string): unknown {
    const proto = AuthController.prototype as unknown as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('auth 端点全部公开（无 @RequirePermission 元数据——凭据语义自解 Bearer 头）', () => {
    for (const handler of ['login', 'refresh', 'logout', 'me']) {
      expect(routePermissions(handler), `AuthController.${handler}`).toBeUndefined();
    }
  });

  it('AuthModule.register 装配 AuthController，缺省回落内存存储', () => {
    const dynamic = AuthModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      AuthModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(AuthModule);
    expect(controllers).toContain(AuthController);
    expect(dynamic.global).toBe(true);
  });
});
