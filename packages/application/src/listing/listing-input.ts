/**
 * listing 输入解析（M2-W3；HTTP body/query → 业务输入）。
 *
 * 与 workorder-input 同一纪律：违规抛 ListingInputError（组合根映射 400），
 * 绝不静默丢弃。命令命名 {module}.{verb}.v1（通用合同纪律 1）：合同 §3 的
 * 命令面按此归一（listing.line.update → listing.line.update.v1、
 * purchase.request.create → purchase.request.create.v1，余类推）。
 * 信封体形状：{ operationId, expectedRevision, command: { kind, payload } }——
 * 租户与操作者不从请求体进（TenantContext / AuthGuard，ADR-0005）。
 */
import { OperationId, UserId, type ExpectedRevision } from '@smes/business-core';
import { ListingInputError } from './listing-errors.js';
import { LISTING_KINDS, PURCHASE_REQUEST_KINDS, type ListingKind, type PurchaseRequestKind } from './listing-config.js';
import { requireExcelSource, type ExcelSource } from './excel-port.js';

// ---- 命令动词（03-listing.md §3 命令面 + 逾期事实扫描） ----

export const LISTING_COMMAND_KINDS = [
  'listing.import.v1',
  'listing.line.update.v1',
  'gap.check.v1',
  'purchase.request.create.v1',
  'purchase.order.submit.v1',
  'purchase.order.approve.v1',
  'purchase.order.issue.v1',
  'purchase.order.receive.v1',
  'purchase.return.create.v1',
  'purchase.return.revoke.v1',
  'purchase.overdue.scan.v1',
] as const;

export type ListingCommandKind = (typeof LISTING_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface ListingCommand {
  readonly kind: ListingCommandKind;
  readonly payload: unknown;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ListingInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new ListingInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ListingInputError(`${what}须为 ${min}~${max} 个非空白字符`);
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
    throw new ListingInputError(`${what}必须是 ISO 8601 日期时间字符串：${JSON.stringify(value)}`);
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
    throw new ListingInputError(`${what}须为 (0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireKind(value: unknown, kinds: readonly string[], what: string): string {
  if (typeof value !== 'string' || !kinds.includes(value)) {
    throw new ListingInputError(`${what}非法：须为 ${kinds.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

// ---- 信封体解析 ----

export interface ListingEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: ListingCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): ListingEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new ListingInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(LISTING_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new ListingInputError(
      `command.kind 非法：须为 ${LISTING_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new ListingInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as ListingCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(input: unknown, expected: ListingCommandKind): ListingEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new ListingInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- listing.import 载荷（判别联合：workorder 骨架 / excel 行导入） ----

export interface ImportFromWorkOrderPayload {
  readonly source: 'workorder';
  readonly workOrderId: string;
}

export interface ImportFromExcelPayload {
  readonly source: 'excel';
  readonly workOrderId: string;
  readonly kind: ListingKind;
  readonly excel: ExcelSource;
}

export type ListingImportPayload = ImportFromWorkOrderPayload | ImportFromExcelPayload;

export function parseListingImportPayload(input: unknown): ListingImportPayload {
  const record = requireObject(input, 'listing.import 载荷');
  const workOrderId = requireBoundedString(record['workOrderId'], '工作令 workOrderId', 1, 128);
  const source = record['source'];
  if (source === 'workorder') {
    return { source: 'workorder', workOrderId };
  }
  if (source === 'excel') {
    return {
      source: 'excel',
      workOrderId,
      kind: requireKind(record['kind'], LISTING_KINDS, '清单类目 kind') as ListingKind,
      excel: requireExcelSource(record['excel'], 'excel 源'),
    };
  }
  throw new ListingInputError(
    `source 非法：须为 'workorder'（骨架生成）或 'excel'（行导入），得到 ${JSON.stringify(source)}`,
  );
}

// ---- listing.line.update 载荷 ----

export interface UpdateListingLinePayload {
  readonly drawingNo?: string | null;
  readonly code?: string | null;
  readonly name?: string | null;
  readonly spec?: string | null;
  /** 人工确认物料（suspected 候选确认 / 手工指定）。 */
  readonly itemId?: string | null;
  readonly requiredQty?: number;
  readonly neededBy?: string | null;
}

export function parseUpdateListingLinePayload(input: unknown): UpdateListingLinePayload {
  const record = requireObject(input, 'listing.line.update 载荷');
  const payload: {
    drawingNo?: string | null;
    code?: string | null;
    name?: string | null;
    spec?: string | null;
    itemId?: string | null;
    requiredQty?: number;
    neededBy?: string | null;
  } = {};
  for (const key of ['drawingNo', 'code', 'name', 'spec', 'itemId'] as const) {
    if (record[key] !== undefined) {
      payload[key] = record[key] === null ? null : requireBoundedString(record[key], key, 1, 256);
    }
  }
  if (record['requiredQty'] !== undefined) {
    payload.requiredQty = requireQuantity(record['requiredQty'], 'requiredQty');
  }
  if (record['neededBy'] !== undefined) {
    payload.neededBy = record['neededBy'] === null ? null : requireIsoDate(record['neededBy'], 'neededBy');
  }
  if (Object.keys(payload).length === 0) {
    throw new ListingInputError('listing.line.update 载荷至少提供 1 个可更新字段');
  }
  return payload;
}

// ---- gap.check 载荷（无必填字段） ----

export function parseGapCheckPayload(input: unknown): Record<string, unknown> {
  return requireObject(input, 'gap.check 载荷'); // 空对象合法
}

// ---- purchase.request.create 载荷 ----

export interface PurchaseRequestCreatePayload {
  readonly workOrderId: string | null;
  readonly kind: PurchaseRequestKind;
  readonly itemId: string;
  readonly quantity: number;
  readonly remark: string | null;
  /** 缺口一键发起时的来源锚点（手工发起不带）。 */
  readonly source:
    | { readonly type: 'gap'; readonly gapCheckId: string; readonly listingLineId: string }
    | { readonly type: 'manual' };
}

export function parsePurchaseRequestCreatePayload(input: unknown): PurchaseRequestCreatePayload {
  const record = requireObject(input, 'purchase.request.create 载荷');
  const rawSource = record['source'];
  let source: PurchaseRequestCreatePayload['source'];
  if (rawSource === undefined || rawSource === null) {
    source = { type: 'manual' };
  } else {
    const sourceRecord = requireObject(rawSource, 'source');
    if (sourceRecord['type'] !== 'gap') {
      throw new ListingInputError(`source.type 非法：须为 'gap'（缺省 = 手工发起）`);
    }
    source = {
      type: 'gap',
      gapCheckId: requireBoundedString(sourceRecord['gapCheckId'], 'source.gapCheckId', 1, 128),
      listingLineId: requireBoundedString(sourceRecord['listingLineId'], 'source.listingLineId', 1, 128),
    };
  }
  return {
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    kind: requireKind(record['kind'], PURCHASE_REQUEST_KINDS, '采购申请 kind') as PurchaseRequestKind,
    itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128),
    quantity: requireQuantity(record['quantity'], '申请数量 quantity'),
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
    source,
  };
}

// ---- purchase.order.submit 载荷（建单 + 提交） ----

export interface PurchaseOrderLinePayload {
  readonly itemId: string;
  readonly quantity: number;
  readonly drawingNo: string | null;
  /** 单价（分，整数精确；可空 = 未定价）。 */
  readonly unitPriceMinor: number | null;
}

export interface PurchaseOrderSubmitPayload {
  readonly workOrderId: string | null;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  /** 交期（必填——逾期事实口径锚点）。 */
  readonly promisedAt: string;
  readonly lines: readonly PurchaseOrderLinePayload[];
  /** 承接的采购申请 id 集（可空）。 */
  readonly requestIds: readonly string[];
  readonly buyer: UserId | null;
  readonly remark: string | null;
}

const MAX_UNIT_PRICE_MINOR = 2_000_000_000; // int32 安全上界内（PG Int 列）
const MAX_ORDER_LINES = 200;

export function parsePurchaseOrderSubmitPayload(input: unknown): PurchaseOrderSubmitPayload {
  const record = requireObject(input, 'purchase.order.submit 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_ORDER_LINES) {
    throw new ListingInputError(`lines 非法：须为 1~${MAX_ORDER_LINES} 行的数组`);
  }
  const lines: PurchaseOrderLinePayload[] = rawLines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    const unitPriceRaw = line['unitPriceMinor'];
    let unitPriceMinor: number | null = null;
    if (unitPriceRaw !== undefined && unitPriceRaw !== null) {
      if (
        typeof unitPriceRaw !== 'number' ||
        !Number.isInteger(unitPriceRaw) ||
        unitPriceRaw < 0 ||
        unitPriceRaw > MAX_UNIT_PRICE_MINOR
      ) {
        throw new ListingInputError(
          `lines[${index}].unitPriceMinor 须为 [0, ${MAX_UNIT_PRICE_MINOR}] 内的整数（分）：${JSON.stringify(unitPriceRaw)}`,
        );
      }
      unitPriceMinor = unitPriceRaw;
    }
    return {
      itemId: requireBoundedString(line['itemId'], `lines[${index}].itemId`, 1, 128),
      quantity: requireQuantity(line['quantity'], `lines[${index}].quantity`),
      drawingNo: optionalBoundedString(line['drawingNo'], `lines[${index}].drawingNo`, 1, 128) ?? null,
      unitPriceMinor,
    };
  });
  const rawRequestIds = record['requestIds'];
  if (rawRequestIds !== undefined && rawRequestIds !== null && !Array.isArray(rawRequestIds)) {
    throw new ListingInputError('requestIds 须为字符串数组');
  }
  const requestIds = (rawRequestIds ?? []).map((raw, index) =>
    requireBoundedString(raw, `requestIds[${index}]`, 1, 128),
  );
  return {
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    supplierRef: optionalBoundedString(record['supplierRef'], '供应商引用 supplierRef', 1, 128) ?? null,
    supplierName: optionalBoundedString(record['supplierName'], '供应商名称 supplierName', 1, 200) ?? null,
    promisedAt: requireIsoDate(record['promisedAt'], '交期 promisedAt'),
    lines,
    requestIds,
    buyer: optionalUserId(record['buyer'], '采购负责人 buyer') ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- purchase.order.approve / issue 载荷 ----

export interface PurchaseOrderDecisionPayload {
  /** 决策理由（必填——决策必须可回溯）。 */
  readonly remark: string;
}

export function parsePurchaseOrderDecisionPayload(input: unknown): PurchaseOrderDecisionPayload {
  const record = requireObject(input, 'purchase.order.approve 载荷');
  return { remark: requireBoundedString(record['remark'], '决策理由 remark', 1, 2000) };
}

export interface PurchaseOrderIssuePayload {
  readonly remark: string | null;
}

export function parsePurchaseOrderIssuePayload(input: unknown): PurchaseOrderIssuePayload {
  const record = requireObject(input, 'purchase.order.issue 载荷');
  return { remark: optionalBoundedString(record['remark'], '下发备注 remark', 1, 2000) ?? null };
}

// ---- purchase.order.receive 载荷 ----

export interface PurchaseOrderReceivePayload {
  readonly lines: readonly { readonly lineNo: number; readonly receivedQty: number }[];
  readonly receiptRef: string | null;
  readonly remark: string | null;
}

export function parsePurchaseOrderReceivePayload(input: unknown): PurchaseOrderReceivePayload {
  const record = requireObject(input, 'purchase.order.receive 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_ORDER_LINES) {
    throw new ListingInputError(`lines 非法：须为 1~${MAX_ORDER_LINES} 行的收货明细数组`);
  }
  const lines = rawLines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    const lineNo = line['lineNo'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo < 1 || lineNo > MAX_ORDER_LINES) {
      throw new ListingInputError(`lines[${index}].lineNo 须为 [1, ${MAX_ORDER_LINES}] 内的整数`);
    }
    return { lineNo, receivedQty: requireQuantity(line['receivedQty'], `lines[${index}].receivedQty`) };
  });
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.lineNo)) {
      throw new ListingInputError(`收货明细行号 ${line.lineNo} 重复`);
    }
    seen.add(line.lineNo);
  }
  return {
    lines,
    receiptRef: optionalBoundedString(record['receiptRef'], '收货单号 receiptRef', 1, 128) ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- purchase.return.create / revoke 载荷 ----

export interface PurchaseReturnCreatePayload {
  readonly purchaseOrderId: string;
  readonly lines: readonly { readonly lineNo: number; readonly returnedQty: number; readonly reason: string | null }[];
  readonly remark: string | null;
}

export function parsePurchaseReturnCreatePayload(input: unknown): PurchaseReturnCreatePayload {
  const record = requireObject(input, 'purchase.return.create 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_ORDER_LINES) {
    throw new ListingInputError(`lines 非法：须为 1~${MAX_ORDER_LINES} 行的退货行数组`);
  }
  const lines = rawLines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    const lineNo = line['lineNo'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo < 1 || lineNo > MAX_ORDER_LINES) {
      throw new ListingInputError(`lines[${index}].lineNo 须为 [1, ${MAX_ORDER_LINES}] 内的整数`);
    }
    return {
      lineNo,
      returnedQty: requireQuantity(line['returnedQty'], `lines[${index}].returnedQty`),
      reason: optionalBoundedString(line['reason'], `lines[${index}].reason`, 1, 500) ?? null,
    };
  });
  return {
    purchaseOrderId: requireBoundedString(record['purchaseOrderId'], '采购订单 purchaseOrderId', 1, 128),
    lines,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

export interface PurchaseReturnRevokePayload {
  readonly remark: string | null;
}

export function parsePurchaseReturnRevokePayload(input: unknown): PurchaseReturnRevokePayload {
  const record = requireObject(input, 'purchase.return.revoke 载荷');
  return { remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null };
}

// ---- purchase.overdue.scan 载荷（无必填字段） ----

export function parseOverdueScanPayload(input: unknown): Record<string, unknown> {
  return requireObject(input, 'purchase.overdue.scan 载荷'); // 空对象合法
}

// ---- 路径/查询参数 ----

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new ListingInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new ListingInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 submitted），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 工作令过滤参数（query；undefined = 不过滤）。 */
export function parseWorkOrderFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ListingInputError(`workOrderId 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, 'workOrderId');
}
