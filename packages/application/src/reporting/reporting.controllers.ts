/**
 * reporting 路由（M2-W7）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute；申报人 = 命令签发人（submit 按本人，载荷不带 reporter）。
 *
 * 权限码（05-reporting.md §5 最小集：report:read|submit|audit|verify|revoke）：
 *   POST /reports                              report:submit （五类申报，单人单工序）
 *   POST /reports/batch                        report:submit （批量申报，上限配置化）
 *   GET  /reports                              report:read   （?kind=&state=&dispatchId=&reporter=&drawingNo=）
 *   GET  /reports/mine                         report:read   （我的报工——本人双键）
 *   GET  /reports/pending-verification         report:read   （待核查队列）
 *   GET  /reports/:id                          report:read   （详情：修正链+留痕+里程碑）
 *   POST /reports/:id/audit-edit               report:audit  （修正版+原因，不改原单）
 *   POST /reports/:id/verify                   report:verify （核查→ReportVerified）
 *   POST /reports/:id/revoke                   report:revoke （撤销→ReportRevoked）
 *   GET  /reporting/drawings/:drawingNo/operation-progress
 *                                               report:read  （图号×工序进度）
 *   GET  /reporting/output-trend               report:read   （产出趋势 ?days=12）
 *
 * 具名路由（mine/pending-verification）声明在参数路由 :id 之前——Nest 按声明
 * 顺序匹配。
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseCommandBodyForKind,
  parseDispatchFilter,
  parseDrawingFilter,
  parseIdParam,
  parseKindFilter,
  parseReporterFilter,
  parseStateFilter,
  parseTrendDaysFilter,
  type ReportCommand,
} from './reporting-input.js';
import type { ReportCommandResult } from './reporting.service.js';
import { ReportingService } from './reporting.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseCommandBodyForKind>[1],
): CommandEnvelope<ReportCommand> {
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

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly reporting: ReportingService,
  ) {}

  @Post()
  @RequirePermission('report:submit')
  async submit(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ReportCommandResult> {
    return this.reporting.execute(envelopeOf(this.tenantContext, request, body, 'report.submit.v1'));
  }

  @Post('batch')
  @RequirePermission('report:submit')
  async submitBatch(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ReportCommandResult> {
    return this.reporting.execute(envelopeOf(this.tenantContext, request, body, 'report.submit-batch.v1'));
  }

  @Get()
  @RequirePermission('report:read')
  async list(
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('dispatchId') dispatchId?: string,
    @Query('reporter') reporter?: string,
    @Query('drawingNo') drawingNo?: string,
  ): Promise<{ reports: Awaited<ReturnType<ReportingService['listReports']>> }> {
    return {
      reports: await this.reporting.listReports(this.tenantContext.current(), {
        ...(parseKindFilter(kind) === undefined ? {} : { kind: parseKindFilter(kind) }),
        ...(parseStateFilter(state) === undefined ? {} : { state: parseStateFilter(state) }),
        ...(parseDispatchFilter(dispatchId) === undefined
          ? {}
          : { dispatchId: parseDispatchFilter(dispatchId) }),
        ...(parseReporterFilter(reporter) === undefined ? {} : { reporter: parseReporterFilter(reporter) }),
        ...(parseDrawingFilter(drawingNo) === undefined ? {} : { drawingNo: parseDrawingFilter(drawingNo) }),
      }),
    };
  }

  @Get('mine')
  @RequirePermission('report:read')
  async mine(@Req() request: AuthenticatedRequest): Promise<{
    reports: Awaited<ReturnType<ReportingService['myReports']>>;
  }> {
    // 我的报工：本人双键 (tenant, reporter)——"仅本人完成"数据权限边界。
    return { reports: await this.reporting.myReports(this.tenantContext.current(), request[REQUEST_USER_KEY]) };
  }

  @Get('pending-verification')
  @RequirePermission('report:read')
  async pendingVerification(): Promise<{
    reports: Awaited<ReturnType<ReportingService['pendingVerificationQueue']>>;
  }> {
    return { reports: await this.reporting.pendingVerificationQueue(this.tenantContext.current()) };
  }

  @Get(':id')
  @RequirePermission('report:read')
  async get(@Param('id') id: string): Promise<Awaited<ReturnType<ReportingService['reportDetail']>>> {
    return this.reporting.reportDetail(this.tenantContext.current(), parseIdParam(id, '报工单 id'));
  }

  @Post(':id/audit-edit')
  @RequirePermission('report:audit')
  async auditEdit(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ReportCommandResult> {
    return this.reporting.execute(
      envelopeOf(this.tenantContext, request, body, 'report.audit-edit.v1'),
      parseIdParam(id, '报工单 id'),
    );
  }

  @Post(':id/verify')
  @RequirePermission('report:verify')
  async verify(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ReportCommandResult> {
    return this.reporting.execute(
      envelopeOf(this.tenantContext, request, body, 'report.verify.v1'),
      parseIdParam(id, '报工单 id'),
    );
  }

  @Post(':id/revoke')
  @RequirePermission('report:revoke')
  async revoke(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ReportCommandResult> {
    return this.reporting.execute(
      envelopeOf(this.tenantContext, request, body, 'report.revoke.v1'),
      parseIdParam(id, '报工单 id'),
    );
  }
}

@Controller('reporting')
export class ReportingQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly reporting: ReportingService,
  ) {}

  @Get('drawings/:drawingNo/operation-progress')
  @RequirePermission('report:read')
  async drawingProgress(@Param('drawingNo') drawingNo: string): Promise<{
    rows: Awaited<ReturnType<ReportingService['drawingOperationProgress']>>;
  }> {
    return {
      rows: await this.reporting.drawingOperationProgress(
        this.tenantContext.current(),
        parseIdParam(drawingNo, '图号 drawingNo'),
      ),
    };
  }

  @Get('output-trend')
  @RequirePermission('report:read')
  async outputTrend(@Query('days') days?: string): Promise<{
    trend: Awaited<ReturnType<ReportingService['outputTrend']>>;
  }> {
    // 缺省 12 日窗口——合同"12 日均"口径；service 侧另有 1~366 夹取。
    const parsed = parseTrendDaysFilter(days) ?? 12;
    return { trend: await this.reporting.outputTrend(this.tenantContext.current(), parsed) };
  }
}
