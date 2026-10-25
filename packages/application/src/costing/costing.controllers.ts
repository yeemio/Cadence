/**
 * costing 路由（M2-W6）。控制器零逻辑：租户取 TenantContext（ALS），操作者取
 * AuthGuard 的 REQUEST_USER_KEY（ADR-0005）。命令体经 parseCommandBodyForKind
 * 解析后组装 smes.command.v1 信封交 service.execute。
 *
 * 权限码（09-costing.md §5 最小集：costing:read|rebuild|model-manage；金额
 * 可见性是敏感权限，默认仅厂长/财务角色——casbin 策略层配置）：
 *   POST /costing/models                   costing:model-manage（口径发布）
 *   GET  /costing/models                   costing:read   （口径版本列表 ?code=）
 *   GET  /costing/models/:code             costing:read   （版本链详情）
 *   POST /costing/rebuild                  costing:rebuild（工作令×口径重算）
 *   POST /costing/export                   costing:read   （快照导出，ExcelPort）
 *   GET  /costing/work-orders/:id/summary  costing:read   （三分类汇总 ?modelCode=&modelVersion=）
 *   GET  /costing/work-orders/:id/details  costing:read   （构成明细下钻 ?category=）
 *   GET  /costing/work-orders/:id/snapshots costing:read  （快照版本回看）
 *   GET  /costing/models/compare           costing:read   （口径对比 ?workOrderId=&code=&a=&b=）
 *   GET  /costing/events                   costing:read   （事件审计读）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { CostingInputError } from './costing-errors.js';
import {
  parseCategoryFilter,
  parseCommandBodyForKind,
  parseIdParam,
  parseOptionalIdParam,
  parseOptionalIntParam,
  type CostingCommand,
} from './costing-input.js';
import type { CostingCommandResult } from './costing.service.js';
import { CostingService } from './costing.service.js';

function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
) {
  const parsed = parseCommandBodyForKind(body, expectedKind);
  return makeCommandEnvelope({
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: parsed.command as CostingCommand,
  });
}

@Controller('costing')
export class CostingModelsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly costing: CostingService,
  ) {}

  @Post('models')
  @RequirePermission('costing:model-manage')
  async publish(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<CostingCommandResult> {
    return this.costing.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'costing.model.publish.v1'));
  }

  @Get('models/compare')
  @RequirePermission('costing:read')
  async compare(
    @Query('workOrderId') workOrderId?: string,
    @Query('code') code?: string,
    @Query('a') a?: string,
    @Query('b') b?: string,
  ): Promise<{ comparison: Awaited<ReturnType<CostingService['compareModels']>> }> {
    if (workOrderId === undefined || workOrderId === '') {
      throw new CostingInputError('workOrderId 查询参数必填');
    }
    const modelCode = parseOptionalIdParam(code, 'code');
    if (modelCode === undefined) {
      throw new CostingInputError('code 查询参数必填（同码两版本对比）');
    }
    const versionA = parseOptionalIntParam(a, 'a');
    const versionB = parseOptionalIntParam(b, 'b');
    if (versionA === undefined || versionB === undefined) {
      throw new CostingInputError('a/b 查询参数必填（对比的两口径版本号）');
    }
    return {
      comparison: await this.costing.compareModels(
        this.tenantContext.current(),
        parseIdParam(workOrderId, 'workOrderId'),
        modelCode,
        versionA,
        versionB,
      ),
    };
  }

  @Get('models/:code')
  @RequirePermission('costing:read')
  async detail(@Param('code') code: string): Promise<{
    detail: Awaited<ReturnType<CostingService['modelDetail']>>;
  }> {
    return { detail: await this.costing.modelDetail(this.tenantContext.current(), parseIdParam(code, '口径码')) };
  }

  @Get('models')
  @RequirePermission('costing:read')
  async list(@Query('code') code?: string): Promise<{
    models: Awaited<ReturnType<CostingService['modelVersions']>>;
  }> {
    return { models: await this.costing.modelVersions(this.tenantContext.current(), parseOptionalIdParam(code, 'code')) };
  }
}

@Controller('costing')
export class CostingLedgerController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly costing: CostingService,
  ) {}

  @Post('rebuild')
  @RequirePermission('costing:rebuild')
  async rebuild(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<CostingCommandResult> {
    return this.costing.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'costing.rebuild.v1'));
  }

  @Post('export')
  @RequirePermission('costing:read')
  async export(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<CostingCommandResult> {
    return this.costing.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'costing.export.v1'));
  }

  @Get('work-orders/:id/summary')
  @RequirePermission('costing:read')
  async summary(
    @Param('id') id: string,
    @Query('modelCode') modelCode?: string,
    @Query('modelVersion') modelVersion?: string,
  ): Promise<{ summary: Awaited<ReturnType<CostingService['workOrderSummary']>> }> {
    const modelCodeFilter = parseOptionalIdParam(modelCode, 'modelCode');
    const modelVersionFilter = parseOptionalIntParam(modelVersion, 'modelVersion');
    return {
      summary: await this.costing.workOrderSummary(this.tenantContext.current(), parseIdParam(id, '工作令 id'), {
        ...(modelCodeFilter === undefined ? {} : { modelCode: modelCodeFilter }),
        ...(modelVersionFilter === undefined ? {} : { modelVersion: modelVersionFilter }),
      }),
    };
  }

  @Get('work-orders/:id/details')
  @RequirePermission('costing:read')
  async details(
    @Param('id') id: string,
    @Query('category') category?: string,
  ): Promise<{ entries: Awaited<ReturnType<CostingService['costDetail']>> }> {
    return {
      entries: await this.costing.costDetail(
        this.tenantContext.current(),
        parseIdParam(id, '工作令 id'),
        parseCategoryFilter(category),
      ),
    };
  }

  @Get('work-orders/:id/snapshots')
  @RequirePermission('costing:read')
  async snapshots(@Param('id') id: string): Promise<{
    snapshots: Awaited<ReturnType<CostingService['snapshots']>>;
  }> {
    return { snapshots: await this.costing.snapshots(this.tenantContext.current(), parseIdParam(id, '工作令 id')) };
  }

  @Get('events')
  @RequirePermission('costing:read')
  async events(): Promise<{ events: Awaited<ReturnType<CostingService['listEvents']>> }> {
    return { events: await this.costing.listEvents(this.tenantContext.current()) };
  }
}
