/**
 * PolicyRule <-> policies 行映射测试（纯函数，零 Prisma / 零活库）。
 * 规范键形状是跨实现幂等合同（内存 Map 键 = PG 主键），此处钉死。
 */
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { PolicyRuleError, roleName } from '@smes/application';
import {
  policyRowToRule,
  policyRuleKey,
  policyRuleToRow,
} from '../src/org/policy-mapping.js';

const t1 = TenantId.create('t1');
const alice = UserId.create('alice');

const grantRole = {
  kind: 'grant-role',
  tenant: t1,
  user: alice,
  role: roleName('operator'),
} as const;

const grantPermission = {
  kind: 'grant-permission',
  tenant: t1,
  role: roleName('operator'),
  resource: 'demo',
  action: 'read',
} as const;

describe('policyRuleKey（规范键 = 幂等合同）', () => {
  it('与 application 内存实现的键形状一致（跨实现同一把键）', () => {
    expect(policyRuleKey(grantRole)).toBe('grant-role|t1|alice|operator');
    expect(policyRuleKey(grantPermission)).toBe('grant-permission|t1|operator|demo|read');
  });

  it('不同租户/主体/资源的键互不相同', () => {
    expect(policyRuleKey(grantRole)).not.toBe(
      policyRuleKey({ ...grantRole, tenant: TenantId.create('t2') }),
    );
    expect(policyRuleKey(grantPermission)).not.toBe(
      policyRuleKey({ ...grantPermission, action: 'write' }),
    );
  });
});

describe('规则 <-> 行 映射', () => {
  it('grant-role 往返：适用列落值、不适用列 null', () => {
    const row = policyRuleToRow(grantRole);
    expect(row).toEqual({
      ruleKey: 'grant-role|t1|alice|operator',
      tenantId: 't1',
      kind: 'grant-role',
      userId: 'alice',
      role: 'operator',
      resource: null,
      action: null,
    });
    expect(policyRowToRule(row)).toEqual(grantRole);
  });

  it('grant-permission 往返', () => {
    const row = policyRuleToRow(grantPermission);
    expect(row).toEqual({
      ruleKey: 'grant-permission|t1|operator|demo|read',
      tenantId: 't1',
      kind: 'grant-permission',
      userId: null,
      role: 'operator',
      resource: 'demo',
      action: 'read',
    });
    expect(policyRowToRule(row)).toEqual(grantPermission);
  });

  it('形状异常行 fail-fast：缺段 / 串段 / 未知 kind 均抛 PolicyRuleError', () => {
    expect(() =>
      policyRowToRule({
        ruleKey: 'k',
        tenantId: 't1',
        kind: 'grant-role',
        userId: null,
        role: 'operator',
        resource: null,
        action: null,
      }),
    ).toThrow(PolicyRuleError);
    expect(() =>
      policyRowToRule({
        ruleKey: 'k',
        tenantId: 't1',
        kind: 'grant-permission',
        userId: 'alice',
        role: 'operator',
        resource: 'demo',
        action: 'read',
      }),
    ).toThrow(PolicyRuleError);
    expect(() =>
      policyRowToRule({
        ruleKey: 'k',
        tenantId: 't1',
        kind: 'grant-magic',
        userId: null,
        role: null,
        resource: null,
        action: null,
      }),
    ).toThrow(PolicyRuleError);
  });
});
