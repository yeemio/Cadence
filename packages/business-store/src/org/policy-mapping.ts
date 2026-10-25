/**
 * PolicyRule <-> policies 表行 的纯映射（M1 增量 3-D）。
 *
 * 本文件零 Prisma 依赖（行形状为本地结构类型，Prisma 生成类型按结构兼容）：
 * 规范键 policyRuleKey 与 application 内存实现的 Map 键同形状——两种
 * PolicyStore 实现的幂等语义共用同一把键（钉死在测试里，漂移即红）。
 */
import { TenantId, UserId } from '@smes/business-core';
import { PolicyRuleError, roleName } from '@smes/application';
import type { PolicyRule } from '@smes/application';

/** 规则规范键：append 幂等锚（PG 主键 / 内存 Map 键同形状）。 */
export function policyRuleKey(rule: PolicyRule): string {
  return rule.kind === 'grant-role'
    ? `grant-role|${rule.tenant}|${rule.user}|${rule.role}`
    : `grant-permission|${rule.tenant}|${rule.role}|${rule.resource}|${rule.action}`;
}

/** createMany 写入形状（可选列 = 不适用段缺省 null）。 */
export interface PolicyRecordRow {
  readonly ruleKey: string;
  readonly tenantId: string;
  readonly kind: 'grant-role' | 'grant-permission';
  readonly userId?: string | null;
  readonly role?: string | null;
  readonly resource?: string | null;
  readonly action?: string | null;
}

/** findMany 读回形状（结构兼容 Prisma 生成行类型；可选列容忍 undefined——往返路径复用）。 */
export interface PolicyRecordDbRow {
  readonly ruleKey: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly userId?: string | null;
  readonly role?: string | null;
  readonly resource?: string | null;
  readonly action?: string | null;
}

export function policyRuleToRow(rule: PolicyRule): PolicyRecordRow {
  const ruleKey = policyRuleKey(rule);
  if (rule.kind === 'grant-role') {
    return {
      ruleKey,
      tenantId: rule.tenant,
      kind: 'grant-role',
      userId: rule.user,
      role: rule.role,
      resource: null,
      action: null,
    };
  }
  return {
    ruleKey,
    tenantId: rule.tenant,
    kind: 'grant-permission',
    userId: null,
    role: rule.role,
    resource: rule.resource,
    action: rule.action,
  };
}

/** 行 -> 业务规则；形状不符抛 PolicyRuleError（fail-fast，不猜——PG 里的行同样不可信）。 */
export function policyRowToRule(row: PolicyRecordDbRow): PolicyRule {
  const has = (value: string | null | undefined): value is string => value != null;
  if (row.kind === 'grant-role') {
    if (!has(row.userId) || !has(row.role) || row.resource != null || row.action != null) {
      throw new PolicyRuleError(`policies 行 '${row.ruleKey}' 的 grant-role 列形状非法`);
    }
    return {
      kind: 'grant-role',
      tenant: TenantId.create(row.tenantId),
      user: UserId.create(row.userId),
      role: roleName(row.role),
    };
  }
  if (row.kind === 'grant-permission') {
    if (!has(row.role) || !has(row.resource) || !has(row.action) || row.userId != null) {
      throw new PolicyRuleError(`policies 行 '${row.ruleKey}' 的 grant-permission 列形状非法`);
    }
    return {
      kind: 'grant-permission',
      tenant: TenantId.create(row.tenantId),
      role: roleName(row.role),
      resource: row.resource,
      action: row.action,
    };
  }
  throw new PolicyRuleError(`policies 行 '${row.ruleKey}' 的 kind 非法：${row.kind}`);
}
