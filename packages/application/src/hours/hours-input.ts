/**
 * hours 输入解析（M2-W6；HTTP body/query → 业务输入）。
 *
 * 与 workorder/listing 输入同一纪律：违规抛 HoursInputError（组合根映射 400），
 * 绝不静默丢弃。命令命名 {module}.{verb}.v1：合同 §3 的 hours.rebuild-month /
 * hours.adjust-entry，另加 hours.ingest（消费端口驱动的联动命令——一切写操作走
 * smes.command.v1 信封，通用合同纪律 1；"报工 verified 即时入账"的系统触发面，
 * 不开放手改单条目的载荷面）。
 *
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { HoursInputError } from './hours-errors.js';
import {
  HOURS_TRADES,
  MAX_HOURS_PER_ENTRY,
  REPORT_KINDS,
  WORK_DATE_PATTERN,
  isMonth,
  type HoursTrade,
  type ReportKind,
} from './hours-config.js';

// ---- 命令动词（08-hours.md §3 命令面 + 消费联动触发） ----

export const HOURS_COMMAND_KINDS = [
  'hours.ingest.v1',
  'hours.rebuild-month.v1',
  'hours.adjust-entry.v1',
] as const;

export type HoursCommandKind = (typeof HOURS_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface HoursCommand {
  readonly kind: HoursCommandKind;
  readonly payload: unknown;
}

/** hours 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type HoursCommandEnvelope = CommandEnvelope<HoursCommand>;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HoursInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new HoursInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HoursInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

/** 工时量纲：(0, MAX_HOURS_PER_ENTRY] 的有限数。 */
export function requireHours(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_HOURS_PER_ENTRY) {
    throw new HoursInputError(`${what}须为 (0, ${MAX_HOURS_PER_ENTRY}] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalQuantity(value: unknown, what: string): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new HoursInputError(`${what}须为 [0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireMonth(value: unknown, what: string): string {
  const month = requireBoundedString(value, what, 7, 7);
  if (!isMonth(month)) {
    throw new HoursInputError(`${what}必须是 'YYYY-MM' 形式月份：${JSON.stringify(value)}`);
  }
  return month;
}

export function requireWorkDate(value: unknown, what: string): string {
  const date = requireBoundedString(value, what, 10, 10);
  if (!WORK_DATE_PATTERN.test(date) || Number.isNaN(Date.parse(date))) {
    throw new HoursInputError(`${what}必须是 'YYYY-MM-DD' 形式日期：${JSON.stringify(value)}`);
  }
  return date;
}

export function requireTrade(value: unknown, what: string): HoursTrade {
  if (typeof value !== 'string' || !(HOURS_TRADES as readonly string[]).includes(value)) {
    throw new HoursInputError(`${what}非法：须为 ${HOURS_TRADES.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as HoursTrade;
}

export function requireReportKind(value: unknown, what: string): ReportKind {
  if (typeof value !== 'string' || !(REPORT_KINDS as readonly string[]).includes(value)) {
    throw new HoursInputError(`${what}非法：须为 ${REPORT_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as ReportKind;
}

// ---- 信封体解析 ----

export interface HoursEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: HoursCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): HoursEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new HoursInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(HOURS_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new HoursInputError(
      `command.kind 非法：须为 ${HOURS_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new HoursInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as HoursCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: HoursCommandKind): HoursEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new HoursInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- hours.ingest.v1 载荷（消费联动触发；无参数面） ----

export interface HoursIngestPayload {
  /** 单次消费的事件数上界（缺省 500；防单批过大的初版口径，可调）。 */
  readonly limit?: number;
}

export function parseHoursIngestPayload(input: unknown): HoursIngestPayload {
  const record = requireObject(input, 'hours.ingest 载荷');
  const limit = record['limit'];
  if (limit === undefined || limit === null) return {};
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new HoursInputError(`limit 须为 [1, 10000] 内的整数：${JSON.stringify(limit)}`);
  }
  return { limit };
}

// ---- hours.rebuild-month.v1 载荷 ----

export interface HoursRebuildMonthPayload {
  readonly month: string;
  /** 可选单人聚焦（缺省 = 该月全员）。 */
  readonly workerId?: string;
}

export function parseHoursRebuildMonthPayload(input: unknown): HoursRebuildMonthPayload {
  const record = requireObject(input, 'hours.rebuild-month 载荷');
  const month = requireMonth(record['month'], 'month');
  const workerId = optionalBoundedString(record['workerId'], 'workerId', 1, 128);
  return workerId === undefined ? { month } : { month, workerId };
}

// ---- hours.adjust-entry.v1 载荷（仅随报工修正/撤销联动，不开放手改） ----

export type HoursAdjustAction = 'verify' | 'correct' | 'revoke';

/** 联动载荷：报工核查动作的 hours 侧对应面。 */
export interface HoursAdjustEntryPayload {
  readonly reportId: string;
  /** verify = verified 入账；correct = 冲销旧值 + 按新值重入；revoke = 冲销。 */
  readonly action: HoursAdjustAction;
  readonly kind: ReportKind;
  readonly worker: string;
  readonly workDate: string;
  readonly hours: number;
  readonly doneQty: number | null;
  readonly dispatchId: string | null;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly processCode: string | null;
  readonly reason: string | null;
}

export function parseHoursAdjustEntryPayload(input: unknown): HoursAdjustEntryPayload {
  const record = requireObject(input, 'hours.adjust-entry 载荷');
  const actionRaw = requireBoundedString(record['action'], 'action', 1, 16);
  if (actionRaw !== 'verify' && actionRaw !== 'correct' && actionRaw !== 'revoke') {
    throw new HoursInputError(`action 非法：须为 verify/correct/revoke 之一，得到 ${JSON.stringify(actionRaw)}`);
  }
  const payload: HoursAdjustEntryPayload = {
    reportId: requireBoundedString(record['reportId'], 'reportId', 1, 128),
    action: actionRaw,
    kind: requireReportKind(record['kind'], 'kind'),
    worker: requireBoundedString(record['worker'], 'worker', 1, 128),
    workDate: requireWorkDate(record['workDate'], 'workDate'),
    hours: requireHours(record['hours'], 'hours'),
    doneQty: optionalQuantity(record['doneQty'], 'doneQty') ?? null,
    dispatchId: optionalBoundedString(record['dispatchId'], 'dispatchId', 1, 128) ?? null,
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    drawingNo: optionalBoundedString(record['drawingNo'], 'drawingNo', 1, 128) ?? null,
    processCode: optionalBoundedString(record['processCode'], 'processCode', 1, 128) ?? null,
    reason: optionalBoundedString(record['reason'], 'reason', 1, 512) ?? null,
  };
  // revoke/correct 携撤销或修正时点的完整快照值（reporting 事件口径）：hours
  // 恒必填——冲销需要被冲销量，缺值在 requireHours 处已 400。
  return payload;
}

// ---- 查询参数解析 ----

export function parseMonthParam(value: string | undefined, what: string): string {
  return requireMonth(value ?? '', what);
}

export function parseIdParam(value: string, what: string): string {
  return requireBoundedString(value, what, 1, 128);
}

export function parseOptionalIdParam(value: string | undefined, what: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requireBoundedString(value, what, 1, 128);
}

export function parseDateRange(from: string | undefined, to: string | undefined): { from?: string; to?: string } {
  const parsed: { from?: string; to?: string } = {};
  if (from !== undefined && from !== '') parsed.from = requireWorkDate(from, 'from');
  if (to !== undefined && to !== '') parsed.to = requireWorkDate(to, 'to');
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
    throw new HoursInputError(`from 不得晚于 to：${parsed.from} > ${parsed.to}`);
  }
  return parsed;
}
