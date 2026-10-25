import { describe, expect, it } from 'vitest';
import { EventId, UserId, type UserIdType } from '@smes/business-core';
import {
  DEFAULT_APPROVAL_FLOW_CONFIG,
  defineApprovalFlowConfig,
  startApprovalFlow,
  type ApprovalDecisionInput,
  type ApprovalFlowConfig,
  type ApprovalFlowRuntime,
  type ApprovalGuardContext,
} from '../src/index.js';

// ---- 测试台：确定性时钟与事件 id ----

function makeDeterministicDeps() {
  let tick = 0;
  let eventNo = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + tick * 1000).toISOString();
    },
    newEventId: () => {
      eventNo += 1;
      return EventId.create(`evt-${String(eventNo).padStart(3, '0')}`);
    },
  };
}

const subject = { aggregate: { id: 'wo-001', type: 'workorder' }, initialObjectVersion: 1 };

function start(
  config: ApprovalFlowConfig,
  guards?: Parameters<typeof startApprovalFlow>[0]['guards'],
): ApprovalFlowRuntime {
  const deps = makeDeterministicDeps();
  return guards === undefined
    ? startApprovalFlow({ config, subject, ...deps })
    : startApprovalFlow({ config, subject, guards, ...deps });
}

const worker: UserIdType = UserId.create('user-001');
const reviewerA: UserIdType = UserId.create('user-002');

function input(by: UserIdType = worker, reason = 'default reason', evidence?: ApprovalDecisionInput['evidence']): ApprovalDecisionInput {
  return evidence === undefined ? { by, reason } : { by, reason, evidence };
}

// ---- 默认配置行为 ----

describe('默认通用审批流', () => {
  it('全旅程：draft→submitted→in_review→escalated→in_review→approved，每次迁移产出事件并推进版本', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    expect(flow.state()).toBe('draft');
    expect(flow.objectVersion()).toBe(1);

    const r1 = flow.send('SUBMIT', input(worker, '提交送审'));
    expect(r1.status).toBe('transitioned');
    if (r1.status !== 'transitioned') return;
    expect(r1.from).toBe('draft');
    expect(r1.to).toBe('submitted');
    expect(r1.event.eventType).toBe('smes.general-approval.v1.submitted');
    expect(r1.record).toBeUndefined(); // 非决策迁移不产审批记录

    expect(flow.send('START_REVIEW', input(reviewerA, '开始评审')).status).toBe('transitioned');
    expect(flow.state()).toBe('in_review');

    const esc = flow.send('ESCALATE', input(reviewerA, '超出本人权限，上抛', [{ kind: 'note', ref: 'note-001' }]));
    expect(esc.status).toBe('transitioned');
    expect(flow.state()).toBe('escalated');

    expect(flow.send('RESUME', input(reviewerA, '回到评审')).status).toBe('transitioned');
    expect(flow.state()).toBe('in_review');

    const ok = flow.send('APPROVE', input(reviewerA, '对照放行标准通过'));
    expect(ok.status).toBe('transitioned');
    expect(flow.state()).toBe('approved');
    expect(flow.isFinal()).toBe(true);

    // 版本：5 次迁移，1 → 6
    expect(flow.objectVersion()).toBe(6);
    // 事件：每次迁移一个，append-only
    expect(flow.events()).toHaveLength(5);
    expect(flow.events().map((e) => e.eventType)).toEqual([
      'smes.general-approval.v1.submitted',
      'smes.general-approval.v1.review-started',
      'smes.general-approval.v1.escalated',
      'smes.general-approval.v1.resumed',
      'smes.general-approval.v1.approved',
    ]);
    // 决策记录：ESCALATE 与 APPROVE 是决策类迁移（SUBMIT/START_REVIEW/RESUME 不是）
    expect(flow.records()).toHaveLength(2);
    expect(flow.records()[0]?.decision).toBe('escalate');
    expect(flow.records()[0]?.reviewer).toBe('user-002');
    expect(flow.records()[0]?.objectVersion).toBe(3); // 决策所见版本（迁移前）
    expect(flow.records()[1]?.decision).toBe('approve');
    expect(flow.records()[1]?.objectVersion).toBe(5); // approve 前版本：已迁移 4 次
    expect(flow.events()[2]?.payload.objectVersion).toBe(4); // escalate 迁移后版本
    expect(flow.events()[4]?.payload.record?.decision).toBe('approve'); // 决策事件内嵌记录
  });

  it('withdraw 从 submitted 与 in_review 均可达终态 withdrawn', () => {
    const a = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    a.send('SUBMIT', input());
    expect(a.send('WITHDRAW', input(worker, '撤回')).status).toBe('transitioned');
    expect(a.state()).toBe('withdrawn');
    expect(a.isFinal()).toBe(true);

    const b = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    b.send('SUBMIT', input());
    b.send('START_REVIEW', input(reviewerA));
    b.send('REJECT', input(reviewerA, '不通过'));
    expect(b.state()).toBe('rejected');
    expect(b.isFinal()).toBe(true);
  });

  it('unhandled：无规则命令不改变状态/版本/账本', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    const outcome = flow.send('APPROVE', input(reviewerA));
    expect(outcome).toEqual({ status: 'unhandled', from: 'draft', event: 'APPROVE' });
    expect(flow.state()).toBe('draft');
    expect(flow.objectVersion()).toBe(1);
    expect(flow.events()).toHaveLength(0);
    expect(flow.records()).toHaveLength(0);
    expect(flow.can('APPROVE', input(reviewerA))).toBe(false);
    expect(flow.can('SUBMIT', input())).toBe(true);
  });

  it('终态后任何命令均 unhandled', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    flow.send('SUBMIT', input());
    flow.send('START_REVIEW', input(reviewerA));
    flow.send('REJECT', input(reviewerA, '不通过'));
    expect(flow.send('RESUBMIT', input())).toEqual({ status: 'unhandled', from: 'rejected', event: 'RESUBMIT' });
  });

  it('非法提交输入直接抛（校验先于规则查找）', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    expect(() => flow.send('SUBMIT', input(worker, '   '))).toThrow(/reason/);
    expect(() => flow.send('SUBMIT', { by: worker } as unknown as ApprovalDecisionInput)).toThrow(/reason/);
  });
});

// ---- 配置可替换性：同一工厂，换配置即换机器（ADR-0010 条 2 的行为差异证明） ----

const MULTI_ROUND_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: 'multi-round-review',
  initial: 'draft',
  states: [
    { id: 'draft' },
    { id: 'round_one' },
    { id: 'round_two' },
    { id: 'endorsed', final: true },
    { id: 'declined', final: true },
  ],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'round_one', eventAction: 'submitted' },
    { from: 'round_one', event: 'ADVANCE', to: 'round_two', guard: 'roundApproved', eventAction: 'advanced' },
    { from: 'round_one', event: 'DECLINE', to: 'declined', decision: 'reject', eventAction: 'declined' },
    { from: 'round_two', event: 'ENDORSE', to: 'endorsed', guard: 'roundApproved', decision: 'approve', eventAction: 'endorsed' },
    { from: 'round_two', event: 'DECLINE', to: 'declined', decision: 'reject', eventAction: 'declined' },
  ],
});

describe('配置真的可替换：5 态多轮签核配置 vs 默认配置', () => {
  it('同一 SUBMIT 命令，两台机器落到不同状态', () => {
    const generic = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    const multi = start(MULTI_ROUND_CONFIG, { roundApproved: () => true });
    expect(generic.state()).toBe('draft');
    expect(multi.state()).toBe('draft');

    generic.send('SUBMIT', input());
    multi.send('SUBMIT', input());
    expect(generic.state()).toBe('submitted'); // 默认配置
    expect(multi.state()).toBe('round_one'); // 自定义配置：无 submitted 态
  });

  it('命令集不同：默认流专有命令在自定义机器 unhandled，反之亦然', () => {
    const generic = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    const multi = start(MULTI_ROUND_CONFIG, { roundApproved: () => true });
    multi.send('SUBMIT', input());

    // START_REVIEW / ESCALATE 只存在于默认流
    expect(multi.send('START_REVIEW', input(reviewerA)).status).toBe('unhandled');
    expect(multi.send('ESCALATE', input(reviewerA)).status).toBe('unhandled');
    // DECLINE 只存在于自定义流
    expect(generic.send('DECLINE', input(reviewerA)).status).toBe('unhandled');
    // ADVANCE 在自定义流可用
    expect(multi.can('ADVANCE', input(reviewerA))).toBe(true);
  });

  it('通过路径与终态集不同：默认一步评审，自定义两轮签核', () => {
    const generic = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    const multi = start(MULTI_ROUND_CONFIG, { roundApproved: () => true });

    generic.send('SUBMIT', input());
    generic.send('START_REVIEW', input(reviewerA));
    generic.send('APPROVE', input(reviewerA, '通过'));
    expect(generic.state()).toBe('approved');

    multi.send('SUBMIT', input());
    expect(multi.send('ENDORSE', input(reviewerA, '未到轮次')).status).toBe('unhandled'); // 第一轮没有 ENDORSE
    expect(multi.send('ADVANCE', input(reviewerA, '第一轮通过')).status).toBe('transitioned');
    expect(multi.state()).toBe('round_two');
    expect(multi.send('ENDORSE', input(reviewerA, '第二轮背书')).status).toBe('transitioned');
    expect(multi.state()).toBe('endorsed');

    const genericFinals = DEFAULT_APPROVAL_FLOW_CONFIG.states.filter((s) => s.final).map((s) => s.id).sort();
    const multiFinals = MULTI_ROUND_CONFIG.states.filter((s) => s.final).map((s) => s.id).sort();
    expect(genericFinals).toEqual(['approved', 'rejected', 'withdrawn']);
    expect(multiFinals).toEqual(['declined', 'endorsed']);
    expect(multi.isFinal()).toBe(true);
  });

  it('事件命名空间随配置走', () => {
    const multi = start(MULTI_ROUND_CONFIG, { roundApproved: () => true });
    multi.send('SUBMIT', input());
    multi.send('ADVANCE', input(reviewerA, '第一轮通过'));
    expect(multi.events().map((e) => e.eventType)).toEqual([
      'smes.multi-round-review.v1.submitted',
      'smes.multi-round-review.v1.advanced',
    ]);
  });
});

// ---- 守卫 ----

describe('守卫（配置引用 + 注册表解析 + 薄层求值）', () => {
  it('守卫拒绝 → blocked，不产生记录/事件/版本变化', () => {
    const seen: ApprovalGuardContext[] = [];
    const flow = start(MULTI_ROUND_CONFIG, {
      roundApproved: (ctx) => {
        seen.push(ctx);
        return false;
      },
    });
    flow.send('SUBMIT', input());

    const outcome = flow.send('ADVANCE', input(reviewerA, '想跳过轮次'));
    expect(outcome).toEqual({ status: 'blocked', from: 'round_one', event: 'ADVANCE', guard: 'roundApproved' });
    expect(flow.state()).toBe('round_one');
    expect(flow.objectVersion()).toBe(2);
    expect(flow.events()).toHaveLength(1);
    expect(flow.records()).toHaveLength(0);
    expect(flow.can('ADVANCE', input(reviewerA))).toBe(false);

    // 守卫拿到了域上下文：迁出态 / 命令 / 提交输入 / 版本 / 决策史
    expect(seen).toHaveLength(2); // can() 与 send() 各求值一次
    expect(seen[0]?.state).toBe('round_one');
    expect(seen[0]?.event).toBe('ADVANCE');
    expect(seen[0]?.input.by).toBe('user-002');
    expect(seen[0]?.objectVersion).toBe(2);
    expect(seen[0]?.records).toEqual([]);
  });

  it('守卫放行 → 正常迁移（同一注册表开关翻转）', () => {
    let approved = false;
    const flow = start(MULTI_ROUND_CONFIG, {
      roundApproved: () => approved,
    });
    flow.send('SUBMIT', input());
    expect(flow.send('ADVANCE', input(reviewerA)).status).toBe('blocked');
    approved = true;
    expect(flow.can('ADVANCE', input(reviewerA))).toBe(true);
    expect(flow.send('ADVANCE', input(reviewerA)).status).toBe('transitioned');
    expect(flow.state()).toBe('round_two');
  });

  it('配置引用的守卫在注册表缺名时，启动即抛（fail-fast）', () => {
    expect(() => start(MULTI_ROUND_CONFIG)).toThrow(/unknown guard "roundApproved"/);
  });
});

// ---- 不可变与 append-only ----

describe('append-only 账本与不可变纪律', () => {
  it('事件/记录数组冻结：追加即抛，历史句柄引用稳定', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    flow.send('SUBMIT', input());
    flow.send('START_REVIEW', input(reviewerA));

    const eventsAfterTwo = flow.events();
    expect(Object.isFrozen(eventsAfterTwo)).toBe(true);
    expect(() => (eventsAfterTwo as unknown as unknown[]).push({})).toThrow(TypeError);

    flow.send('APPROVE', input(reviewerA, '通过'));
    const eventsAfterThree = flow.events();
    expect(eventsAfterThree).not.toBe(eventsAfterTwo); // 写时复制：新数组
    expect(eventsAfterTwo).toHaveLength(2); // 旧句柄不被改写
    expect(eventsAfterThree).toHaveLength(3);
    expect(eventsAfterThree[0]).toBe(eventsAfterTwo[0]); // 既有条目引用稳定
    expect(eventsAfterThree[1]).toBe(eventsAfterTwo[1]);
  });

  it('事件与记录深冻结，payload/record 不可变', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    flow.send('SUBMIT', input());
    flow.send('START_REVIEW', input(reviewerA));
    flow.send('REJECT', input(reviewerA, '不通过'));
    const event = flow.events()[2]!;
    const record = flow.records()[0]!;
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (event.payload as { to: string }).to = 'approved';
    }).toThrow();
    expect(() => {
      (record as { reason: string }).reason = 'tampered';
    }).toThrow();
  });

  it('snapshot 为冻结快照', () => {
    const flow = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    flow.send('SUBMIT', input());
    const snap = flow.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap).toMatchObject({ flowId: 'general-approval', state: 'submitted', isFinal: false, objectVersion: 2 });
    expect(snap.events).toBe(flow.events());
    expect(snap.records).toBe(flow.records());
  });

  it('同一配置可并行启动多个独立运行时，互不串账', () => {
    const a = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    const b = start(DEFAULT_APPROVAL_FLOW_CONFIG);
    a.send('SUBMIT', input());
    expect(b.state()).toBe('draft');
    expect(b.events()).toHaveLength(0);
    expect(a.events()).toHaveLength(1);
  });
});
