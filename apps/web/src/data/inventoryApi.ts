/**
 * 库存薄数据层（M5 首波：移动端库存查询页）：fetch 直连 server inventory
 * 端点。移动端与桌面逻辑面同径（?itemId= 扫码查询——后端注释明示不设镜像
 * 端点，呈现归 M5 PWA）；本层只经 apiClient 注入 Bearer。
 */
import { parseStockLevelsResponse } from '@smes/product-ui';
import type { StockLevelView } from '@smes/product-ui';
import { request } from './apiClient';

/** GET /inventory/stock → 实时库存（可用量口径；itemId 省略 = 全部物料）。 */
export async function fetchStockLevels(itemId?: string): Promise<readonly StockLevelView[]> {
  const query =
    itemId !== undefined && itemId.trim().length > 0
      ? `?itemId=${encodeURIComponent(itemId.trim())}`
      : '';
  return parseStockLevelsResponse(await request(`/inventory/stock${query}`));
}
