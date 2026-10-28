/**
 * workorder 路由（M2-W1）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute（信封深冻结、幂等键与乐观锁口径由 business-core 校验）。
 *
 * 权限码（02-workorder.md §5 最小集）：
 *   POST /workorder/work-orders                     workorder:write   （创建）
 *   GET  /workorder/work-orders                     workorder:read    （列表 ?state=）
 *   GET  /workorder/work-orders/:id                 workorder:read    （详情）
 *   POST /workorder/work-orders/:id/update          workorder:write
 *   POST /workorder/work-orders/:id/transitions     workorder:transition
 *   POST /workorder/work-orders/:id/close           workorder:close
 *   POST /workorder/work-orders/:id/attachments     workorder:write   （图纸挂接）
 *   POST /workorder/work-orders/:id/kit-checks      kit:refresh       （齐套刷新）
 *   GET  /workorder/work-orders/:id/progress        workorder:read    （项目进度）
 *   GET  /workorder/work-orders/:id/machining-progress workorder:read （机加工进度）
 *   GET  /workorder/work-orders/:id/assembly-progress  workorder:read （装配调试进度）
 *   GET  /workorder/kit-board                       kit:read          （齐套看板）
 *   GET  /workorder/delivery-situation              workorder:read    （交付态势/工作台）
 *   POST /workorder/parts-requests                  parts:request
 *   GET  /workorder/parts-requests                  parts:read        （列表 ?state=&workOrderId=）
 *   GET  /workorder/parts-requests/:id              parts:read
 *   POST /workorder/parts-requests/:id/approval     parts:approve     （approve/reject）
 *   POST /workorder/parts-requests/:id/shipment     parts:request     （发货联动出库）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseCommandBodyForKind,
  parseIdParam,
  parseStateFilter,
  type WorkOrderCommand,
} from './workorder-input.js';
import type { WorkOrderCommandResult } from './workorder.service.js';
import { WorkOrderService } from './workorder.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<WorkOrderCommand> {
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

@Controller('workorder/work-orders')
export class WorkOrdersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly workOrder: WorkOrderService,
  ) {}

  @Get(':id/equipment')
  @RequirePermission('workorder:read')
  async equipment(@Param('id') id: string) { return { equipment: await this.workOrder.equipmentList(this.tenantContext.current(), parseIdParam(id, '工作令 id')) }; }

  @Post(':id/equipment')
  @RequirePermission('workorder:write')
  async defineEquipment(@Param('id') id: string, @Body() body: unknown) { return this.workOrder.defineEquipment(this.tenantContext.current(), parseIdParam(id, '工作令 id'), body); }

  @Post()
  @RequirePermission('workorder:write')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(envelopeOf(this.tenantContext, request, body, 'workorder.create.v1'));
  }

  @Get()
  @RequirePermission('workorder:read')
  async list(@Query('state') state?: string): Promise<{ orders: Awaited<ReturnType<WorkOrderService['list']>> }> {
    return { orders: await this.workOrder.list(this.tenantContext.current(), parseStateFilter(state)) };
  }

  @Get(':id')
  @RequirePermission('workorder:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<WorkOrderService['detail']>>> {
    return this.workOrder.detail(this.tenantContext.current(), parseIdParam(id, '工作令 id'));
  }

  @Post(':id/update')
  @RequirePermission('workorder:write')
  async update(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.update.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Post(':id/transitions')
  @RequirePermission('workorder:transition')
  async transition(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.transition.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Post(':id/close')
  @RequirePermission('workorder:close')
  async close(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.close.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Post(':id/attachments')
  @RequirePermission('workorder:write')
  async attach(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.attach.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Post(':id/kit-checks')
  @RequirePermission('kit:refresh')
  async refreshKit(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.kit.refresh.v1'),
      parseIdParam(id, '工作令 id'),
    );
  }

  @Get(':id/progress')
  @RequirePermission('workorder:read')
  async progress(@Param('id') id: string): Promise<Awaited<ReturnType<WorkOrderService['projectProgress']>>> {
    return this.workOrder.projectProgress(this.tenantContext.current(), parseIdParam(id, '工作令 id'));
  }

  @Get(':id/machining-progress')
  @RequirePermission('workorder:read')
  async machiningProgress(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<WorkOrderService['machiningProgress']>>> {
    return this.workOrder.machiningProgress(this.tenantContext.current(), parseIdParam(id, '工作令 id'));
  }

  @Get(':id/assembly-progress')
  @RequirePermission('workorder:read')
  async assemblyProgress(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<WorkOrderService['assemblyProgress']>>> {
    return this.workOrder.assemblyProgress(this.tenantContext.current(), parseIdParam(id, '工作令 id'));
  }
}

@Controller('workorder')
export class WorkOrderQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly workOrder: WorkOrderService,
  ) {}

  @Get('kit-board')
  @RequirePermission('kit:read')
  async kitBoard(): Promise<{ snapshots: Awaited<ReturnType<WorkOrderService['kitBoard']>> }> {
    return { snapshots: await this.workOrder.kitBoard(this.tenantContext.current()) };
  }

  @Get('delivery-situation')
  @RequirePermission('workorder:read')
  async deliverySituation(): Promise<Awaited<ReturnType<WorkOrderService['deliverySituation']>>> {
    return this.workOrder.deliverySituation(this.tenantContext.current());
  }
}

@Controller('workorder/parts-requests')
export class PartsRequestsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly workOrder: WorkOrderService,
  ) {}

  @Post()
  @RequirePermission('parts:request')
  async request(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.parts.request.v1'),
    );
  }

  @Get()
  @RequirePermission('parts:read')
  async list(
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
  ): Promise<{ partsRequests: Awaited<ReturnType<WorkOrderService['listParts']>> }> {
    return {
      partsRequests: await this.workOrder.listParts(
        this.tenantContext.current(),
        parseStateFilter(state),
        workOrderId === undefined ? undefined : parseIdParam(workOrderId, '工作令 id'),
      ),
    };
  }

  @Get(':id')
  @RequirePermission('parts:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<WorkOrderService['partsDetail']>>> {
    return this.workOrder.partsDetail(this.tenantContext.current(), parseIdParam(id, '配件申请 id'));
  }

  @Post(':id/approval')
  @RequirePermission('parts:approve')
  async approve(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.parts.approve.v1'),
      parseIdParam(id, '配件申请 id'),
    );
  }

  @Post(':id/shipment')
  @RequirePermission('parts:request')
  async ship(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkOrderCommandResult> {
    return this.workOrder.execute(
      envelopeOf(this.tenantContext, request, body, 'workorder.parts.ship.v1'),
      parseIdParam(id, '配件申请 id'),
    );
  }
}
