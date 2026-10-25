/**
 * 移动作业读取薄数据层（S3 移动呈现，m.verify/m.parts-approval/m.inspection/
 * m.stocktake/m.progress/m.op-progress/m.mine 七页的读取面）：fetch 直连 server
 * 端点，响应经 product-ui 视图模型类型化解析（坏形状抛错不静默）。
 *
 * 与既有各 *Api.ts 的分工：命令面（verify/approve/judge/stocktake 系动作）
 * 复用 S2 各模块 API 的既有函数（本文件零命令端点、不与命令层重复）；本文件
 * 只补移动读取面的类型化出口——其中 GET /reports/mine 是既有数据层未覆盖的
 * 端点（本人双键，reporting.controllers.ts:103-110 实态），其余读取端点虽有
 * 通用 Record 行版本，移动页按 M5 先例（hours/inventory）走视图模型钉形状。
 *
 * 端点/权限码（后端控制器实态，同码证据见各控制器 @RequirePermission）：
 *   GET /reports/mine                        report:read
 *   GET /reports/pending-verification        report:read
 *   GET /inspection/orders?kind=&state=      inspection:read
 *   GET /workorder/parts-requests?state=     parts:read
 *   GET /inventory/stocktakes?state=         stocktake:read
 *   GET /inventory/stocktakes/:id            stocktake:read
 *   GET /workorder/work-orders/:id/progress  workorder:read
 *   GET /reporting/drawings/:drawingNo/operation-progress  report:read
 */
import {
  parseInspectionOrdersResponse,
  parseOperationProgressResponse,
  parsePartsRequestsResponse,
  parseStocktakeDetailResponse,
  parseStocktakesResponse,
  parseWorkOrderProgressResponse,
  parseWorkReportsResponse,
} from '@smes/product-ui';
import type {
  InspectionOrderRowView,
  OperationProgressRowView,
  PartsRequestRowView,
  StocktakeDetailView,
  StocktakeRowView,
  WorkOrderProgressView,
  WorkReportRowView,
} from '@smes/product-ui';
import { request } from './apiClient';
import { queryString } from './commandClient';

/** GET 裸信封 + 视图模型解析（信封键校验归 product-ui parse 函数）。 */
async function fetchEnvelope(path: string): Promise<unknown> {
  return request(path);
}

/** GET /reports/mine → 我的报工记录（本人双键；#136 我的报工 + #116 记录列表）。 */
export async function fetchMyReports(): Promise<readonly WorkReportRowView[]> {
  return parseWorkReportsResponse(await fetchEnvelope('/reports/mine'));
}

/** GET /reports/pending-verification → 待核查队列（reported 链尾，先进先核）。 */
export async function fetchPendingVerification(): Promise<readonly WorkReportRowView[]> {
  return parseWorkReportsResponse(await fetchEnvelope('/reports/pending-verification'));
}

/** GET /inspection/orders → 四类质检队列（kind/state 过滤可选）。 */
export async function fetchInspectionQueue(filters: {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
} = {}): Promise<readonly InspectionOrderRowView[]> {
  return parseInspectionOrdersResponse(
    await fetchEnvelope(
      `/inspection/orders${queryString([['kind', filters.kind], ['state', filters.state]])}`,
    ),
  );
}

/** GET /workorder/parts-requests → 配件申请列表（缺省 state=submitted 待审队列）。 */
export async function fetchPartsRequests(state?: string | undefined): Promise<readonly PartsRequestRowView[]> {
  return parsePartsRequestsResponse(
    await fetchEnvelope(
      `/workorder/parts-requests${queryString([['state', state ?? 'submitted']])}`,
    ),
  );
}

/** GET /inventory/stocktakes → 盘点台账（state 过滤可选）。 */
export async function fetchStocktakeList(state?: string | undefined): Promise<readonly StocktakeRowView[]> {
  return parseStocktakesResponse(
    await fetchEnvelope(`/inventory/stocktakes${queryString([['state', state]])}`),
  );
}

/** GET /inventory/stocktakes/:id → 盘点单详情（主单据 + 行集 + 里程碑）。 */
export async function fetchStocktakeDetail(id: string): Promise<StocktakeDetailView> {
  return parseStocktakeDetailResponse(
    await fetchEnvelope(`/inventory/stocktakes/${encodeURIComponent(id)}`),
  );
}

/** GET /workorder/work-orders/:id/progress → 工作令项目进度（直返视图对象）。 */
export async function fetchWorkOrderProgress(id: string): Promise<WorkOrderProgressView> {
  return parseWorkOrderProgressResponse(
    await fetchEnvelope(`/workorder/work-orders/${encodeURIComponent(id)}/progress`),
  );
}

/** GET /reporting/drawings/:drawingNo/operation-progress → 图号×工序净报工聚合。 */
export async function fetchDrawingOperationProgress(
  drawingNo: string,
): Promise<readonly OperationProgressRowView[]> {
  return parseOperationProgressResponse(
    await fetchEnvelope(
      `/reporting/drawings/${encodeURIComponent(drawingNo)}/operation-progress`,
    ),
  );
}
