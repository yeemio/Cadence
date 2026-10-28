/**
 * inspection 输入解析（HTTP body / query → 业务输入；M2-W4）。
 *
 * 与 org/workbench/approval/workorder-input 同一纪律：违规抛 InspectionInputError
 * （组合根映射 400），绝不静默丢弃。命令信封体（POST body）形状：
 *   { operationId, expectedRevision, command: { kind, payload } }
 * ——租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005），控制器
 * 在 makeCommandEnvelope 处补齐后交 service.execute。
 */
import { OperationId, UserId, type ExpectedRevision } from '@smes/business-core';
import {
  INSPECTION_KINDS,
  INSPECTION_SOURCE_TYPES,
  NONCONFORM_DISPOSALS,
  type InspectionKind,
  type InspectionSourceType,
  type NonconformDisposal,
} from './inspection-config.js';
import { InspectionInputError } from './inspection-errors.js';

// ---- 命令动词（06-inspection.md §3） ----

export const INSPECTION_COMMAND_KINDS = [
  'inspection.create.v1',
  'inspection.judge.v1',
  'inspection.judge-batch.v1',
  'inspection.recheck.v1',
  'inspection.concession.v1',
  'inspection.revoke.v1',
  'inspection.overdue.scan.v1',
  'nonconform.dispose.v1',
  'nonconform.close.v1',
] as const;

export type InspectionCommandKind = (typeof INSPECTION_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface InspectionCommand {
  readonly kind: InspectionCommandKind;
  readonly payload: unknown;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InspectionInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new InspectionInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new InspectionInputError(`${what}须为 ${min}~${max} 个非空白字符`);
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

function requireQuantity(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    throw new InspectionInputError(`${what}须为 (0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new InspectionInputError(`${what}须为 [0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireKind(value: unknown, what: string): InspectionKind {
  if (typeof value !== 'string' || !(INSPECTION_KINDS as readonly string[]).includes(value)) {
    throw new InspectionInputError(
      `${what}非法：须为 ${INSPECTION_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`,
    );
  }
  return value as InspectionKind;
}

// ---- 信封体解析 ----

export interface InspectionEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: InspectionCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): InspectionEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new InspectionInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(INSPECTION_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new InspectionInputError(
      `command.kind 非法：须为 ${INSPECTION_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new InspectionInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload'); // 形状校验；各命令字段由解析器细查
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as InspectionCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致（POST /xxx/:id/judgment 只收 inspection.judge.v1）。 */
export function parseCommandBodyForKind(
  input: unknown,
  expected: InspectionCommandKind,
): InspectionEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new InspectionInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- 各命令载荷 ----

export interface CreateInspectionPayload {
  readonly kind: InspectionKind;
  /** 来源引用（手工建单可空——多由来源事件自动生成，也留手工建单）。 */
  readonly sourceType: InspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly remark: string | null;
}

function requireSourceType(value: unknown, what: string): InspectionSourceType {
  if (typeof value !== 'string' || !(INSPECTION_SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new InspectionInputError(
      `${what}非法：须为 ${INSPECTION_SOURCE_TYPES.join('/')} 之一，得到 ${JSON.stringify(value)}`,
    );
  }
  return value as InspectionSourceType;
}

export function parseCreateInspectionPayload(input: unknown): CreateInspectionPayload {
  const record = requireObject(input, 'inspection.create 载荷');
  const sourceType = record['sourceType'] === undefined || record['sourceType'] === null
    ? null
    : requireSourceType(record['sourceType'], '来源类型 sourceType');
  const sourceRefId = optionalBoundedString(record['sourceRefId'], '来源对象 sourceRefId', 1, 128) ?? null;
  if ((sourceType === null) !== (sourceRefId === null)) {
    throw new InspectionInputError('sourceType 与 sourceRefId 须成对提供（或均缺省=手工建单）');
  }
  return {
    kind: requireKind(record['kind'], '质检类别 kind'),
    sourceType,
    sourceRefId,
    itemId: optionalBoundedString(record['itemId'], '物料 itemId', 1, 128) ?? null,
    drawingNo: optionalBoundedString(record['drawingNo'], '图号 drawingNo', 1, 128) ?? null,
    quantity: requireQuantity(record['quantity'], '送检数量 quantity'),
    remark: optionalBoundedString(record['remark'], '建单备注 remark', 1, 2000) ?? null,
  };
}

/** 判定与复检共用数量载荷（inspection.judge / inspection.recheck）。 */
export interface JudgeInspectionPayload {
  readonly itemId?: string;
  readonly passedQty: number;
  readonly failedQty: number;
  readonly remark: string | null;
}

function parseJudgmentQuantities(record: Record<string, unknown>, what: string): JudgeInspectionPayload {
  const passedQty = requireCount(record['passedQty'], `${what}合格数量 passedQty`);
  const failedQty = requireCount(record['failedQty'], `${what}不合格数量 failedQty`);
  return {
    passedQty,
    failedQty,
    ...(typeof record['itemId'] === 'string' ? { itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128) } : {}),
    remark: optionalBoundedString(record['remark'], `${what}备注 remark`, 1, 2000) ?? null,
  };
}

export function parseJudgeInspectionPayload(input: unknown): JudgeInspectionPayload {
  const record = requireObject(input, 'inspection.judge 载荷');
  return parseJudgmentQuantities(record, '判定');
}

export function parseRecheckInspectionPayload(input: unknown): JudgeInspectionPayload {
  const record = requireObject(input, 'inspection.recheck 载荷');
  return parseJudgmentQuantities(record, '复检');
}

// ---- inspection.concession 载荷（fix-wave-6 6a-2 / RQ-035 特采确认） ----

/**
 * 特采确认载荷：quantity = 本次特采数量（源 NsPurchaseQcSubmitDTO.inboundQuantity，
 * ≥1）。源口径"无审批、无原因"——不设 reason 字段；服务层校验
 * quantity ≤ 不合格 − 已特采（剩余可特采边界）。
 */
export interface ConcessionInspectionPayload {
  readonly quantity: number;
}

export function parseConcessionInspectionPayload(input: unknown): ConcessionInspectionPayload {
  const record = requireObject(input, 'inspection.concession 载荷');
  return { quantity: requireQuantity(record['quantity'], '特采数量 quantity') };
}

// ---- inspection.judge-batch 载荷（fix-wave-6 6a-2 / RQ-036 批量质检） ----

/** 批量行：目标质检单 + 该单乐观锁版本（整批"全部合格"无数量载荷）。 */
export interface JudgeBatchLine {
  readonly inspectionId: string;
  readonly expectedRevision: number;
  readonly remark: string | null;
}

export interface JudgeBatchPayload {
  readonly lines: readonly JudgeBatchLine[];
}

/** 批内行解析上限（防御值——真实业务上限由服务层 batchLimit 配置拒绝）。 */
const BATCH_LINE_PARSE_LIMIT = 500;

export function parseJudgeBatchPayload(input: unknown): JudgeBatchPayload {
  const record = requireObject(input, 'inspection.judge-batch 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length < 1) {
    throw new InspectionInputError('inspection.judge-batch 载荷 lines 须为非空数组');
  }
  if (rawLines.length > BATCH_LINE_PARSE_LIMIT) {
    throw new InspectionInputError(`inspection.judge-batch 单次最多 ${BATCH_LINE_PARSE_LIMIT} 行（防御上限）`);
  }
  const lines = rawLines.map((line, index) => {
    const row = requireObject(line, `批量第 ${index + 1} 行`);
    const expectedRevision = row['expectedRevision'];
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new InspectionInputError(
        `批量第 ${index + 1} 行 expectedRevision 须为 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
      );
    }
    return {
      inspectionId: parseIdParam(
        String(requireBoundedString(row['inspectionId'], `批量第 ${index + 1} 行 inspectionId`, 1, 128)),
        `批量第 ${index + 1} 行质检单 id`,
      ),
      expectedRevision,
      remark: optionalBoundedString(row['remark'], `批量第 ${index + 1} 行备注 remark`, 1, 2000) ?? null,
    };
  });
  return { lines };
}

// ---- inspection.revoke 载荷（fix-wave-6 6a-2 / RQ-037 撤销质检） ----

/** 撤销载荷：remark = 撤销原因（推荐必填留痕，口径同 reporting 撤销）。 */
export interface RevokeInspectionPayload {
  readonly remark: string | null;
}

export function parseRevokeInspectionPayload(input: unknown): RevokeInspectionPayload {
  const record = requireObject(input, 'inspection.revoke 载荷');
  return { remark: optionalBoundedString(record['remark'], '撤销原因 remark', 1, 2000) ?? null };
}

export interface DisposeNonconformPayload {
  readonly disposal: NonconformDisposal;
  /** 不合格原因（处置判定必填留痕）。 */
  readonly reason: string;
  readonly remark: string | null;
}

export function parseDisposeNonconformPayload(input: unknown): DisposeNonconformPayload {
  const record = requireObject(input, 'nonconform.dispose 载荷');
  const disposal = record['disposal'];
  if (typeof disposal !== 'string' || !(NONCONFORM_DISPOSALS as readonly string[]).includes(disposal)) {
    throw new InspectionInputError(
      `处置方式 disposal 非法：须为 ${NONCONFORM_DISPOSALS.join('/')}（返工/让步/报废）之一，得到 ${JSON.stringify(disposal)}`,
    );
  }
  return {
    disposal: disposal as NonconformDisposal,
    reason: requireBoundedString(record['reason'], '不合格原因 reason', 1, 2000),
    remark: optionalBoundedString(record['remark'], '处置备注 remark', 1, 2000) ?? null,
  };
}

export interface CloseNonconformPayload {
  readonly remark: string | null;
}

export function parseCloseNonconformPayload(input: unknown): CloseNonconformPayload {
  const record = requireObject(input, 'nonconform.close 载荷');
  return { remark: optionalBoundedString(record['remark'], '闭环备注 remark', 1, 2000) ?? null };
}

// ---- inspection.overdue.scan 载荷（无必填字段——点名是系统/主管动作） ----

export function parseOverdueScanPayload(input: unknown): Record<string, never> {
  return requireObject(input, 'inspection.overdue.scan 载荷') as Record<string, never>; // 空对象合法
}

// ---- 路径/查询参数 ----

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new InspectionInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（query；undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new InspectionInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 pending），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 四类质检队列的 kind 过滤参数（query；白名单四类）。 */
export function parseKindFilter(value: unknown): InspectionKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireKind(value, '质检类别过滤参数 kind');
}

/** 不合格明细列表的质检单过滤参数（query）。 */
export function parseInspectionIdFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseIdParam(String(value), '质检单 id 过滤参数 inspectionId');
}

/** 手工建单操作者兜底（不提供时取系统质检账号——命令信封口径见 service）。 */
export function optionalUserId(value: unknown, what: string): UserId | undefined {
  if (value === undefined || value === null) return undefined;
  return UserId.create(requireBoundedString(value, what, 1, 128));
}
