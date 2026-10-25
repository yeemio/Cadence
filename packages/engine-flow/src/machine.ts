/**
 * 守卫合同 + XState 机器工厂（决策簿：审批流配置层 = 自研薄层，XState 之上）。
 *
 * 分工取舍（防止两处求值漂移）：
 * - XState 持有状态图（initial / final / 迁移表），send 后的状态解析以它为准；
 * - 守卫在薄层求值（守卫需要域上下文：决策史 / 对象版本 / 提交输入，这些不属于
 *   状态图）；配置里的守卫按名引用，创建运行时时对注册表解析，缺名即抛。
 * 两者的同构性由 runtime 的迁移后断言防护（XState 解析结果必须等于规则目标态，
 * 否则抛引擎不变量错误），不靠双写守卫维持。
 */
import { createMachine } from 'xstate';
import type { ApprovalFlowConfig } from './config.js';
import type { ApprovalDecisionInput } from './record.js';

/** 守卫求值上下文：迁出态、命令动词、提交输入与域历史。 */
export interface ApprovalGuardContext {
  readonly state: string;
  readonly event: string;
  readonly input: ApprovalDecisionInput;
  readonly objectVersion: number;
  readonly records: readonly import('./record.js').ApprovalRecord[];
  /**
   * 决策人角色表（userId → 角色名集，通用词），由启动方经 StartApprovalFlowParams.roles
   * 注入；roleGuard 消费。缺省为空表（无角色记录的决策人在 roleGuard 下 fail-closed）。
   */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
}

export type ApprovalGuard = (ctx: ApprovalGuardContext) => boolean;
export type ApprovalGuardRegistry = Readonly<Record<string, ApprovalGuard>>;

interface FlowStateNode {
  readonly type?: 'final';
  readonly on: Readonly<Record<string, { readonly target: string }>>;
}

/**
 * 机器工厂：吃版本化配置，产出 XState 状态机（扁平状态图）。
 * 配置已经 defineApprovalFlowConfig 校验；此处只做形态转换，不做再校验。
 */
export function createApprovalFlowMachine(config: ApprovalFlowConfig) {
  const stateNodes: Record<string, FlowStateNode> = {};
  for (const state of config.states) {
    stateNodes[state.id] = state.final ? { type: 'final', on: {} } : { on: {} };
  }
  for (const rule of config.transitions) {
    const node = stateNodes[rule.from];
    if (node === undefined) {
      throw new Error(`engine invariant violation: transition from unknown state "${rule.from}"`);
    }
    const mutableOn = { ...node.on };
    mutableOn[rule.event] = { target: rule.to };
    stateNodes[rule.from] = { ...(node.type === 'final' ? { type: 'final' } : {}), on: mutableOn };
  }

  return createMachine({
    id: config.flowId,
    initial: config.initial,
    states: stateNodes,
  });
}

export type ApprovalFlowMachine = ReturnType<typeof createApprovalFlowMachine>;
