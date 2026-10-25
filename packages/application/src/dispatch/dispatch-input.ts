/**
 * dispatch 输入解析（M2-W6；HTTP body/query → 业务输入）。
 *
 * 与 workorder-input / listing-input 同一纪律：违规抛 DispatchInputError（组合根
 * 映射 400），绝不静默丢弃。命令命名 {module}.{verb}.v1（通用合同纪律 1）：
 * dispatch.create / dispatch.assign / dispatch.start / dispatch.complete /
 * dispatch.cancel / outsourcing.price.backfill（均 .v1）。
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, UserId, type ExpectedRevision } from '@smes/business-core';
import { DispatchInputError } from './dispatch-errors.js';
import { DISPATCH_KINDS, type DispatchKind } from './dispatch-config.js';

// ---- 命令动词（04-dispatch.md §3 命令面） ----

export const DISPATCH_COMMAND_KINDS = [
  'dispatch.create.v1',
  'dispatch.assign.v1',
  'dispatch.start.v1',
  'dispatch.complete.v1',
  'dispatch.cancel.v1',
  'outsourcing.price.backfill.v1',
] as const;

export type DispatchCommandKind = (typeof DISPATCH_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface DispatchCommand {
  readonly kind: DispatchCommandKind;
  readonly payload: unknown;
}

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

function requireIsoDate(value: unknown, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DispatchInputError(`${what}必须是 ISO 8601 日期时间字符串：${JSON.stringify(value)}`);
  }
  return value;
}

function optionalIsoDate(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIsoDate(value, what);
}

function optionalUserId(value: unknown, what: string): UserId | undefined {
  if (value === undefined || value === null) return undefined;
  return UserId.create(requireBoundedString(value, what, 1, 128));
}

function requireQuantity(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    throw new DispatchInputError(`${what}须为 (0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

const MAX_PRICE_MINOR = 2_000_000_000; // int32 安全上界内（PG Int 列；对齐 listing 口径）
const MAX_MARGIN_PERMYRIAD = 100_000; // 万分比上界（对齐 baseline outsourcing-price 口径）
const MAX_OUTSOURCING_LINES = 200;

function optionalUnitPriceMinor(value: unknown, what: string): number | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_PRICE_MINOR
  ) {
    throw new DispatchInputError(
      `${what}须为 (0, ${MAX_PRICE_MINOR}] 内的整数（分）：${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---- 信封体解析 ----

export interface DispatchEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: DispatchCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): DispatchEnvelopeBody {
  const record = requireObject(input, '命令信封体');
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
  if (typeof kind !== 'string' || !(DISPATCH_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new DispatchInputError(
      `command.kind 非法：须为 ${DISPATCH_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
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
    command: { kind: kind as DispatchCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: DispatchCommandKind): DispatchEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new DispatchInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- dispatch.create 载荷（六类判别校验） ----

/** 外协明细行载荷（kind=outsourcing 必填行集——批量派发到供应商）。 */
export interface OutsourcingLinePayload {
  readonly processCode: string;
  readonly drawingNo: string | null;
  readonly supplierRef: string;
  readonly supplierName: string | null;
  readonly quantity: number;
  /** 单价（分；缺省走 baseline 实时取价，取不到落未定价）。 */
  readonly unitPriceMinor: number | null;
  readonly promisedAt: string | null;
  /** 来源清单行锚点（listing 零件清单行 id，opaque）。 */
  readonly sourceListingLineId: string | null;
}

export interface DispatchCreatePayload {
  readonly workOrderId: string | null;
  readonly kind: DispatchKind;
  readonly title: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  /** 材料随单（零件单工艺属性快照）。 */
  readonly material: string | null;
  /** 尺寸随单（零件单工艺属性快照）。 */
  readonly sizeSpec: string | null;
  readonly quantity: number;
  readonly assignee: UserId | null;
  readonly dueAt: string | null;
  readonly remark: string | null;
  readonly lines: readonly OutsourcingLinePayload[];
}

/**
 * 六类 kind 的载荷判别（04-dispatch.md §2）：
 *  - part（零件）：图号 + 工序必填（图号×工序是机加工上卷键），材料/尺寸随单；
 *  - outsourcing（外协）：明细行集必填（≥1 行，每行供应商+工序+数量——批量派发）；
 *  - assembly / electrical（装配/电气）：工序必填（装配调试上卷键；创建时另经
 *    齐套放行拦截——服务侧校验，非载荷校验）；
 *  - aftermarket / oddjob（售后/零工）：标题必填（描述性工作），工序可空。
 */
export function parseDispatchCreatePayload(input: unknown): DispatchCreatePayload {
  const record = requireObject(input, 'dispatch.create 载荷');
  const kind = requireKind(record['kind'], '派工 kind');
  const workOrderId = optionalBoundedString(record['workOrderId'], '工作令 workOrderId', 1, 128) ?? null;
  const title = optionalBoundedString(record['title'], '标题 title', 1, 256) ?? null;
  const drawingNo = optionalBoundedString(record['drawingNo'], '图号 drawingNo', 1, 128) ?? null;
  const operationCode =
    optionalBoundedString(record['operationCode'], '工序 operationCode', 1, 128) ?? null;
  const material = optionalBoundedString(record['material'], '材料 material', 1, 256) ?? null;
  const sizeSpec = optionalBoundedString(record['sizeSpec'], '尺寸 sizeSpec', 1, 256) ?? null;

  if (kind === 'part' && (drawingNo === null || operationCode === null)) {
    throw new DispatchInputError('零件派工必须携带图号（drawingNo）与工序（operationCode）——图号×工序随单');
  }
  if ((kind === 'assembly' || kind === 'electrical') && operationCode === null) {
    throw new DispatchInputError(`${kind === 'assembly' ? '装配' : '电气'}派工必须携带工序（operationCode）`);
  }
  if (kind === 'aftermarket' || kind === 'oddjob') {
    if (title === null && operationCode === null) {
      throw new DispatchInputError('售后/零工派工必须携带标题（title）或工序（operationCode）之一');
    }
  }

  const quantity = requireQuantity(record['quantity'], '派工数量 quantity');
  const lines = parseOutsourcingLinePayloads(record['lines']);
  if (kind === 'outsourcing' && lines.length === 0) {
    throw new DispatchInputError('外协派工必须携带明细行集（lines ≥ 1 行：供应商×工序×数量）');
  }
  if (kind !== 'outsourcing' && lines.length > 0) {
    throw new DispatchInputError('明细行集（lines）仅外协派工可携带');
  }

  return {
    workOrderId,
    kind,
    title,
    drawingNo,
    operationCode,
    material,
    sizeSpec,
    quantity,
    assignee: optionalUserId(record['assignee'], '执行人 assignee') ?? null,
    dueAt: optionalIsoDate(record['dueAt'], '要求完成时刻 dueAt') ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
    lines,
  };
}

function parseOutsourcingLinePayloads(raw: unknown): OutsourcingLinePayload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OUTSOURCING_LINES) {
    throw new DispatchInputError(`lines 非法：须为 ≤${MAX_OUTSOURCING_LINES} 行的数组`);
  }
  return raw.map((entry, index) => {
    const line = requireObject(entry, `lines[${index}]`);
    return {
      processCode: requireBoundedString(line['processCode'], `lines[${index}].processCode`, 1, 128),
      drawingNo: optionalBoundedString(line['drawingNo'], `lines[${index}].drawingNo`, 1, 128) ?? null,
      supplierRef: requireBoundedString(line['supplierRef'], `lines[${index}].supplierRef`, 1, 128),
      supplierName: optionalBoundedString(line['supplierName'], `lines[${index}].supplierName`, 1, 200) ?? null,
      quantity: requireQuantity(line['quantity'], `lines[${index}].quantity`),
      unitPriceMinor: optionalUnitPriceMinor(line['unitPriceMinor'], `lines[${index}].unitPriceMinor`) ?? null,
      promisedAt: optionalIsoDate(line['promisedAt'], `lines[${index}].promisedAt`) ?? null,
      sourceListingLineId:
        optionalBoundedString(line['sourceListingLineId'], `lines[${index}].sourceListingLineId`, 1, 128) ?? null,
    };
  });
}

// ---- dispatch.assign / start / complete / cancel 载荷 ----

export interface DispatchAssignPayload {
  /** 执行人（派工到人——待办推送对象）。 */
  readonly assignee: UserId;
  readonly remark: string | null;
}

export function parseDispatchAssignPayload(input: unknown): DispatchAssignPayload {
  const record = requireObject(input, 'dispatch.assign 载荷');
  return {
    assignee: UserId.create(requireBoundedString(record['assignee'], '执行人 assignee', 1, 128)),
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

export interface DispatchStartPayload {
  readonly remark: string | null;
}

export function parseDispatchStartPayload(input: unknown): DispatchStartPayload {
  const record = requireObject(input, 'dispatch.start 载荷');
  return { remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null };
}

export interface DispatchCompletePayload {
  /** 完工数量（缺省 = 整单数量；初版口径整单完工）。 */
  readonly doneQty: number | null;
  readonly remark: string | null;
}

export function parseDispatchCompletePayload(input: unknown): DispatchCompletePayload {
  const record = requireObject(input, 'dispatch.complete 载荷');
  const rawQty = record['doneQty'];
  let doneQty: number | null = null;
  if (rawQty !== undefined && rawQty !== null) {
    doneQty = requireQuantity(rawQty, '完工数量 doneQty');
  }
  return { doneQty, remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null };
}

export interface DispatchCancelPayload {
  readonly remark: string | null;
}

export function parseDispatchCancelPayload(input: unknown): DispatchCancelPayload {
  const record = requireObject(input, 'dispatch.cancel 载荷');
  return { remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null };
}

// ---- outsourcing.price.backfill 载荷（补录单价） ----

export interface OutsourcingPriceBackfillPayload {
  /** 补录单价（分，必填——补录语义即定价）。 */
  readonly unitPriceMinor: number;
  /** 交期补录（可空——单据级交期字段顺带修订）。 */
  readonly promisedAt: string | null;
  readonly remark: string | null;
}

export function parseOutsourcingPriceBackfillPayload(input: unknown): OutsourcingPriceBackfillPayload {
  const record = requireObject(input, 'outsourcing.price.backfill 载荷');
  const unitPriceMinor = record['unitPriceMinor'];
  if (
    typeof unitPriceMinor !== 'number' ||
    !Number.isInteger(unitPriceMinor) ||
    unitPriceMinor <= 0 ||
    unitPriceMinor > MAX_PRICE_MINOR
  ) {
    throw new DispatchInputError(
      `补录单价 unitPriceMinor 须为 (0, ${MAX_PRICE_MINOR}] 内的整数（分）：${JSON.stringify(unitPriceMinor)}`,
    );
  }
  return {
    unitPriceMinor,
    promisedAt: optionalIsoDate(record['promisedAt'], '交期 promisedAt') ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

/** 校验补录单价的利润率上界（与 baseline MAX_MARGIN_PERMYRIAD 同口径；防越界存储）。 */
export function assertBackfillMarginInRange(marginPermyriad: number | null): void {
  if (
    marginPermyriad !== null &&
    (!Number.isInteger(marginPermyriad) || marginPermyriad < 0 || marginPermyriad > MAX_MARGIN_PERMYRIAD)
  ) {
    throw new DispatchInputError(`marginPermyriad ${String(marginPermyriad)} 非法（0~${MAX_MARGIN_PERMYRIAD}）`);
  }
}

// ---- 路径/查询参数 ----

function requireKind(value: unknown, what: string): DispatchKind {
  if (typeof value !== 'string' || !(DISPATCH_KINDS as readonly string[]).includes(value)) {
    throw new DispatchInputError(`${what}非法：须为 ${DISPATCH_KINDS.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as DispatchKind;
}

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new DispatchInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new DispatchInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 assigned），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 六类 kind 过滤参数。 */
export function parseKindFilter(value: unknown): DispatchKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireKind(value, 'kind 过滤参数');
}

/** 工作令过滤参数（query；undefined = 不过滤）。 */
export function parseWorkOrderFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new DispatchInputError(`workOrderId 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'workOrderId');
}

/** 执行人过滤参数（按人任务视图；必填场景由控制器断言）。 */
export function parseAssigneeFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new DispatchInputError(`assignee 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'assignee');
}

/** 供应商过滤参数（外协单供应商维度）。 */
export function parseSupplierFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new DispatchInputError(`supplierRef 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'supplierRef');
}
