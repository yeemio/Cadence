/**
 * PermissionService —— RBAC 鉴权判定的业务入口（M1 增量 2-B）。
 *
 * 三条判定语义（各有单测锁定，见 tests/authorization.test.ts）：
 *  1. 租户隔离：角色绑定与权限授予都按域（tenant）收口，跨租户一律不成立；
 *  2. 精确权限码：模型零通配（authorization-model.ts），授予什么就只放行什么；
 *  3. admin bypass：用户在**当前租户**内持有 ADMIN_ROLE 即放行（业务层判定，
 *     不进 matcher——bypass 同样不跨租户）。
 *
 * 纯业务逻辑类：零 @nestjs import（装配纪律见 apps/server/README.md；
 * 组合根经 useFactory 构造，业务代码/单测直接 new）。
 * casbin enforcer 惰性初始化（构造是同步的，首个判定付一次性 init 成本）。
 */
import { newEnforcer, newModelFromString, type Enforcer } from 'casbin';
import type { TenantId, UserId } from '@smes/business-core';
import { ADMIN_ROLE, AUTHORIZATION_MODEL } from './authorization-model.js';
import { CasbinPolicyAdapter, tupleToRule } from './casbin-policy-adapter.js';
import { permissionCode, splitPermissionCode, type PermissionCode } from './permission-code.js';
import type { PolicyRule, PolicyStore, RoleName } from './policy-store.js';

export interface PermissionServiceOptions {
  /** 覆盖模型文本（版本化常量默认 v1；测试注入用）。 */
  readonly modelText?: string;
}

export class PermissionService {
  private enforcerPromise: Promise<Enforcer> | undefined;

  constructor(
    private readonly store: PolicyStore,
    private readonly options: PermissionServiceOptions = {},
  ) {}

  private ready(): Promise<Enforcer> {
    this.enforcerPromise ??= newEnforcer(
      newModelFromString(this.options.modelText ?? AUTHORIZATION_MODEL),
      new CasbinPolicyAdapter(this.store),
    );
    return this.enforcerPromise;
  }

  /** 判定：当前租户内用户是否持有权限码（含域内 admin bypass）。 */
  async authorize(tenant: TenantId, user: UserId, code: PermissionCode): Promise<boolean> {
    const enforcer = await this.ready();
    const rolesInTenant = await enforcer.getRolesForUserInDomain(user, tenant);
    if (rolesInTenant.includes(ADMIN_ROLE)) {
      return true;
    }
    const { resource, action } = splitPermissionCode(code);
    return enforcer.enforce(user, tenant, resource, action);
  }

  /** 当前租户内用户持有的角色清单（按域收口；观测/调试用）。 */
  async rolesOf(tenant: TenantId, user: UserId): Promise<readonly string[]> {
    const enforcer = await this.ready();
    return enforcer.getRolesForUserInDomain(user, tenant);
  }

  /**
   * 当前租户内角色被直接授予的权限码清单（p 规则投影；不含 admin bypass——
   * bypass 是身份属性不是可授予项）。形状异常的元组经 tupleToRule fail-fast。
   */
  async permissionsOfRole(tenant: TenantId, role: RoleName): Promise<readonly PermissionCode[]> {
    const enforcer = await this.ready();
    const tuples = await enforcer.getFilteredPolicy(0, role, tenant);
    return tuples.map((tuple) => {
      const rule = tupleToRule('p', tuple);
      if (rule.kind !== 'grant-permission') {
        throw new Error(`p 节意外出现非授权规则：${JSON.stringify(rule)}`);
      }
      return permissionCode(`${rule.resource}:${rule.action}`);
    });
  }

  /**
   * 当前租户内用户持有的权限码投影（/auth/me 用）：admin 是身份属性，
   * 单独以 admin=true 表达（权限码表为空）；普通用户 = 各角色被直接授予
   * 权限码的去重并集。
   */
  async permissionsOfUser(
    tenant: TenantId,
    user: UserId,
  ): Promise<{ readonly admin: boolean; readonly permissions: readonly PermissionCode[] }> {
    const enforcer = await this.ready();
    const roles = await enforcer.getRolesForUserInDomain(user, tenant);
    if (roles.includes(ADMIN_ROLE)) {
      return { admin: true, permissions: [] };
    }
    const codes = new Set<string>();
    for (const role of roles) {
      for (const code of await this.permissionsOfRole(tenant, role as RoleName)) {
        codes.add(code);
      }
    }
    return { admin: false, permissions: [...codes].map((code) => permissionCode(code)) };
  }

  /**
   * 注入策略规则：经 casbin autoSave 写通 PolicyStore（内存与存储同一变更路径，
   * 不出现两个事实源）。重复规则幂等（enforcer 去重 + store.append 幂等）。
   */
  async apply(rules: readonly PolicyRule[]): Promise<void> {
    const enforcer = await this.ready();
    for (const rule of rules) {
      if (rule.kind === 'grant-role') {
        await enforcer.addGroupingPolicy(rule.user, rule.role, rule.tenant);
      } else {
        await enforcer.addPolicy(rule.role, rule.tenant, rule.resource, rule.action);
      }
    }
  }

  /**
   * 撤销策略规则：与 apply 同一条 casbin autoSave 写通路径（M1 增量 3-D，
   * 组织管理的期望态授权需要移除侧）。幂等——enforcer 对不存在的规则
   * 返回 false 且不触发 adapter；store.remove 本身幂等。
   */
  async revoke(rules: readonly PolicyRule[]): Promise<void> {
    const enforcer = await this.ready();
    for (const rule of rules) {
      if (rule.kind === 'grant-role') {
        await enforcer.removeGroupingPolicy(rule.user, rule.role, rule.tenant);
      } else {
        await enforcer.removePolicy(rule.role, rule.tenant, rule.resource, rule.action);
      }
    }
  }
}
