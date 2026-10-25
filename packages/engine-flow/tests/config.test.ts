import { describe, expect, it } from 'vitest';
import {
  APPROVAL_FLOW_CONFIG_SCHEMA_VERSION,
  DEFAULT_APPROVAL_FLOW_CONFIG,
  defineApprovalFlowConfig,
  type ApprovalFlowConfig,
} from '../src/index.js';

function baseRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flowId: 'general-approval',
    initial: 'draft',
    states: [{ id: 'draft' }, { id: 'approved', final: true }],
    transitions: [{ from: 'draft', event: 'SUBMIT', to: 'approved' }],
  };
}

describe('defineApprovalFlowConfig', () => {
  it('接受合法配置并深冻结', () => {
    const config = defineApprovalFlowConfig(baseRaw()) as ApprovalFlowConfig;
    expect(config.schemaVersion).toBe(APPROVAL_FLOW_CONFIG_SCHEMA_VERSION);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.states)).toBe(true);
    expect(Object.isFrozen(config.transitions)).toBe(true);
    expect(Object.isFrozen(config.transitions[0])).toBe(true);
  });

  it('拒绝未知 schemaVersion / 非法 flowId / 空 states / 未知 initial', () => {
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), flowId: 'General Approval' })).toThrow(/flowId/);
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), states: [] })).toThrow(/states/);
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), initial: 'missing' })).toThrow(/initial/);
  });

  it('拒绝重复状态、非法状态 id、未知迁移端点、重复规则、终态迁出', () => {
    expect(() =>
      defineApprovalFlowConfig({ ...baseRaw(), states: [{ id: 'draft' }, { id: 'draft' }] }),
    ).toThrow(/duplicate state/);
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), states: [{ id: 'Draft' }, { id: 'ok' }] })).toThrow(
      /state.*id/,
    );
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), transitions: [{ from: 'ghost', event: 'SUBMIT', to: 'approved' }] })).toThrow(
      /"from"/,
    );
    expect(() =>
      defineApprovalFlowConfig({
        ...baseRaw(),
        transitions: [
          { from: 'draft', event: 'SUBMIT', to: 'approved' },
          { from: 'draft', event: 'SUBMIT', to: 'approved' },
        ],
      }),
    ).toThrow(/duplicate rule/);
    expect(() =>
      defineApprovalFlowConfig({
        ...baseRaw(),
        states: [{ id: 'draft', final: true }, { id: 'approved', final: true }],
        transitions: [{ from: 'approved', event: 'SUBMIT', to: 'draft' }],
      }),
    ).toThrow(/final/);
  });

  it('拒绝非法命令动词 / 非法 decision / 非法 eventAction / 非法 guard 名', () => {
    expect(() => defineApprovalFlowConfig({ ...baseRaw(), transitions: [{ from: 'draft', event: 'submit!', to: 'approved' }] })).toThrow(
      /event/,
    );
    expect(() =>
      defineApprovalFlowConfig({ ...baseRaw(), transitions: [{ from: 'draft', event: 'SUBMIT', to: 'approved', decision: 'sign' }] }),
    ).toThrow(/decision/);
    expect(() =>
      defineApprovalFlowConfig({ ...baseRaw(), transitions: [{ from: 'draft', event: 'SUBMIT', to: 'approved', eventAction: 'OK!' }] }),
    ).toThrow(/eventAction/);
    expect(() =>
      defineApprovalFlowConfig({ ...baseRaw(), transitions: [{ from: 'draft', event: 'SUBMIT', to: 'approved', guard: '' }] }),
    ).toThrow(/guard/);
  });

  it('默认配置：通用审批 draft→submitted→评审循环→终态', () => {
    const config = DEFAULT_APPROVAL_FLOW_CONFIG;
    expect(config.initial).toBe('draft');
    expect(config.states.map((s) => s.id)).toEqual([
      'draft',
      'submitted',
      'in_review',
      'escalated',
      'approved',
      'rejected',
      'withdrawn',
    ]);
    expect(config.states.filter((s) => s.final).map((s) => s.id).sort()).toEqual(['approved', 'rejected', 'withdrawn']);
    // 评审循环：escalated 可回到 in_review；submitted/in_review/escalated 均可 withdraw
    expect(config.transitions.filter((t) => t.event === 'WITHDRAW').map((t) => t.from).sort()).toEqual([
      'escalated',
      'in_review',
      'submitted',
    ]);
    expect(config.transitions.find((t) => t.from === 'escalated' && t.event === 'RESUME')?.to).toBe('in_review');
    expect(Object.isFrozen(config)).toBe(true);
  });
});
