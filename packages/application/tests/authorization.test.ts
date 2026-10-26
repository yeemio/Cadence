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
  type PolicyRule,
  type PolicyStore,
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

// ---- D-1 修复：按租户隔离 enforcer（SaaS + FORCE RLS 形态回归钉）----

function ruleKey(rule: PolicyRule): string {
  return rule.kind === 'grant-role'
    ? `g|${rule.tenant}|${rule.user}|${rule.role}`
    : `p|${rule.tenant}|${rule.role}|${rule.resource}|${rule.action}`;
}

/**
 * RLS 模拟 store（D-1 单测复现用）：visibleTenant 模拟 FORCE RLS 会话租户——
 * load() 只返回该租户的行（undefined = superuser / 内存形态全量可见）。
 * append/remove 幂等并记录写通调用，供 apply/revoke 路由断言。
 */
class RlsSimPolicyStore implements PolicyStore {
  readonly appended: PolicyRule[] = [];
  readonly removed: PolicyRule[] = [];
  private readonly rules = new Map<string, PolicyRule>();

  constructor(rules: readonly PolicyRule[], public visibleTenant?: TenantId) {
    for (const rule of rules) {
      this.rules.set(ruleKey(rule), rule);
    }
  }

  async load(): Promise<readonly PolicyRule[]> {
    return [...this.rules.values()].filter(
      (rule) => this.visibleTenant === undefined || rule.tenant === this.visibleTenant,
    );
  }

  async append(rules: readonly PolicyRule[]): Promise<void> {
    for (const rule of rules) {
      if (!this.rules.has(ruleKey(rule))) {
        this.rules.set(ruleKey(rule), rule);
        this.appended.push(rule);
      }
    }
  }

  async remove(rules: readonly PolicyRule[]): Promise<void> {
    for (const rule of rules) {
      if (this.rules.delete(ruleKey(rule))) {
        this.removed.push(rule);
      }
    }
  }
}

describe('按租户隔离 enforcer（D-1：进程级单例吞并首个初始化租户的修复）', () => {
  it('RLS 形态：两租户先后初始化互不吞并，bypass 不跨租户不回归', async () => {
    const store = new RlsSimPolicyStore([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName(ADMIN_ROLE) },
      { kind: 'grant-role', tenant: t2, user: bob, role: roleName(ADMIN_ROLE) },
    ]);
    const service = new PermissionService(store);

    // 重启后先访问 t1：RLS 可见集 = t1（旧实现在此缓存进程级单例 enforcer）
    store.visibleTenant = t1;
    expect(await service.authorize(t1, alice, demoRead)).toBe(true);

    // 再访问 t2：t2 管理员不再被 t1 的策略快照吞并（旧实现此处 false = D-1）
    store.visibleTenant = t2;
    expect(await service.authorize(t2, bob, demoRead)).toBe(true);

    // 回到 t1 仍正常（两个 enforcer 独立缓存，先初始化者不被后到者挤掉）
    store.visibleTenant = t1;
    expect(await service.authorize(t1, alice, demoWrite)).toBe(true);

    // bypass 不跨租户不回归：alice 的 admin 只在 t1 成立
    store.visibleTenant = t2;
    expect(await service.authorize(t2, alice, demoRead)).toBe(false);
    expect(await service.rolesOf(t2, alice)).toEqual([]);
  });

  it('apply/revoke 按规则自带租户路由（多租户批量不串 enforcer，写通不丢）', async () => {
    const store = new RlsSimPolicyStore([]);
    const service = new PermissionService(store);

    // 先在 t1 上下文初始化 t1 的 enforcer（此时无任何规则）
    store.visibleTenant = t1;
    expect(await service.authorize(t1, alice, demoRead)).toBe(false);

    // 多租户规则批量（模拟 t2 请求上下文）：逐租户路由到对应 enforcer
    store.visibleTenant = t2;
    await service.apply([
      { kind: 'grant-role', tenant: t2, user: bob, role: roleName('operator') },
      {
        kind: 'grant-permission',
        tenant: t2,
        role: roleName('operator'),
        resource: 'demo',
        action: 'read',
      },
      {
        kind: 'grant-permission',
        tenant: t1,
        role: roleName('operator'),
        resource: 'demo',
        action: 'read',
      },
    ]);
    expect(store.appended).toHaveLength(3);

    // t2 内生效且精确（不旁通 demo:write）
    expect(await service.authorize(t2, bob, demoRead)).toBe(true);
    expect(await service.authorize(t2, bob, demoWrite)).toBe(false);
    // 不串租户：t1 的 alice 未获得角色绑定
    expect(await service.authorize(t1, alice, demoRead)).toBe(false);

    // revoke 同一条 autoSave 路径按租户路由
    await service.revoke([{ kind: 'grant-role', tenant: t2, user: bob, role: roleName('operator') }]);
    expect(await service.authorize(t2, bob, demoRead)).toBe(false);
    expect(store.removed).toHaveLength(1);
  });

  it('全量可见 store（内存/superuser 形态）：同名角色的租户切片互不泄漏', async () => {
    const store = new RlsSimPolicyStore([
      { kind: 'grant-role', tenant: t1, user: alice, role: roleName('operator') },
      { kind: 'grant-permission', tenant: t1, role: roleName('operator'), resource: 'demo', action: 'read' },
      { kind: 'grant-role', tenant: t2, user: bob, role: roleName('operator') },
      { kind: 'grant-permission', tenant: t2, role: roleName('operator'), resource: 'demo', action: 'read' },
      { kind: 'grant-permission', tenant: t2, role: roleName('operator'), resource: 'demo', action: 'write' },
    ]);
    const service = new PermissionService(store);

    // load() 全量可见，但每个 enforcer 只持有自己租户的切片
    expect(await service.authorize(t1, alice, demoRead)).toBe(true);
    expect(await service.authorize(t1, alice, demoWrite)).toBe(false); // t2 的 write 授权不泄漏进 t1
    expect(await service.authorize(t2, bob, demoWrite)).toBe(true);
    expect(await service.authorize(t2, alice, demoWrite)).toBe(false); // 角色绑定不跨租户
    expect(await service.rolesOf(t2, alice)).toEqual([]);
    // permissionsOfRole 按租户投影各自切片
    expect(await service.permissionsOfRole(t1, roleName('operator'))).toEqual(['demo:read']);
    expect(await service.permissionsOfRole(t2, roleName('operator'))).toEqual(['demo:read', 'demo:write']);
  });
});
