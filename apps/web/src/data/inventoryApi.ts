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

// ---- 管理面（S2 批次；端点形状按 inventory.controllers.ts 实态） ----

import {
  fetchObject,
  fetchRawObject,
  fetchRows,
  postCommand,
  queryString,
  revisionOf,
} from './commandClient';

/** 库位分布（balances）。 */
export async function fetchLocationBalances(params: {
  readonly warehouseId?: string | undefined;
  readonly itemId?: string | undefined;
} = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/inventory/stock/locations${queryString([['warehouseId', params.warehouseId], ['itemId', params.itemId]])}`,
    'balances',
  );
}

/** 出入库流水（movements）。 */
export async function fetchMovements(params: {
  readonly itemId?: string | undefined;
  readonly warehouseId?: string | undefined;
} = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/inventory/movements${queryString([['itemId', params.itemId], ['warehouseId', params.warehouseId]])}`,
    'movements',
  );
}

// ---- 仓库与库位 ----

export async function listWarehouses(): Promise<readonly Record<string, unknown>[]> {
  return fetchRows('/inventory/warehouses', 'warehouses');
}

/** 仓库详情（{warehouse}，含库位）。 */
export async function getWarehouseDetail(id: string): Promise<Record<string, unknown>> {
  return fetchObject(`/inventory/warehouses/${encodeURIComponent(id)}`, 'warehouse');
}

/** 建仓库 + 库位（第一个库位为默认库位）。 */
export function defineWarehouse(input: {
  readonly code: string;
  readonly name: string;
  readonly locations: ReadonlyArray<{ readonly code: string; readonly name?: string | undefined }>;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/warehouses', 'warehouse.define.v1', {
    code: input.code,
    name: input.name,
    locations: input.locations.map((location) => ({
      code: location.code,
      name: location.name ?? null,
    })),
    remark: input.remark ?? null,
  });
}

// ---- 出入库操作 ----

/** 三类入库（inspection 放行须带质检单；purchase 须带 receiptKey 幂等键）。 */
export function receiveStock(input: {
  readonly kind: 'inspection' | 'purchase' | 'production';
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: number;
  readonly locationId?: string | undefined;
  readonly inspectionId?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly receiptKey?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/stock/receipts', 'stock.receive.v1', {
    kind: input.kind,
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    quantity: input.quantity,
    locationId: input.locationId ?? null,
    inspectionId: input.inspectionId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    workOrderId: input.workOrderId ?? null,
    receiptKey: input.receiptKey ?? null,
    remark: input.remark ?? null,
  });
}

/** 出库（直扣/预占-核销-释放）。 */
export function issueStock(input: {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly quantity: number;
  readonly purpose: 'production' | 'parts' | 'manual';
  readonly locationId?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly reservationKey?: string | undefined;
  readonly issueKey?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/stock/issues', 'stock.issue.v1', {
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    quantity: input.quantity,
    purpose: input.purpose,
    locationId: input.locationId ?? null,
    workOrderId: input.workOrderId ?? null,
    reservationKey: input.reservationKey ?? null,
    issueKey: input.issueKey ?? null,
    remark: input.remark ?? null,
  });
}

/** 调拨/移库（跨仓调拨与仓内移库同命令）。 */
export function transferStock(input: {
  readonly itemId: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly quantity: number;
  readonly fromLocationId?: string | undefined;
  readonly toLocationId?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/stock/transfers', 'stock.transfer.v1', {
    itemId: input.itemId,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    quantity: input.quantity,
    fromLocationId: input.fromLocationId ?? null,
    toLocationId: input.toLocationId ?? null,
    remark: input.remark ?? null,
  });
}

// ---- 盘点 ----

export async function listStocktakes(state?: string | undefined): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(`/inventory/stocktakes${queryString([['state', state]])}`, 'stocktakes');
}

/** 盘点单详情（直返对象）。 */
export async function getStocktakeDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/inventory/stocktakes/${encodeURIComponent(id)}`);
}

/** 开单进盘点（itemIds 缺省=全仓有账物料）。 */
export function openStocktake(input: {
  readonly warehouseId: string;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/stocktakes', 'stocktake.open.v1', {
    warehouseId: input.warehouseId,
    itemIds: null,
    remark: input.remark ?? null,
  });
}

/** 实盘录入（complete=true 提交差异）。 */
export function recordStocktake(
  id: string,
  row: Record<string, unknown>,
  input: {
    readonly lines: ReadonlyArray<{ readonly itemId: string; readonly countedQty: number }>;
    readonly complete: boolean;
  },
) {
  return postCommand(
    `/inventory/stocktakes/${encodeURIComponent(id)}/records`,
    'stocktake.record.v1',
    { lines: input.lines, complete: input.complete },
    revisionOf(row, '盘点单行'),
  );
}

/** 审核调账（理由必填——账面=实盘留痕）。 */
export function approveStocktake(id: string, row: Record<string, unknown>, remark: string) {
  return postCommand(
    `/inventory/stocktakes/${encodeURIComponent(id)}/approval`,
    'stocktake.approve-adjust.v1',
    { remark },
    revisionOf(row, '盘点单行'),
  );
}

// ---- 发货 ----

export async function listShippingOrders(params: {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
} = {}): Promise<readonly Record<string, unknown>[]> {
  return fetchRows(
    `/inventory/shipping-orders${queryString([['state', params.state], ['workOrderId', params.workOrderId]])}`,
    'shippingOrders',
  );
}

/** 发货任务详情（直返对象）。 */
export async function getShippingDetail(id: string): Promise<Record<string, unknown>> {
  return fetchRawObject(`/inventory/shipping-orders/${encodeURIComponent(id)}`);
}

/** 建任务 + 执行出库（draft→executing）。 */
export function executeShipping(input: {
  readonly lines: ReadonlyArray<{ readonly itemId: string; readonly quantity: number }>;
  readonly workOrderId?: string | undefined;
  readonly carrier?: string | undefined;
  readonly trackingNo?: string | undefined;
  readonly remark?: string | undefined;
}) {
  return postCommand('/inventory/shipping-orders', 'shipping.execute.v1', {
    workOrderId: input.workOrderId ?? null,
    lines: input.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      warehouseId: null,
      locationId: null,
      reservationKey: null,
    })),
    carrier: input.carrier ?? null,
    trackingNo: input.trackingNo ?? null,
    remark: input.remark ?? null,
  });
}

/** 确认发货（executing→shipped）。 */
export function confirmShipping(
  id: string,
  row: Record<string, unknown>,
  input: {
    readonly carrier?: string | undefined;
    readonly trackingNo?: string | undefined;
    readonly remark?: string | undefined;
  },
) {
  return postCommand(
    `/inventory/shipping-orders/${encodeURIComponent(id)}/confirm`,
    'shipping.confirm.v1',
    {
      carrier: input.carrier ?? null,
      trackingNo: input.trackingNo ?? null,
      remark: input.remark ?? null,
    },
    revisionOf(row, '发货任务行'),
  );
}

export interface ReceiveOptions {
  readonly items: readonly { id: string; code: string; name: string }[];
  readonly warehouses: readonly { id: string; code: string; name: string }[];
  readonly releases: readonly { id: string; itemId: string; remainingQty: number }[];
}
export async function receiveOptions(): Promise<ReceiveOptions> { return await request('/inventory/receive-options') as ReceiveOptions; }
