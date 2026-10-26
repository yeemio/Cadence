/**
 * inventory 路由（M2-W5）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute。
 *
 * 权限码（07-inventory.md §5 最小集：warehouse:read|write、stock:read|
 * receive|issue|transfer、stocktake:read|record|approve、shipping:read|execute）：
 *   POST /inventory/warehouses                    warehouse:write  （建仓库+库位）
 *   GET  /inventory/warehouses                    warehouse:read
 *   GET  /inventory/warehouses/:id                warehouse:read   （含库位）
 *   POST /inventory/goods-shelves                 warehouse:write  （建货架+随建库位，B3）
 *   GET  /inventory/goods-shelves                 warehouse:read   （货架目录）
 *   GET  /inventory/goods-shelves/:id             warehouse:read   （含货架库位）
 *   POST /inventory/goods-shelves/:id/update      warehouse:write  （改码/名称/备注）
 *   POST /inventory/goods-shelves/:id/status      warehouse:write  （启停，结存保护）
 *   POST /inventory/goods-shelves/:id/remove      warehouse:write  （删架，下属保护）
 *   POST /inventory/goods-shelves/:id/locations   warehouse:write  （建货架库位）
 *   POST /inventory/shelf-locations/:id/update    warehouse:write  （改码/名称/备注）
 *   POST /inventory/shelf-locations/:id/status    warehouse:write  （启停，结存保护）
 *   POST /inventory/shelf-locations/:id/remove    warehouse:write  （删位，结存+流水保护）
 *   POST /inventory/stock/receipts                stock:receive    （三类入库）
 *   POST /inventory/stock/issues                  stock:issue      （出库）
 *   POST /inventory/stock/transfers               stock:transfer   （调拨/移库）
 *   POST /inventory/stocktakes                    stocktake:record （开单进盘点）
 *   POST /inventory/stocktakes/:id/records        stocktake:record （实盘录入，移动端同径）
 *   POST /inventory/stocktakes/:id/approval       stocktake:approve（审核调账）
 *   POST /inventory/shipping-orders               shipping:execute （建任务+执行出库）
 *   POST /inventory/shipping-orders/:id/confirm   shipping:execute （确认发货）
 *   GET  /inventory/stock                         stock:read       （实时库存·可用量口径）
 *   GET  /inventory/stock/locations               stock:read       （库位分布）
 *   GET  /inventory/movements                     stock:read       （出入库流水）
 *   GET  /inventory/stocktakes                    stocktake:read   （盘点台账）
 *   GET  /inventory/stocktakes/:id                stocktake:read
 *   GET  /inventory/shipping-orders               shipping:read    （发货记录）
 *   GET  /inventory/shipping-orders/:id           shipping:read
 *
 * 移动端库存查询/盘点录入走逻辑面同径（?itemId= 扫码查询 + record 命令）——
 * 呈现归 M5 PWA（m2-drafts README 移动镜像项口径），此处不设镜像端点。
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseCommandBodyForKind,
  parseIdParam,
  parseItemQuery,
  parseOptionalIdFilter,
  parseStateFilter,
  type InventoryCommand,
} from './inventory-input.js';
import type { InventoryCommandResult } from './inventory.service.js';
import { InventoryService } from './inventory.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<InventoryCommand> {
  const parsed = parseCommandBodyForKind(body, expectedKind);
  return makeCommandEnvelope({
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: parsed.command,
  });
}

@Controller('inventory')
export class WarehousesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post('warehouses')
  @RequirePermission('warehouse:write')
  async define(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'warehouse.define.v1'));
  }

  @Get('warehouses')
  @RequirePermission('warehouse:read')
  async list(): Promise<{ warehouses: Awaited<ReturnType<InventoryService['listWarehouses']>> }> {
    return { warehouses: await this.inventory.listWarehouses(this.tenantContext.current()) };
  }

  @Get('warehouses/:id')
  @RequirePermission('warehouse:read')
  async get(@Param('id') id: string): Promise<{ warehouse: Awaited<ReturnType<InventoryService['warehouseDetail']>> }> {
    return {
      warehouse: await this.inventory.warehouseDetail(
        this.tenantContext.current(),
        parseIdParam(id, '仓库 id'),
      ),
    };
  }
}

/**
 * 货架主数据（B3 / RREQ-IV-002）：建架（可随建库位）、目录/详情、改码锁与
 * 停删保护。命令动词走 service.execute 分发；货架与货架库位沿用仓库主数据
 * 权限码（warehouse:read/write——仓库四类主数据同族，不另设权限面）。
 */
@Controller('inventory/goods-shelves')
export class GoodsShelvesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post()
  @RequirePermission('warehouse:write')
  async define(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'goods-shelf.define.v1'));
  }

  @Get()
  @RequirePermission('warehouse:read')
  async list(
    @Query('warehouseId') warehouseId?: string,
  ): Promise<{ shelves: Awaited<ReturnType<InventoryService['listGoodsShelves']>> }> {
    return {
      shelves: await this.inventory.listGoodsShelves(
        this.tenantContext.current(),
        parseOptionalIdFilter(warehouseId, '仓库 id'),
      ),
    };
  }

  @Get(':id')
  @RequirePermission('warehouse:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<InventoryService['goodsShelfDetail']>>> {
    return this.inventory.goodsShelfDetail(this.tenantContext.current(), parseIdParam(id, '货架 id'));
  }

  @Post(':id/update')
  @RequirePermission('warehouse:write')
  async update(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'goods-shelf.update.v1'),
      parseIdParam(id, '货架 id'),
    );
  }

  @Post(':id/status')
  @RequirePermission('warehouse:write')
  async setStatus(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'goods-shelf.set-status.v1'),
      parseIdParam(id, '货架 id'),
    );
  }

  @Post(':id/remove')
  @RequirePermission('warehouse:write')
  async remove(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'goods-shelf.remove.v1'),
      parseIdParam(id, '货架 id'),
    );
  }

  @Post(':id/locations')
  @RequirePermission('warehouse:write')
  async defineLocation(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'shelf-location.define.v1'),
      parseIdParam(id, '货架 id'),
    );
  }
}

/** 货架库位（挂货架）的编辑/启停/删除面（结存与流水引用保护在用例层）。 */
@Controller('inventory/shelf-locations')
export class ShelfLocationsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post(':id/update')
  @RequirePermission('warehouse:write')
  async update(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'shelf-location.update.v1'),
      parseIdParam(id, '货架库位 id'),
    );
  }

  @Post(':id/status')
  @RequirePermission('warehouse:write')
  async setStatus(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'shelf-location.set-status.v1'),
      parseIdParam(id, '货架库位 id'),
    );
  }

  @Post(':id/remove')
  @RequirePermission('warehouse:write')
  async remove(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'shelf-location.remove.v1'),
      parseIdParam(id, '货架库位 id'),
    );
  }
}

@Controller('inventory/stock')
export class StockMovementCommandsController {  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post('receipts')
  @RequirePermission('stock:receive')
  async receive(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'stock.receive.v1'));
  }

  @Post('issues')
  @RequirePermission('stock:issue')
  async issue(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'stock.issue.v1'));
  }

  @Post('transfers')
  @RequirePermission('stock:transfer')
  async transfer(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'stock.transfer.v1'));
  }
}

@Controller('inventory/stocktakes')
export class StocktakingController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post()
  @RequirePermission('stocktake:record')
  async open(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'stocktake.open.v1'));
  }

  @Post(':id/records')
  @RequirePermission('stocktake:record')
  async record(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'stocktake.record.v1'),
      parseIdParam(id, '盘点单 id'),
    );
  }

  @Post(':id/approval')
  @RequirePermission('stocktake:approve')
  async approveAdjust(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'stocktake.approve-adjust.v1'),
      parseIdParam(id, '盘点单 id'),
    );
  }
}

@Controller('inventory/shipping-orders')
export class ShippingOrdersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Post()
  @RequirePermission('shipping:execute')
  async execute(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InventoryCommandResult> {
    return this.inventory.execute(envelopeOf(this.tenantContext, request, body, 'shipping.execute.v1'));
  }

  @Post(':id/confirm')
  @RequirePermission('shipping:execute')
  async confirm(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InventoryCommandResult> {
    return this.inventory.execute(
      envelopeOf(this.tenantContext, request, body, 'shipping.confirm.v1'),
      parseIdParam(id, '发货任务 id'),
    );
  }

  @Get()
  @RequirePermission('shipping:read')
  async list(
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
  ): Promise<{ shippingOrders: Awaited<ReturnType<InventoryService['listShippingOrders']>> }> {
    return {
      shippingOrders: await this.inventory.listShippingOrders(
        this.tenantContext.current(),
        parseStateFilter(state),
        parseOptionalIdFilter(workOrderId, '工作令 id'),
      ),
    };
  }

  @Get(':id')
  @RequirePermission('shipping:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<InventoryService['shippingDetail']>>> {
    return this.inventory.shippingDetail(this.tenantContext.current(), parseIdParam(id, '发货任务 id'));
  }
}

@Controller('inventory')
export class InventoryQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inventory: InventoryService,
  ) {}

  @Get('stock')
  @RequirePermission('stock:read')
  async stock(
    @Query('warehouseId') warehouseId?: string,
    @Query('itemId') itemId?: string,
  ): Promise<{ levels: Awaited<ReturnType<InventoryService['stockLevels']>> }> {
    return {
      levels: await this.inventory.stockLevels(
        this.tenantContext.current(),
        parseOptionalIdFilter(warehouseId, '仓库 id'),
        parseItemQuery(itemId),
      ),
    };
  }

  @Get('stock/locations')
  @RequirePermission('stock:read')
  async locationBalances(
    @Query('warehouseId') warehouseId?: string,
    @Query('itemId') itemId?: string,
  ): Promise<{ balances: Awaited<ReturnType<InventoryService['locationBalances']>> }> {
    return {
      balances: await this.inventory.locationBalances(
        this.tenantContext.current(),
        parseOptionalIdFilter(warehouseId, '仓库 id'),
        parseItemQuery(itemId),
      ),
    };
  }

  @Get('movements')
  @RequirePermission('stock:read')
  async movements(
    @Query('itemId') itemId?: string,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<{ movements: Awaited<ReturnType<InventoryService['listMovements']>> }> {
    return {
      movements: await this.inventory.listMovements(
        this.tenantContext.current(),
        parseItemQuery(itemId),
        parseOptionalIdFilter(warehouseId, '仓库 id'),
      ),
    };
  }

  @Get('stocktakes')
  @RequirePermission('stocktake:read')
  async stocktakes(@Query('state') state?: string): Promise<{ stocktakes: Awaited<ReturnType<InventoryService['listStocktakes']>> }> {
    return {
      stocktakes: await this.inventory.listStocktakes(this.tenantContext.current(), parseStateFilter(state)),
    };
  }

  @Get('stocktakes/:id')
  @RequirePermission('stocktake:read')
  async stocktake(@Param('id') id: string): Promise<Awaited<ReturnType<InventoryService['stocktakeDetail']>>> {
    return this.inventory.stocktakeDetail(this.tenantContext.current(), parseIdParam(id, '盘点单 id'));
  }
}
