import { describe, expect, it } from 'vitest';
import { EventId, UserId, type UserIdType } from '@smes/business-core';
import {
  DEFAULT_TIMER_PORT,
  createFakeTimerPort,
  defineApprovalFlowConfig,
  startApprovalFlow,
  type ApprovalDecisionInput,
  type ApprovalFlowConfig,
} from '../src/index.js';

// ---- 测试台 ----

const subject = { aggregate: { id: 'wo-001', type: 'workorder' }, initialObjectVersion: 1 };
const worker: UserIdType = UserId.create('user-001');
const reviewerA: UserIdType = UserId.create('user-002');
const systemUser: UserIdType = UserId.create('user-system');

const autoInput = (state: string, event: string): ApprovalDecisionInput => ({
  by: systemUser,
  reason: `auto ${event} from ${state} (sla timeout)`,
});

function input(by: UserIdType = worker, reason = 'default reason'): ApprovalDecisionInput {
  return { by, reason };
}

function autoRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flowId: 'auto-sla',
    initial: 'draft',
    states: [
      { id: 'draft' },
      { id: 'submitted', autoAfterMs: 5_000, autoEvent: 'ESCALATE' },
      { id: 'escalated', autoAfterMs: 3_000, autoEvent: 'TIMEOUT_REJECT' },
      { id: 'approved', final: true },
      { id: 'rejected', final: true },
    ],
    transitions: [
      { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
      { from: 'submitted', event: 'ESCALATE', to: 'escalated', decision: 'escalate', eventAction: 'escalated' },
      { from: 'submitted', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
      { from: 'escalated', event: 'TIMEOUT_REJECT', to: 'rejected', decision: 'reject', eventAction: 'timeout-rejected' },
      { from: 'escalated', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
    ],
  };
}

const AUTO_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig(autoRaw());

function startAuto(
  config: ApprovalFlowConfig = AUTO_CONFIG,
  overrides: Partial<Parameters<typeof startApprovalFlow>[0]> = {},
) {
  let eventNo = 0;
  const timer = createFakeTimerPort();
  const flow = startApprovalFlow({
    config,
    subject,
    timer,
    autoInput,
    now: () => '2026-10-25T10:00:00.000Z',
    newEventId: () => EventId.create(`evt-${String((eventNo += 1)).padStart(3, '0')}`),
    ...overrides,
  });
  return { flow, timer };
}

// ---- 到点自动迁移 ----

describe('超时自动迁移（假时钟证明）', () => {
  it('到点自动迁移：进入状态 N 毫秒后自动触发指定事件；链式状态逐段到点', () => {
    const { flow, timer } = startAuto();
    expect(timer.pending()).toBe(0); // draft 无超时配置
    flow.send('SUBMIT', input(worker, '提交送审'));
    expect(timer.pending()).toBe(1); // submitted 排定 5s

    timer.advance(4_999);
    expect(flow.state()).toBe('submitted'); // 未到点不动
    expect(timer.pending()).toBe(1);

    timer.advance(1); // 到点：ESCALATE 自动触发
    expect(flow.state()).toBe('escalated');
    expect(timer.pending()).toBe(1); // escalated 排定自己的 3s

    timer.advance(3_000); // 链式到点：TIMEOUT_REJECT
    expect(flow.state()).toBe('rejected');
    expect(flow.isFinal()).toBe(true);
    expect(timer.pending()).toBe(0); // 终态无自动迁移

    // 自动迁移走与人工相同路径：事件/决策记录/版本俱全，身份来自 autoInput 提供者
    expect(flow.events().map((e) => e.eventType)).toEqual([
      'smes.auto-sla.v1.submitted',
      'smes.auto-sla.v1.escalated',
      'smes.auto-sla.v1.timeout-rejected',
    ]);
    expect(flow.records().map((r) => r.decision)).toEqual(['escalate', 'reject']);
    expect(flow.events()[1]?.payload.actor).toBe('user-system');
    expect(flow.events()[1]?.payload.reason).toBe('auto ESCALATE from submitted (sla timeout)');
    expect(flow.objectVersion()).toBe(4); // 1 + 3 次迁移
  });

  it('到点前人工迁移（异命令）：定时器作废，绝不补触发', () => {
    const { flow, timer } = startAuto();
    flow.send('SUBMIT', input(worker, '提交送审'));
    flow.send('APPROVE', input(reviewerA, '提前通过')); // 到点前人工迁出 submitted
    expect(flow.state()).toBe('approved');
    expect(timer.pending()).toBe(0);

    timer.advance(60_000); // 远超原定时器
    expect(flow.state()).toBe('approved');
    expect(flow.events()).toHaveLength(2); // 无自动事件
  });

  it('到点前人工迁移（同名命令）：旧定时器作废，新状态定时器从人工进入时刻起算', () => {
    const { flow, timer } = startAuto();
    flow.send('SUBMIT', input(worker, '提交送审'));
    flow.send('ESCALATE', input(reviewerA, '人工提前上抛')); // 与 autoEvent 同名命令，人工先行
    expect(flow.state()).toBe('escalated');
    expect(timer.pending()).toBe(1); // escalated 的 3s 从此刻起算

    timer.advance(5_000); // 跨过 submitted 原定时器的到点时刻
    expect(flow.events().filter((e) => e.payload.event === 'ESCALATE')).toHaveLength(1); // 旧定时器作废，只此一次
    expect(flow.state()).toBe('rejected'); // escalated 的 3s 在 t=3000 已触发 TIMEOUT_REJECT
  });

  it('初始状态即带超时配置：启动即排定', () => {
    const raw = autoRaw();
    raw.initial = 'submitted';
    const { flow, timer } = startAuto(defineApprovalFlowConfig(raw));
    expect(timer.pending()).toBe(1);
    timer.advance(5_000);
    expect(flow.state()).toBe('escalated');
  });

  it('自动命令被守卫拒绝：一次性语义，不重试不重排，状态与账本不变', () => {
    const raw = autoRaw();
    (raw.transitions as { from?: string; event?: string; guard?: string }[]).forEach((rule) => {
      if (rule.from === 'submitted' && rule.event === 'ESCALATE') rule.guard = 'never';
    });
    const config = defineApprovalFlowConfig(raw);
    const { flow, timer } = startAuto(config, { guards: { never: () => false } });
    flow.send('SUBMIT', input(worker, '提交送审'));

    timer.advance(5_000); // 到点触发但被守卫拒绝
    expect(flow.state()).toBe('submitted');
    expect(timer.pending()).toBe(0); // 一次性：定时器已消费
    expect(flow.events()).toHaveLength(1); // 无自动事件
    expect(flow.records()).toHaveLength(0);
  });

  it('stop 后无孤儿定时器：advance 不再触发任何自动迁移；send 即抛、can 恒 false、stop 幂等', () => {
    const { flow, timer } = startAuto();
    flow.send('SUBMIT', input(worker, '提交送审'));
    expect(timer.pending()).toBe(1);

    flow.stop();
    expect(timer.pending()).toBe(0); // 在途定时器全部释放
    timer.advance(100_000);
    expect(flow.state()).toBe('submitted');
    expect(flow.events()).toHaveLength(1); // 无自动事件
    expect(flow.records()).toHaveLength(0);

    expect(() => flow.send('APPROVE', input(reviewerA))).toThrow(/stopped/);
    expect(flow.can('APPROVE', input(reviewerA))).toBe(false);
    expect(flow.snapshot().state).toBe('submitted'); // 账本与快照仍可读
    expect(() => flow.stop()).not.toThrow(); // 幂等
  });
});

// ---- 配置校验 ----

describe('超时配置校验（defineApprovalFlowConfig）', () => {
  /** 替换 submitted 状态定义（保留其余状态与全部迁移，避免别的校验先抛遮蔽目标错误）。 */
  const withSubmitted = (submitted: unknown): Record<string, unknown> => {
    const raw = autoRaw();
    raw.states = [
      { id: 'draft' },
      submitted,
      { id: 'escalated', autoAfterMs: 3_000, autoEvent: 'TIMEOUT_REJECT' },
      { id: 'approved', final: true },
      { id: 'rejected', final: true },
    ];
    return raw;
  };
  /** 替换 approved（终态）状态定义。 */
  const withApproved = (approved: unknown): Record<string, unknown> => {
    const raw = autoRaw();
    raw.states = [
      { id: 'draft' },
      { id: 'submitted', autoAfterMs: 5_000, autoEvent: 'ESCALATE' },
      { id: 'escalated', autoAfterMs: 3_000, autoEvent: 'TIMEOUT_REJECT' },
      approved,
      { id: 'rejected', final: true },
    ];
    return raw;
  };

  it('autoAfterMs 与 autoEvent 必须成对；autoEvent 须有 from 该状态的规则', () => {
    expect(() => defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoAfterMs: 5_000 }))).toThrow(/together/);
    expect(() => defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoEvent: 'ESCALATE' }))).toThrow(/together/);
    expect(() => defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoAfterMs: 100, autoEvent: 'NOPE' }))).toThrow(
      /no matching transition/,
    );
  });

  it('autoAfterMs 须正整数；autoEvent 须 SCREAMING_SNAKE_CASE；终态不得声明', () => {
    expect(() =>
      defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoAfterMs: 0, autoEvent: 'ESCALATE' })),
    ).toThrow(/autoAfterMs/);
    expect(() =>
      defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoAfterMs: 1.5, autoEvent: 'ESCALATE' })),
    ).toThrow(/autoAfterMs/);
    expect(() =>
      defineApprovalFlowConfig(withSubmitted({ id: 'submitted', autoAfterMs: 100, autoEvent: 'escalate' })),
    ).toThrow(/autoEvent/);
    expect(() =>
      defineApprovalFlowConfig(
        withApproved({ id: 'approved', final: true, autoAfterMs: 100, autoEvent: 'APPROVE' }),
      ),
    ).toThrow(/final state must not declare autoAfterMs/);
  });

  it('配置含 autoAfterMs 但启动未给 autoInput 提供者：启动即抛（fail-fast）', () => {
    let eventNo = 0;
    expect(() =>
      startApprovalFlow({
        config: AUTO_CONFIG,
        subject,
        now: () => '2026-10-25T10:00:00.000Z',
        newEventId: () => EventId.create(`evt-${String((eventNo += 1)).padStart(3, '0')}`),
      }),
    ).toThrow(/autoInput/);
  });
});

// ---- 默认端口冒烟 ----

describe('DEFAULT_TIMER_PORT（宿主 setTimeout）', () => {
  it('可排定并取消（不等待真实延时）', async () => {
    let fired = false;
    const handle = DEFAULT_TIMER_PORT.schedule(60_000, () => {
      fired = true;
    });
    DEFAULT_TIMER_PORT.cancel(handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(fired).toBe(false);
  });
});
