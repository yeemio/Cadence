/**
 * dispatch 售后报销输入解析（U5 A12；HTTP body → 业务输入）。
 *
 * 与 dispatch-input 同一纪律：违规抛 DispatchInputError（组合根映射 400），
 * 绝不静默丢弃。命令动词独立成族（不改既有 DISPATCH_COMMAND_KINDS——
 * dispatch-input.ts 是既有冻结面）：
 *   aftercare.claim.save.v1   新增（expectedRevision='initial'）
 *   aftercare.claim.update.v1 编辑（expectedRevision=报销单当前 objectVersion）
 * 信封体形状与 smes.command.v1 全局约定一致：
 * { operationId, expectedRevision, command: { kind, payload } }——租户与
 * 操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 *
 * 口径重述（文档 §2.4.3 → 载荷规则）：
 *  - 四费非必填，未填默认按 0 落库，有值须 ≥0（整数分；与外包单价的
 *    ">0 才有效"不同——费用允许 0 值申报）；
 *  - 明细须与通过报工一致 → personLines 的 reportId 集校验（解析层查重复键，
 *    与报工集的恰合校验在用例层——事实经端口读）；
 *  - 金额上界：单项费与整单合计均 ≤ 2e9 分（int32 安全存储上界，对齐
 *    dispatch-input MAX_PRICE_MINOR 口径）。
 */
import { OperationId, type ExpectedRevision } from '@smes/business-core';
import { DispatchInputError } from './dispatch-errors.js';

// ---- 命令动词 ----

export const AFTERCARE_CLAIM_COMMAND_KINDS = [
  'aftercare.claim.save.v1',
  'aftercare.claim.update.v1',
] as const;

export type AftercareClaimCommandKind = (typeof AFTERCARE_CLAIM_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface AftercareClaimCommand {
  readonly kind: AftercareClaimCommandKind;
  readonly payload: unknown;
}

// ---- 通用小工具（同 dispatch-input 体例） ----

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DispatchInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new DispatchInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new DispatchInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(
  value: unknown,
  what: string,
  min: number,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

// ---- 费用解析（未填默认 0；有值须整数 ≥0 且 ≤上界） ----

/** 单项费用上界（分，int32 安全上界内——对齐 dispatch-input MAX_PRICE_MINOR）。 */
export const MAX_AFTERCARE_FEE_MINOR = 2_000_000_000;
/** 整单合计上界（分——四费 × 各行之和的落库安全上界；2000 万元）。 */
export const MAX_AFTERCARE_CLAIM_TOTAL_MINOR = 2_000_000_000;
/** 明细行数上界（对齐 dispatch-input MAX_OUTSOURCING_LINES）。 */
export const MAX_AFTERCARE_CLAIM_LINES = 200;

function optionalFeeMinor(value: unknown, what: string): number {
  if (value === undefined || value === null) return 0; // 未填默认按 0 落库（文档 §2.4.3）
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_AFTERCARE_FEE_MINOR
  ) {
    throw new DispatchInputError(
      `${what}须为 [0, ${MAX_AFTERCARE_FEE_MINOR}] 内的整数（分）：${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---- 信封体解析（同 parseCommandEnvelopeBody 体例，kind 族独立） ----

export interface AftercareClaimEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: AftercareClaimCommand;
}

/** 解析报销命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseAftercareClaimEnvelopeBody(input: unknown): AftercareClaimEnvelopeBody {
  const record = requireObject(input, '报销命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new DispatchInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (
    typeof kind !== 'string' ||
    !(AFTERCARE_CLAIM_COMMAND_KINDS as readonly string[]).includes(kind)
  ) {
    throw new DispatchInputError(
      `command.kind 非法：须为 ${AFTERCARE_CLAIM_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new DispatchInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as AftercareClaimCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseAftercareClaimBodyForKind(
  input: unknown,
  expected: AftercareClaimCommandKind,
): AftercareClaimEnvelopeBody {
  const parsed = parseAftercareClaimEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new DispatchInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- 费用行载荷 ----

/** 报销费用行载荷（文档 personLines：reportId 键控 + 四费 + 备注）。 */
export interface AftercareClaimPersonLinePayload {
  readonly reportId: string;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  readonly remark: string | null;
}

function parsePersonLines(raw: unknown): AftercareClaimPersonLinePayload[] {
  if (raw === undefined || raw === null) {
    throw new DispatchInputError('personLines 必填（明细行集 = 审批通过报工 × 售后人）');
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AFTERCARE_CLAIM_LINES) {
    throw new DispatchInputError(`personLines 非法：须为 [1, ${MAX_AFTERCARE_CLAIM_LINES}] 行的数组`);
  }
  const seen = new Set<string>();
  let total = 0;
  const lines = raw.map((entry, index) => {
    const line = requireObject(entry, `personLines[${index}]`);
    const reportId = requireBoundedString(line['reportId'], `personLines[${index}].reportId`, 1, 128);
    if (seen.has(reportId)) {
      throw new DispatchInputError(`personLines[${index}].reportId '${reportId}' 重复（明细键 = reportId）`);
    }
    seen.add(reportId);
    const fees = {
      lodgingMinor: optionalFeeMinor(line['lodgingMinor'], `personLines[${index}].lodgingMinor`),
      trafficMinor: optionalFeeMinor(line['trafficMinor'], `personLines[${index}].trafficMinor`),
      overtimeMinor: optionalFeeMinor(line['overtimeMinor'], `personLines[${index}].overtimeMinor`),
      otherMinor: optionalFeeMinor(line['otherMinor'], `personLines[${index}].otherMinor`),
    };
    total += fees.lodgingMinor + fees.trafficMinor + fees.overtimeMinor + fees.otherMinor;
    return {
      reportId,
      ...fees,
      remark: optionalBoundedString(line['remark'], `personLines[${index}].remark`, 1, 2000) ?? null,
    };
  });
  if (total > MAX_AFTERCARE_CLAIM_TOTAL_MINOR) {
    throw new DispatchInputError(
      `报销合计超上界：${total} > ${MAX_AFTERCARE_CLAIM_TOTAL_MINOR}（分）`,
    );
  }
  return lines;
}

// ---- aftercare.claim.save 载荷（新增） ----

export interface AftercareClaimSavePayload {
  /** 所挂售后派工单（文档 save 入参 dispatchOrderId）。 */
  readonly dispatchOrderId: string;
  readonly personLines: readonly AftercareClaimPersonLinePayload[];
}

export function parseAftercareClaimSavePayload(input: unknown): AftercareClaimSavePayload {
  const record = requireObject(input, 'aftercare.claim.save 载荷');
  return {
    dispatchOrderId: requireBoundedString(record['dispatchOrderId'], '派工单 dispatchOrderId', 1, 128),
    personLines: parsePersonLines(record['personLines']),
  };
}

// ---- aftercare.claim.update 载荷（编辑：派工单在路径参数，行集只改四费/备注） ----

export interface AftercareClaimUpdatePayload {
  readonly personLines: readonly AftercareClaimPersonLinePayload[];
}

export function parseAftercareClaimUpdatePayload(input: unknown): AftercareClaimUpdatePayload {
  const record = requireObject(input, 'aftercare.claim.update 载荷');
  return { personLines: parsePersonLines(record['personLines']) };
}
