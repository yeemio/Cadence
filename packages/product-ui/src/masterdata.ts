/**
 * 基础数据（物品/资源）视图模型（M1 增量 4-I）：类型 / 构造器 / 权限码。
 *
 * 与 org.ts 同一取舍：只做"响应形状解析 + 请求载荷构造"（纯函数，测试
 * 钉死），不含 fetch 与 URL——那是 apps/web 装配层的事。权限码常量与
 * 后端 masterdata 端点的 @RequirePermission 一一对应（ADR-0010 通用词：
 * item/resource/category/spec 均为跨行业通用词）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 基础数据权限码（与 apps/server masterdata 端点一一对应）。 */
export const ITEM_READ: PermissionCode = permissionCode('item:read');
export const ITEM_WRITE: PermissionCode = permissionCode('item:write');
export const RESOURCE_READ: PermissionCode = permissionCode('resource:read');
export const RESOURCE_WRITE: PermissionCode = permissionCode('resource:write');

/** 物品列表行视图（服务端 ItemMaster 的 UI 投影：不透出租户）。 */
export interface ItemView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unit: string | null;
  readonly category: string | null;
  readonly active: boolean;
}

/** 资源列表行视图。 */
export interface ResourceView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string | null;
  readonly active: boolean;
}

export class MasterdataViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterdataViewError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MasterdataViewError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MasterdataViewError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new MasterdataViewError(`字段 '${field}' 须为字符串或 null`);
  }
  return value.length === 0 ? null : value;
}

/** 解析单个物品视图（POST /masterdata/items 响应）。 */
export function parseItem(input: unknown): ItemView {
  const record = requireObject(input, '物品对象');
  return {
    id: requireString(record['id'], 'id'),
    code: requireString(record['code'], 'code'),
    name: requireString(record['name'], 'name'),
    spec: optionalString(record['spec'], 'spec'),
    unit: optionalString(record['unit'], 'unit'),
    category: optionalString(record['category'], 'category'),
    active: record['active'] === true,
  };
}

/** 解析 GET /masterdata/items 响应 { items: [...] }。 */
export function parseItemsResponse(input: unknown): readonly ItemView[] {
  const record = requireObject(input, '物品列表响应');
  const items = record['items'];
  if (!Array.isArray(items)) {
    throw new MasterdataViewError("物品列表响应缺 'items' 数组");
  }
  return items.map(parseItem);
}

/** 解析单个资源视图。 */
export function parseResource(input: unknown): ResourceView {
  const record = requireObject(input, '资源对象');
  return {
    id: requireString(record['id'], 'id'),
    code: requireString(record['code'], 'code'),
    name: requireString(record['name'], 'name'),
    type: optionalString(record['type'], 'type'),
    active: record['active'] === true,
  };
}

/** 解析 GET /masterdata/resources 响应 { resources: [...] }。 */
export function parseResourcesResponse(input: unknown): readonly ResourceView[] {
  const record = requireObject(input, '资源列表响应');
  const resources = record['resources'];
  if (!Array.isArray(resources)) {
    throw new MasterdataViewError("资源列表响应缺 'resources' 数组");
  }
  return resources.map(parseResource);
}

/** 构造 POST /masterdata/items 载荷（空字段拒绝；可选字段纯空白剔除）。 */
export function buildCreateItemPayload(input: {
  readonly code: string;
  readonly name: string;
  readonly spec?: string;
  readonly unit?: string;
  readonly category?: string;
}): { code: string; name: string } & Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: requireString(input.code.trim(), 'code'),
    name: requireString(input.name.trim(), 'name'),
  };
  const spec = input.spec?.trim();
  if (spec) payload.spec = spec;
  const unit = input.unit?.trim();
  if (unit) payload.unit = unit;
  const category = input.category?.trim();
  if (category) payload.category = category;
  return payload as { code: string; name: string } & Record<string, unknown>;
}

/** 构造 POST /masterdata/resources 载荷。 */
export function buildCreateResourcePayload(input: {
  readonly code: string;
  readonly name: string;
  readonly type?: string;
}): { code: string; name: string } & Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: requireString(input.code.trim(), 'code'),
    name: requireString(input.name.trim(), 'name'),
  };
  const type = input.type?.trim();
  if (type) payload.type = type;
  return payload as { code: string; name: string } & Record<string, unknown>;
}
