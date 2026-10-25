import { describe, expect, it } from 'vitest';
import {
  makeCommandEnvelope,
  isCommandEnvelope,
  OperationId,
  TenantId,
  UserId,
} from '../src/index.js';

function validInput(): { tenantId: TenantId; issuedBy: UserId; operationId: OperationId; expectedRevision: 'initial'; issuedAt: string; command: { kind: 'createWorkOrder' } } {
  return {
    tenantId: TenantId.create('t-001'),
    issuedBy: UserId.create('u-001'),
    operationId: OperationId.create('op-001'),
    expectedRevision: 'initial',
    issuedAt: '2026-10-24T10:00:00.000Z',
    command: { kind: 'createWorkOrder' },
  };
}

describe('CommandEnvelope（smes.command.v1）', () => {
  it('构造合法信封并携带合同名', () => {
    const envelope = makeCommandEnvelope(validInput());
    expect(envelope.contract).toBe('smes.command.v1');
    expect(envelope.expectedRevision).toBe('initial');
  });

  it('接受 >= 1 的整数 expectedRevision，拒绝其他数字', () => {
    const input = validInput();
    expect(makeCommandEnvelope({ ...input, expectedRevision: 5 }).expectedRevision).toBe(5);
    expect(() => makeCommandEnvelope({ ...input, expectedRevision: 0 })).toThrow();
    expect(() => makeCommandEnvelope({ ...input, expectedRevision: -1 })).toThrow();
    expect(() => makeCommandEnvelope({ ...input, expectedRevision: 1.5 })).toThrow();
  });

  it('拒绝非法 issuedAt 与非法 command', () => {
    const input = validInput();
    expect(() => makeCommandEnvelope({ ...input, issuedAt: 'not-a-date' })).toThrow();
    expect(() => makeCommandEnvelope({ ...input, command: null as never })).toThrow();
    expect(() => makeCommandEnvelope({ ...input, command: [] as never })).toThrow();
  });

  it('构造后深冻结（不可变快照纪律）', () => {
    const envelope = makeCommandEnvelope(validInput());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.command)).toBe(true);
    expect(() => {
      (envelope.command as { kind: string }).kind = 'hack';
    }).toThrow(TypeError);
  });

  it('isCommandEnvelope 只认 smes.command.v1 合同名', () => {
    const envelope = makeCommandEnvelope(validInput());
    expect(isCommandEnvelope(envelope)).toBe(true);
    expect(isCommandEnvelope({ contract: 'other.v1' })).toBe(false);
    expect(isCommandEnvelope(null)).toBe(false);
  });
});
