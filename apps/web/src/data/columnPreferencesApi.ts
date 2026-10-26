/**
 * 列显隐偏好薄数据层（fix-wave-6 6b-3，A14 / RREQ-INT-032：
 * column-preferences 模块控制器实态）：
 *   GET  /column-preferences?page=<code>   @RequireLogin → { tables: { [tableKey]: string[] } }
 *   PUT  /column-preferences               @RequireLogin → { hiddenProps }（幂等 upsert）
 *
 * 语义：tables 中缺 tableKey = 从未保存（列全显）；键存在且为空数组 = 用户
 * 显式选择全显示——两态必须区分（跨设备同步"全显示"）。请求体不带 userId
 * （服务端取会话身份）。行级形状校验坏形状抛错不静默。
 */
import { request } from './apiClient';
import { ModuleApiError } from './commandClient';

/** 按页偏好视图：tableKey → 隐藏列集合（缺键 = 从未保存）。 */
export type PageColumnPreferencesView = Readonly<Record<string, readonly string[]>>;

function parseTables(body: unknown): PageColumnPreferencesView {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, '列显隐偏好响应非对象');
  }
  const tables = (body as Record<string, unknown>)['tables'];
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    throw new ModuleApiError(undefined, "列显隐偏好响应缺 'tables' 对象");
  }
  const parsed: Record<string, readonly string[]> = {};
  for (const [tableKey, hidden] of Object.entries(tables as Record<string, unknown>)) {
    if (
      !Array.isArray(hidden) ||
      hidden.some((prop) => typeof prop !== 'string')
    ) {
      throw new ModuleApiError(undefined, `表格 '${tableKey}' 的 hiddenProps 非字符串数组`);
    }
    parsed[tableKey] = hidden as readonly string[];
  }
  return parsed;
}

/** 进页一次拉取整页全部表格偏好（登录即可，无权限码）。 */
export async function fetchColumnPreferences(pageKey: string): Promise<PageColumnPreferencesView> {
  const body: unknown = await request(
    `/column-preferences?page=${encodeURIComponent(pageKey)}`,
  );
  return parseTables(body);
}

/** 保存单表偏好（幂等 upsert；空数组 = 显式全显示；服务端忽略请求体 userId）。 */
export async function saveColumnPreferences(input: {
  page: string;
  table: string;
  hiddenProps: readonly string[];
}): Promise<readonly string[]> {
  const body: unknown = await request('/column-preferences', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  const hiddenProps = (body as Record<string, unknown>)['hiddenProps'];
  if (!Array.isArray(hiddenProps) || hiddenProps.some((p) => typeof p !== 'string')) {
    throw new ModuleApiError(undefined, '保存响应缺 hiddenProps 字符串数组');
  }
  return hiddenProps as readonly string[];
}
