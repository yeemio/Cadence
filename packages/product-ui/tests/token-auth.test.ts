/**
 * 真实认证前端原语测试（M1 收尾波-③）：TokenSession 解析/过期判定 +
 * createTokenAuthProvider 的会话规则——login 写存储、check 网络失败不清
 * 会话/服务端拒绝才清、logout 尽力而为真实登出。
 */
import { describe, expect, it } from 'vitest';
import {
  AuthRejectedError,
  createMemoryTokenSessionStore,
  createTokenAuthProvider,
  isTokenSessionExpired,
  parseTokenSession,
  permissionCode,
  type AuthSessionPayload,
  type AuthTransport,
} from '../src/index.js';

function payload(overrides: Partial<AuthSessionPayload> = {}): AuthSessionPayload {
  return {
    token: 'tok-1',
    expiresAt: '2026-10-25T16:00:00.000Z',
    user: { id: 'user-1', tenant: 'default', username: 'admin', displayName: '管理员' },
    admin: false,
    permissions: [permissionCode('user:read')],
    ...overrides,
  };
}

describe('parseTokenSession / isTokenSessionExpired', () => {
  it('合法形状解析；admin 投影在前端如何存由写入方决定（parse 不特判）', () => {
    const session = parseTokenSession({
      userId: 'user-1',
      tenantId: 'default',
      displayName: '管理员',
      permissions: ['user:read', 'bad code!'],
      token: 'tok-1',
      expiresAt: '2026-10-25T16:00:00.000Z',
    });
    expect(session?.permissions).toEqual(['user:read']);
    expect(session?.token).toBe('tok-1');
  });

  it('缺 token / 坏 expiresAt / 非对象 → null（读作未登录）', () => {
    expect(parseTokenSession(null)).toBeNull();
    expect(parseTokenSession({ userId: 'u', tenantId: 't', displayName: 'x', permissions: [], token: '', expiresAt: 'x' })).toBeNull();
    expect(parseTokenSession({ userId: 'u', tenantId: 't', displayName: 'x', permissions: [], token: 't', expiresAt: 'not-a-date' })).toBeNull();
  });

  it('isTokenSessionExpired 按访问期上界判定', () => {
    const session = parseTokenSession({
      userId: 'u', tenantId: 't', displayName: 'x', permissions: [], token: 't',
      expiresAt: '2026-10-25T16:00:00.000Z',
    });
    expect(session).not.toBeNull();
    expect(isTokenSessionExpired(session!, Date.parse('2026-10-25T15:59:59.000Z'))).toBe(false);
    expect(isTokenSessionExpired(session!, Date.parse('2026-10-25T16:00:00.000Z'))).toBe(true);
  });
});

describe('createTokenAuthProvider（会话规则）', () => {
  it("login：成功写存储（admin 投影 → 通配权限码）；失败不写", async () => {
    const store = createMemoryTokenSessionStore();
    const transport: AuthTransport = {
      login: async (username, password) =>
        username === 'admin' && password === 'demo-password'
          ? payload({ token: 'tok-9', admin: true, permissions: [] })
          : Promise.reject(new AuthRejectedError('用户名或口令不正确')),
      me: async () => payload(),
      refresh: async () => payload(),
      logout: async () => undefined,
    };
    const provider = createTokenAuthProvider({ transport, store });

    const bad = await provider.login({ username: 'admin', password: 'wrong' });
    expect(bad.success).toBe(false);
    expect(store.read()).toBeNull();

    const good = await provider.login({ username: 'admin', password: 'demo-password' });
    expect(good.success).toBe(true);
    expect(good.redirectTo).toBe('/');
    expect(store.read()?.token).toBe('tok-9');
    expect(store.read()?.permissions).toEqual(['*']); // admin 投影 → 本地通配码
    expect(await provider.getPermissions?.({})).toEqual(['*']);
    const identity = await provider.getIdentity?.();
    expect(identity).toMatchObject({ userId: 'user-1', tenantId: 'default', displayName: '管理员' });
  });

  it('check：无会话跳登录；me 成功覆写存储；服务端拒绝清会话；网络失败保留会话', async () => {
    const store = createMemoryTokenSessionStore();
    let meBehavior: 'ok' | 'reject' | 'network' = 'ok';
    const transport: AuthTransport = {
      login: async () => payload(),
      me: async () => {
        if (meBehavior === 'reject') throw new AuthRejectedError('会话已失效');
        if (meBehavior === 'network') throw new Error('fetch failed');
        return payload({ token: 'tok-2', permissions: [permissionCode('role:read')] });
      },
      refresh: async () => payload(),
      logout: async () => undefined,
    };
    const provider = createTokenAuthProvider({ transport, store });

    expect(await provider.check({})).toEqual({ authenticated: false, redirectTo: '/login' });

    store.write(parseTokenSession({
      userId: 'user-1', tenantId: 'default', displayName: '管理员',
      permissions: [], token: 'tok-1', expiresAt: '2099-01-01T00:00:00.000Z',
    })!);

    meBehavior = 'ok';
    expect(await provider.check({})).toEqual({ authenticated: true });
    expect(store.read()?.token).toBe('tok-2'); // 服务端为准覆写
    expect(store.read()?.permissions).toEqual([permissionCode('role:read')]);

    meBehavior = 'network';
    expect(await provider.check({})).toEqual({ authenticated: true }); // 网络失败不清会话
    expect(store.read()).not.toBeNull();

    meBehavior = 'reject';
    expect(await provider.check({})).toMatchObject({ authenticated: false, logout: true });
    expect(store.read()).toBeNull(); // 服务端明确拒绝才清
  });

  it('logout：真实登出尽力而为（网络失败也清本地）', async () => {
    const store = createMemoryTokenSessionStore();
    let logoutCalled = false;
    const transport: AuthTransport = {
      login: async () => payload(),
      me: async () => payload(),
      refresh: async () => payload(),
      logout: async () => {
        logoutCalled = true;
        throw new Error('network down'); // 服务端登出失败
      },
    };
    const provider = createTokenAuthProvider({ transport, store });
    store.write(parseTokenSession({
      userId: 'user-1', tenantId: 'default', displayName: 'x',
      permissions: [], token: 'tok-1', expiresAt: '2099-01-01T00:00:00.000Z',
    })!);

    const result = await provider.logout({});
    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe('/login');
    expect(logoutCalled).toBe(true); // 真实登出被调用
    expect(store.read()).toBeNull(); // 本地照清
  });
});
