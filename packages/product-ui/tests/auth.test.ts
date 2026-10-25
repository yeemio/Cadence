import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSION, permissionCode } from '../src/permissions.js';
import {
  createMockAuthProvider,
  sessionHasPermission,
  toPermissionCodes,
} from '../src/auth.js';
import { createMemorySessionStore } from '../src/session.js';

const operatorLogin = { email: 'operator@demo.local', password: 'any' };

describe('createMockAuthProvider：refine v5 契约骨架', () => {
  it('login：凭据命中 → success + 写会话 + redirectTo 首页', async () => {
    const store = createMemorySessionStore();
    const provider = createMockAuthProvider({ store });
    const result = await provider.login(operatorLogin);
    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe('/');
    expect(store.read()?.displayName).toBe('演示操作员');
  });

  it('login：凭据不命中 → success:false + 不写会话', async () => {
    const store = createMemorySessionStore();
    const provider = createMockAuthProvider({ store });
    const result = await provider.login({ email: 'nobody@demo.local', password: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(store.read()).toBeNull();
  });

  it('check：有会话 authenticated:true；无会话 authenticated:false + redirectTo 登录页', async () => {
    const store = createMemorySessionStore();
    const provider = createMockAuthProvider({ store });

    const before = await provider.check();
    expect(before).toEqual({ authenticated: false, redirectTo: '/login' });

    await provider.login(operatorLogin);
    const after = await provider.check();
    expect(after).toEqual({ authenticated: true });
  });

  it('logout：清会话 + redirectTo 登录页', async () => {
    const store = createMemorySessionStore();
    const provider = createMockAuthProvider({ store });
    await provider.login(operatorLogin);
    const result = await provider.logout({});
    expect(result).toEqual({ success: true, redirectTo: '/login' });
    expect(store.read()).toBeNull();
  });

  it('getPermissions / getIdentity：随会话走', async () => {
    const provider = createMockAuthProvider({ store: createMemorySessionStore() });
    expect(await provider.getPermissions?.()).toEqual([]);
    expect(await provider.getIdentity?.()).toBeNull();

    await provider.login(operatorLogin);
    expect(await provider.getPermissions?.()).toEqual([
      permissionCode('workbench:read'),
      permissionCode('item:read'),
      // M1 收尾波-②：operator 增授 scan:read（与 session.test 同步）
      permissionCode('scan:read'),
      // M5 预研：operator 增授 report:submit（报工页可见；与 session.test 同步）
      permissionCode('report:submit'),
      // M5 首波：operator 增授 hours:read / stock:read（移动端页可见；与 session.test 同步）
      permissionCode('hours:read'),
      permissionCode('stock:read'),
      // S2 批次：桌面菜单码切后端实态 :read 码（与 session.test 同步）
      permissionCode('workorder:read'),
      permissionCode('parts:read'),
      permissionCode('listing:read'),
      permissionCode('gap:read'),
      permissionCode('dispatch:read'),
      permissionCode('outsourcing:read'),
      permissionCode('report:read'),
      // S3-d：operator 增授 parts:request / fault:report（移动端 m.parts/m.fault
      // 可见；与 session.test 同步——桌面菜单门控在 :read 码，桌面可见面不变）
      permissionCode('parts:request'),
      permissionCode('fault:report'),
    ]);
    expect(await provider.getIdentity?.()).toEqual({
      userId: 'user-demo-operator',
      tenantId: 'tenant-demo',
      displayName: '演示操作员',
    });
  });

  it('onError：骨架恒返回空对象（refine v5 必选方法）', async () => {
    const provider = createMockAuthProvider();
    await expect(provider.onError(new Error('x'))).resolves.toEqual({});
  });

  it('loginPath / homePath 可注入（登录 MPA 与主壳装配同参）', async () => {
    const provider = createMockAuthProvider({
      store: createMemorySessionStore(),
      loginPath: '/auth',
      homePath: '/workbench',
    });
    const failed = await provider.check();
    expect(failed.authenticated).toBe(false);
    expect(failed.redirectTo).toBe('/auth');
    const ok = await provider.login({ ...operatorLogin });
    expect(ok.redirectTo).toBe('/workbench');
  });
});

describe('权限辅助', () => {
  it('toPermissionCodes：unknown 收敛为合法权限码数组', () => {
    expect(toPermissionCodes(undefined)).toEqual([]);
    expect(toPermissionCodes('workorder:access')).toEqual([]);
    expect(toPermissionCodes(['workorder:access', 42, null, 'bad code'])).toEqual([
      permissionCode('workorder:access'),
    ]);
  });

  it('sessionHasPermission：admin bypass 与精确码', () => {
    expect(sessionHasPermission([ADMIN_PERMISSION], permissionCode('system:access'))).toBe(true);
    expect(
      sessionHasPermission([permissionCode('system:access')], permissionCode('system:access')),
    ).toBe(true);
    expect(
      sessionHasPermission([permissionCode('system:access')], permissionCode('workorder:access')),
    ).toBe(false);
  });
});
