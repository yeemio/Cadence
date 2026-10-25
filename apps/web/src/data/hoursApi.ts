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
