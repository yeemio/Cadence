/**
 * 基础数据薄数据层（M1 增量 4-I）：fetch 直连 server masterdata 端点。
 * 视图模型（解析/构造）在 @smes/product-ui；本文件只做 URL 与方法装配。
 */
import {
  buildCreateItemPayload,
  buildCreateResourcePayload,
  parseItem,
  parseItemsResponse,
  parseResource,
  parseResourcesResponse,
  type ItemView,
  type ResourceView,
} from '@smes/product-ui';
import { request } from './apiClient';
import { fetchRows } from './commandClient';

export async function listItems(): Promise<readonly ItemView[]> {
  return parseItemsResponse(await request('/masterdata/items'));
}

export async function createItem(input: {
  readonly code: string;
  readonly name: string;
  readonly spec?: string;
  readonly unit?: string;
  readonly category?: string;
}): Promise<ItemView> {
  return parseItem(
    await request('/masterdata/items', {
      method: 'POST',
      body: JSON.stringify(buildCreateItemPayload(input)),
    }),
  );
}

export async function listResources(): Promise<readonly ResourceView[]> {
  return parseResourcesResponse(await request('/masterdata/resources'));
}

export async function createResource(input: {
  readonly code: string;
  readonly name: string;
  readonly type?: string;
}): Promise<ResourceView> {
  return parseResource(
    await request('/masterdata/resources', {
      method: 'POST',
      body: JSON.stringify(buildCreateResourcePayload(input)),
    }),
  );
}

// ---- 客户/供应商/计量单位（S3-a：0920 #8/#9/#100 管理页；实态见
// masterdata.controllers.ts）----
// 与 items/resources 的差别：本组走 S2 批次管理页的裸行风格（fetchRows +
// 直连 POST/PUT 直返实体，无命令信封）——行形状以 CustomerMaster/
// SupplierMaster/UnitMaster 为准（unit 无 active 字段：字典无停用语义）。

/** GET /masterdata/customers → { customers: [...] }。 */
export async function listCustomers(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/masterdata/customers', 'customers');
}

/** POST /masterdata/customers（code/name 必填；contact 可选自由文本）。 */
export async function createCustomer(input: {
  readonly code: string;
  readonly name: string;
  readonly contact?: string;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { code: input.code.trim(), name: input.name.trim() };
  const contact = input.contact?.trim();
  if (contact) payload.contact = contact;
  return (await request('/masterdata/customers', {
    method: 'POST',
    body: JSON.stringify(payload),
  })) as Record<string, unknown>;
}

/** PUT /masterdata/customers/:id（字段级期望态；软停用 = { active: false }）。 */
export async function updateCustomer(
  id: string,
  patch: { readonly name?: string; readonly contact?: string | null; readonly active?: boolean },
): Promise<Record<string, unknown>> {
  return (await request(`/masterdata/customers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as Record<string, unknown>;
}

/** GET /masterdata/suppliers → { suppliers: [...] }。 */
export async function listSuppliers(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/masterdata/suppliers', 'suppliers');
}

/** POST /masterdata/suppliers（code/name 必填）。 */
export async function createSupplier(input: {
  readonly code: string;
  readonly name: string;
}): Promise<Record<string, unknown>> {
  return (await request('/masterdata/suppliers', {
    method: 'POST',
    body: JSON.stringify({ code: input.code.trim(), name: input.name.trim() }),
  })) as Record<string, unknown>;
}

/** PUT /masterdata/suppliers/:id（软停用 = { active: false }）。 */
export async function updateSupplier(
  id: string,
  patch: { readonly name?: string; readonly active?: boolean },
): Promise<Record<string, unknown>> {
  return (await request(`/masterdata/suppliers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as Record<string, unknown>;
}

/** GET /masterdata/units → { units: [...] }。 */
export async function listUnits(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/masterdata/units', 'units');
}

/** POST /masterdata/units（code/name 必填；symbol 可选，如 PCS/KG）。 */
export async function createUnit(input: {
  readonly code: string;
  readonly name: string;
  readonly symbol?: string;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { code: input.code.trim(), name: input.name.trim() };
  const symbol = input.symbol?.trim();
  if (symbol) payload.symbol = symbol;
  return (await request('/masterdata/units', {
    method: 'POST',
    body: JSON.stringify(payload),
  })) as Record<string, unknown>;
}
