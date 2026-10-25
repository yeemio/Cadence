import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import {
  ADMIN_ROLE,
  AUTHORIZATION_MODEL,
  AUTHORIZATION_MODEL_VERSION,
  InMemoryPolicyStore,
  PermissionCodeError,
  PermissionService,
  isPermissionCode,
  parsePolicyRule,
  permissionCode,
  PolicyRuleError,
  roleName,
} from '../src/index.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('alice');
const bob = UserId.create('bob');

const demoRead = permissionCode('demo:read');
const demoWrite = permissionCode('demo:write');

/** 常用夹具：operator 角色在 t1 持 demo:read，授予 alice。 */
async function fixtureTenant1Operator(): Promise<PermissionService> {
  const service = new PermissionService(new InMemoryPolicyStore());
  await service.apply([
    {
      kind: 'grant-role',
      tenant: t1,
      user: alice,
      role: roleName('operator'),
    },
    {
      kind: 'grant-permission',
      tenant: t1,
      role: roleName('operator'),
      resource: 'demo',
      action: 'read',
    },
  ]);
  return service;
}

describe('权限码（ADR-0010 <环节>:<动作> 通用词汇纪律）', () => {
  it('合法形状通过，非法形状在构造期抛错', () => {
    expect(isPermissionCode('demo:read')).toBe(true);
    expect(isPermissionCode('workorder:dispatch')).toBe(true);
    expect(permissionCode('demo:read')).toBe('demo:read');
    expect(() => permissionCode('Demo:Read')).toThrow(PermissionCodeError);
    expect(() => permissionCode('demo')).toThrow(PermissionCodeError);
    expect(() => permissionCode('demo:read:x')).toThrow(PermissionCodeError);
    expect(() => permissionCode('demo:*')).toThrow(PermissionCodeError);
    expect(() => permissionCode('*:*')).toThrow(PermissionCodeError);
  });
});

describe('casbin 域模型语义（M1 增量 2-B Done-when 2）', () => {
  it('语义一：租户隔离——t1 授予的角色与权限对 t2 全部不生效', async () => {
    const service = await fixtureTenant1Operator();
    expect(await service.authorize(t1, alice, demoRead)).toBe(true);
    // 同一用户、同一权限码、另一租户：角色绑定与 p 规则都按域收口
    expect(await service.authorize(t2, alice, demoRead)).toBe(false);
    // t2 中同角色名的 p 规则也不存在——角色名不跨域泄漏
    expect(await service.rolesOf(t2, alice)).toEqual([]);
    expect(await service.rolesOf(t1, alice)).toEqual(['operator']);
  });

  it('语义二：精确权限码——授予 demo:read 不旁通 demo:write / 相邻资源', async () => {
    const service = await fixtureTenant1Operator();
    expect(await service.authorize(t1, alice, demoRead)).toBe(true);
    expect(await service.authorize(t1, alice, demoWrite)).toBe(false);
    expect(await service.authorize(t1, alice, permissionCode('demo:list'))).toBe(false);
    expect(await service.authorize(t1, alice, permissionCode('other:read'))).toBe(false);
    // 未授权用户一律拒绝（无身份=无策略命中）
    expect(await service.authorize(t1, bob, demoRead)).toBe(false);
  });

  it('语义三：admin bypass——域内 admin 全量放行，且不跨租户', async () => {
    const service = new PermissionService(new InMemoryPolicyStore());
    await service.apply([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName(ADMIN_ROLE) },
    ]);
    // t1 内未配置任何 p 规则，admin 仍放行（bypass）
    expect(await service.authorize(t1, alice, demoRead)).toBe(true);
    expect(await service.authorize(t1, alice, demoWrite)).toBe(true);
    // admin 身份只在 t1 成立
    expect(await service.authorize(t2, alice, demoRead)).toBe(false);
    // 其他人不因存在 admin 角色名而受益
    expect(await service.authorize(t1, bob, demoRead)).toBe(false);
  });

  it('模型文本版本化钉（v1 = RBAC with domains、零通配 matcher）', () => {
    expect(AUTHORIZATION_MODEL_VERSION).toBe('v1');
    expect(AUTHORIZATION_MODEL).toContain('r = sub, dom, obj, act');
    expect(AUTHORIZATION_MODEL).toContain('g = _, _, _');
    expect(AUTHORIZATION_MODEL).toContain(
      'm = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act',
    );
    expect(AUTHORIZATION_MODEL).not.toContain('keyMatch');
    expect(AUTHORIZATION_MODEL).not.toContain('*');
  });

  it('apply 写通存储：store 与内存判定同源（重启等价性）', async () => {
    const store = new InMemoryPolicyStore();
    const service = new PermissionService(store);
    await service.apply([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
      {
        kind: 'grant-permission',
        tenant: t1,
        role: roleName('operator'),
        resource: 'demo',
        action: 'read',
      },
    ]);
    const persisted = await store.load();
    expect(persisted).toHaveLength(2);
    // 用同一 store 重建 enforcer（模拟重启后从存储加载）判定结果不变
    const reborn = new PermissionService(store);
    expect(await reborn.authorize(t1, alice, demoRead)).toBe(true);
    expect(await reborn.authorize(t2, alice, demoRead)).toBe(false);
  });
});

describe('策略规则解析（PolicyStore 端口边界校验）', () => {
  it('合法规则解析并品牌化；非法规则抛 PolicyRuleError', () => {
    expect(parsePolicyRule({ kind: 'grant-role', tenant: 't1', user: 'alice', role: 'admin' }))
      .toEqual({ kind: 'grant-role', tenant: 't1', user: 'alice', role: 'admin' });
    expect(
      parsePolicyRule({
        kind: 'grant-permission',
        tenant: 't1',
        role: 'operator',
        resource: 'demo',
        action: 'read',
      }),
    ).toEqual({
      kind: 'grant-permission',
      tenant: 't1',
      role: 'operator',
      resource: 'demo',
      action: 'read',
    });

    expect(() => parsePolicyRule('nope')).toThrow(PolicyRuleError);
    expect(() => parsePolicyRule({ kind: 'grant-role' })).toThrow(PolicyRuleError);
    expect(() =>
      parsePolicyRule({ kind: 'grant-role', tenant: 't1', user: 'alice', role: 'Admin' }),
    ).toThrow(PolicyRuleError);
    expect(() =>
      parsePolicyRule({ kind: 'grant-permission', tenant: 't1', role: 'operator', resource: 'demo' }),
    ).toThrow(PolicyRuleError);
    expect(() => parsePolicyRule({ kind: 'unknown', tenant: 't1' })).toThrow(PolicyRuleError);
  });
});
