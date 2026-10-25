/**
 * listing 路由（M2-W3）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute。
 *
 * 权限码（03-listing.md §5 最小集：listing:read|write|import、gap:read、
 * purchase:read|request|order|approve|receive|return）：
 *   POST /listing/imports                            listing:import  （骨架/Excel 导入）
 *   GET  /listing/sheets?workOrderId=                listing:read    （四类清单按工作令）
 *   GET  /listing/sheets/:id                         listing:read    （清单详情含行）
 *   GET  /listing/upload-stats                       listing:read    （A9 下图统计：零件清单行 COUNT）
 *   POST /listing/lines/:id/update                   listing:write   （行修订）
 *   POST /listing/work-orders/:id/gap-checks         gap:read        （核查动作+快照）
 *   GET  /listing/work-orders/:id/gap-checks/latest  gap:read        （核查结果）
 *   POST /purchase/requests                          purchase:request
 *   GET  /purchase/requests                          purchase:read   （?state=&workOrderId=&purchaseOrderId=）
 *   GET  /purchase/requests/:id                      purchase:read
 *   POST /purchase/orders                            purchase:order  （建单+提交）
 *   GET  /purchase/orders                            purchase:read   （?state=&workOrderId=）
 *   GET  /purchase/orders/:id                        purchase:read   （全流程视图）
 *   POST /purchase/orders/:id/approval               purchase:approve
 *   POST /purchase/orders/:id/issue                  purchase:order
 *   POST /purchase/orders/:id/receipts               purchase:receive（联动入库指令）
 *   GET  /purchase/returns?purchaseOrderId=          purchase:read
 *   POST /purchase/returns                           purchase:return
 *   POST /purchase/returns/:id/revoke                purchase:return
 *   POST /purchase/overdue-scan                      purchase:order  （逾期事实扫描）
 *   GET  /purchase/overdue                           purchase:read   （逾期未交明细·订单头）
 *   GET  /purchase/overdue-lines                     purchase:read   （逾期未交明细行·U8，?workOrderId=）
 *   GET  /purchase/details/export                    purchase:read   （采购明细导出）
 *
 * gap.check 为写命令（产出不可变快照）但权限面只有 gap:read——合同最小集口径，
 * 核查动作视为"读取型核查"（不改变任何运营状态，只追加事实）。
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ListingInputError } from './listing-errors.js';
import {
  parseCommandBodyForKind,
  parseIdParam,
  parseStateFilter,
  parseWorkOrderFilter,
  type ListingCommand,
} from './listing-input.js';
import type { ListingCommandResult } from './listing.service.js';
import { ListingService } from './listing.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<ListingCommand> {
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

@Controller('listing')
export class ListingSheetsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly listing: ListingService,
  ) {}

  @Post('imports')
  @RequirePermission('listing:import')
  async import(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ListingCommandResult> {
    return this.listing.execute(envelopeOf(this.tenantContext, request, body, 'listing.import.v1'));
  }

  @Get('sheets')
  @RequirePermission('listing:read')
  async sheets(@Query('workOrderId') workOrderId?: string): Promise<{
    sheets: Awaited<ReturnType<ListingService['sheetsByWorkOrder']>>;
  }> {
    const filter = parseWorkOrderFilter(workOrderId);
    if (filter === undefined) {
      throw new ListingInputError('workOrderId 查询参数必填（四类清单按工作令查询）');
    }
    return { sheets: await this.listing.sheetsByWorkOrder(this.tenantContext.current(), filter) };
  }

  @Get('sheets/:id')
  @RequirePermission('listing:read')
  async sheet(@Param('id') id: string): Promise<Awaited<ReturnType<ListingService['sheetDetail']>>> {
    return this.listing.sheetDetail(this.tenantContext.current(), parseIdParam(id, '清单 id'));
  }

  @Post('lines/:id/update')
  @RequirePermission('listing:write')
  async updateLine(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'listing.line.update.v1'),
      parseIdParam(id, '清单行 id'),
    );
  }

  @Post('work-orders/:id/gap-checks')
  @RequirePermission('gap:read')
  async checkGap(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'gap.check.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Get('work-orders/:id/gap-checks/latest')
  @RequirePermission('gap:read')
  async latestGapCheck(@Param('id') id: string): Promise<{
    gapCheck: Awaited<ReturnType<ListingService['latestGapCheck']>>;
  }> {
    return {
      gapCheck: await this.listing.latestGapCheck(
        this.tenantContext.current(),
        parseIdParam(id, '工作令 id'),
      ),
    };
  }

  /**
   * A9 下图统计（工作令-下图统计-开发文档）：时间范围内零件清单明细行
   * COUNT——不去重、不分页、恒一行（无匹配行 drawingCount=0）。空串参数按
   * 未传处理（与 purchase 控制器空串归一口径一致）。
   */
  @Get('upload-stats')
  @RequirePermission('listing:read')
  async uploadStats(
    @Query('createTimeStart') createTimeStart?: string,
    @Query('createTimeEnd') createTimeEnd?: string,
  ): Promise<{ uploadStat: Awaited<ReturnType<ListingService['partUploadStats']>> }> {
    return {
      uploadStat: await this.listing.partUploadStats(
        this.tenantContext.current(),
        createTimeStart === '' ? undefined : createTimeStart,
        createTimeEnd === '' ? undefined : createTimeEnd,
      ),
    };
  }
}

@Controller('purchase/requests')
export class PurchaseRequestsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly listing: ListingService,
  ) {}

  @Post()
  @RequirePermission('purchase:request')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.request.create.v1'),
    );
  }

  @Get()
  @RequirePermission('purchase:read')
  async list(
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('purchaseOrderId') purchaseOrderId?: string,
  ): Promise<{ requests: Awaited<ReturnType<ListingService['listRequests']>> }> {
    return {
      requests: await this.listing.listRequests(
        this.tenantContext.current(),
        parseStateFilter(state),
        parseWorkOrderFilter(workOrderId),
        purchaseOrderId === undefined || purchaseOrderId === ''
          ? undefined
          : parseIdParam(purchaseOrderId, '采购订单 id'),
      ),
    };
  }

  @Get(':id')
  @RequirePermission('purchase:read')
  async get(@Param('id') id: string): Promise<{ request: Awaited<ReturnType<ListingService['requestDetail']>> }> {
    return { request: await this.listing.requestDetail(this.tenantContext.current(), parseIdParam(id, '采购申请 id')) };
  }
}

@Controller('purchase/orders')
export class PurchaseOrdersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly listing: ListingService,
  ) {}

  @Post()
  @RequirePermission('purchase:order')
  async submit(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.order.submit.v1'),
    );
  }

  @Get()
  @RequirePermission('purchase:read')
  async list(
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
  ): Promise<{ orders: Awaited<ReturnType<ListingService['listOrders']>> }> {
    return {
      orders: await this.listing.listOrders(
        this.tenantContext.current(),
        parseStateFilter(state),
        parseWorkOrderFilter(workOrderId),
      ),
    };
  }

  @Get(':id')
  @RequirePermission('purchase:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<ListingService['orderDetail']>>> {
    return this.listing.orderDetail(this.tenantContext.current(), parseIdParam(id, '采购订单 id'));
  }

  @Post(':id/approval')
  @RequirePermission('purchase:approve')
  async approve(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.order.approve.v1'),
      parseIdParam(id, '采购订单 id'),
    );
  }

  @Post(':id/issue')
  @RequirePermission('purchase:order')
  async issue(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.order.issue.v1'),
      parseIdParam(id, '采购订单 id'),
    );
  }

  @Post(':id/receipts')
  @RequirePermission('purchase:receive')
  async receive(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.order.receive.v1'),
      parseIdParam(id, '采购订单 id'),
    );
  }
}

@Controller('purchase/returns')
export class PurchaseReturnsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly listing: ListingService,
  ) {}

  @Post()
  @RequirePermission('purchase:return')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.return.create.v1'),
    );
  }

  @Get()
  @RequirePermission('purchase:read')
  async list(@Query('purchaseOrderId') purchaseOrderId?: string): Promise<{
    returns: Awaited<ReturnType<ListingService['listReturns']>>;
  }> {
    return {
      returns: await this.listing.listReturns(
        this.tenantContext.current(),
        parseIdParam(purchaseOrderId ?? '', '采购订单 id（purchaseOrderId 查询参数必填）'),
      ),
    };
  }

  @Post(':id/revoke')
  @RequirePermission('purchase:return')
  async revoke(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.return.revoke.v1'),
      parseIdParam(id, '退货单 id'),
    );
  }
}

@Controller('purchase')
export class PurchaseQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly listing: ListingService,
  ) {}

  @Post('overdue-scan')
  @RequirePermission('purchase:order')
  async scanOverdue(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ListingCommandResult> {
    return this.listing.execute(
      envelopeOf(this.tenantContext, request, body, 'purchase.overdue.scan.v1'),
    );
  }

  @Get('overdue')
  @RequirePermission('purchase:read')
  async overdue(): Promise<{ overdue: Awaited<ReturnType<ListingService['overdueList']>> }> {
    return { overdue: await this.listing.overdueList(this.tenantContext.current()) };
  }

  /**
   * U8 逾期未交**明细行**（逾期交货采购件报表-开发文档：订单明细行级事实面，
   * 与订单头粒度 GET /purchase/overdue 并存）。workOrderId 空串按未传处理
   * （parseWorkOrderFilter，与 /purchase/details 同口径）。
   */
  @Get('overdue-lines')
  @RequirePermission('purchase:read')
  async overdueLines(
    @Query('workOrderId') workOrderId?: string,
  ): Promise<{ overdueLines: Awaited<ReturnType<ListingService['overdueLines']>> }> {
    return {
      overdueLines: await this.listing.overdueLines(
        this.tenantContext.current(),
        parseWorkOrderFilter(workOrderId),
      ),
    };
  }

  @Get('details/export')
  @RequirePermission('purchase:read')
  async exportDetails(@Query('workOrderId') workOrderId?: string): Promise<Awaited<ReturnType<ListingService['exportPurchaseDetails']>>> {
    return this.listing.exportPurchaseDetails(this.tenantContext.current(), parseWorkOrderFilter(workOrderId));
  }

  @Get('details')
  @RequirePermission('purchase:read')
  async details(@Query('workOrderId') workOrderId?: string): Promise<Awaited<ReturnType<ListingService['purchaseDetails']>>> {
    return this.listing.purchaseDetails(this.tenantContext.current(), parseWorkOrderFilter(workOrderId));
  }
}
