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
