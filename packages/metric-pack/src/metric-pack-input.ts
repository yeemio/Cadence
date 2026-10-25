/**
 * metric-pack 输入解析（M3；HTTP body/query → 业务输入）。
 *
 * 与 payroll 输入同一纪律：违规抛 MetricPackInputError（组合根映射 400），
 * 绝不静默丢弃。命令命名 {module}.{verb}.v1（合同 §3）：metric-pack.activate /
 * metric-pack.export。一切写操作走 smes.command.v1 信封（G1 口径：先解析校验
 * 后记账——被拒命令不占用 operationId）。
 *
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import type { MetricFilter, MetricQuery, TimeBasis } from '@smes/engine-reporting';
import { validateMetricFilter } from '@smes/engine-reporting';
import { MetricPackInputError } from './metric-pack-errors.js';

// ---- 命令动词（04-metric-pack.md §3 命令面） ----

export const METRIC_PACK_COMMAND_KINDS = [
  'metric-pack.activate.v1',
  'metric-pack.export.v1',
] as const;

export type MetricPackCommandKind = (typeof METRIC_PACK_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface MetricPackCommand {
  readonly kind: MetricPackCommandKind;
  readonly payload: unknown;
}

/** metric-pack 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type MetricPackCommandEnvelope = CommandEnvelope<MetricPackCommand>;

const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MetricPackInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new MetricPackInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new MetricPackInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, what: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, what, min, max);
}

function requireKebab(value: unknown, what: string): string {
  const raw = requireBoundedString(value, what, 1, 64);
  if (!KEBAB_PATTERN.test(raw)) {
    throw new MetricPackInputError(`${what}须为 kebab-case（小写字母数字段 + 连字符）：${JSON.stringify(raw)}`);
  }
  return raw;
}

function requirePackVersion(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new MetricPackInputError(`${what}须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireIsoTime(value: unknown, what: string): string {
  const raw = requireBoundedString(value, what, 1, 64);
  if (Number.isNaN(new Date(raw).getTime())) {
    throw new MetricPackInputError(`${what}须为 ISO 8601 时刻：${JSON.stringify(raw)}`);
  }
  return raw;
}

// ---- 信封体解析 ----

export interface MetricPackEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: MetricPackCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): MetricPackEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new MetricPackInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(METRIC_PACK_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new MetricPackInputError(
      `command.kind 非法：须为 ${METRIC_PACK_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new MetricPackInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as MetricPackCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: MetricPackCommandKind): MetricPackEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new MetricPackInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- metric-pack.activate.v1 载荷（装载/升级口径包） ----

/**
 * 激活载荷：完整口径包原始数据（可序列化 MetricPack 形状——运营侧拿到的
 * 售卖产物即此形状；服务层经 defineMetricPack 逐条校验冻结后落装载记录，
 * 合同 §3）。
 */
export interface MetricPackActivatePayload {
  readonly pack: Readonly<Record<string, unknown>>;
}

export function parseMetricPackActivatePayload(input: unknown): MetricPackActivatePayload {
  const record = requireObject(input, 'metric-pack.activate 载荷');
  const packRaw = record['pack'];
  if (packRaw === undefined || packRaw === null) {
    throw new MetricPackInputError('pack 必须提供（可序列化口径包原始数据）');
  }
  return { pack: requireObject(packRaw, 'pack') };
}

// ---- 口径查询形状（metric-pack.export 载荷与求值查询共用） ----

/**
 * 解析口径查询（MetricQuery 形状守门）：metricId kebab + version >= 1 钉死
 * 定义；时间窗 ISO；dimensionSlice = 维度字段 → 标量值数组；filter 交引擎
 * validateMetricFilter 校验（非法谓词在此拒绝）。装载校验后的切片字段合法
 * 性由引擎 evaluateMetric 断言（声明维度集合在其上下文内）。
 */
export function parseMetricQueryShape(input: unknown): MetricQuery {
  const record = requireObject(input, '口径查询');
  const metricId = requireKebab(record['metricId'], 'metricId');
  const version = requirePackVersion(record['version'], 'version');
  const from = record['from'] === undefined || record['from'] === null ? undefined : requireIsoTime(record['from'], 'from');
  const to = record['to'] === undefined || record['to'] === null ? undefined : requireIsoTime(record['to'], 'to');
  const timeBasisRaw = record['timeBasis'];
  let timeBasis: TimeBasis | undefined;
  if (timeBasisRaw !== undefined && timeBasisRaw !== null) {
    if (timeBasisRaw !== 'business' && timeBasisRaw !== 'available' && timeBasisRaw !== 'occurred') {
      throw new MetricPackInputError(
        `timeBasis 须为 business/available/occurred 之一：${JSON.stringify(timeBasisRaw)}`,
      );
    }
    timeBasis = timeBasisRaw;
  }
  let dimensionSlice: MetricQuery['dimensionSlice'] | undefined;
  if (record['dimensionSlice'] !== undefined && record['dimensionSlice'] !== null) {
    const sliceRaw = requireObject(record['dimensionSlice'], 'dimensionSlice');
    const slice: Record<string, readonly (string | number | boolean | null)[]> = {};
    for (const [field, values] of Object.entries(sliceRaw)) {
      if (!Array.isArray(values)) {
        throw new MetricPackInputError(`dimensionSlice['${field}'] 须为标量值数组：${JSON.stringify(values)}`);
      }
      for (const value of values) {
        if (
          !(
            value === null ||
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          )
        ) {
          throw new MetricPackInputError(
            `dimensionSlice['${field}'] 元素须为 string/number/boolean/null：${JSON.stringify(value)}`,
          );
        }
      }
      slice[field] = values as readonly (string | number | boolean | null)[];
    }
    dimensionSlice = slice;
  }
  let filter: MetricFilter | undefined;
  if (record['filter'] !== undefined && record['filter'] !== null) {
    try {
      filter = validateMetricFilter(record['filter']);
    } catch (error) {
      throw new MetricPackInputError(`filter 非法：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    metricId,
    version,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(timeBasis === undefined ? {} : { timeBasis }),
    ...(dimensionSlice === undefined ? {} : { dimensionSlice }),
    ...(filter === undefined ? {} : { filter }),
  };
}

/** 求值查询参数（HTTP query 场景：单对象形状，同 parseMetricQueryShape）。 */
export function parseEvaluateQuery(input: unknown): MetricQuery {
  return parseMetricQueryShape(input);
}

// ---- metric-pack.export.v1 载荷（报表导出：求值即重算 + 表集导出） ----

export type MetricPackExportPayload = MetricQuery;

export function parseMetricPackExportPayload(input: unknown): MetricPackExportPayload {
  requireObject(input, 'metric-pack.export 载荷');
  return parseMetricQueryShape(input);
}

// ---- 查询参数解析（组合根 query 面便利） ----

/** 任意字符串参数的口径查询解析（HTTP query 拼装对象后走 parseMetricQueryShape）。 */
export function parseQueryObject(value: string | undefined, what: string): Record<string, unknown> {
  const raw = requireBoundedString(value ?? '', what, 1, 8192);
  try {
    return requireObject(JSON.parse(raw), what);
  } catch {
    throw new MetricPackInputError(`${what}须为 JSON 对象字面量：${JSON.stringify(raw)}`);
  }
}
