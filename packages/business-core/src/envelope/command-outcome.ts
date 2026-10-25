/**
 * 命令三分结果：committed / rejected / indeterminate（决策簿"架构与模块化"页）。
 *
 * indeterminate = 命令可能已落账也可能未落（如写入后失联）。
 * retrySafe=false 时禁止自动重试，必须先人工对账，否则可能重复执行。
 * M1 起由命令处理器产出，本文件只定形状。
 */
import type { BusinessEvent } from '../events/business-event.js';

export interface CommittedOutcome {
  readonly status: 'committed';
  readonly newRevision: number;
  readonly events: readonly BusinessEvent[];
}

export interface RejectedOutcome {
  readonly status: 'rejected';
  readonly reason: string;
}

export interface IndeterminateOutcome {
  readonly status: 'indeterminate';
  readonly reason: string;
  readonly retrySafe: boolean;
}

export type CommandOutcome = CommittedOutcome | RejectedOutcome | IndeterminateOutcome;
