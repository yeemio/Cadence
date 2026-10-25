/**
 * InMemoryPolicyStore —— PolicyStore 端口的内存实现（M1 先行形态）。
 * 重启即失（无持久化）；PG adapter 由 business-store 线按同端口接入。
 * append/remove 均幂等（按规则键去重），纯数据结构，零框架依赖。
 */
import type { PolicyRule, PolicyStore } from './policy-store.js';

function ruleKey(rule: PolicyRule): string {
  return rule.kind === 'grant-role'
    ? `grant-role|${rule.tenant}|${rule.user}|${rule.role}`
    : `grant-permission|${rule.tenant}|${rule.role}|${rule.resource}|${rule.action}`;
}

export class InMemoryPolicyStore implements PolicyStore {
  private readonly rules = new Map<string, PolicyRule>();

  async load(): Promise<readonly PolicyRule[]> {
    return [...this.rules.values()];
  }

  async append(rules: readonly PolicyRule[]): Promise<void> {
    for (const rule of rules) {
      const key = ruleKey(rule);
      if (!this.rules.has(key)) {
        this.rules.set(key, rule);
      }
    }
  }

  async remove(rules: readonly PolicyRule[]): Promise<void> {
    for (const rule of rules) {
      this.rules.delete(ruleKey(rule));
    }
  }
}
