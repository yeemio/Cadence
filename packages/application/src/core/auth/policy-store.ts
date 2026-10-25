/**
 * PolicyStore —— 策略存储端口（业务形状，M1 增量 2-B）。
 *
 * 这是策略持久化的唯一接缝：内存实现先行；PG adapter 由 business-store 线
 * 后续按同一端口接入（非目标清单明确排除本增量做持久化）。
 *
 * 形状纪律（ADR-0010）：规则词汇全部通用（tenant/user/role/resource/action），
 * 无行业词。角色经 g 绑定按租户授予用户；权限经 p 规则按租户授予角色
 * （p.sub 一律是角色名，业务形状不表达"直接用户授权"）。
 *
 * 一致性合同：adapter（casbin-policy-adapter.ts）以 autoSave 写通本端口——
 * append/remove 在 enforcer 内存更新之后被调用。内存实现不会失败；
 * PG 实现须自行保证崩溃一致（事务/幂等重放），端口不提供两阶段语义。
 */
import { TenantId, UserId, type Brand } from '@smes/business-core';
import { PERMISSION_SEGMENT_PATTERN } from './permission-code.js';

/** 角色名品牌类型：构造只经 roleName()（段形状校验）。 */
export type RoleName = Brand<string, 'RoleName'>;

export class PolicyRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyRuleError';
  }
}

/** 策略规则（业务形状，两种）：域内授予角色 / 域内角色授予权限。 */
export type PolicyRule =
  | {
      readonly kind: 'grant-role';
      readonly tenant: TenantId;
      readonly user: UserId;
      readonly role: RoleName;
    }
  | {
      readonly kind: 'grant-permission';
      readonly tenant: TenantId;
      readonly role: RoleName;
      readonly resource: string;
      readonly action: string;
    };

/** 角色名构造：复用权限码单段词汇形状（小写、无行业词约束同 ADR-0010）。 */
export function roleName(value: string): RoleName {
  if (!PERMISSION_SEGMENT_PATTERN.test(value)) {
    throw new PolicyRuleError(`非法角色名 '${value}'：须为单段小写形状（小写字母/数字/连字符）`);
  }
  return value as RoleName;
}

function requireSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || !PERMISSION_SEGMENT_PATTERN.test(value)) {
    throw new PolicyRuleError(
      `策略规则字段 '${field}' 非法：${JSON.stringify(value)}，须为单段小写形状`,
    );
  }
  return value;
}

function requireId(kind: 'tenant' | 'user', value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new PolicyRuleError(
      `策略规则字段 '${kind}' 非法：${JSON.stringify(value)}，须为 1~128 字符非空字符串`,
    );
  }
  return value;
}

/**
 * 从外部输入（HTTP body / 未来 PG 行）解析并校验一条策略规则。
 * 违规即抛 PolicyRuleError——调用方（dev 策略端点）映射为 400，绝不静默丢弃。
 */
export function parsePolicyRule(input: unknown): PolicyRule {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyRuleError(`策略规则必须是对象：${JSON.stringify(input)}`);
  }
  const record = input as Record<string, unknown>;
  const tenant = TenantId.create(requireId('tenant', record['tenant']));
  const role = roleName(requireSegment(record['role'], 'role'));

  if (record['kind'] === 'grant-role') {
    return {
      kind: 'grant-role',
      tenant,
      user: UserId.create(requireId('user', record['user'])),
      role,
    };
  }
  if (record['kind'] === 'grant-permission') {
    return {
      kind: 'grant-permission',
      tenant,
      role,
      resource: requireSegment(record['resource'], 'resource'),
      action: requireSegment(record['action'], 'action'),
    };
  }
  throw new PolicyRuleError(
    `策略规则 kind 非法：${JSON.stringify(record['kind'])}，须为 'grant-role' 或 'grant-permission'`,
  );
}

/** 策略存储端口。实现方保证：append 幂等（重复规则不产生重复行）。 */
export interface PolicyStore {
  /** 全量读取（enforcer 初始加载用）。 */
  load(): Promise<readonly PolicyRule[]>;
  /** 追加规则（重复规则幂等跳过）。 */
  append(rules: readonly PolicyRule[]): Promise<void>;
  /** 移除规则（不存在的规则幂等跳过）。 */
  remove(rules: readonly PolicyRule[]): Promise<void>;
}

/** DI 注入令牌（组合根装配用；业务代码直接构造，不经容器）。 */
export const POLICY_STORE = Symbol('smes.policyStore');
