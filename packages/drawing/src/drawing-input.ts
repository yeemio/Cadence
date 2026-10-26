/**
 * drawing 输入解析（M3；HTTP body/query → 业务输入）。
 *
 * 与 payroll 输入同一纪律：违规抛 DrawingInputError（组合根映射 400），绝不
 * 静默丢弃。命令命名 {module}.{verb}.v1（合同 §3）：drawing.publish（发布修订
 * =通知的上游动作，差异表 #1）。一切写操作走 smes.command.v1 信封（G1 口径：
 * 先解析校验后记账）。查看（viewRevision）是读路径动作，不走信封——留痕行
 * 即其操作事实（drawing.view 溯源形状见 drawing-events）。
 *
 * 图号编码规则=数据约定（差异表 #2）：drawingId 只做有界非空校验，不进
 * kebab 等编码模式（租户图号体系各异，过早绑定=定制面陷阱）。
 *
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, type CommandEnvelope, type ExpectedRevision } from '@smes/business-core';
import { DrawingInputError } from './drawing-errors.js';
import {
  CLASSIFICATION_LEVELS,
  DEFAULT_CLASSIFICATION_LEVEL,
  DRAWING_INDEX_DEFAULT_PAGE_SIZE,
  DRAWING_INDEX_MAX_PAGE_SIZE,
  requireClassificationLevel,
} from './drawing-config.js';
import { MAX_DRAWING_READ_REFERENCE_TTL_SECONDS } from './drawing-read-references.js';
import { DrawingId, type DrawingId as DrawingIdType } from './drawing-ids.js';

// ---- 命令动词（03-drawing.md §3 命令面全集） ----

export const DRAWING_COMMAND_KINDS = ['drawing.publish.v1'] as const;

export type DrawingCommandKind = (typeof DRAWING_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface DrawingCommand {
  readonly kind: DrawingCommandKind;
  readonly payload: unknown;
}

/** drawing 命令信封（makeCommandEnvelope 产物；服务层入参形状）。 */
export type DrawingCommandEnvelope = CommandEnvelope<DrawingCommand>;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DrawingInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new DrawingInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new DrawingInputError(`${what}须为 ${min}~${max} 个非空白字符`);
  }
  return trimmed;
}

/** 图纸标识：有界非空串（opaque 锚——"图号"编码规则=数据约定，不做模式校验）。 */
export function requireDrawingId(value: unknown, what: string): DrawingIdType {
  return DrawingId.create(requireBoundedString(value, what, 1, 128));
}

/** 修订号：>= 1 的整数。 */
export function requireVersion(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DrawingInputError(`${what}须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return value;
}

// ---- 信封体解析 ----

export interface DrawingEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: DrawingCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): DrawingEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(requireBoundedString(record['operationId'], 'operationId', 1, 128));
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new DrawingInputError(`expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`);
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(DRAWING_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new DrawingInputError(
      `command.kind 非法：须为 ${DRAWING_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new DrawingInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return { operationId, expectedRevision, command: { kind: kind as DrawingCommandKind, payload } };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: DrawingCommandKind): DrawingEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new DrawingInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- drawing.publish.v1 载荷（发布新修订；version 由链尾+1，不收客户端值） ----

export interface DrawingPublishPayload {
  readonly drawingId: DrawingIdType;
  /** 文件引用（存储键/URL；实施层解释——水印/签名 URL 不在本层）。 */
  readonly fileRef: string;
  /** 变更说明（必填：修订链追溯"改了什么"的锚点）。 */
  readonly changeNote: string;
  /** 保密等级（缺省 public/公开；值集两级，未知词拒绝）。 */
  readonly classification: string;
}

export function parseDrawingPublishPayload(input: unknown): DrawingPublishPayload {
  const record = requireObject(input, 'drawing.publish 载荷');
  return {
    drawingId: requireDrawingId(record['drawingId'], 'drawingId'),
    fileRef: requireBoundedString(record['fileRef'], 'fileRef', 1, 1024),
    changeNote: requireBoundedString(record['changeNote'], 'changeNote', 1, 2000),
    classification:
      record['classification'] === undefined || record['classification'] === null
        ? DEFAULT_CLASSIFICATION_LEVEL
        : requireClassificationLevel(record['classification'], 'classification'),
  };
}

// ---- 查询参数解析 ----

/** sinceVersion 游标（通知轮询）：>= 0 的整数（0=含首发通知）。 */
export function parseSinceVersionParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DrawingInputError(`sinceVersion 须为 >= 0 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

/** 索引页码（P1-c）：>= 1 的整数（缺省 1）。 */
export function parsePageIndexParam(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DrawingInputError(`page 须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

/** 索引页大小（P1-c）：1..上限 的整数（缺省 20）。 */
export function parsePageSizeParam(value: string | undefined): number {
  if (value === undefined || value === '') return DRAWING_INDEX_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > DRAWING_INDEX_MAX_PAGE_SIZE) {
    throw new DrawingInputError(`pageSize 须为 1~${String(DRAWING_INDEX_MAX_PAGE_SIZE)} 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

/** 索引前缀检索词（P1-c）：1~128 非空白字符（缺省/空串=不过滤）。 */
export function parseSearchParam(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return requireBoundedString(value, 'search', 1, 128);
}

/** 只读引用 TTL 秒（P1-e）：1..上限 的整数（缺省=本次查看不签发引用）。 */
export function parseReadReferenceTtlParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DRAWING_READ_REFERENCE_TTL_SECONDS) {
    throw new DrawingInputError(
      `referenceTtlSeconds 须为 1~${String(MAX_DRAWING_READ_REFERENCE_TTL_SECONDS)} 的整数：${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/** 路径参数 drawingId。 */
export function parseDrawingIdParam(value: string, what: string): DrawingIdType {
  return requireDrawingId(value, what);
}

/** 路径参数 version（字符串转数值后校验）。 */
export function parseVersionParam(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DrawingInputError(`${what}须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

/** 查看者许可等级解析（DrawingViewer.clearance 装配面；未知词 fail-fast）。 */
export function parseClearance(value: unknown, what: string): string {
  const raw = requireBoundedString(value, what, 1, 64);
  if (!(CLASSIFICATION_LEVELS as readonly string[]).includes(raw)) {
    throw new DrawingInputError(
      `${what}非法：须为 ${CLASSIFICATION_LEVELS.join('/')} 之一（保密许可值集与等级同源），得到 ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** 钉版引用（结构同形入参：消费方 { drawingId: string; version: number }）。 */
export interface DrawingRefInput {
  readonly drawingId: string;
  readonly version: number;
}

/** 钉版引用解析（按工作令图纸清单入参：组合根透传 workorder 附件载荷）。 */
export function parseDrawingRef(value: unknown): { readonly drawingId: DrawingIdType; readonly version: number } {
  const record = requireObject(value, 'drawingRef');
  const drawingId = requireDrawingId(record['drawingId'], 'drawingRef.drawingId');
  const version = requireVersion(record['version'], 'drawingRef.version');
  return { drawingId, version };
}
