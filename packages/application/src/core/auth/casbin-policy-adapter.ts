/**
 * casbin Adapter 桥：casbin 原生策略元组 <-> PolicyStore 业务形状 的唯一翻译点。
 *
 * 翻译表（模型文本见 authorization-model.ts）：
 *   g 元组 [user, role, tenant]         <-> { kind: 'grant-role', ... }
 *   p 元组 [role, tenant, resource, action] <-> { kind: 'grant-permission', ... }
 *
 * 租户收口（D-1 修复）：构造时可传入 tenant，loadPolicy 只灌入该租户的策略
 * 切片（业务规则按 rule.tenant 过滤）。 PolicyStore.load() 端口不变——可见集
 * 由实现方决定：PG + FORCE RLS 形态下 SQL 层已按 RLS 会话租户收口；内存 /
 * superuser（全量可见）形态由本过滤兜底。**RLS 形态的加载上下文合同**：本
 * adapter 不感知 ALS/RLS 会话，初始化时读到的即 store.load() 当时的可见集——
 * 调用方（PermissionService.readyFor）须保证 enforcer 初始化发生在目标租户
 * 上下文内（server 请求路径由 main.ts 租户中间件的 runWithRlsTenant +
 * tenantContext 复合同点保证；后台任务/种子脚本须自行 runWithRlsTenant 包裹，
 * 见 business-store rls-session.ts 既有合同）。
 *
 * enforcer autoSave 开启（casbin 默认）：addPolicy/addGroupingPolicy 先更新内存，
 * 再写通本 adapter -> PolicyStore.append。savePolicy（全量覆写）与
 * removeFilteredPolicy（条件删除）不在本增量任何调用路径上，显式抛错而非静默。
 */
import type { Adapter, Model } from 'casbin';
import { TenantId, UserId } from '@smes/business-core';
import { PolicyRuleError, roleName, type PolicyRule, type PolicyStore } from './policy-store.js';

export class UnsupportedPolicyOperationError extends Error {
  constructor(operation: string) {
    super(`PolicyStore 端口不支持的操作：${operation}`);
    this.name = 'UnsupportedPolicyOperationError';
  }
}

/** 业务规则 -> casbin 元组。 */
export function ruleToTuple(rule: PolicyRule): { sec: 'p' | 'g'; tuple: string[] } {
  return rule.kind === 'grant-role'
    ? { sec: 'g', tuple: [rule.user, rule.role, rule.tenant] }
    : { sec: 'p', tuple: [rule.role, rule.tenant, rule.resource, rule.action] };
}

/** casbin (sec, 元组) -> 业务规则；形状不符抛 PolicyRuleError（fail-fast，不猜）。 */
export function tupleToRule(sec: string, tuple: readonly string[]): PolicyRule {
  const [first, second, third, fourth] = tuple;
  const need = (n: number): void => {
    if (tuple.length !== n || tuple.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new PolicyRuleError(`casbin '${sec}' 元组形状非法：${JSON.stringify(tuple)}`);
    }
  };
  if (sec === 'g') {
    need(3);
    return {
      kind: 'grant-role',
      user: UserId.create(first as string),
      role: roleName(second as string),
      tenant: TenantId.create(third as string),
    };
  }
  if (sec === 'p') {
    need(4);
    return {
      kind: 'grant-permission',
      role: roleName(first as string),
      tenant: TenantId.create(second as string),
      resource: third as string,
      action: fourth as string,
    };
  }
  throw new PolicyRuleError(`casbin 未知策略节 '${sec}'（本模型只有 p/g）`);
}

export class CasbinPolicyAdapter implements Adapter {
  constructor(
    private readonly store: PolicyStore,
    /** 租户收口（D-1）：设置后本 adapter 只装载/持有该租户的策略切片。 */
    private readonly tenant?: TenantId,
  ) {}

  /** casbin 初始加载：读 PolicyStore，按构造租户过滤后灌入 model。 */
  async loadPolicy(model: Model): Promise<void> {
    const rules = await this.store.load();
    for (const rule of rules) {
      if (this.tenant !== undefined && rule.tenant !== this.tenant) {
        continue; // 全量可见 store（内存/superuser）形态的租户收口兜底
      }
      const { sec, tuple } = ruleToTuple(rule);
      // key 与 sec 同名（p/g 单策略节模型约定）
      model.addPolicy(sec, sec, [...tuple]);
    }
  }

  /** autoSave 写通：新增策略行落库（store.append 幂等）。 */
  async addPolicy(sec: string, _ptype: string, rule: string[]): Promise<void> {
    await this.store.append([tupleToRule(sec, rule)]);
  }

  /** autoSave 写通：删除策略行落库（store.remove 幂等）。 */
  async removePolicy(sec: string, _ptype: string, rule: string[]): Promise<void> {
    await this.store.remove([tupleToRule(sec, rule)]);
  }

  async removeFilteredPolicy(): Promise<void> {
    throw new UnsupportedPolicyOperationError('removeFilteredPolicy（条件删除）');
  }

  async savePolicy(): Promise<boolean> {
    throw new UnsupportedPolicyOperationError('savePolicy（全量覆写）');
  }
}
