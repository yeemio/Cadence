/**
 * 工时薄数据层（M5 首波：移动端我的工时页）：fetch 直连 server hours 端点。
 * "本人"是服务端合同（hours 控制器 workerId 只取会话身份，不收查询参数）；
 * 本层只经 apiClient 注入 Bearer，month 为可选过滤（'YYYY-MM'，后端
 * requireMonth 校验 400 反馈）。
 */
import { parseMyHoursResponse } from '@smes/product-ui';
import type { MyHoursView } from '@smes/product-ui';
import { request } from './apiClient';

/** GET /hours/my → 我的工时（本人已审核净额按日；month 省略 = 全量）。 */
export async function fetchMyHours(month?: string): Promise<MyHoursView> {
  const query = month !== undefined && month.length > 0 ? `?month=${encodeURIComponent(month)}` : '';
  return parseMyHoursResponse(await request(`/hours/my${query}`));
}

// ---- 管理面（S2 批次；端点形状按 hours.controllers.ts 实态） ----

import { fetchRawObject, fetchRows, postCommand, queryString } from './commandClient';

/** 机加工时统计（产出×工时按工作令；仅机加工种）。 */
export async function fetchMachiningStats(params: {
  readonly workOrderId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
} = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/hours/machining/stats${queryString([
      ['workOrderId', params.workOrderId],
      ['from', params.from],
      ['to', params.to],
    ])}`,
    'stats',
  );
}

/** 月度汇总（实时净额）。 */
export async function fetchMonthSummary(month: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/hours/months/${encodeURIComponent(month)}/summary`);
}

/** 月度下钻明细（workerId/trade 可选过滤）。 */
export async function fetchMonthDetails(
  month: string,
  params: { readonly workerId?: string | undefined; readonly trade?: string | undefined } = {},
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/hours/months/${encodeURIComponent(month)}/details${queryString([
      ['workerId', params.workerId],
      ['trade', params.trade],
    ])}`,
    'entries',
  );
}

/** 月度重算快照当前版。 */
export async function fetchMonthLedgers(
  month: string,
  workerId?: string | undefined,
): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/hours/months/${encodeURIComponent(month)}/ledgers${queryString([['workerId', workerId]])}`,
    'ledgers',
  );
}

/** 按工作令工时视图（{view} 直返包装）。 */
export async function fetchWorkOrderHours(workOrderId: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/hours/work-orders/${encodeURIComponent(workOrderId)}`);
}

/** 月度重算（幂等；月×工种口径）。 */
export function rebuildMonth(month: string) {
  return postCommand('/hours/rebuild-month', 'hours.rebuild-month.v1', { month });
}
