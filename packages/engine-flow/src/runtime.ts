/**
 * 审批流运行时薄层：机器工厂（XState 状态图）+ 守卫求值 + 审批记录/事件账本
 * + 超时自动迁移（TimerPort 注入）。
 *
 * 纯域：无 IO、无时钟依赖（now/newEventId/timer 可注入）、无租户上下文。
 * append-only：records / events 采用写时复制（copy-on-write）——每次迁移产出
 * 新的冻结数组，任何历史句柄永远不变；写入只追加，从不改写既有条目。
 *
 * 超时自动迁移语义：进入带 autoAfterMs 的状态即排定定时器（含初始状态）；
 * 成功迁出即作废在途定时器并为目标状态重排；到点触发走与人工提交完全相同的
 * 求值路径（守卫/记录/事件/版本），守卫拒绝不重试（一次性）；stop() 释放全部
 * 在途定时器（无孤儿定时器），停止后 send 即抛、can 恒 false。
 */
import { EventId, UserId, type EventAggregateRef } from '@smes/business-core';
import { createActor } from 'xstate';
import type { ApprovalDecisionKind, ApprovalFlowConfig, ApprovalTransitionRule } from './config.js';
import { makeApprovalEvent, type ApprovalEvent } from './events.js';
import { createApprovalFlowMachine, type ApprovalGuardContext, type ApprovalGuardRegistry } from './machine.js';
import {
  makeApprovalRecord,
  type ApprovalDecisionInput,
  type ApprovalRecord,
  type EvidenceRef,
} from './record.js';
import { deepFreeze } from './internal/freeze.js';
import { DEFAULT_TIMER_PORT, type ApprovalTimerHandle, type ApprovalTimerPort } from './timer.js';

/** 被审批对象引用（进事件 aggregate）。 */
export interface ApprovalSubjectRef {
  readonly aggregate: Omit<EventAggregateRef, 'revision'>;
  /** 初始对象版本（乐观锁口径，>= 1；revision 随版本推进）。 */
  readonly initialObjectVersion: number;
}

export interface ApprovalFlowSnapshot {
  readonly flowId: string;
  readonly state: string;
  readonly isFinal: boolean;
  readonly objectVersion: number;
  readonly records: readonly ApprovalRecord[];
  readonly events: readonly ApprovalEvent[];
}

export type ApprovalSendOutcome =
  | {
      readonly status: 'transitioned';
      readonly from: string;
      readonly to: string;
      readonly event: ApprovalEvent;
      readonly record?: ApprovalRecord;
    }
  | { readonly status: 'unhandled'; readonly from: string; readonly event: string }
  | { readonly status: 'blocked'; readonly from: string; readonly event: string; readonly guard: string };

export interface ApprovalFlowRuntime {
  /** 当前状态 id。 */
  state(): string;
  isFinal(): boolean;
  /** 当前对象版本（每次成功迁移 +1）。 */
  objectVersion(): number;
  /** 该命令在当前状态是否可用（含守卫求值）。 */
  can(event: string, input: ApprovalDecisionInput): boolean;
  /**
   * 提交一次命令：迁移成功产出审批事件（决策类迁移同时产出审批记录）；
   * 无规则 → unhandled；守卫拒绝 → blocked。二者均不改变任何状态与账本。
   * 运行时已 stop 时提交即抛。
   */
  send(event: string, input: ApprovalDecisionInput): ApprovalSendOutcome;
  /** 决策记录账本（append-only，冻结）。 */
  records(): readonly ApprovalRecord[];
  /** 迁移事件账本（append-only，冻结，Outbox 形状对齐见 events.ts）。 */
  events(): readonly ApprovalEvent[];
  snapshot(): ApprovalFlowSnapshot;
  /**
   * 停止运行时：作废全部在途超时定时器（无孤儿定时器）并停掉状态机；
   * 幂等。停止后 send 即抛、can 恒 false；账本与 snapshot 仍可读。
   */
  stop(): void;
}

export interface StartApprovalFlowParams {
  readonly config: ApprovalFlowConfig;
  readonly subject: ApprovalSubjectRef;
  /** 守卫注册表：配置引用的守卫名必须全部可解析，缺名即抛（fail-fast）。 */
  readonly guards?: ApprovalGuardRegistry;
  readonly now?: () => string;
  readonly newEventId?: () => EventId;
  /** 定时器端口（超时自动迁移用）；缺省用宿主 setTimeout（DEFAULT_TIMER_PORT）。 */
  readonly timer?: ApprovalTimerPort;
  /**
   * 自动迁移的提交输入提供者（决策人 + 理由）：配置声明了 autoAfterMs 的状态
   * 到点后用它构造提交输入。配置含 autoAfterMs 时必填，缺省即抛（fail-fast）；
   * 返回的输入须合法（校验同人工提交），非法输入会在触发时抛出。
   */
  readonly autoInput?: (state: string, event: string) => ApprovalDecisionInput;
  /** 决策人角色表（userId → 角色名集，通用词），注入守卫上下文（roleGuard 消费）。 */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
}

const EMPTY_FROZEN_RECORDS: readonly ApprovalRecord[] = Object.freeze([]);
const EMPTY_FROZEN_EVENTS: readonly ApprovalEvent[] = Object.freeze([]);

function toKebab(eventName: string): string {
  return eventName.toLowerCase().replaceAll('_', '-');
}

function assertDecisionInput(input: ApprovalDecisionInput): void {
  if (!UserId.is(input.by)) {
    throw new Error('invalid decision input: by must be a branded UserId');
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 2000) {
    throw new Error('invalid decision input: reason must be a non-empty string (max 2000 chars)');
  }
  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence)) {
      throw new Error('invalid decision input: evidence must be an array of { kind, ref }');
    }
    for (const entry of input.evidence) {
      const e = entry as Partial<EvidenceRef> | null;
      if (
        typeof e?.kind !== 'string' ||
        e.kind.length === 0 ||
        e.kind.length > 64 ||
        typeof e?.ref !== 'string' ||
        e.ref.trim().length === 0 ||
        e.ref.length > 128
      ) {
        throw new Error('invalid decision input: evidence entries must be { kind: string, ref: string }');
      }
    }
  }
  if (input.objectVersion !== undefined && (!Number.isInteger(input.objectVersion) || input.objectVersion < 1)) {
    throw new Error('invalid decision input: objectVersion must be an integer >= 1 when present');
  }
}

/**
 * 启动一个审批流运行时（纯域对象）。同一份配置可启动任意多个独立运行时；
 * 换一份配置即得到不同机器行为——状态集/迁移/守卫/事件命名空间全部随配置走
 * （ADR-0010 条 2，行为差异证明见 tests/runtime.test.ts）。
 */
export function startApprovalFlow(params: StartApprovalFlowParams): ApprovalFlowRuntime {
  const { config, subject } = params;
  const guards: ApprovalGuardRegistry = params.guards ?? {};
  const now = params.now ?? (() => new Date().toISOString());
  const newEventId = params.newEventId ?? (() => EventId.create(`evt-${crypto.randomUUID()}`));

  if (!Number.isInteger(subject.initialObjectVersion) || subject.initialObjectVersion < 1) {
    throw new Error('invalid subject.initialObjectVersion: expected an integer >= 1');
  }

  // 守卫引用解析：缺名 fail-fast（在第一次 send 之前暴露配置错误）
  for (const rule of config.transitions) {
    if (rule.guard !== undefined && guards[rule.guard] === undefined) {
      throw new Error(`unknown guard "${rule.guard}" referenced by ${rule.from} + ${rule.event}: provide it in the guard registry`);
    }
  }

  // 超时自动迁移接线：autoAfterMs 状态表 + 定时器端口 + 提交输入提供者（fail-fast）
  const autoByState = new Map<string, { readonly afterMs: number; readonly event: string }>();
  for (const state of config.states) {
    if (state.autoAfterMs !== undefined && state.autoEvent !== undefined) {
      autoByState.set(state.id, { afterMs: state.autoAfterMs, event: state.autoEvent });
    }
  }
  const timer: ApprovalTimerPort = params.timer ?? DEFAULT_TIMER_PORT;
  const provideAutoInput = params.autoInput;
  if (autoByState.size > 0 && provideAutoInput === undefined) {
    throw new Error(
      `config declares autoAfterMs on [${[...autoByState.keys()].join(', ')}] but no autoInput provider was given`,
    );
  }
  const roles = params.roles;

  const rulesByKey = new Map<string, ApprovalTransitionRule>();
  for (const rule of config.transitions) {
    rulesByKey.set(`${rule.from}\u0000${rule.event}`, rule);
  }
  const finalStates = new Set(config.states.filter((s) => s.final === true).map((s) => s.id));

  const machine = createApprovalFlowMachine(config);
  const actor = createActor(machine);
  actor.start();

  let objectVersion = subject.initialObjectVersion;
  let records: readonly ApprovalRecord[] = EMPTY_FROZEN_RECORDS;
  let events: readonly ApprovalEvent[] = EMPTY_FROZEN_EVENTS;
  let stopped = false;
  let activeTimer: { readonly handle: ApprovalTimerHandle; readonly stateId: string } | null = null;

  const currentState = (): string => {
    const value = actor.getSnapshot().value;
    return typeof value === 'string' ? value : config.initial;
  };

  const guardContext = (state: string, event: string, input: ApprovalDecisionInput): ApprovalGuardContext => ({
    state,
    event,
    input,
    objectVersion,
    records,
    ...(roles === undefined ? {} : { roles }),
  });

  const cancelActiveTimer = (): void => {
    if (activeTimer !== null) {
      timer.cancel(activeTimer.handle);
      activeTimer = null;
    }
  };

  // 进入带 autoAfterMs 的状态即排定；到点走与人工提交完全相同的 evaluate 路径。
  // 过期防御：已停止 / 登记已被替换或取消（activeTimer 对不上）/ 状态已变，均不触发。
  const scheduleAutoFor = (stateId: string): void => {
    const auto = autoByState.get(stateId);
    if (auto === undefined) return;
    const handle = timer.schedule(auto.afterMs, () => {
      if (stopped) return;
      if (activeTimer === null || activeTimer.stateId !== stateId) return; // 已作废/已替换（端口违约兜底）
      activeTimer = null; // 本定时器已消费（一次性：blocked/unhandled 不重排）
      if (currentState() !== stateId) return; // 过期定时器
      const provider = provideAutoInput;
      if (provider === undefined) return;
      evaluate(auto.event, provider(stateId, auto.event));
    });
    activeTimer = { handle, stateId };
  };

  const evaluate = (event: string, input: ApprovalDecisionInput): ApprovalSendOutcome => {
    if (stopped) {
      throw new Error('approval flow runtime is stopped: send is no longer accepted');
    }
    assertDecisionInput(input);
    const from = currentState();
    const rule = rulesByKey.get(`${from}\u0000${event}`);
    if (rule === undefined) {
      return { status: 'unhandled', from, event };
    }
    if (rule.guard !== undefined) {
      const guardFn = guards[rule.guard];
      if (guardFn === undefined) {
        throw new Error(`engine invariant violation: guard "${rule.guard}" disappeared after creation`);
      }
      if (!guardFn(guardContext(from, event, input))) {
        return { status: 'blocked', from, event, guard: rule.guard };
      }
    }

    let record: ApprovalRecord | undefined;
    if (rule.decision !== undefined) {
      const decision: ApprovalDecisionKind = rule.decision;
      record = makeApprovalRecord({
        reviewer: input.by,
        decision,
        reason: input.reason,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        objectVersion,
        decidedAt: now(),
      });
    }

    const nextVersion = objectVersion + 1;
    const approvalEvent = makeApprovalEvent({
      eventId: newEventId(),
      eventType: `smes.${config.flowId}.v1.${rule.eventAction ?? toKebab(event)}`,
      aggregate: { ...subject.aggregate, revision: nextVersion },
      occurredAt: now(),
      payload: deepFreeze({
        flowId: config.flowId,
        from,
        to: rule.to,
        event,
        objectVersion: nextVersion,
        actor: input.by,
        reason: input.reason,
        ...(record === undefined ? {} : { record }),
      }),
    });

    actor.send({ type: event });
    const resolved = currentState();
    if (resolved !== rule.to) {
      throw new Error(
        `engine invariant violation: XState resolved "${resolved}" but config targets "${rule.to}" for ${from} + ${event}`,
      );
    }

    objectVersion = nextVersion;
    if (record !== undefined) {
      records = Object.freeze([...records, record]);
    }
    events = Object.freeze([...events, approvalEvent]);

    // 超时自动迁移：迁出即作废在途定时器，为目标状态按其 autoAfterMs 重排。
    cancelActiveTimer();
    scheduleAutoFor(rule.to);

    const outcome: ApprovalSendOutcome =
      record === undefined
        ? { status: 'transitioned', from, to: rule.to, event: approvalEvent }
        : { status: 'transitioned', from, to: rule.to, event: approvalEvent, record };
    return deepFreeze(outcome);
  };

  // 初始状态即带 autoAfterMs 的，启动即排定（进入状态 = 排定时器，含初始进入）。
  scheduleAutoFor(config.initial);

  return {
    state: currentState,
    isFinal: () => finalStates.has(currentState()),
    objectVersion: () => objectVersion,
    can: (event, input) => {
      if (stopped) return false;
      try {
        assertDecisionInput(input);
      } catch {
        return false;
      }
      const from = currentState();
      const rule = rulesByKey.get(`${from}\u0000${event}`);
      if (rule === undefined) return false;
      if (rule.guard !== undefined) {
        const guardFn = guards[rule.guard];
        if (guardFn === undefined) return false;
        return guardFn(guardContext(from, event, input));
      }
      return true;
    },
    send: evaluate,
    records: () => records,
    events: () => events,
    snapshot: () =>
      deepFreeze({
        flowId: config.flowId,
        state: currentState(),
        isFinal: finalStates.has(currentState()),
        objectVersion,
        records,
        events,
      }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelActiveTimer();
      actor.stop();
    },
  };
}
