/**
 * 运营总览薄数据层（T 波 #1，pages/overview/IndexPage.tsx 专用）：fetch 直连
 * server 四源端点，响应经 product-ui 视图模型类型化解析（坏形状抛错不静默），
 * 再经 buildOverviewView 聚合为总览卡片+下钻分组。
 *
 * 端点/权限码（后端控制器实态，同码证据见各控制器 @RequirePermission）：
 *   GET /workbench/summary             workbench:read
 *   GET /workorder/delivery-situation  workorder:read
 *   GET /inspection/summary            inspection:read
 *   GET /hours/machining/stats         hours:read
 *
 * 取舍：Promise.all 全量聚合（任一源失败整页失败并明示来源 URL——四码一体的
 * 运营视角下部分渲染易误导；分权限降级留后续增量）。
 *
 * 模块接缝说明：overview-views.ts 的桶出口导出已并入 src/index.ts（总控接线），
 * 本文件与其它数据层同体例走 '@smes/product-ui' 公共面。
 */
import {
  buildOverviewView,
  parseDeliverySituationResponse,
  parseInspectionSummaryResponse,
  parseMachiningStatsResponse,
  parseWorkbenchSummaryResponse,
} from '@smes/product-ui';
import type { OverviewSources, OverviewView } from '@smes/product-ui';
import { request } from './apiClient';

/** 四源并行拉取 + 类型化解析（不做聚合；聚合纯函数见 product-ui）。 */
export async function fetchOverviewSources(): Promise<OverviewSources> {
  const [workbench, delivery, inspection, machining] = await Promise.all([
    parseWorkbenchSummaryResponse(await request('/workbench/summary')),
    parseDeliverySituationResponse(await request('/workorder/delivery-situation')),
    parseInspectionSummaryResponse(await request('/inspection/summary')),
    parseMachiningStatsResponse(await request('/hours/machining/stats')),
  ]);
  return { workbench, delivery, inspection, machining };
}

/** 四源拉取 + 解析 + 聚合 → 总览视图（IndexPage 唯一查询入口）。 */
export async function fetchOverviewView(): Promise<OverviewView> {
  return buildOverviewView(await fetchOverviewSources());
}
