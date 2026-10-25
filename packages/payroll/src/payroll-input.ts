/**
 * payroll 输入解析（M3；HTTP body/query → 业务输入）。
 *
 * 与 hours/costing 输入同一纪律：违规抛 PayrollInputError（组合根映射 400），
 * 绝不静默丢弃。命令命名 {module}.{verb}.v1（合同 §3）：payroll.rule.publish /
 * payroll.run.month / payroll.export。一切写操作走 smes.command.v1 信封
 * （G1 口径：先解析校验后记账）。
 *
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, UserId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { PayrollInputError } from './payroll-errors.js';
import {
  LABOR_KINDS,
  MAX_COEFFICIENT,
  MAX_PERIOD_HOURS,
  MAX_RATE_MINOR,
  DEFAULT_COEFFICIENT,
  isLaborKind,
  isMonth,
  type LaborKind,
} from './payroll-config.js';
import { PayrollRuleId, type PayrollRuleId as PayrollRuleIdType } from './payroll-ids.js';
import type { PayrollRuleScope } from './payroll-stores.js';

// ---- 命令动词（01-payroll.md §3 命令面） ----

export const PAYROLL_COMMAND_KINDS = [
  'payroll.rule.publish.v1',
  'payroll.run.month.v1',
  'payroll.export.v1',
] as const;

export type PayrollCommandKind = (typeof PAYROLL_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface PayrollCommand {
  readonly kind: PayrollCommandKind;
  readonly payload: unknown;
}

/** payroll 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type PayrollCommandEnvelope = CommandEnvelope<PayrollCommand>;

const RULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PayrollInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new PayrollInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new PayrollInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

/** 规则业务身份：kebab-case（人读稳定码，跨版本不变）。 */
export function requireRuleId(value: unknown, what: string): PayrollRuleIdType {
  const raw = requireBoundedString(value, what, 1, 128);
  if (!RULE_ID_PATTERN.test(raw)) {
    throw new PayrollInputError(`${what}须为 kebab-case（小写字母数字段 + 连字符，如 'part-hourly'）：${JSON.stringify(raw)}`);
  }
  return PayrollRuleId.create(raw);
}

/** 时薪量纲：(0, MAX_RATE_MINOR] 的整数（分/小时）。 */
export function requireRateMinor(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_RATE_MINOR) {
    throw new PayrollInputError(`${what}须为 (0, ${MAX_RATE_MINOR}] 内的整数（分/小时）：${JSON.stringify(value)}`);
  }
  return value;
}

/** 系数量纲：(0, MAX_COEFFICIENT] 的有限数（缺省 1）。 */
export function requireCoefficient(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_COEFFICIENT) {
    throw new PayrollInputError(`${what}须为 (0, ${MAX_COEFFICIENT}] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

/** 工种量纲：五词值集（未知词 rejected 不静默）。 */
export function requireLaborKind(value: unknown, what: string): LaborKind {
  if (typeof value !== 'string' || !isLaborKind(value)) {
    throw new PayrollInputError(`${what}非法：须为 ${LABOR_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireMonth(value: unknown, what: string): string {
  const month = requireBoundedString(value, what, 7, 7);
  if (!isMonth(month)) {
    throw new PayrollInputError(`${what}必须是 'YYYY-MM' 形式月份：${JSON.stringify(value)}`);
  }
  return month;
}

// ---- 信封体解析 ----

export interface PayrollEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: PayrollCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): PayrollEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new PayrollInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(PAYROLL_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new PayrollInputError(
      `command.kind 非法：须为 ${PAYROLL_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new PayrollInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as PayrollCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: PayrollCommandKind): PayrollEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new PayrollInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- payroll.rule.publish.v1 载荷（86 时薪维护面：发布/修订=新版本） ----

export interface PayrollRulePublishPayload {
  /** 规则业务身份（kebab；同名修订 = expectedRevision 乐观锁 + 新版本行）。 */
  readonly ruleId: PayrollRuleId;
  readonly name: string | null;
  /** v1 只接 hours（§8 #7：output 数据源未定——显式拒绝，防过早抽象）。 */
  readonly basis: 'hours';
  readonly rateMinor: number;
  readonly coefficient: number;
  /** 适用面（personId/laborKind/projectId 任意组合；全缺省 = 周期兜底规则）。 */
  readonly scope: PayrollRuleScope;
}

/** 适用面解析（差异表 #1：personId 维度——人员时薪主场景）。 */
function parseScope(input: unknown): PayrollRuleScope {
  if (input === undefined || input === null) return {};
  const record = requireObject(input, 'scope');
  const personIdRaw = optionalBoundedString(record['personId'], 'scope.personId', 1, 128);
  const laborKindRaw = record['laborKind'];
  const projectIdRaw = optionalBoundedString(record['projectId'], 'scope.projectId', 1, 128);
  const scope: {
    personId?: ReturnType<typeof UserId.create>;
    laborKind?: LaborKind;
    projectId?: string;
  } = {};
  if (personIdRaw !== undefined) scope.personId = UserId.create(personIdRaw);
  if (laborKindRaw !== undefined && laborKindRaw !== null) scope.laborKind = requireLaborKind(laborKindRaw, 'scope.laborKind');
  if (projectIdRaw !== undefined) scope.projectId = projectIdRaw;
  return scope;
}

export function parsePayrollRulePublishPayload(input: unknown): PayrollRulePublishPayload {
  const record = requireObject(input, 'payroll.rule.publish 载荷');
  const basis = record['basis'] === undefined || record['basis'] === null ? 'hours' : record['basis'];
  if (basis !== 'hours') {
    throw new PayrollInputError(
      `basis 非法：v1 只接 'hours' 事实源（功能项 86/87 = 工时×时薪）；'output'（计件）数据源未定（合同 §10），得到 ${JSON.stringify(basis)}`,
    );
  }
  return {
    ruleId: requireRuleId(record['ruleId'], 'ruleId'),
    name: optionalBoundedString(record['name'], 'name', 1, 256) ?? null,
    basis: 'hours',
    rateMinor: requireRateMinor(record['rateMinor'], 'rateMinor'),
    coefficient:
      record['coefficient'] === undefined || record['coefficient'] === null
        ? DEFAULT_COEFFICIENT
        : requireCoefficient(record['coefficient'], 'coefficient'),
    scope: parseScope(record['scope']),
  };
}

// ---- payroll.run.month.v1 载荷（87 月度核算/重算） ----

export interface PayrollRunMonthPayload {
  readonly periodKey: string;
  /** 可选单人聚焦（缺省 = 该月全部有事实人员）。 */
  readonly personId?: string;
}

export function parsePayrollRunMonthPayload(input: unknown): PayrollRunMonthPayload {
  const record = requireObject(input, 'payroll.run.month 载荷');
  const periodKey = requireMonth(record['periodKey'], 'periodKey');
  const personId = optionalBoundedString(record['personId'], 'personId', 1, 128);
  return personId === undefined ? { periodKey } : { periodKey, personId };
}

// ---- payroll.export.v1 载荷（导出端口化：ExportPort） ----

export interface PayrollExportPayload {
  readonly periodKey: string;
  /** 可选单人聚焦（缺省 = 该月全部已核算人员）。 */
  readonly personId?: string;
}

export function parsePayrollExportPayload(input: unknown): PayrollExportPayload {
  const record = requireObject(input, 'payroll.export 载荷');
  const periodKey = requireMonth(record['periodKey'], 'periodKey');
  const personId = optionalBoundedString(record['personId'], 'personId', 1, 128);
  return personId === undefined ? { periodKey } : { periodKey, personId };
}

// ---- 查询参数解析 ----

export function parseMonthParam(value: string | undefined, what: string): string {
  return requireMonth(value ?? '', what);
}

export function parseIdParam(value: string, what: string): string {
  return requireBoundedString(value, what, 1, 128);
}

/** 事实净工时上界校验（核算前的端口事实防线：负值/超界拒绝，不静默截断）。 */
export function requirePeriodHours(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PERIOD_HOURS) {
    throw new PayrollInputError(`${what}须为 [0, ${MAX_PERIOD_HOURS}] 内的数（小时）：${JSON.stringify(value)}`);
  }
  return value;
}
