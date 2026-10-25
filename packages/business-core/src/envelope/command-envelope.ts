/**
 * CommandEnvelope —— smes.command.v1（ADR-0003 #3）
 *
 * 与 OwlCodaE product.v1 同构的命令信封；合同全文见
 * architecture/contracts/smes.command.v1.md。
 * expectedRevision = objectVersion 乐观锁：'initial' 表示创建，数字须为 >= 1 的整数。
 * 信封构造后深冻结（不可变快照纪律）。
 */
import { OperationId, TenantId, UserId } from '../ids.js';
import { deepFreeze } from '../internal/freeze.js';

export const COMMAND_ENVELOPE_CONTRACT = 'smes.command.v1';

export type ExpectedRevision = number | 'initial';

export interface CommandEnvelope<C = unknown> {
  readonly contract: typeof COMMAND_ENVELOPE_CONTRACT;
  readonly tenantId: TenantId;
  readonly issuedBy: UserId;
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly issuedAt: string;
  readonly command: C;
}

export interface CommandEnvelopeInput<C> {
  readonly tenantId: TenantId;
  readonly issuedBy: UserId;
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly issuedAt: string;
  readonly command: C;
}

function assertIsoDateTime(name: string, value: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid ${name}: expected an ISO 8601 date-time string`);
  }
}

export function makeCommandEnvelope<C extends object>(input: CommandEnvelopeInput<C>): CommandEnvelope<C> {
  const { tenantId, issuedBy, operationId, expectedRevision, issuedAt, command } = input;

  if (!TenantId.is(tenantId) || !UserId.is(issuedBy) || !OperationId.is(operationId)) {
    throw new Error('invalid envelope identity: tenantId / issuedBy / operationId must be valid branded ids');
  }

  if (expectedRevision !== 'initial' && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    throw new Error("invalid expectedRevision: 'initial' or an integer >= 1 (objectVersion)");
  }
  assertIsoDateTime('issuedAt', issuedAt);
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('invalid command: expected a non-null, non-array object');
  }

  return deepFreeze<CommandEnvelope<C>>({
    contract: COMMAND_ENVELOPE_CONTRACT,
    tenantId,
    issuedBy,
    operationId,
    expectedRevision,
    issuedAt,
    command,
  });
}

/** 结构级识别（只看合同名，不做完整校验）。 */
export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { contract?: unknown }).contract === COMMAND_ENVELOPE_CONTRACT
  );
}
