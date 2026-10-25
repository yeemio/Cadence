/**
 * U7 项目成本路由（控制器零逻辑，体例同 costing.controllers：租户取
 * TenantContext，操作者取 AuthGuard；命令体经 parseProjectCommandBodyForKind
 * 解析后组装 smes.command.v1 信封交 ProjectCostService.execute）。
 *
 * 权限码（沿 costing 既有最小集；录入价格 = 写型命令复用 costing:rebuild，
 * 独立价格权限码归后续 casbin 策略面）：
 *   POST /costing/project/rebuild          costing:rebuild（六块重算跑批）
 *   GET  /costing/project/summary          costing:read  （实时六块汇总 ?modelCode=&modelVersion=）
 *   GET  /costing/project/detail           costing:read  （快照详情 + KPI；无快照 404 语义）
 *   GET  /costing/project/snapshots        costing:read  （快照版本链回看）
 *   GET  /costing/project/entries          costing:read  （段事实下钻 ?block=&segment=）
 *   POST /costing/price-entry              costing:rebuild（录入价格）
 *   GET  /costing/price-entries            costing:read  （录入价格读面）
 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { CostingInputError } from './costing-errors.js';
import { parseIdParam, parseOptionalIdParam, parseOptionalIntParam } from './costing-input.js';
import {
  parseProjectCommandBodyForKind,
  type ProjectCostCommand,
  type ProjectCostCommandKind,
} from './project-cost-input.js';
import type { ProjectCostCommandResult } from './project-cost.service.js';
import { ProjectCostService } from './project-cost.service.js';
import type { ProjectCostBlock, ProjectCostSegment } from './project-cost-model.js';
import { PROJECT_COST_BLOCKS, PROJECT_COST_SEGMENTS } from './project-cost-model.js';

function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: ProjectCostCommandKind,
) {
  const parsed = parseProjectCommandBodyForKind(body, expectedKind);
  return makeCommandEnvelope({
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: parsed.command as ProjectCostCommand,
  });
}

function modelSelector(modelCode?: string, modelVersion?: string) {
  const code = parseOptionalIdParam(modelCode, 'modelCode');
  const version = parseOptionalIntParam(modelVersion, 'modelVersion');
  return {
    ...(code === undefined ? {} : { modelCode: code }),
    ...(version === undefined ? {} : { modelVersion: version }),
  };
}

@Controller('costing')
export class ProjectCostController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly projectCost: ProjectCostService,
  ) {}

  @Post('project/rebuild')
  @RequirePermission('costing:rebuild')
  async rebuild(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ProjectCostCommandResult> {
    return this.projectCost.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'costing.project.rebuild.v1'));
  }

  @Get('project/summary')
  @RequirePermission('costing:read')
  async summary(
    @Query('workOrderId') workOrderId?: string,
    @Query('modelCode') modelCode?: string,
    @Query('modelVersion') modelVersion?: string,
  ): Promise<{ summary: Awaited<ReturnType<ProjectCostService['projectSummary']>> }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    return {
      summary: await this.projectCost.projectSummary(this.tenantContext.current(), parseIdParam(workOrderId, 'workOrderId'), modelSelector(modelCode, modelVersion)),
    };
  }

  @Get('project/detail')
  @RequirePermission('costing:read')
  async detail(
    @Query('workOrderId') workOrderId?: string,
    @Query('modelCode') modelCode?: string,
    @Query('modelVersion') modelVersion?: string,
  ): Promise<{ detail: Awaited<ReturnType<ProjectCostService['projectDetail']>> }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    return {
      detail: await this.projectCost.projectDetail(this.tenantContext.current(), parseIdParam(workOrderId, 'workOrderId'), modelSelector(modelCode, modelVersion)),
    };
  }

  @Get('project/snapshots')
  @RequirePermission('costing:read')
  async snapshots(@Query('workOrderId') workOrderId?: string): Promise<{
    snapshots: Awaited<ReturnType<ProjectCostService['projectSnapshots']>>;
  }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    return { snapshots: await this.projectCost.projectSnapshots(this.tenantContext.current(), parseIdParam(workOrderId, 'workOrderId')) };
  }

  @Get('project/entries')
  @RequirePermission('costing:read')
  async entries(
    @Query('workOrderId') workOrderId?: string,
    @Query('block') block?: string,
    @Query('segment') segment?: string,
  ): Promise<{ entries: Awaited<ReturnType<ProjectCostService['projectEntries']>> }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    const blockFilter = block === undefined || block === '' ? undefined : block;
    if (blockFilter !== undefined && !(PROJECT_COST_BLOCKS as readonly string[]).includes(blockFilter)) {
      throw new CostingInputError(`block 非法：须为 ${PROJECT_COST_BLOCKS.join('/')} 之一，得到 ${JSON.stringify(blockFilter)}`);
    }
    const segmentFilter = segment === undefined || segment === '' ? undefined : segment;
    if (segmentFilter !== undefined && !(PROJECT_COST_SEGMENTS as readonly string[]).includes(segmentFilter)) {
      throw new CostingInputError(`segment 非法：须为 ${PROJECT_COST_SEGMENTS.join('/')} 之一，得到 ${JSON.stringify(segmentFilter)}`);
    }
    return {
      entries: await this.projectCost.projectEntries(this.tenantContext.current(), parseIdParam(workOrderId, 'workOrderId'), {
        ...(blockFilter === undefined ? {} : { block: blockFilter as ProjectCostBlock }),
        ...(segmentFilter === undefined ? {} : { segment: segmentFilter as ProjectCostSegment }),
      }),
    };
  }

  @Post('price-entry')
  @RequirePermission('costing:rebuild')
  async priceEntry(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ProjectCostCommandResult> {
    return this.projectCost.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'costing.price.entry.v1'));
  }

  @Get('price-entries')
  @RequirePermission('costing:read')
  async priceEntries(@Query('workOrderId') workOrderId?: string): Promise<{
    entries: Awaited<ReturnType<ProjectCostService['priceEntries']>>;
  }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    return { entries: await this.projectCost.priceEntries(this.tenantContext.current(), parseIdParam(workOrderId, 'workOrderId')) };
  }
}
