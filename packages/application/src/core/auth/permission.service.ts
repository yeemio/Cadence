/**
 * PermissionService —— RBAC 鉴权判定的业务入口（M1 增量 2-B）。
 *
 * 三条判定语义（各有单测锁定，见 tests/authorization.test.ts）：
 *  1. 租户隔离：角色绑定与权限授予都按域（tenant）收口，跨租户一律不成立；
 *  2. 精确权限码：模型零通配（authorization-model.ts），授予什么就只放行什么；
 *  3. admin bypass：用户在**当前租户**内持有 ADMIN_ROLE 即放行（业务层判定，
 *     不进 matcher——bypass 同样不跨租户）。
 *
 * enforcer 按租户隔离（D-1 修复）：每租户一个惰性 enforcer（Map 缓存初始化
 * promise）。进程级单例会让**首个初始化租户的策略快照吞并其余租户**——PG +
 * FORCE RLS 形态下 store.load() 只读得到初始化时 RLS 会话租户的行，重启后
 * 谁先访问谁独占，其他租户管理员全部 403。每租户的 adapter 以该租户收口
 * 装载（见 casbin-policy-adapter.ts 头注释的加载上下文合同：server 请求路径
 * 由租户中间件保证初始化发生在目标租户 RLS 上下文内）。写路径（apply/revoke）
 * 按规则自带的 tenant 逐租户路由，autoSave 写通后对应租户 enforcer 内存与
 * store 同步。多实例部署的跨进程 enforcer 失效广播不在本修复范围（M1 已登记
 * 推迟项）。
 * RLS 形态的已知限制：apply/revoke 批量混入非当前请求租户的规则时，非上下文
 * 租户的 enforcer 初始化会读不到该租户已有策略行，且写通被 PG WITH CHECK 拒
 * （fail-visible 非泄漏）——当前请求路径无混租户批量调用方，如需支持须经
 * runWithRlsTenant 显式逐租户包裹。
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

/** 规则按租户分组（首现序）：apply/revoke 逐租户路由的输入形状。 */
function groupRulesByTenant(rules: readonly PolicyRule[]): Map<TenantId, PolicyRule[]> {
  const grouped = new Map<TenantId, PolicyRule[]>();
  for (const rule of rules) {
    const bucket = grouped.get(rule.tenant);
    if (bucket === undefined) {
      grouped.set(rule.tenant, [rule]);
    } else {
      bucket.push(rule);
    }
  }
  return grouped;
}

export class PermissionService {
  /** 按租户隔离的 enforcer 缓存：tenant 字符串 -> 初始化 promise。 */
  private readonly enforcers = new Map<string, Promise<Enforcer>>();

  constructor(
    private readonly store: PolicyStore,
    private readonly options: PermissionServiceOptions = {},
  ) {}

  /**
   * 取指定租户的 enforcer（不存在则初始化并缓存）。初始化失败（如加载期
   * 存储故障）不缓存坏 promise——剔除后下次判定可重试，不让一次瞬态故障
   * 钉死该租户直到重启。
   */
  private readyFor(tenant: TenantId): Promise<Enforcer> {
    const key = String(tenant);
    let promise = this.enforcers.get(key);
    if (promise === undefined) {
      promise = newEnforcer(
        newModelFromString(this.options.modelText ?? AUTHORIZATION_MODEL),
        new CasbinPolicyAdapter(this.store, tenant),
      ).catch((error: unknown) => {
        this.enforcers.delete(key);
        throw error;
      });
      this.enforcers.set(key, promise);
    }
    return promise;
  }

  /** 判定：当前租户内用户是否持有权限码（含域内 admin bypass）。 */
  async authorize(tenant: TenantId, user: UserId, code: PermissionCode): Promise<boolean> {
    const enforcer = await this.readyFor(tenant);
    const rolesInTenant = await enforcer.getRolesForUserInDomain(user, tenant);
    if (rolesInTenant.includes(ADMIN_ROLE)) {
      return true;
    }
    const { resource, action } = splitPermissionCode(code);
    return enforcer.enforce(user, tenant, resource, action);
  }

  /** 当前租户内用户持有的角色清单（按域收口；观测/调试用）。 */
  async rolesOf(tenant: TenantId, user: UserId): Promise<readonly string[]> {
    const enforcer = await this.readyFor(tenant);
    return enforcer.getRolesForUserInDomain(user, tenant);
  }

  /**
   * 当前租户内角色被直接授予的权限码清单（p 规则投影；不含 admin bypass——
   * bypass 是身份属性不是可授予项）。形状异常的元组经 tupleToRule fail-fast。
   */
  async permissionsOfRole(tenant: TenantId, role: RoleName): Promise<readonly PermissionCode[]> {
    const enforcer = await this.readyFor(tenant);
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
    const enforcer = await this.readyFor(tenant);
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
   * 规则按自带 tenant 逐租户路由到对应 enforcer（D-1：批量混入多租户规则时
   * 各归各的 enforcer，不串内存）。
   */
  async apply(rules: readonly PolicyRule[]): Promise<void> {
    for (const [tenant, tenantRules] of groupRulesByTenant(rules)) {
      const enforcer = await this.readyFor(tenant);
      for (const rule of tenantRules) {
        if (rule.kind === 'grant-role') {
          await enforcer.addGroupingPolicy(rule.user, rule.role, rule.tenant);
        } else {
          await enforcer.addPolicy(rule.role, rule.tenant, rule.resource, rule.action);
        }
      }
    }
  }

  /**
   * 撤销策略规则：与 apply 同一条 casbin autoSave 写通路径（M1 增量 3-D，
   * 组织管理的期望态授权需要移除侧），同样按规则自带 tenant 逐租户路由。
   * 幂等——enforcer 对不存在的规则返回 false 且不触发 adapter；store.remove
   * 本身幂等。
   */
  async revoke(rules: readonly PolicyRule[]): Promise<void> {
    for (const [tenant, tenantRules] of groupRulesByTenant(rules)) {
      const enforcer = await this.readyFor(tenant);
      for (const rule of tenantRules) {
        if (rule.kind === 'grant-role') {
          await enforcer.removeGroupingPolicy(rule.user, rule.role, rule.tenant);
        } else {
          await enforcer.removePolicy(rule.role, rule.tenant, rule.resource, rule.action);
        }
      }
    }
  }
}
