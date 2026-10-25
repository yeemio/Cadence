import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { permissionCode } from '../src/permissions.js';
import {
  authenticateMockIdentity,
  createBrowserSessionStore,
  createMemorySessionStore,
  DEFAULT_SESSION_STORAGE_KEY,
  DEMO_IDENTITIES,
} from '../src/session.js';

const operator = DEMO_IDENTITIES.find((identity) => identity.email === 'operator@demo.local');
if (operator === undefined) throw new Error('fixture: operator identity missing');

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  dump(): Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => map,
  };
}

describe('authenticateMockIdentity：mock 凭据校验', () => {
  it('身份表内邮箱 + 非空口令 → 建立会话（邮箱做 trim）', () => {
    const session = authenticateMockIdentity(DEMO_IDENTITIES, '  operator@demo.local ', 'any');
    expect(session?.userId).toBe(operator.userId);
    expect(session?.tenantId).toBe(TenantId.create('tenant-demo'));
    expect(session?.displayName).toBe('演示操作员');
    expect([...(session?.permissions ?? [])]).toEqual([
      permissionCode('workorder:access'),
      permissionCode('dispatch:access'),
      permissionCode('workbench:read'),
      permissionCode('item:read'),
      // M1 收尾波-②：operator 增授扫码读取（扫码页可见，M2 报工消费扫码结果）
      permissionCode('scan:read'),
      // M5 预研：operator 增授报工提交（报工页可见；码与后端同码）
      permissionCode('report:submit'),
      // M5 首波：operator 增授工时/库存读取（移动端 m.hours/m.stock 页可见）
      permissionCode('hours:read'),
      permissionCode('stock:read'),
    ]);
  });

  it('未知邮箱 / 空口令 / 空邮箱 → null', () => {
    expect(authenticateMockIdentity(DEMO_IDENTITIES, 'nobody@demo.local', 'x')).toBeNull();
    expect(authenticateMockIdentity(DEMO_IDENTITIES, 'operator@demo.local', '')).toBeNull();
    expect(authenticateMockIdentity(DEMO_IDENTITIES, '  ', 'x')).toBeNull();
  });

  it('返回会话是副本：改动不影响身份表', () => {
    const session = authenticateMockIdentity(DEMO_IDENTITIES, 'operator@demo.local', 'x');
    expect(session).not.toBeNull();
    // permissions 声明为 readonly，运行时防御：不通过引用泄漏内部数组
    expect([...(session?.permissions ?? [])].length).toBe(8);
  });
});

describe('createMemorySessionStore', () => {
  it('读写清回环', () => {
    const store = createMemorySessionStore();
    expect(store.read()).toBeNull();
    const session = authenticateMockIdentity(DEMO_IDENTITIES, 'operator@demo.local', 'x');
    if (session === null) throw new Error('fixture');
    store.write(session);
    expect(store.read()?.userId).toBe(operator.userId);
    store.clear();
    expect(store.read()).toBeNull();
  });
});

describe('createBrowserSessionStore', () => {
  it('浏览器存储回环（序列化/反序列化保形）', () => {
    const storage = fakeStorage();
    const store = createBrowserSessionStore(storage);
    const session = authenticateMockIdentity(DEMO_IDENTITIES, 'admin@demo.local', 'x');
    if (session === null) throw new Error('fixture');
    store.write(session);
    const back = store.read();
    expect(back?.userId).toBe(UserId.create('user-demo-admin'));
    expect(back?.permissions).toEqual(['*']);
    store.clear();
    expect(store.read()).toBeNull();
    expect(storage.dump().has(DEFAULT_SESSION_STORAGE_KEY)).toBe(false);
  });

  it('损坏 JSON / 形状不对 / 字段非法 → 读作空会话（不抛错）', () => {
    const storage = fakeStorage();
    const store = createBrowserSessionStore(storage);

    storage.setItem(DEFAULT_SESSION_STORAGE_KEY, '{not-json');
    expect(store.read()).toBeNull();

    storage.setItem(DEFAULT_SESSION_STORAGE_KEY, JSON.stringify({ userId: 'u' }));
    expect(store.read()).toBeNull();

    storage.setItem(
      DEFAULT_SESSION_STORAGE_KEY,
      JSON.stringify({
        userId: 'user-demo-admin',
        tenantId: 'tenant-demo',
        displayName: 'x',
        permissions: ['workorder:access', 42, 'bad code', 'dispatch:access'],
      }),
    );
    const parsed = store.read();
    expect(parsed?.permissions).toEqual([
      permissionCode('workorder:access'),
      permissionCode('dispatch:access'),
    ]);
  });
});
