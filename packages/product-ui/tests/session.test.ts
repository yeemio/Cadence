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
      permissionCode('workbench:read'),
      permissionCode('item:read'),
      // M1 收尾波-②：operator 增授扫码读取（扫码页可见，M2 报工消费扫码结果）
      permissionCode('scan:read'),
      // M5 预研：operator 增授报工提交（报工页可见；码与后端同码）
      permissionCode('report:submit'),
      // M5 首波：operator 增授工时/库存读取（移动端 m.hours/m.stock 页可见）
      permissionCode('hours:read'),
      permissionCode('stock:read'),
      // S2 批次：桌面菜单码切后端实态 :read 码——车间岗位桌面可见面（制造运营 +
      // 报工 + 工时统计；采购/质检/盘点/发货/成本/工艺基线不授予）。
      // workorder:access / dispatch:access 两占位码随占位页退役移除。
      permissionCode('workorder:read'),
      permissionCode('parts:read'),
      permissionCode('listing:read'),
      permissionCode('gap:read'),
      permissionCode('dispatch:read'),
      permissionCode('outsourcing:read'),
      permissionCode('report:read'),
      // S3-d：移动端 m.parts/m.fault 可见（117 配件申请/127 故障上报是现场
      // 工人动作；桌面菜单门控全在 :read 码，桌面可见面不变）
      permissionCode('parts:request'),
      permissionCode('fault:report'),
    ]);
  });

  it('身份表含演示班长（S3-d 移动动作码承载——16 码精确匹配，无通配）', () => {
    const lead = DEMO_IDENTITIES.find((identity) => identity.email === 'lead@demo.local');
    if (lead === undefined) throw new Error('fixture: lead identity missing');
    expect(lead.permissions).not.toContain('*');
    expect([...lead.permissions]).toEqual([
      permissionCode('workbench:read'),
      permissionCode('report:read'),
      permissionCode('report:verify'),
      permissionCode('workorder:read'),
      permissionCode('parts:read'),
      permissionCode('parts:request'),
      permissionCode('parts:approve'),
      permissionCode('inspection:read'),
      permissionCode('inspection:judge'),
      permissionCode('fault:report'),
      permissionCode('stock:read'),
      permissionCode('stock:receive'),
      permissionCode('stock:transfer'),
      permissionCode('stocktake:read'),
      permissionCode('stocktake:record'),
      permissionCode('stocktake:approve'),
    ]);
    const session = authenticateMockIdentity(DEMO_IDENTITIES, 'lead@demo.local', 'demo-password');
    expect(session?.displayName).toBe('演示班长');
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
    // S3-d：operator 13 → 15（parts:request + fault:report）
    expect([...(session?.permissions ?? [])].length).toBe(15);
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
