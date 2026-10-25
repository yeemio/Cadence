/**
 * 审批输入解析（HTTP body / query → 业务输入；M1 收尾波-①）。
 *
 * 与 org/workbench-input 同一纪律：违规抛 ApprovalInputError（组合根映射
 * 400），绝不静默丢弃。subjectRef.type 复用 PERMISSION_SEGMENT_PATTERN
 * （单段小写，与 refType/来源码同形状——ADR-0010 通用词）。
 */
import { UserId } from '@smes/business-core';
import { PERMISSION_SEGMENT_PATTERN } from '../core/auth/permission-code.js';
import { ApprovalInputError } from './approval-errors.js';
import type { ApprovalDecisionKind } from '@smes/engine-flow';

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApprovalInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireReason(value: unknown, what = '理由'): string {
  if (typeof value !== 'string') {
    throw new ApprovalInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) {
    throw new ApprovalInputError(`${what}须为 1~2000 个非空白字符`);
  }
  return trimmed;
}

function requireUserId(value: unknown, what: string): UserId {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new ApprovalInputError(`${what} id 非法：${JSON.stringify(value)}`);
  }
  return UserId.create(value.trim());
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApprovalInputError(`标题必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new ApprovalInputError(`标题须为 1~200 个非空白字符`);
  }
  return trimmed;
}

export interface StartApprovalPayload {
  /** 被审批对象引用（通用聚合引用）。 */
  readonly subjectRef: { readonly type: string; readonly id: string };
  /** 审批人清单（1~50 人；去重后逐人派待办）。 */
  readonly approvers: readonly UserId[];
  /** 待办标题（可选；缺省由用例层按 subjectRef 组合）。 */
  readonly title?: string;
  /** 发起理由（必填——engine-flow 决策输入合同：reason 非空）。 */
  readonly reason: string;
}

/** 解析 POST /approval/cases 请求体。 */
export function parseStartApprovalInput(input: unknown): StartApprovalPayload {
  const record = requireObject(input, '发起审批请求体');
  const refRaw = record['subjectRef'];
  const ref = requireObject(refRaw, 'subjectRef');
  const type = ref['type'];
  if (typeof type !== 'string' || !PERMISSION_SEGMENT_PATTERN.test(type)) {
    throw new ApprovalInputError(
      `subjectRef.type '${JSON.stringify(type)}' 非法：须为单段小写形状（如 item）`,
    );
  }
  const refId = ref['id'];
  if (typeof refId !== 'string' || refId.trim().length === 0 || refId.length > 128) {
    throw new ApprovalInputError(`subjectRef.id 非法：${JSON.stringify(refId)}`);
  }
  const payload: {
    subjectRef: { type: string; id: string };
    approvers: readonly UserId[];
    title?: string;
    reason: string;
  } = {
    subjectRef: { type, id: refId.trim() },
    approvers: parseApprovers(record['approvers']),
    reason: requireReason(record['reason'], '发起理由'),
  };
  const title = record['title'];
  if (title !== undefined) payload.title = requireTitle(title);
  return payload;
}

function parseApprovers(value: unknown): readonly UserId[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApprovalInputError(`审批人清单 approvers 须为非空数组：${JSON.stringify(value)}`);
  }
  if (value.length > 50) {
    throw new ApprovalInputError('审批人清单 approvers 最多 50 人');
  }
  const approvers: UserId[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const approver = requireUserId(entry, '审批人');
    if (seen.has(approver)) continue; // 去重：同一人不重复派待办
    seen.add(approver);
    approvers.push(approver);
  }
  return approvers;
}

const DECISIONS: readonly ApprovalDecisionKind[] = ['approve', 'reject', 'escalate', 'withdraw'];

export interface DecisionPayload {
  readonly decision: ApprovalDecisionKind;
  readonly reason: string;
  /** 版本声明（乐观锁口径，可选）：提供时必须等于案件当前 objectVersion。 */
  readonly objectVersion?: number;
}

/** 解析 POST /approval/cases/:id/decisions 请求体。 */
export function parseDecisionInput(input: unknown): DecisionPayload {
  const record = requireObject(input, '决策请求体');
  const decision = record['decision'];
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as ApprovalDecisionKind)) {
    throw new ApprovalInputError(
      `决策 decision 非法：须为 ${DECISIONS.join('/')} 之一，得到 ${JSON.stringify(decision)}`,
    );
  }
  const payload: { decision: ApprovalDecisionKind; reason: string; objectVersion?: number } = {
    decision: decision as ApprovalDecisionKind,
    reason: requireReason(record['reason'], '决策理由'),
  };
  const version = record['objectVersion'];
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new ApprovalInputError(`objectVersion 须为 >= 1 的整数：${JSON.stringify(version)}`);
    }
    payload.objectVersion = version;
  }
  return payload;
}

/** 路径参数案件 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseCaseIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new ApprovalInputError(`案件 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（query；undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new ApprovalInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 in_review），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}
