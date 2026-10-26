/**
 * 基础数据输入解析（HTTP body → 业务输入；M1 增量 4-I）。
 *
 * 与 org-input 同一纪律：违规抛 MasterdataInputError（组合根映射 400），
 * 绝不静默丢弃。code 形状宽松于用户名（主数据稳定码常含大写/点/下划线，
 * 如 P-1001 / RM_001）：字母/数字开头 + 字母/数字/点/下划线/连字符。
 */
import { MasterdataInputError } from './masterdata-errors.js';

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MasterdataInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MasterdataInputError(`名称必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new MasterdataInputError(`名称须为 1~128 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function requireCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new MasterdataInputError(
      `${what} '${JSON.stringify(value)}' 非法：须为字母/数字开头，仅含字母/数字/点/下划线/连字符（1~64 字符）`,
    );
  }
  return value;
}

/** 可选自由文本：undefined → 缺省不动；null → 显式清空；字符串 trim 后 1~256。 */
function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new MasterdataInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null; // 纯空白视为清空
  if (trimmed.length > maxLength) {
    throw new MasterdataInputError(`字段 '${field}' 超长（>${maxLength}）：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function optionalActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new MasterdataInputError(`active 须为布尔：${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 初始价格上界（RREQ-MD-020）：Int32 安全上界内的整数分——与 listing
 * MAX_UNIT_PRICE_MINOR（PG Int 列）同口径；源侧"整数 16 位 BigDecimal"形态
 * 不复刻（差异随需求登记）。
 */
export const MAX_INITIAL_PRICE_MINOR = 2_000_000_000;

/**
 * 初始价格（分）解析：undefined → 不动；null → 清空保存（取消初始价格）；
 * 其余须为 [0, MAX_INITIAL_PRICE_MINOR] 整数（≥0 整数分，PRD RREQ-MD-020）。
 */
function optionalInitialPriceMinor(
  value: unknown,
  field: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_INITIAL_PRICE_MINOR
  ) {
    throw new MasterdataInputError(
      `字段 '${field}' 须为 [0, ${MAX_INITIAL_PRICE_MINOR}] 内的整数（分，≥0）：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export interface CreateItemPayload {
  readonly code: string;
  readonly name: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
  readonly active?: boolean;
  readonly initialPriceMinor?: number | null;
}

/** 解析 POST /masterdata/items 请求体。 */
export function parseCreateItemInput(input: unknown): CreateItemPayload {
  const record = requireObject(input, '创建物品请求体');
  const payload: {
    code: string;
    name: string;
    spec?: string | null;
    unit?: string | null;
    category?: string | null;
    active?: boolean;
    initialPriceMinor?: number | null;
  } = {
    code: requireCode(record['code'], '物品 code'),
    name: requireName(record['name']),
  };
  const spec = optionalText(record['spec'], 'spec', 256);
  if (spec !== undefined) payload.spec = spec;
  const unit = optionalText(record['unit'], 'unit', 64);
  if (unit !== undefined) payload.unit = unit;
  const category = optionalText(record['category'], 'category', 64);
  if (category !== undefined) payload.category = category;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  const initialPriceMinor = optionalInitialPriceMinor(record['initialPriceMinor'], 'initialPriceMinor');
  if (initialPriceMinor !== undefined) payload.initialPriceMinor = initialPriceMinor;
  return payload;
}

export interface UpdateItemPayload {
  readonly name?: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
  readonly active?: boolean;
  readonly initialPriceMinor?: number | null;
}

/** 解析 PUT /masterdata/items/:id 请求体（字段级期望态：未提供即不变）。 */
export function parseUpdateItemInput(input: unknown): UpdateItemPayload {
  const record = requireObject(input, '更新物品请求体');
  if (record['code'] !== undefined) {
    throw new MasterdataInputError('物品 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: {
    name?: string;
    spec?: string | null;
    unit?: string | null;
    category?: string | null;
    active?: boolean;
    initialPriceMinor?: number | null;
  } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const spec = optionalText(record['spec'], 'spec', 256);
  if (spec !== undefined) payload.spec = spec;
  const unit = optionalText(record['unit'], 'unit', 64);
  if (unit !== undefined) payload.unit = unit;
  const category = optionalText(record['category'], 'category', 64);
  if (category !== undefined) payload.category = category;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  const initialPriceMinor = optionalInitialPriceMinor(record['initialPriceMinor'], 'initialPriceMinor');
  if (initialPriceMinor !== undefined) payload.initialPriceMinor = initialPriceMinor;
  return payload;
}

export interface CreateResourcePayload {
  readonly code: string;
  readonly name: string;
  readonly type?: string | null;
  readonly active?: boolean;
}

/** 解析 POST /masterdata/resources 请求体。 */
export function parseCreateResourceInput(input: unknown): CreateResourcePayload {
  const record = requireObject(input, '创建资源请求体');
  const payload: {
    code: string;
    name: string;
    type?: string | null;
    active?: boolean;
  } = {
    code: requireCode(record['code'], '资源 code'),
    name: requireName(record['name']),
  };
  const type = optionalText(record['type'], 'type', 64);
  if (type !== undefined) payload.type = type;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdateResourcePayload {
  readonly name?: string;
  readonly type?: string | null;
  readonly active?: boolean;
}

/** 解析 PUT /masterdata/resources/:id 请求体。 */
export function parseUpdateResourceInput(input: unknown): UpdateResourcePayload {
  const record = requireObject(input, '更新资源请求体');
  if (record['code'] !== undefined) {
    throw new MasterdataInputError('资源 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: {
    name?: string;
    type?: string | null;
    active?: boolean;
  } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const type = optionalText(record['type'], 'type', 64);
  if (type !== undefined) payload.type = type;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseIdParam(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new MasterdataInputError(`${what} id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// 客户/供应商/计量单位输入解析（S1 backfill：0920 #8/#9/#100）——复用本文件
// 既有原语（requireCode/requireName/optionalText/optionalActive）。
// ---------------------------------------------------------------------------

export interface CreateCustomerPayload {
  readonly code: string;
  readonly name: string;
  readonly contact?: string | null;
  readonly active?: boolean;
}

/** 解析 POST /masterdata/customers 请求体。 */
export function parseCreateCustomerInput(input: unknown): CreateCustomerPayload {
  const record = requireObject(input, '创建客户请求体');
  const payload: {
    code: string;
    name: string;
    contact?: string | null;
    active?: boolean;
  } = {
    code: requireCode(record['code'], '客户 code'),
    name: requireName(record['name']),
  };
  const contact = optionalText(record['contact'], 'contact', 256);
  if (contact !== undefined) payload.contact = contact;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdateCustomerPayload {
  readonly name?: string;
  readonly contact?: string | null;
  readonly active?: boolean;
}

/** 解析 PUT /masterdata/customers/:id 请求体（字段级期望态；code 不可变）。 */
export function parseUpdateCustomerInput(input: unknown): UpdateCustomerPayload {
  const record = requireObject(input, '更新客户请求体');
  if (record['code'] !== undefined) {
    throw new MasterdataInputError('客户 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; contact?: string | null; active?: boolean } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const contact = optionalText(record['contact'], 'contact', 256);
  if (contact !== undefined) payload.contact = contact;
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface CreateSupplierPayload {
  readonly code: string;
  readonly name: string;
  readonly active?: boolean;
}

/** 解析 POST /masterdata/suppliers 请求体。 */
export function parseCreateSupplierInput(input: unknown): CreateSupplierPayload {
  const record = requireObject(input, '创建供应商请求体');
  const payload: { code: string; name: string; active?: boolean } = {
    code: requireCode(record['code'], '供应商 code'),
    name: requireName(record['name']),
  };
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdateSupplierPayload {
  readonly name?: string;
  readonly active?: boolean;
}

/** 解析 PUT /masterdata/suppliers/:id 请求体（字段级期望态；code 不可变）。 */
export function parseUpdateSupplierInput(input: unknown): UpdateSupplierPayload {
  const record = requireObject(input, '更新供应商请求体');
  if (record['code'] !== undefined) {
    throw new MasterdataInputError('供应商 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; active?: boolean } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface CreateUnitPayload {
  readonly code: string;
  readonly name: string;
  readonly symbol?: string | null;
}

/** 解析 POST /masterdata/units 请求体。 */
export function parseCreateUnitInput(input: unknown): CreateUnitPayload {
  const record = requireObject(input, '创建计量单位请求体');
  const payload: { code: string; name: string; symbol?: string | null } = {
    code: requireCode(record['code'], '计量单位 code'),
    name: requireName(record['name']),
  };
  const symbol = optionalText(record['symbol'], 'symbol', 32);
  if (symbol !== undefined) payload.symbol = symbol;
  return payload;
}

export interface UpdateUnitPayload {
  readonly name?: string;
  readonly symbol?: string | null;
}

/** 解析 PUT /masterdata/units/:id 请求体（字段级期望态；code 不可变）。 */
export function parseUpdateUnitInput(input: unknown): UpdateUnitPayload {
  const record = requireObject(input, '更新计量单位请求体');
  if (record['code'] !== undefined) {
    throw new MasterdataInputError('计量单位 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; symbol?: string | null } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  const symbol = optionalText(record['symbol'], 'symbol', 32);
  if (symbol !== undefined) payload.symbol = symbol;
  return payload;
}

// ---------------------------------------------------------------------------
// 价格台账分页查询解析（RREQ-MD-019，fix-wave-6 6b-1 S9）。页基 1、默认
// pageSize 10（源 §2.4 分页 10/20/50 默认 10——我方放开为 1..100 任意值，
// 档位约束属 UI 面）。查询串原值（URLSearchParams.get：缺参数 = null）。
// ---------------------------------------------------------------------------

/** 台账分页默认与上界（缺省 10；页大小 1..100 防全表拉取）。 */
export const DEFAULT_PRICE_LEDGER_PAGE_SIZE = 10;
export const MAX_PRICE_LEDGER_PAGE_SIZE = 100;

/** 解析后的分页参数（页基 1 → store 侧 offset 收窄）。 */
export interface PriceLedgerPageParams {
  readonly page: number;
  readonly pageSize: number;
}

/** 解析 GET /masterdata/items/:id/purchase-prices 的 page/pageSize 查询参数。 */
export function parsePriceLedgerPageQuery(
  page: string | null | undefined,
  pageSize: string | null | undefined,
): PriceLedgerPageParams {
  const parsePositiveInt = (value: string | null | undefined, field: string): number => {
    const trimmed = value === null || value === undefined ? '' : value.trim();
    if (trimmed === '') {
      throw new MasterdataInputError(`查询参数 '${field}' 须为正整数：${JSON.stringify(value ?? null)}`);
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new MasterdataInputError(`查询参数 '${field}' 须为正整数：${JSON.stringify(value)}`);
    }
    return parsed;
  };
  return {
    page: page === null || page === undefined || page.trim() === '' ? 1 : parsePositiveInt(page, 'page'),
    pageSize:
      pageSize === null || pageSize === undefined || pageSize.trim() === ''
        ? DEFAULT_PRICE_LEDGER_PAGE_SIZE
        : (() => {
            const size = parsePositiveInt(pageSize, 'pageSize');
            if (size > MAX_PRICE_LEDGER_PAGE_SIZE) {
              throw new MasterdataInputError(
                `查询参数 'pageSize' 须为 1~${MAX_PRICE_LEDGER_PAGE_SIZE}：${JSON.stringify(pageSize)}`,
              );
            }
            return size;
          })(),
  };
}
