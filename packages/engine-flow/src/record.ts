/**
 * 审批记录：一次决策的不可变快照（对齐 DomainReview 语义——图纸对齐，零件各造，ADR-0003）。
 *
 * 形状：reviewer（品牌化 UserId）+ decision（approve/reject/escalate/withdraw + 理由）
 * + evidence 引用 + objectVersion + decidedAt。构造即深冻结（ADR-0003 #4）。
 */
import { UserId } from '@smes/business-core';
import { deepFreeze } from './internal/freeze.js';

/** 决策集（与 config.ApprovalDecisionKind 同集；独立导出避免配置模块反向依赖记录模块）。 */
export type ApprovalDecision = 'approve' | 'reject' | 'escalate' | 'withdraw';

/**
 * 证据引用：通用上位概念（kind = 证据类别口径，ref = 证据标识字符串）。
 * 具体类别枚举由调用方领域规格定义，内核不绑定。
 */
export interface EvidenceRef {
  readonly kind: string;
  readonly ref: string;
}

export interface ApprovalRecord {
  /** 决策人（提交 withdraw 时为撤回人）。品牌化，见 ADR-0003 #2。 */
  readonly reviewer: UserId;
  readonly decision: ApprovalDecision;
  /** 理由：非空必填，审计口径。 */
  readonly reason: string;
  /** 证据引用（缺省空集）。 */
  readonly evidence: readonly EvidenceRef[];
  /** 决策所针对的对象版本（乐观锁口径：决策作用于该版本，迁移产出下一版本）。 */
  readonly objectVersion: number;
  /** ISO 8601，决策时刻。 */
  readonly decidedAt: string;
}

export interface ApprovalRecordInput {
  readonly reviewer: UserId;
  readonly decision: ApprovalDecision;
  readonly reason: string;
  readonly evidence?: readonly EvidenceRef[];
  readonly objectVersion: number;
  readonly decidedAt: string;
}

/**
 * 决策提交输入：驱动一次迁移的命令载荷（决策人 + 理由 + 证据引用）。
 * 决策类迁移会把它固化为 ApprovalRecord；非决策迁移只进事件 payload。
 */
export interface ApprovalDecisionInput {
  readonly by: UserId;
  readonly reason: string;
  readonly evidence?: readonly EvidenceRef[];
  /**
   * 版本声明（乐观锁口径）：提交人所见的对象版本。versionGuard 校验其等于
   * 当前版本；缺省不带声明（versionGuard 对缺省输入 fail-closed）。
   * 仅作守卫校验用途——记录/事件的版本赋值始终以运行时当前版本为准。
   */
  readonly objectVersion?: number;
}

const DECISIONS: readonly ApprovalDecision[] = ['approve', 'reject', 'escalate', 'withdraw'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEvidenceRef(entry: unknown): void {
  if (!isPlainObject(entry)) {
    throw new Error('invalid evidence entry: expected { kind, ref }');
  }
  if (typeof entry.kind !== 'string' || entry.kind.length === 0 || entry.kind.length > 64) {
    throw new Error('invalid evidence entry: kind must be a non-empty string (max 64 chars)');
  }
  if (typeof entry.ref !== 'string' || entry.ref.trim().length === 0 || entry.ref.length > 128) {
    throw new Error('invalid evidence entry: ref must be a non-empty string (max 128 chars)');
  }
}

/** 构造审批记录：校验后深冻结返回。非法输入即抛（fail-fast）。 */
export function makeApprovalRecord(input: ApprovalRecordInput): ApprovalRecord {
  const { reviewer, decision, reason, evidence, objectVersion, decidedAt } = input;

  if (!UserId.is(reviewer)) {
    throw new Error('invalid reviewer: expected a branded UserId');
  }
  if (!DECISIONS.includes(decision)) {
    throw new Error(`invalid decision: expected one of ${DECISIONS.join('/')}, got "${String(decision)}"`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2000) {
    throw new Error('invalid reason: expected a non-empty string (max 2000 chars)');
  }
  if (evidence !== undefined && !Array.isArray(evidence)) {
    throw new Error('invalid evidence: expected an array of { kind, ref }');
  }
  if (!Number.isInteger(objectVersion) || objectVersion < 1) {
    throw new Error('invalid objectVersion: expected an integer >= 1');
  }
  if (typeof decidedAt !== 'string' || Number.isNaN(Date.parse(decidedAt))) {
    throw new Error('invalid decidedAt: expected an ISO 8601 date-time string');
  }

  const evidenceList = evidence === undefined ? [] : evidence.slice();
  for (const entry of evidenceList) {
    validateEvidenceRef(entry);
  }

  return deepFreeze<ApprovalRecord>({
    reviewer,
    decision,
    reason,
    evidence: deepFreeze(evidenceList),
    objectVersion,
    decidedAt,
  });
}
