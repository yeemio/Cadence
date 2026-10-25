/**
 * 审批流版本化配置（ADR-0010 条 2：状态集配置分离——状态集是配置，不是内核）。
 *
 * 配置是纯数据（可序列化、可版本化、可整体替换）；机器机制（XState 包装、
 * 守卫接口、迁移求值）见 machine.ts / runtime.ts。行业/租户差异通过替换整份
 * 配置表达，内核词汇保持通用（ADR-0010 条 1）。
 */
import { deepFreeze } from './internal/freeze.js';

/** 当前配置 schema 版本；不认识的版本在 defineApprovalFlowConfig 处即抛。 */
export const APPROVAL_FLOW_CONFIG_SCHEMA_VERSION = 1 as const;
export type ApprovalFlowConfigSchemaVersion = typeof APPROVAL_FLOW_CONFIG_SCHEMA_VERSION;

const FLOW_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STATE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const EVENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const EVENT_ACTION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 状态定义。id 为通用词（submit/review/approve/... 家族），语义由配置作者定义。
 *
 * 超时自动迁移（状态级）：autoAfterMs + autoEvent 成对声明——进入该状态
 * N 毫秒后自动提交 autoEvent 命令（走与人工提交完全相同的迁移路径：守卫、
 * 决策记录、事件、版本）。时间机制经 TimerPort 注入（见 timer.ts / runtime.ts）。
 */
export interface ApprovalStateDef {
  readonly id: string;
  /** 终态：不允许迁出。 */
  readonly final?: boolean;
  /** 进入该状态 N 毫秒后自动触发 autoEvent；正整数毫秒。与 autoEvent 成对。 */
  readonly autoAfterMs?: number;
  /** 到时自动提交的命令动词；必须存在 from=该状态的既有迁移规则。与 autoAfterMs 成对。 */
  readonly autoEvent?: string;
}

/**
 * 迁移规则：from 状态收到 event 命令后迁到 to。
 * - guard：守卫引用（按名解析，注册表在机器创建处提供，缺名即抛）；
 * - decision：决策类标记——该迁移会产出一审批记录（对齐 DomainReview 形状）；
 * - eventAction：产出事件的过去式动作名（缺省取 event 的小写全形）。
 */
export interface ApprovalTransitionRule {
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly guard?: string;
  readonly decision?: ApprovalDecisionKind;
  readonly eventAction?: string;
}

/** 审批记录的决策集（通用词，对齐 DomainReview 语义）。 */
export type ApprovalDecisionKind = 'approve' | 'reject' | 'escalate' | 'withdraw';

export interface ApprovalFlowConfig {
  readonly schemaVersion: ApprovalFlowConfigSchemaVersion;
  /** 流标识（kebab-case），进事件命名空间：smes.<flowId>.v1.<action>。 */
  readonly flowId: string;
  readonly initial: string;
  readonly states: readonly ApprovalStateDef[];
  readonly transitions: readonly ApprovalTransitionRule[];
}

const DECISION_KINDS: readonly ApprovalDecisionKind[] = ['approve', 'reject', 'escalate', 'withdraw'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验并固化一份审批流配置：结构合法即深冻结返回（配置是不可变快照）。
 * 非法配置立即抛错（fail-fast），不产生半合法机器。
 */
export function defineApprovalFlowConfig(raw: unknown): ApprovalFlowConfig {
  if (!isPlainObject(raw)) {
    throw new Error('invalid approval flow config: expected a plain object');
  }
  const { schemaVersion, flowId, initial, states, transitions } = raw;

  if (schemaVersion !== APPROVAL_FLOW_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `invalid schemaVersion: expected ${String(APPROVAL_FLOW_CONFIG_SCHEMA_VERSION)}, got ${String(schemaVersion)}`,
    );
  }
  if (typeof flowId !== 'string' || !FLOW_ID_PATTERN.test(flowId) || flowId.length > 64) {
    throw new Error(`invalid flowId: expected kebab-case (max 64 chars), got "${String(flowId)}"`);
  }
  if (!Array.isArray(states) || states.length === 0) {
    throw new Error('invalid states: expected a non-empty array');
  }
  if (!Array.isArray(transitions) || transitions.length === 0) {
    throw new Error('invalid transitions: expected a non-empty array');
  }
  if (typeof initial !== 'string') {
    throw new Error('invalid initial: expected a state id string');
  }

  const stateIds = new Set<string>();
  const finalIds = new Set<string>();
  for (const state of states) {
    if (!isPlainObject(state) || typeof state.id !== 'string' || !STATE_ID_PATTERN.test(state.id) || state.id.length > 64) {
      throw new Error(`invalid state: each state needs an id matching ${STATE_ID_PATTERN} (max 64 chars)`);
    }
    if (stateIds.has(state.id)) {
      throw new Error(`invalid states: duplicate state id "${state.id}"`);
    }
    if (state.final !== undefined && typeof state.final !== 'boolean') {
      throw new Error(`invalid state "${state.id}": final must be a boolean when present`);
    }
    if (state.final === true && state.autoAfterMs !== undefined) {
      throw new Error(`invalid state "${state.id}": final state must not declare autoAfterMs`);
    }
    const hasAutoAfter = state.autoAfterMs !== undefined;
    const hasAutoEvent = state.autoEvent !== undefined;
    if (hasAutoAfter !== hasAutoEvent) {
      throw new Error(`invalid state "${state.id}": autoAfterMs and autoEvent must be declared together`);
    }
    if (hasAutoAfter && (!Number.isSafeInteger(state.autoAfterMs as number) || (state.autoAfterMs as number) <= 0)) {
      throw new Error(`invalid state "${state.id}": autoAfterMs must be a positive integer (milliseconds)`);
    }
    if (
      hasAutoEvent &&
      (typeof state.autoEvent !== 'string' || !EVENT_NAME_PATTERN.test(state.autoEvent) || state.autoEvent.length > 64)
    ) {
      throw new Error(`invalid state "${state.id}": autoEvent must be SCREAMING_SNAKE_CASE (max 64 chars)`);
    }
    stateIds.add(state.id);
    if (state.final === true) finalIds.add(state.id);
  }
  if (!stateIds.has(initial)) {
    throw new Error(`invalid initial: "${initial}" is not a declared state`);
  }

  const seenEventOnState = new Set<string>();
  for (const rule of transitions) {
    if (!isPlainObject(rule)) {
      throw new Error('invalid transition: expected a plain object');
    }
    const { from, event, to } = rule;
    if (typeof from !== 'string' || !stateIds.has(from)) {
      throw new Error(`invalid transition: unknown "from" state "${String(from)}"`);
    }
    if (typeof to !== 'string' || !stateIds.has(to)) {
      throw new Error(`invalid transition: unknown "to" state "${String(to)}"`);
    }
    if (typeof event !== 'string' || !EVENT_NAME_PATTERN.test(event) || event.length > 64) {
      throw new Error(`invalid transition event: expected SCREAMING_SNAKE_CASE (max 64 chars), got "${String(event)}"`);
    }
    const key = `${from}\u0000${event}`;
    if (seenEventOnState.has(key)) {
      throw new Error(`invalid transitions: duplicate rule for state "${from}" + event "${event}"`);
    }
    seenEventOnState.add(key);
    if (finalIds.has(from)) {
      throw new Error(`invalid transition: state "${from}" is final and must not have outgoing transitions`);
    }
    if (rule.guard !== undefined && (typeof rule.guard !== 'string' || rule.guard.length === 0)) {
      throw new Error(`invalid transition "${from}" + "${event}": guard must be a non-empty guard name`);
    }
    if (rule.decision !== undefined && !DECISION_KINDS.includes(rule.decision as ApprovalDecisionKind)) {
      throw new Error(
        `invalid transition "${from}" + "${event}": decision must be one of ${DECISION_KINDS.join('/')}`,
      );
    }
    if (
      rule.eventAction !== undefined &&
      (typeof rule.eventAction !== 'string' || !EVENT_ACTION_PATTERN.test(rule.eventAction) || rule.eventAction.length > 64)
    ) {
      throw new Error(`invalid transition "${from}" + "${event}": eventAction must be kebab-case (max 64 chars)`);
    }
  }

  // 超时自动迁移交叉校验：autoEvent 必须有 from=该状态的既有规则
  // （保证到点提交必然有规则可走，终态因禁止迁出已被上面的 final 检查排除）。
  for (const state of states) {
    const autoEvent = state.autoEvent;
    if (autoEvent === undefined) continue;
    const hasRule = transitions.some((rule) => rule?.from === state.id && rule?.event === autoEvent);
    if (!hasRule) {
      throw new Error(`invalid state "${String(state.id)}": autoEvent "${String(autoEvent)}" has no matching transition rule from that state`);
    }
  }

  return deepFreeze<ApprovalFlowConfig>({
    schemaVersion: schemaVersion as ApprovalFlowConfigSchemaVersion,
    flowId,
    initial,
    states: deepFreeze(states.slice()) as readonly ApprovalStateDef[],
    transitions: deepFreeze(transitions.slice()) as readonly ApprovalTransitionRule[],
  });
}
