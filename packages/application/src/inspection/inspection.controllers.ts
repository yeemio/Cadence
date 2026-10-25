/**
 * inspection 路由（M2-W4）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute（信封深冻结、幂等键与乐观锁口径由 business-core 校验）。
 *
 * 权限码（06-inspection.md §5 最小集）：
 *   POST /inspection/orders                       inspection:judge（手工建单）
 *   GET  /inspection/orders                       inspection:read （队列 ?kind=&state=）
 *   GET  /inspection/orders/:id                   inspection:read （详情）
 *   POST /inspection/orders/:id/judgment          inspection:judge（合格/不合格数量）
 *   POST /inspection/orders/:id/recheck           inspection:judge（复检）
 *   GET  /inspection/summary                      inspection:read （汇总事实/工作台 KPI）
 *   POST /inspection/overdue-scans                inspection:judge（闭环超时点名）
 *   GET  /inspection/nonconformities              nonconform:read （明细 ?state=&inspectionId=）
 *   GET  /inspection/nonconformities/:id          nonconform:read （闭环追踪）
 *   POST /inspection/nonconformities/:id/disposal nonconform:dispose（处置+原因）
 *   POST /inspection/nonconformities/:id/close    nonconform:close （闭环）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseCommandBodyForKind,
  parseIdParam,
  parseInspectionIdFilter,
  parseKindFilter,
  parseStateFilter,
  type InspectionCommand,
} from './inspection-input.js';
import type { InspectionCommandResult } from './inspection.service.js';
import { InspectionService } from './inspection.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<InspectionCommand> {
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

@Controller('inspection/orders')
export class InspectionsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inspection: InspectionService,
  ) {}

  @Post()
  @RequirePermission('inspection:judge')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<InspectionCommandResult> {
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'inspection.create.v1'),
    );
  }

  @Get()
  @RequirePermission('inspection:read')
  async list(
    @Query('kind') kind?: string,
    @Query('state') state?: string,
  ): Promise<{ orders: Awaited<ReturnType<InspectionService['queue']>> }> {
    return {
      orders: await this.inspection.queue(this.tenantContext.current(), {
        kind: parseKindFilter(kind),
        state: parseStateFilter(state),
      }),
    };
  }

  @Get(':id')
  @RequirePermission('inspection:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<InspectionService['detail']>>> {
    return this.inspection.detail(this.tenantContext.current(), parseIdParam(id, '质检单 id'));
  }

  @Post(':id/judgment')
  @RequirePermission('inspection:judge')
  async judge(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InspectionCommandResult> {
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'inspection.judge.v1'),
      parseIdParam(id, '质检单 id'),
    );
  }

  @Post(':id/recheck')
  @RequirePermission('inspection:judge')
  async recheck(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InspectionCommandResult> {
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'inspection.recheck.v1'),
      parseIdParam(id, '质检单 id'),
    );
  }
}

@Controller('inspection')
export class InspectionQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inspection: InspectionService,
  ) {}

  @Get('summary')
  @RequirePermission('inspection:read')
  async summary(): Promise<Awaited<ReturnType<InspectionService['summary']>>> {
    return this.inspection.summary(this.tenantContext.current());
  }

  @Post('overdue-scans')
  @RequirePermission('inspection:judge')
  async scanOverdue(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InspectionCommandResult> {
    // 信封命令（体例同 listing 逾期扫描）：operationId 幂等账在 service 侧落，
    // 单级一次点名幂等（overdue-<单id>）不变；载荷为空对象。
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'inspection.overdue.scan.v1'),
    );
  }
}

@Controller('inspection/nonconformities')
export class NonconformitiesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly inspection: InspectionService,
  ) {}

  @Get()
  @RequirePermission('nonconform:read')
  async list(
    @Query('state') state?: string,
    @Query('inspectionId') inspectionId?: string,
  ): Promise<{ nonconforms: Awaited<ReturnType<InspectionService['nonconformList']>> }> {
    return {
      nonconforms: await this.inspection.nonconformList(this.tenantContext.current(), {
        state: parseStateFilter(state),
        inspectionId: parseInspectionIdFilter(inspectionId),
      }),
    };
  }

  @Get(':id')
  @RequirePermission('nonconform:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<InspectionService['nonconformDetail']>>> {
    return this.inspection.nonconformDetail(this.tenantContext.current(), parseIdParam(id, '不合格处置 id'));
  }

  @Post(':id/disposal')
  @RequirePermission('nonconform:dispose')
  async dispose(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InspectionCommandResult> {
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'nonconform.dispose.v1'),
      parseIdParam(id, '不合格处置 id'),
    );
  }

  @Post(':id/close')
  @RequirePermission('nonconform:close')
  async close(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<InspectionCommandResult> {
    return this.inspection.execute(
      envelopeOf(this.tenantContext, request, body, 'nonconform.close.v1'),
      parseIdParam(id, '不合格处置 id'),
    );
  }
}
