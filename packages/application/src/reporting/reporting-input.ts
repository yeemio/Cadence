/**
 * reporting 输入解析（M2-W7；HTTP body/query → 业务输入）。
 *
 * 与 workorder/listing/dispatch-input 同一纪律：违规抛 ReportInputError（组合根
 * 映射 400），绝不静默丢弃。命令命名 {module}.{verb}.v1（通用合同纪律 1）：
 * report.submit / report.submit-batch / report.audit-edit / report.verify /
 * report.revoke（均 .v1）。信封体形状：{ operationId, expectedRevision,
 * command: { kind, payload } }——租户与操作者不从请求体进（TenantContext /
 * AuthGuard，ADR-0005）；申报人 = 命令签发人（submit 按本人，载荷不带 reporter）。
 */
import { OperationId, type ExpectedRevision } from '@smes/business-core';
import { ReportInputError } from './reporting-errors.js';
import { REPORT_KINDS, type ReportKind } from './reporting-config.js';

// ---- 命令动词（05-reporting.md §3 命令面） ----

export const REPORT_COMMAND_KINDS = [
  'report.submit.v1',
  'report.submit-batch.v1',
  'report.audit-edit.v1',
  'report.verify.v1',
  'report.revoke.v1',
] as const;

export type ReportCommandKind = (typeof REPORT_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface ReportCommand {
  readonly kind: ReportCommandKind;
  readonly payload: unknown;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ReportInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new ReportInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ReportInputError(`${what}须为 ${min}~${max} 个非空白字符`);
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

function requireIsoDate(value: unknown, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ReportInputError(`${what}必须是 ISO 8601 日期时间字符串：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalIsoDate(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIsoDate(value, what);
}

/** 完工数量（正数；(0, 1e9] 内——与 dispatch quantity 同口径）。 */
function requireQuantity(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    throw new ReportInputError(`${what}须为 (0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

/** 工时分钟（正整数：(0, 1440×31] 内——单次报工上限一个月分钟数，防误输）。 */
const MAX_LABOR_MINUTES = 44_640;

export function requireLaborMinutes(value: unknown, what: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_LABOR_MINUTES
  ) {
    throw new ReportInputError(
      `${what}须为 (0, ${MAX_LABOR_MINUTES}] 内的整数分钟：${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---- 信封体解析 ----

export interface ReportEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: ReportCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): ReportEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new ReportInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(REPORT_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new ReportInputError(
      `command.kind 非法：须为 ${REPORT_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new ReportInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as ReportCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: ReportCommandKind): ReportEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new ReportInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- report.submit 载荷（单人单工序） ----

export interface ReportSubmitPayload {
  /** 所挂派工单（DispatchId，opaque；报工 kind 与工艺快照从派工单事实推导）。 */
  readonly dispatchId: string;
  readonly doneQty: number;
  /** 工时（整数分钟）。 */
  readonly laborMinutes: number;
  /** 业务时间（事后补录口径；缺省 = 申报时刻）。 */
  readonly businessTime: string | null;
  readonly remark: string | null;
}

export function parseReportSubmitPayload(input: unknown): ReportSubmitPayload {
  const record = requireObject(input, 'report.submit 载荷');
  return {
    dispatchId: requireBoundedString(record['dispatchId'], '派工单 dispatchId', 1, 128),
    doneQty: requireQuantity(record['doneQty'], '完工数量 doneQty'),
    laborMinutes: requireLaborMinutes(record['laborMinutes'], '工时 laborMinutes'),
    businessTime: optionalIsoDate(record['businessTime'], '业务时间 businessTime') ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- report.submit-batch 载荷（批量；上限在服务层按配置校验） ----

export interface BatchReportLinePayload {
  readonly dispatchId: string;
  readonly doneQty: number;
  readonly laborMinutes: number;
  readonly businessTime: string | null;
  readonly remark: string | null;
}

export interface ReportSubmitBatchPayload {
  readonly lines: readonly BatchReportLinePayload[];
}

/** 批内行解析上限（防御值——真实业务上限由服务层 batchLimit 配置拒绝）。 */
const MAX_BATCH_LINES_HARD = 1000;

export function parseReportSubmitBatchPayload(input: unknown): ReportSubmitBatchPayload {
  const record = requireObject(input, 'report.submit-batch 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ReportInputError('lines 非法：须为 ≥1 行的批量报工数组');
  }
  if (rawLines.length > MAX_BATCH_LINES_HARD) {
    throw new ReportInputError(`lines 超出防御上限（${MAX_BATCH_LINES_HARD} 行）`);
  }
  const lines = rawLines.map((entry, index) => {
    const line = requireObject(entry, `lines[${index}]`);
    return {
      dispatchId: requireBoundedString(line['dispatchId'], `lines[${index}].dispatchId`, 1, 128),
      doneQty: requireQuantity(line['doneQty'], `lines[${index}].doneQty`),
      laborMinutes: requireLaborMinutes(line['laborMinutes'], `lines[${index}].laborMinutes`),
      businessTime: optionalIsoDate(line['businessTime'], `lines[${index}].businessTime`) ?? null,
      remark: optionalBoundedString(line['remark'], `lines[${index}].remark`, 1, 2000) ?? null,
    };
  });
  return { lines };
}

// ---- report.audit-edit 载荷（修正版 + 原因） ----

/** 可编辑字段（数量/工时/备注/业务时间；未提供的键继承原单——修正版其余字段快照不变）。 */
export interface ReportAuditEditPayload {
  readonly doneQty: number | null;
  readonly laborMinutes: number | null;
  readonly businessTime: string | null;
  readonly remark: string | null;
  /** 编辑原因（必填——核查留痕的"为什么改"）。 */
  readonly reason: string;
}

export function parseReportAuditEditPayload(input: unknown): ReportAuditEditPayload {
  const record = requireObject(input, 'report.audit-edit 载荷');
  const doneQtyRaw = record['doneQty'];
  const laborRaw = record['laborMinutes'];
  return {
    doneQty:
      doneQtyRaw === undefined || doneQtyRaw === null ? null : requireQuantity(doneQtyRaw, '修正数量 doneQty'),
    laborMinutes:
      laborRaw === undefined || laborRaw === null
        ? null
        : requireLaborMinutes(laborRaw, '修正工时 laborMinutes'),
    businessTime: optionalIsoDate(record['businessTime'], '业务时间 businessTime') ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
    reason: requireBoundedString(record['reason'], '编辑原因 reason', 1, 2000),
  };
}

// ---- report.verify / report.revoke 载荷 ----

export interface ReportVerifyPayload {
  readonly remark: string | null;
}

export function parseReportVerifyPayload(input: unknown): ReportVerifyPayload {
  const record = requireObject(input, 'report.verify 载荷');
  return { remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null };
}

export interface ReportRevokePayload {
  /** 撤销原因（推荐必填——已核查撤销的冲销说明；初版可空）。 */
  readonly reason: string | null;
}

export function parseReportRevokePayload(input: unknown): ReportRevokePayload {
  const record = requireObject(input, 'report.revoke 载荷');
  return { reason: optionalBoundedString(record['reason'], '撤销原因 reason', 1, 2000) ?? null };
}

// ---- 路径/查询参数 ----

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new ReportInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new ReportInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 reported），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 五类 kind 过滤参数。 */
export function parseKindFilter(value: unknown): ReportKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(REPORT_KINDS as readonly string[]).includes(value)) {
    throw new ReportInputError(
      `kind 过滤参数非法：须为 ${REPORT_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`,
    );
  }
  return value as ReportKind;
}

/** 派工单过滤参数（query；undefined = 不过滤）。 */
export function parseDispatchFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ReportInputError(`dispatchId 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'dispatchId');
}

/** 申报人过滤参数（我的报工/按人视图；本人场景由控制器断言必填）。 */
export function parseReporterFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ReportInputError(`reporter 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'reporter');
}

/** 图号过滤参数（图号×工序进度查询键）。 */
export function parseDrawingFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ReportInputError(`drawingNo 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'drawingNo');
}

/** 趋势窗口天数参数（正整数，1~366；缺省 12——合同"12 日均"口径）。 */
export function parseTrendDaysFilter(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const days = typeof value === 'string' ? Number(value) : value;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 366) {
    throw new ReportInputError(`days 须为 1~366 的整数：${JSON.stringify(value)}`);
  }
  return days;
}
