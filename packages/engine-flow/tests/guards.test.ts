import { describe, expect, it } from 'vitest';
import { EventId, UserId, type UserIdType } from '@smes/business-core';
import {
  defineApprovalFlowConfig,
  makeApprovalRecord,
  quorumGuard,
  roleGuard,
  startApprovalFlow,
  versionGuard,
  type ApprovalDecisionInput,
  type ApprovalFlowConfig,
  type ApprovalGuardContext,
  type ApprovalRecord,
} from '../src/index.js';

// ---- 测试台 ----

const u1: UserIdType = UserId.create('user-001');
const u2: UserIdType = UserId.create('user-002');
const u3: UserIdType = UserId.create('user-003');
const outsider: UserIdType = UserId.create('user-009');

function ctx(partial: Partial<ApprovalGuardContext> = {}): ApprovalGuardContext {
  return {
    state: 'open',
    event: 'ENDORSE',
    input: { by: u1, reason: 'default' },
    objectVersion: 1,
    records: [],
    ...partial,
  };
}

function vote(reviewer: UserIdType, decision: ApprovalRecord['decision'] = 'approve', objectVersion = 1): ApprovalRecord {
  return makeApprovalRecord({
    reviewer,
    decision,
    reason: '计票记录',
    objectVersion,
    decidedAt: '2026-10-25T10:00:00.000Z',
  });
}

// ---- quorumGuard ----

describe('quorumGuard（M 人中至少 N 个指定决策，防重复计票）', () => {
  const pool = ['user-001', 'user-002', 'user-003'];
  const quorum2 = quorumGuard({ decision: 'approve', distinctVoters: 2, eligibleVoters: pool });

  it('池内 2 个不同决策人各持 approve 记录 → 放行', () => {
    const guard = quorum2(ctx({ records: [vote(u1), vote(u2)], input: { by: u3, reason: 'x' } }));
    expect(guard).toBe(true);
  });

  it('防重复计票反例：同一人多次记录只计一票，不足 N → 拒绝', () => {
    expect(quorum2(ctx({ records: [vote(u1), vote(u1, 'approve', 2), vote(u1, 'approve', 3)] }))).toBe(false);
    // 补入第二个不同决策人后达标
    expect(quorum2(ctx({ records: [vote(u1), vote(u1, 'approve', 2), vote(u2)] }))).toBe(true);
  });

  it('池外决策人的记录不计票；决策类不符不计票', () => {
    expect(quorum2(ctx({ records: [vote(u1), vote(outsider)] }))).toBe(false); // 池外不计
    expect(quorum2(ctx({ records: [vote(u1), vote(u2, 'reject')] }))).toBe(false); // 计 approve，reject 不算
  });

  it('构造校验：坏 decision / 门槛 0 或超池 / 空池 / 池内重复 → 即抛', () => {
    expect(() => quorumGuard({ decision: 'sign' as never, distinctVoters: 1, eligibleVoters: pool })).toThrow(/decision/);
    expect(() => quorumGuard({ decision: 'approve', distinctVoters: 0, eligibleVoters: pool })).toThrow(/distinctVoters/);
    expect(() => quorumGuard({ decision: 'approve', distinctVoters: 4, eligibleVoters: pool })).toThrow(/exceeds pool/);
    expect(() => quorumGuard({ decision: 'approve', distinctVoters: 1, eligibleVoters: [] })).toThrow(/eligibleVoters/);
    expect(() =>
      quorumGuard({ decision: 'approve', distinctVoters: 2, eligibleVoters: ['user-001', 'user-001'] }),
    ).toThrow(/duplicate eligible voter/);
  });
});

// ---- roleGuard ----

describe('roleGuard（决策人须持指定角色，角色集由上下文注入）', () => {
  const reviewerOnly = roleGuard({ anyOf: ['reviewer'] });
  const adminOrReviewer = roleGuard({ anyOf: ['admin', 'reviewer'] });
  const input2: ApprovalDecisionInput = { by: u2, reason: 'x' };

  it('持任一指定角色 → 放行', () => {
    expect(reviewerOnly(ctx({ input: input2, roles: { 'user-002': ['reviewer'] } }))).toBe(true);
    expect(adminOrReviewer(ctx({ input: input2, roles: { 'user-002': ['viewer', 'admin'] } }))).toBe(true);
  });

  it('反例：角色不匹配 / 上下文无该决策人角色记录（fail-closed）→ 拒绝', () => {
    expect(reviewerOnly(ctx({ input: input2, roles: { 'user-002': ['viewer'] } }))).toBe(false);
    expect(reviewerOnly(ctx({ input: input2, roles: {} }))).toBe(false); // 无角色记录
    expect(reviewerOnly(ctx({ input: input2 }))).toBe(false); // 未注入角色表
  });

  it('构造校验：空 anyOf / 空角色名 → 即抛', () => {
    expect(() => roleGuard({ anyOf: [] })).toThrow(/anyOf/);
    expect(() => roleGuard({ anyOf: [''] })).toThrow(/anyOf/);
  });
});

// ---- versionGuard ----

describe('versionGuard（提交输入的版本声明须等于当前版本）', () => {
  const fresh = versionGuard();

  it('声明等于当前版本 → 放行', () => {
    expect(fresh(ctx({ input: { by: u1, reason: 'x', objectVersion: 4 }, objectVersion: 4 }))).toBe(true);
  });

  it('反例：声明过期/超前 / 缺省不带声明（fail-closed）→ 拒绝', () => {
    expect(fresh(ctx({ input: { by: u1, reason: 'x', objectVersion: 3 }, objectVersion: 4 }))).toBe(false);
    expect(fresh(ctx({ input: { by: u1, reason: 'x', objectVersion: 5 }, objectVersion: 4 }))).toBe(false);
    expect(fresh(ctx({ input: { by: u1, reason: 'x' }, objectVersion: 4 }))).toBe(false);
  });
});

// ---- 运行时集成：守卫库经注册表进入真实迁移路径 ----

const QUORUM_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: 'quorum-review',
  initial: 'open',
  states: [{ id: 'open' }, { id: 'endorsed', final: true }, { id: 'declined', final: true }],
  transitions: [
    // 自环累积计票：每次 VOTE 产一条 approve 记录，状态不动、版本 +1
    { from: 'open', event: 'VOTE', to: 'open', decision: 'approve', eventAction: 'vote-recorded' },
    { from: 'open', event: 'ENDORSE', to: 'endorsed', decision: 'approve', guard: 'gate', eventAction: 'endorsed' },
    { from: 'open', event: 'DECLINE', to: 'declined', decision: 'reject', eventAction: 'declined' },
  ],
});

const ROLE_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: 'role-gate',
  initial: 'open',
  states: [{ id: 'open' }, { id: 'endorsed', final: true }],
  transitions: [{ from: 'open', event: 'ENDORSE', to: 'endorsed', decision: 'approve', guard: 'gate', eventAction: 'endorsed' }],
});

const VERSION_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: 'version-gate',
  initial: 'open',
  states: [{ id: 'open' }, { id: 'advanced' }, { id: 'endorsed', final: true }],
  transitions: [
    { from: 'open', event: 'ADVANCE', to: 'advanced', guard: 'gate', eventAction: 'advanced' },
    { from: 'advanced', event: 'ENDORSE', to: 'endorsed', decision: 'approve', eventAction: 'endorsed' },
  ],
});

function start(
  config: ApprovalFlowConfig,
  extra: Partial<Parameters<typeof startApprovalFlow>[0]> = {},
): ReturnType<typeof startApprovalFlow> {
  let eventNo = 0;
  return startApprovalFlow({
    config,
    subject: { aggregate: { id: 'wo-001', type: 'workorder' }, initialObjectVersion: 1 },
    now: () => '2026-10-25T10:00:00.000Z',
    newEventId: () => EventId.create(`evt-${String((eventNo += 1)).padStart(3, '0')}`),
    ...extra,
  });
}

describe('守卫库 × 运行时（注册表 + 自环计票）', () => {
  it('quorumGuard：2/3 计票达标才放行 ENDORSE；重复票与池外票不计', () => {
    const flow = start(QUORUM_CONFIG, {
      guards: { gate: quorumGuard({ decision: 'approve', distinctVoters: 2, eligibleVoters: ['user-001', 'user-002', 'user-003'] }) },
    });
    flow.send('VOTE', { by: u1, reason: '同意' });
    flow.send('VOTE', { by: u1, reason: '再同意一次（应只计一票）' });
    expect(flow.can('ENDORSE', { by: u3, reason: '计票未达标' })).toBe(false);
    expect(flow.send('ENDORSE', { by: u3, reason: '计票未达标' }).status).toBe('blocked'); // 仍只有 1 个不同决策人

    flow.send('VOTE', { by: u2, reason: '第二票' });
    const outcome = flow.send('ENDORSE', { by: u3, reason: '计票达标背书' });
    expect(outcome.status).toBe('transitioned');
    expect(flow.state()).toBe('endorsed');
    // 自环投票产 3 条 approve 记录（版本 1/2/3），ENDORSE 决策记录针对版本 4
    expect(flow.records().map((r) => r.objectVersion)).toEqual([1, 2, 3, 4]);
    expect(flow.events().map((e) => e.eventType)).toEqual([
      'smes.quorum-review.v1.vote-recorded',
      'smes.quorum-review.v1.vote-recorded',
      'smes.quorum-review.v1.vote-recorded',
      'smes.quorum-review.v1.endorsed',
    ]);
  });

  it('quorumGuard 池外反例：池外人的投票不推进计票', () => {
    const flow = start(QUORUM_CONFIG, {
      guards: { gate: quorumGuard({ decision: 'approve', distinctVoters: 2, eligibleVoters: ['user-001', 'user-002'] }) },
    });
    flow.send('VOTE', { by: outsider, reason: '池外人投票' });
    flow.send('VOTE', { by: u1, reason: '池内第一票' });
    expect(flow.send('ENDORSE', { by: u2, reason: '仍差一票' }).status).toBe('blocked'); // 池外票不计，只有 1 票
    expect(flow.state()).toBe('open');
  });

  it('roleGuard：角色表经 StartApprovalFlowParams.roles 注入守卫上下文', () => {
    const flow = start(ROLE_CONFIG, {
      guards: { gate: roleGuard({ anyOf: ['reviewer', 'admin'] }) },
      roles: { 'user-002': ['reviewer'], 'user-003': ['viewer'] },
    });
    expect(flow.send('ENDORSE', { by: u3, reason: '角色不符' }).status).toBe('blocked');
    expect(flow.send('ENDORSE', { by: u2, reason: '评审人背书' }).status).toBe('transitioned');
    expect(flow.state()).toBe('endorsed');
  });

  it('versionGuard：缺省声明拒绝（fail-closed）、声明不符当前版本拒绝、声明正确放行', () => {
    const flow = start(VERSION_CONFIG, { guards: { gate: versionGuard() } });
    expect(flow.objectVersion()).toBe(1);
    expect(flow.send('ADVANCE', { by: u1, reason: '不带声明' }).status).toBe('blocked');
    expect(flow.send('ADVANCE', { by: u1, reason: '超前声明', objectVersion: 2 }).status).toBe('blocked');
    expect(flow.send('ADVANCE', { by: u1, reason: '针对当前版本', objectVersion: 1 }).status).toBe('transitioned');
    expect(flow.state()).toBe('advanced');
    expect(flow.objectVersion()).toBe(2);
  });
});
