/**
 * costing 输入解析（M2-W6；HTTP body/query → 业务输入）。
 *
 * 与既有模块输入同一纪律：违规抛 CostingInputError（组合根映射 400），绝不
 * 静默丢弃。命令命名 {module}.{verb}.v1（09-costing.md §3）：costing.model.
 * publish / costing.rebuild / costing.export。信封体形状：{ operationId,
 * expectedRevision, command: { kind, payload } }——租户与操作者不从请求体进
 * （ADR-0005）。
 */
import { OperationId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { CostingInputError } from './costing-errors.js';
import { COST_CATEGORIES, type CostCategory } from './costing-model.js';

// ---- 命令动词（09-costing.md §3 命令面） ----

export const COSTING_COMMAND_KINDS = [
  'costing.model.publish.v1',
  'costing.rebuild.v1',
  'costing.export.v1',
] as const;

export type CostingCommandKind = (typeof COSTING_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface CostingCommand {
  readonly kind: CostingCommandKind;
  readonly payload: unknown;
}

/** costing 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type CostingCommandEnvelope = CommandEnvelope<CostingCommand>;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CostingInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new CostingInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new CostingInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

function requirePositiveInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new CostingInputError(`${what}须为 [1, 1e9] 内的整数：${JSON.stringify(value)}`);
  }
  return value;
}

// ---- 信封体解析 ----

export interface CostingEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: CostingCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): CostingEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new CostingInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(COSTING_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new CostingInputError(
      `command.kind 非法：须为 ${COSTING_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new CostingInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as CostingCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: CostingCommandKind): CostingEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new CostingInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- costing.model.publish.v1 载荷 ----

export interface CostingModelPublishPayload {
  /** 口径码（版本链业务键；'standard' 为缺省口径码）。 */
  readonly code: string;
  readonly name: string | null;
  /** 工种时薪表（分/小时）——口径定义的单价来源段（类别映射/分摊段取初版默认）。 */
  readonly hourlyRates: unknown;
  readonly status: 'draft' | 'active';
}

export function parseCostingModelPublishPayload(input: unknown): CostingModelPublishPayload {
  const record = requireObject(input, 'costing.model.publish 载荷');
  const status = record['status'];
  if (status !== undefined && status !== null && status !== 'draft' && status !== 'active') {
    throw new CostingInputError(`status 非法：须为 draft/active 之一，得到 ${JSON.stringify(status)}`);
  }
  const rates = record['hourlyRates'];
  if (rates === undefined || rates === null) {
    throw new CostingInputError('hourlyRates 必须提供（工时金额化口径不可缺省）');
  }
  return {
    code: requireBoundedString(record['code'], 'code', 1, 64),
    name: optionalBoundedString(record['name'], 'name', 1, 256) ?? null,
    hourlyRates: rates,
    status: (status as 'draft' | 'active' | undefined | null) ?? 'active',
  };
}

// ---- costing.rebuild.v1 / costing.export.v1 载荷（口径选择器同形） ----

export interface CostingWorkOrderSelectorPayload {
  readonly workOrderId: string;
  /** 口径码（缺省 'standard'）。 */
  readonly modelCode?: string;
  /** 锁定口径版本（缺省 = 该码最新版本）。 */
  readonly modelVersion?: number;
}

export function parseWorkOrderSelectorPayload(input: unknown, what: string): CostingWorkOrderSelectorPayload {
  const record = requireObject(input, what);
  const modelVersion = record['modelVersion'];
  const modelCode = optionalBoundedString(record['modelCode'], 'modelCode', 1, 64);
  return {
    workOrderId: requireBoundedString(record['workOrderId'], 'workOrderId', 1, 128),
    ...(modelCode === undefined ? {} : { modelCode }),
    ...(modelVersion === undefined || modelVersion === null ? {} : { modelVersion: requirePositiveInt(modelVersion, 'modelVersion') }),
  };
}

// ---- 查询参数解析 ----

export function parseIdParam(value: string, what: string): string {
  return requireBoundedString(value, what, 1, 128);
}

export function parseOptionalIdParam(value: string | undefined, what: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requireBoundedString(value, what, 1, 128);
}

export function parseOptionalIntParam(value: string | undefined, what: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CostingInputError(`${what}须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseCategoryFilter(value: string | undefined): CostCategory | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(COST_CATEGORIES as readonly string[]).includes(value)) {
    throw new CostingInputError(`category 非法：须为 ${COST_CATEGORIES.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as CostCategory;
}
