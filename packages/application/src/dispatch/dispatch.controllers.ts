/**
 * dispatch 路由（M2-W6）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute。
 *
 * 权限码（04-dispatch.md §5 最小集：dispatch:read|write|assign|cancel、
 * outsourcing:read|price；fix-wave-6 6a-1 增量路由见尾部注记）：
 *   POST /dispatch/orders                        dispatch:write  （六类创建，含齐套拦截）
 *   GET  /dispatch/orders                        dispatch:read   （?kind=&state=&workOrderId=&assignee=）
 *   GET  /dispatch/orders/export                 dispatch:read   （Excel 导出——仅导出不写库，6a-1）
 *   GET  /dispatch/orders/stats                  dispatch:read   （页眉五态计数，6a-1）
 *   GET  /dispatch/orders/:id                    dispatch:read   （详情：外协行 + 里程碑）
 *   POST /dispatch/orders/:id/assign             dispatch:assign （派工到人 + 待办）
 *   POST /dispatch/orders/:id/start              dispatch:write  （开工）
 *   POST /dispatch/orders/:id/complete           dispatch:write  （完工；外协单联动回厂触发）
 *   POST /dispatch/orders/:id/cancel             dispatch:cancel （撤销：draft/assigned）
 *   POST /dispatch/orders/:id/transfer           dispatch:assign （转单：executing 换执行人/
 *                                                                 工序 + 审计事件，6a-1）
 *   POST /dispatch/orders/batch-assign           dispatch:assign （批量派工下发：均 draft，
 *                                                                 整批拒绝，6a-1）
 *   POST /dispatch/orders/batch-cancel           dispatch:cancel （批量删除：均 draft 且
 *                                                                 零件/外协——逐类豁免，6a-1）
 *   GET  /dispatch/tasks                         dispatch:read   （按人任务视图；?assignee= 必填）
 *   GET  /dispatch/work-orders/:id/tasks         dispatch:read   （按序任务视图）
 *   GET  /outsourcing/lines                      outsourcing:read（供应商维度；?supplierRef= 必填）
 *   POST /outsourcing/lines/:id/price-backfill   outsourcing:price（补录单价→OutsourcingPriced）
 *   POST /outsourcing/lines/:id/cancel           dispatch:cancel （取消外协明细行——取消/
 *                                                                 撤销动作族权限码复用，6a-1）
 *   GET  /outsourcing/orders/:id/print-data      outsourcing:read（外协加工单打印数据）
 *   POST /outsourcing/orders/:id/print           outsourcing:read（打印提交——读权限动作：
 *                                                 打印不改变业务状态，只消费打印数据）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { DispatchInputError } from './dispatch-errors.js';
import {
  parseAssigneeFilter,
  parseBatchAssignBody,
  parseBatchCancelBody,
  parseCommandBodyForKind,
  parseIdParam,
  parseKindFilter,
  parseStateFilter,
  parseSupplierFilter,
  parseWorkOrderFilter,
  type DispatchCommand,
} from './dispatch-input.js';
import type { DispatchCommandResult } from './dispatch.service.js';
import { DispatchService } from './dispatch.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<DispatchCommand> {
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

@Controller('dispatch')
export class DispatchOrdersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly dispatch: DispatchService,
  ) {}

  @Get('orders/equipment-options')
  @RequirePermission('dispatch:write')
  async equipmentOptions(@Query('workOrderId') workOrderId: string) { return { equipment: await this.dispatch.equipmentOptions(this.tenantContext.current(), parseIdParam(workOrderId, '工作令 id')) }; }

  @Post('orders')
  @RequirePermission('dispatch:write')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<DispatchCommandResult> {
    return this.dispatch.execute(envelopeOf(this.tenantContext, request, body, 'dispatch.create.v1'));
  }

  @Get('orders')
  @RequirePermission('dispatch:read')
  async list(
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('assignee') assignee?: string,
  ): Promise<{ orders: Awaited<ReturnType<DispatchService['listDispatchOrders']>> }> {
    return {
      orders: await this.dispatch.listDispatchOrders(this.tenantContext.current(), {
        ...(parseKindFilter(kind) === undefined ? {} : { kind: parseKindFilter(kind) }),
        ...(parseStateFilter(state) === undefined ? {} : { state: parseStateFilter(state) }),
        ...(parseWorkOrderFilter(workOrderId) === undefined ? {} : { workOrderId: parseWorkOrderFilter(workOrderId) }),
        ...(parseAssigneeFilter(assignee) === undefined ? {} : { assignee: parseAssigneeFilter(assignee) }),
      }),
    };
  }

  @Get('orders/export')
  @RequirePermission('dispatch:read')
  async exportOrders(
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('assignee') assignee?: string,
  ): Promise<{ export: Awaited<ReturnType<DispatchService['exportDispatchOrders']>> }> {
    return {
      export: await this.dispatch.exportDispatchOrders(this.tenantContext.current(), {
        ...(parseKindFilter(kind) === undefined ? {} : { kind: parseKindFilter(kind) }),
        ...(parseStateFilter(state) === undefined ? {} : { state: parseStateFilter(state) }),
        ...(parseWorkOrderFilter(workOrderId) === undefined ? {} : { workOrderId: parseWorkOrderFilter(workOrderId) }),
        ...(parseAssigneeFilter(assignee) === undefined ? {} : { assignee: parseAssigneeFilter(assignee) }),
      }),
    };
  }

  @Get('orders/stats')
  @RequirePermission('dispatch:read')
  async stats(
    @Query('kind') kind?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('assignee') assignee?: string,
  ): Promise<{ counts: Awaited<ReturnType<DispatchService['dispatchOrderStats']>> }> {
    return {
      counts: await this.dispatch.dispatchOrderStats(this.tenantContext.current(), {
        ...(parseKindFilter(kind) === undefined ? {} : { kind: parseKindFilter(kind) }),
        ...(parseWorkOrderFilter(workOrderId) === undefined ? {} : { workOrderId: parseWorkOrderFilter(workOrderId) }),
        ...(parseAssigneeFilter(assignee) === undefined ? {} : { assignee: parseAssigneeFilter(assignee) }),
      }),
    };
  }

  @Get('orders/:id')
  @RequirePermission('dispatch:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<DispatchService['dispatchDetail']>>> {
    return this.dispatch.dispatchDetail(this.tenantContext.current(), parseIdParam(id, '派工单 id'));
  }

  @Post('orders/:id/assign')
  @RequirePermission('dispatch:assign')
  async assign(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'dispatch.assign.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }

  @Post('orders/:id/start')
  @RequirePermission('dispatch:write')
  async start(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'dispatch.start.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }

  @Post('orders/:id/complete')
  @RequirePermission('dispatch:write')
  async complete(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'dispatch.complete.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }

  @Post('orders/:id/cancel')
  @RequirePermission('dispatch:cancel')
  async cancel(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'dispatch.cancel.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }

  @Post('orders/:id/transfer')
  @RequirePermission('dispatch:assign')
  async transfer(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'dispatch.transfer.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }

  @Post('orders/batch-assign')
  @RequirePermission('dispatch:assign')
  async batchAssign(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<DispatchService['batchAssign']>>> {
    const parsed = parseBatchAssignBody(body);
    return this.dispatch.batchAssign(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
      { operationId: parsed.operationId, assignee: parsed.assignee, remark: parsed.remark, items: parsed.items },
    );
  }

  @Post('orders/batch-cancel')
  @RequirePermission('dispatch:cancel')
  async batchCancel(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<DispatchService['batchCancel']>>> {
    const parsed = parseBatchCancelBody(body);
    return this.dispatch.batchCancel(this.tenantContext.current(), request[REQUEST_USER_KEY], {
      operationId: parsed.operationId,
      remark: parsed.remark,
      items: parsed.items,
    });
  }
}

@Controller('dispatch')
export class DispatchTasksController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly dispatch: DispatchService,
  ) {}

  @Get('tasks')
  @RequirePermission('dispatch:read')
  async tasksByAssignee(@Query('assignee') assignee?: string): Promise<{
    tasks: Awaited<ReturnType<DispatchService['tasksByAssignee']>>;
  }> {
    const assigneeId = parseAssigneeFilter(assignee);
    if (assigneeId === undefined) {
      throw new DispatchInputError('assignee 查询参数必填（按人任务视图）');
    }
    return { tasks: await this.dispatch.tasksByAssignee(this.tenantContext.current(), assigneeId) };
  }

  @Get('work-orders/:id/tasks')
  @RequirePermission('dispatch:read')
  async tasksByWorkOrder(@Param('id') id: string): Promise<{
    tasks: Awaited<ReturnType<DispatchService['tasksByWorkOrder']>>;
  }> {
    return {
      tasks: await this.dispatch.tasksByWorkOrder(
        this.tenantContext.current(),
        parseIdParam(id, '工作令 id'),
      ),
    };
  }

  @Get('work-orders/:id/progress-facts')
  @RequirePermission('dispatch:read')
  async progressFacts(@Param('id') id: string): Promise<{
    facts: Awaited<ReturnType<DispatchService['progressFacts']>>;
  }> {
    return {
      facts: await this.dispatch.progressFacts(this.tenantContext.current(), parseIdParam(id, '工作令 id')),
    };
  }
}

@Controller('outsourcing')
export class OutsourcingController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly dispatch: DispatchService,
  ) {}

  @Get('lines')
  @RequirePermission('outsourcing:read')
  async bySupplier(@Query('supplierRef') supplierRef?: string): Promise<{
    lines: Awaited<ReturnType<DispatchService['outsourcingBySupplier']>>;
  }> {
    const supplier = parseSupplierFilter(supplierRef);
    if (supplier === undefined) {
      throw new DispatchInputError('supplierRef 查询参数必填（外协单供应商维度查询）');
    }
    return { lines: await this.dispatch.outsourcingBySupplier(this.tenantContext.current(), supplier) };
  }

  @Post('lines/:id/price-backfill')
  @RequirePermission('outsourcing:price')
  async backfillPrice(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'outsourcing.price.backfill.v1'),
      parseIdParam(id, '外协明细 id'),
    );
  }

  /** 取消外协明细行（6a-1，RREQ-DP-031）：取消/撤销动作族——复用 dispatch:cancel。 */
  @Post('lines/:id/cancel')
  @RequirePermission('dispatch:cancel')
  async cancelLine(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchCommandResult> {
    return this.dispatch.execute(
      envelopeOf(this.tenantContext, request, body, 'outsourcing.line.cancel.v1'),
      parseIdParam(id, '外协明细 id'),
    );
  }

  @Get('orders/:id/print-data')
  @RequirePermission('outsourcing:read')
  async printData(@Param('id') id: string): Promise<{
    document: Awaited<ReturnType<DispatchService['outsourcingPrintData']>>;
  }> {
    return {
      document: await this.dispatch.outsourcingPrintData(
        this.tenantContext.current(),
        parseIdParam(id, '外协派工单 id'),
      ),
    };
  }

  @Post('orders/:id/print')
  @RequirePermission('outsourcing:read')
  async print(@Param('id') id: string): Promise<Awaited<ReturnType<DispatchService['printOutsourcingSheet']>>> {
    return this.dispatch.printOutsourcingSheet(
      this.tenantContext.current(),
      parseIdParam(id, '外协派工单 id'),
    );
  }
}
