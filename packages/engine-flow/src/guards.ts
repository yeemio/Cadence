/**
 * 常用守卫库：纯函数，输入 = 决策史（records）+ 守卫上下文，输出 boolean。
 *
 * 三个通用守卫（零行业词，ADR-0010 条 1）：
 * - quorumGuard   计票：M 人池中至少 N 个不同决策人计过指定决策（防重复计票）；
 * - roleGuard     角色：决策人须持指定角色之一（角色表由启动方经 roles 注入上下文）；
 * - versionGuard  版本：提交输入的版本声明须等于当前对象版本（乐观锁守卫形态）。
 *
 * 组合：配置每条迁移引用一个守卫名；需同时施加多个守卫时由调用方注册组合守卫
 * （库函数是纯函数，可直接组合）：
 *   const quorumAndFresh = (ctx) => quorumGuard(opts)(ctx) && versionGuard()(ctx);
 */
import type { ApprovalGuard, ApprovalGuardContext } from './machine.js';
import type { ApprovalDecision } from './record.js';

/** 与 config.ApprovalDecisionKind / record.ApprovalDecision 同集（零件各造，ADR-0003）。 */
const DECISIONS: readonly ApprovalDecision[] = ['approve', 'reject', 'escalate', 'withdraw'];

// ---- quorumGuard：M 人中至少 N 个指定决策（防重复计票） ----

export interface QuorumGuardOptions {
  /** 计票的决策类。 */
  readonly decision: ApprovalDecision;
  /** 门槛 N：至少 N 个**不同**决策人计过该决策。 */
  readonly distinctVoters: number;
  /** 计票池 M 人（userId 字符串集）；池外决策人的记录不计票。 */
  readonly eligibleVoters: readonly string[];
}

export function quorumGuard(options: QuorumGuardOptions): ApprovalGuard {
  const { decision, distinctVoters, eligibleVoters } = options ?? ({} as QuorumGuardOptions);
  if (!DECISIONS.includes(decision)) {
    throw new Error(`invalid quorumGuard options: decision must be one of ${DECISIONS.join('/')}`);
  }
  if (typeof distinctVoters !== 'number' || !Number.isInteger(distinctVoters) || distinctVoters < 1) {
    throw new Error('invalid quorumGuard options: distinctVoters must be an integer >= 1');
  }
  if (!Array.isArray(eligibleVoters) || eligibleVoters.length === 0) {
    throw new Error('invalid quorumGuard options: eligibleVoters must be a non-empty array of user ids');
  }
  const pool = new Set<string>();
  for (const voter of eligibleVoters) {
    if (typeof voter !== 'string' || voter.length === 0) {
      throw new Error('invalid quorumGuard options: eligibleVoters entries must be non-empty user id strings');
    }
    if (pool.has(voter)) {
      throw new Error(`invalid quorumGuard options: duplicate eligible voter "${voter}"`);
    }
    pool.add(voter);
  }
  if (distinctVoters > pool.size) {
    throw new Error(
      `invalid quorumGuard options: distinctVoters (${distinctVoters}) exceeds pool size (${String(pool.size)})`,
    );
  }
  return (ctx: ApprovalGuardContext): boolean => {
    const counted = new Set<string>();
    for (const record of ctx.records) {
      if (record.decision !== decision) continue;
      if (!pool.has(record.reviewer)) continue;
      counted.add(record.reviewer); // 同一决策人多条记录只计一票（防重复计票）
    }
    return counted.size >= distinctVoters;
  };
}

// ---- roleGuard：决策人须持指定角色（角色集由上下文注入） ----

export interface RoleGuardOptions {
  /** 任一命中即放行的角色名集（通用词，如 reviewer / admin）。 */
  readonly anyOf: readonly string[];
}

export function roleGuard(options: RoleGuardOptions): ApprovalGuard {
  const { anyOf } = options ?? ({} as RoleGuardOptions);
  if (!Array.isArray(anyOf) || anyOf.length === 0) {
    throw new Error('invalid roleGuard options: anyOf must be a non-empty array of role names');
  }
  for (const role of anyOf) {
    if (typeof role !== 'string' || role.length === 0) {
      throw new Error('invalid roleGuard options: anyOf entries must be non-empty role name strings');
    }
  }
  const allowed = new Set<string>(anyOf);
  return (ctx: ApprovalGuardContext): boolean => {
    const roles = ctx.roles?.[ctx.input.by];
    if (roles === undefined) return false; // fail-closed：上下文无该决策人角色记录即拒绝
    for (const role of roles) {
      if (allowed.has(role)) return true;
    }
    return false;
  };
}

// ---- versionGuard：版本声明须等于当前版本（乐观锁守卫） ----

/**
 * 提交输入携带的版本声明（input.objectVersion = 提交所见版本）必须等于当前对象版本；
 * 缺省不带声明一律拒绝（fail-closed）。
 *
 * 设计取舍：ApprovalRecord.objectVersion 由运行时按"决策时版本"赋值，恒等于该次
 * 迁移的前一版本（迁移后版本 = 其 +1），拿历史记录与当前版本比较永不相等；因此
 * 版本一致性校验锚定在提交输入的版本声明上（CommandEnvelope.expectedRevision 的
 * 守卫形态），语义 = "本次决策针对当前版本，过期/超前提交拒绝"。
 * 声明只作守卫校验，不改变记录/事件的版本赋值（版本以运行时为准）。
 */
export function versionGuard(): ApprovalGuard {
  return (ctx: ApprovalGuardContext): boolean => {
    const claimed = ctx.input.objectVersion;
    if (claimed === undefined) return false;
    return claimed === ctx.objectVersion;
  };
}
