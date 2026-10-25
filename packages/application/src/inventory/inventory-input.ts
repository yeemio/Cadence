/**
 * inventory 输入解析（M2-W5；HTTP body/query → 业务输入）。
 *
 * 与 workorder/listing-input 同一纪律：违规抛 InventoryInputError（组合根映射
 * 400），绝不静默丢弃。命令命名按 07-inventory.md §3 原文（stock./stocktake./
 * shipping./warehouse. 前缀 + .v1——同 listing 的 purchase.* 先例，命令面
 * 以合同 §3 口径归一）。信封体形状：{ operationId, expectedRevision,
 * command: { kind, payload } }——租户与操作者不从请求体进（TenantContext /
 * AuthGuard，ADR-0005）。
 */
import { OperationId, type ExpectedRevision } from '@smes/business-core';
import { InventoryInputError } from './inventory-errors.js';
import {
  ISSUE_PURPOSES,
  RECEIPT_SOURCE_KINDS,
  type IssuePurpose,
  type ReceiptSourceKind,
} from './inventory-config.js';

// ---- 命令动词（07-inventory.md §3 命令面） ----

export const INVENTORY_COMMAND_KINDS = [
  'warehouse.define.v1',
  'stock.receive.v1',
  'stock.issue.v1',
  'stock.transfer.v1',
  'stocktake.open.v1',
  'stocktake.record.v1',
  'stocktake.approve-adjust.v1',
  'shipping.execute.v1',
  'shipping.confirm.v1',
] as const;

export type InventoryCommandKind = (typeof INVENTORY_COMMAND_KINDS)[number];

/** 命令载荷（信封 command 段；payload 形状由各解析器定形）。 */
export interface InventoryCommand {
  readonly kind: InventoryCommandKind;
  readonly payload: unknown;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InventoryInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireBoundedString(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new InventoryInputError(`${what}必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new InventoryInputError(`${what}须为 ${min}~${max} 个非空白字符`);
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
    throw new InventoryInputError(`${what}须为 (0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

/** 可为零的数量（盘点实盘可为 0——盘亏到零）。 */
function requireCountableQty(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new InventoryInputError(`${what}须为 [0, 1e9] 内的数：${JSON.stringify(value)}`);
  }
  return value;
}

function requireKind(value: unknown, kinds: readonly string[], what: string): string {
  if (typeof value !== 'string' || !kinds.includes(value)) {
    throw new InventoryInputError(`${what}非法：须为 ${kinds.join('/')} 之一，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireCode(value: unknown, what: string): string {
  const code = requireBoundedString(value, what, 1, 64);
  if (/\s/.test(code)) {
    throw new InventoryInputError(`${what}不得含空白字符：${JSON.stringify(value)}`);
  }
  return code;
}

// ---- 信封体解析 ----

export interface InventoryEnvelopeBody {
  readonly operationId: OperationId;
  readonly expectedRevision: ExpectedRevision;
  readonly command: InventoryCommand;
}

/** 解析 POST 命令信封体（operationId + expectedRevision + command{kind,payload}）。 */
export function parseCommandEnvelopeBody(input: unknown): InventoryEnvelopeBody {
  const record = requireObject(input, '命令信封体');
  const operationId = OperationId.create(
    requireBoundedString(record['operationId'], 'operationId', 1, 128),
  );
  const expectedRevision = record['expectedRevision'];
  if (
    expectedRevision !== 'initial' &&
    (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new InventoryInputError(
      `expectedRevision 须为 'initial' 或 >= 1 的整数：${JSON.stringify(expectedRevision)}`,
    );
  }
  const commandRaw = requireObject(record['command'], 'command');
  const kind = commandRaw['kind'];
  if (typeof kind !== 'string' || !(INVENTORY_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new InventoryInputError(
      `command.kind 非法：须为 ${INVENTORY_COMMAND_KINDS.join('/')} 之一，得到 ${JSON.stringify(kind)}`,
    );
  }
  const payload = commandRaw['payload'];
  if (payload === undefined || payload === null) {
    throw new InventoryInputError('command.payload 必须提供（可为空对象）');
  }
  requireObject(payload, 'command.payload');
  return {
    operationId,
    expectedRevision,
    command: { kind: kind as InventoryCommandKind, payload },
  };
}

/** 解析并断言命令动词与端点一致。 */
export function parseCommandBodyForKind(
  input: unknown,
  expected: InventoryCommandKind,
): InventoryEnvelopeBody {
  const parsed = parseCommandEnvelopeBody(input);
  if (parsed.command.kind !== expected) {
    throw new InventoryInputError(
      `command.kind 与端点不符：本端点只接受 '${expected}'，得到 '${parsed.command.kind}'`,
    );
  }
  return parsed;
}

// ---- warehouse.define 载荷 ----

export interface WarehouseDefinePayload {
  readonly code: string;
  readonly name: string;
  /** 库位集（至少 1 个；第一个为默认库位）。 */
  readonly locations: readonly { readonly code: string; readonly name: string | null }[];
  readonly remark: string | null;
}

const MAX_LOCATIONS = 200;

export function parseWarehouseDefinePayload(input: unknown): WarehouseDefinePayload {
  const record = requireObject(input, 'warehouse.define 载荷');
  const rawLocations = record['locations'];
  if (!Array.isArray(rawLocations) || rawLocations.length === 0 || rawLocations.length > MAX_LOCATIONS) {
    throw new InventoryInputError(`locations 非法：须为 1~${MAX_LOCATIONS} 个库位的数组`);
  }
  const locations = rawLocations.map((raw, index) => {
    const location = requireObject(raw, `locations[${index}]`);
    return {
      code: requireCode(location['code'], `locations[${index}].code`),
      name: optionalBoundedString(location['name'], `locations[${index}].name`, 1, 200) ?? null,
    };
  });
  const seen = new Set<string>();
  for (const location of locations) {
    if (seen.has(location.code)) {
      throw new InventoryInputError(`库位编码 '${location.code}' 重复（同仓库内唯一）`);
    }
    seen.add(location.code);
  }
  return {
    code: requireCode(record['code'], '仓库编码 code'),
    name: requireBoundedString(record['name'], '仓库名称 name', 1, 200),
    locations,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- stock.receive 载荷 ----

export interface StockReceivePayload {
  /** 三类入库来源（07-inventory.md §2 In：非标件/标准配件/设备的质检放行/采购收货/完工入库）。 */
  readonly kind: ReceiptSourceKind;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  /** kind=inspection 必填：放行事实锚点。 */
  readonly inspectionId: string | null;
  /** kind=purchase 可选：来源采购订单（opaque 回执引用）。 */
  readonly purchaseOrderId: string | null;
  readonly workOrderId: string | null;
  /** 幂等键（kind=purchase 必填——listing 收货联动 receiptKey 合同）。 */
  readonly receiptKey: string | null;
  readonly remark: string | null;
}

export function parseStockReceivePayload(input: unknown): StockReceivePayload {
  const record = requireObject(input, 'stock.receive 载荷');
  const kind = requireKind(record['kind'], RECEIPT_SOURCE_KINDS, '入库来源 kind') as ReceiptSourceKind;
  const inspectionId =
    kind === 'inspection'
      ? requireBoundedString(record['inspectionId'], '质检单 inspectionId（inspection 来源必填）', 1, 128)
      : optionalBoundedString(record['inspectionId'], 'inspectionId', 1, 128) ?? null;
  const receiptKey =
    kind === 'purchase'
      ? requireBoundedString(record['receiptKey'], '入库幂等键 receiptKey（purchase 来源必填）', 1, 200)
      : optionalBoundedString(record['receiptKey'], 'receiptKey', 1, 200) ?? null;
  return {
    kind,
    itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128),
    warehouseId: requireBoundedString(record['warehouseId'], '仓库 warehouseId', 1, 128),
    locationId: optionalBoundedString(record['locationId'], '库位 locationId', 1, 128) ?? null,
    quantity: requireQuantity(record['quantity'], '入库数量 quantity'),
    inspectionId,
    purchaseOrderId: optionalBoundedString(record['purchaseOrderId'], 'purchaseOrderId', 1, 128) ?? null,
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    receiptKey,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- stock.issue 载荷 ----

export interface StockIssuePayload {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly quantity: number;
  readonly purpose: IssuePurpose;
  readonly workOrderId: string | null;
  /** 核销的预占键（发料任务/派工预占的核销锚点；可空=直扣可用量）。 */
  readonly reservationKey: string | null;
  /** 幂等键（配件发货 requestId 等调用方幂等锚点；可空）。 */
  readonly issueKey: string | null;
  readonly remark: string | null;
}

export function parseStockIssuePayload(input: unknown): StockIssuePayload {
  const record = requireObject(input, 'stock.issue 载荷');
  return {
    itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128),
    warehouseId: requireBoundedString(record['warehouseId'], '仓库 warehouseId', 1, 128),
    locationId: optionalBoundedString(record['locationId'], '库位 locationId', 1, 128) ?? null,
    quantity: requireQuantity(record['quantity'], '出库数量 quantity'),
    purpose: requireKind(record['purpose'], ISSUE_PURPOSES, '出库目的 purpose') as IssuePurpose,
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    reservationKey: optionalBoundedString(record['reservationKey'], '预占键 reservationKey', 1, 200) ?? null,
    issueKey: optionalBoundedString(record['issueKey'], '幂等键 issueKey', 1, 200) ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- stock.transfer 载荷 ----

export interface StockTransferPayload {
  readonly itemId: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly quantity: number;
  readonly remark: string | null;
}

export function parseStockTransferPayload(input: unknown): StockTransferPayload {
  const record = requireObject(input, 'stock.transfer 载荷');
  const fromWarehouseId = requireBoundedString(record['fromWarehouseId'], '源仓库 fromWarehouseId', 1, 128);
  const toWarehouseId = requireBoundedString(record['toWarehouseId'], '目的仓库 toWarehouseId', 1, 128);
  const fromLocationId = optionalBoundedString(record['fromLocationId'], 'fromLocationId', 1, 128) ?? null;
  const toLocationId = optionalBoundedString(record['toLocationId'], 'toLocationId', 1, 128) ?? null;
  if (fromWarehouseId === toWarehouseId && fromLocationId === toLocationId) {
    throw new InventoryInputError('仓内移库的源库位与目的库位不得相同');
  }
  return {
    itemId: requireBoundedString(record['itemId'], '物料 itemId', 1, 128),
    fromWarehouseId,
    toWarehouseId,
    fromLocationId,
    toLocationId,
    quantity: requireQuantity(record['quantity'], '调拨数量 quantity'),
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- stocktake.open 载荷 ----

export interface StocktakeOpenPayload {
  readonly warehouseId: string;
  /** 盘点范围物料集（缺省 = 该仓全部有账物料）。 */
  readonly itemIds: readonly string[] | null;
  readonly remark: string | null;
}

const MAX_SCOPE_ITEMS = 2000;

export function parseStocktakeOpenPayload(input: unknown): StocktakeOpenPayload {
  const record = requireObject(input, 'stocktake.open 载荷');
  const rawItemIds = record['itemIds'];
  if (rawItemIds === undefined || rawItemIds === null) {
    return {
      warehouseId: requireBoundedString(record['warehouseId'], '仓库 warehouseId', 1, 128),
      itemIds: null,
      remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
    };
  }
  if (!Array.isArray(rawItemIds) || rawItemIds.length === 0 || rawItemIds.length > MAX_SCOPE_ITEMS) {
    throw new InventoryInputError(`itemIds 非法：须为 1~${MAX_SCOPE_ITEMS} 个物料的数组（缺省=全仓有账物料）`);
  }
  const itemIds = rawItemIds.map((raw, index) =>
    requireBoundedString(raw, `itemIds[${index}]`, 1, 128),
  );
  const seen = new Set<string>();
  for (const itemId of itemIds) {
    if (seen.has(itemId)) {
      throw new InventoryInputError(`itemIds 中 '${itemId}' 重复`);
    }
    seen.add(itemId);
  }
  return {
    warehouseId: requireBoundedString(record['warehouseId'], '仓库 warehouseId', 1, 128),
    itemIds,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- stocktake.record 载荷 ----

export interface StocktakeRecordLinePayload {
  readonly itemId: string;
  readonly countedQty: number;
}

export interface StocktakeRecordPayload {
  readonly lines: readonly StocktakeRecordLinePayload[];
  /** true=本轮录入完成并提交差异（counting→reconciled；须全部行已盘）。 */
  readonly complete: boolean;
}

const MAX_RECORD_LINES = 2000;

export function parseStocktakeRecordPayload(input: unknown): StocktakeRecordPayload {
  const record = requireObject(input, 'stocktake.record 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_RECORD_LINES) {
    throw new InventoryInputError(`lines 非法：须为 1~${MAX_RECORD_LINES} 行的实盘数组`);
  }
  const lines = rawLines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    return {
      itemId: requireBoundedString(line['itemId'], `lines[${index}].itemId`, 1, 128),
      countedQty: requireCountableQty(line['countedQty'], `lines[${index}].countedQty`),
    };
  });
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.itemId)) {
      throw new InventoryInputError(`实盘行 '${line.itemId}' 重复（同轮录入唯一）`);
    }
    seen.add(line.itemId);
  }
  const complete = record['complete'];
  if (complete === undefined || complete === null) {
    throw new InventoryInputError('complete 必填（false=继续录；true=录完提交差异）');
  }
  if (typeof complete !== 'boolean') {
    throw new InventoryInputError(`complete 须为布尔：${JSON.stringify(complete)}`);
  }
  return { lines, complete };
}

// ---- stocktake.approve-adjust 载荷 ----

export interface StocktakeApprovePayload {
  /** 审核调账理由（必填——调账审计留痕，07-inventory.md §7 Done-when）。 */
  readonly remark: string;
}

export function parseStocktakeApprovePayload(input: unknown): StocktakeApprovePayload {
  const record = requireObject(input, 'stocktake.approve-adjust 载荷');
  return { remark: requireBoundedString(record['remark'], '调账理由 remark', 1, 2000) };
}

// ---- shipping.execute 载荷 ----

export interface ShippingExecuteLinePayload {
  readonly itemId: string;
  readonly quantity: number;
  /** 缺省 = 服务选项 defaultWarehouseId（未配置则拒绝）。 */
  readonly warehouseId: string | null;
  readonly locationId: string | null;
  /** 核销的预占键（可空）。 */
  readonly reservationKey: string | null;
}

export interface ShippingExecutePayload {
  readonly workOrderId: string | null;
  readonly lines: readonly ShippingExecuteLinePayload[];
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly remark: string | null;
}

const MAX_SHIPPING_LINES = 200;

export function parseShippingExecutePayload(input: unknown): ShippingExecutePayload {
  const record = requireObject(input, 'shipping.execute 载荷');
  const rawLines = record['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_SHIPPING_LINES) {
    throw new InventoryInputError(`lines 非法：须为 1~${MAX_SHIPPING_LINES} 行的发货数组`);
  }
  const lines = rawLines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    return {
      itemId: requireBoundedString(line['itemId'], `lines[${index}].itemId`, 1, 128),
      quantity: requireQuantity(line['quantity'], `lines[${index}].quantity`),
      warehouseId: optionalBoundedString(line['warehouseId'], `lines[${index}].warehouseId`, 1, 128) ?? null,
      locationId: optionalBoundedString(line['locationId'], `lines[${index}].locationId`, 1, 128) ?? null,
      reservationKey:
        optionalBoundedString(line['reservationKey'], `lines[${index}].reservationKey`, 1, 200) ?? null,
    };
  });
  return {
    workOrderId: optionalBoundedString(record['workOrderId'], 'workOrderId', 1, 128) ?? null,
    lines,
    carrier: optionalBoundedString(record['carrier'], '承运 carrier', 1, 200) ?? null,
    trackingNo: optionalBoundedString(record['trackingNo'], '运单号 trackingNo', 1, 200) ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- shipping.confirm 载荷 ----

export interface ShippingConfirmPayload {
  readonly carrier: string | null;
  readonly trackingNo: string | null;
  readonly remark: string | null;
}

export function parseShippingConfirmPayload(input: unknown): ShippingConfirmPayload {
  const record = requireObject(input, 'shipping.confirm 载荷');
  return {
    carrier: optionalBoundedString(record['carrier'], '承运 carrier', 1, 200) ?? null,
    trackingNo: optionalBoundedString(record['trackingNo'], '运单号 trackingNo', 1, 200) ?? null,
    remark: optionalBoundedString(record['remark'], 'remark', 1, 2000) ?? null,
  };
}

// ---- 路径/查询参数 ----

/** 路径参数 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what = 'id'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new InventoryInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

const STATE_FILTER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 列表状态过滤参数（undefined = 不过滤；形状与配置状态 id 同族）。 */
export function parseStateFilter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !STATE_FILTER_PATTERN.test(value)) {
    throw new InventoryInputError(
      `状态过滤参数 state 非法：须为小写状态 id 形状（如 counting），得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 可选 id 过滤参数（query；undefined = 不过滤）。 */
export function parseOptionalIdFilter(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new InventoryInputError(`${what} 非法：${JSON.stringify(value)}`);
  }
  return parseIdParam(value, what);
}

/** 移动端库存查询的物料扫码输入（逻辑面与桌面同径——扫码值即 itemId 查询）。 */
export function parseItemQuery(value: unknown): string | undefined {
  return parseOptionalIdFilter(value, '物料 itemId');
}
