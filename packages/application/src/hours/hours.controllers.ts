/**
 * hours 路由（M2-W6）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute。
 *
 * 权限码（08-hours.md §5 最小集：hours:read|rebuild，read 按数据权限本人 vs
 * 全部——"我的工时"只取本人身份，不收 workerId 查询参数）：
 *   POST /hours/ingest                    hours:rebuild（联动消费系统触发面）
 *   POST /hours/rebuild-month             hours:rebuild（月×工种重算）
 *   GET  /hours/machining/stats           hours:read   （机加工时统计 ?workOrderId=&from=&to=）
 *   GET  /hours/months/:month/summary     hours:read   （工时汇总，实时净额）
 *   GET  /hours/months/:month/details     hours:read   （汇总下钻明细 ?workerId=&trade=）
 *   GET  /hours/months/:month/ledgers     hours:read   （重算快照当前版 ?workerId=）
 *   GET  /hours/my                        hours:read   （我的工时，本人 ?month=）
 *   GET  /hours/work-orders/:id           hours:read   （按工作令工时视图）
 *   GET  /hours/entries/:id               hours:read   （条目下钻）
 *   GET  /hours/events                    hours:read   （事件审计读）
 *
 * hours.adjust-entry.v1 为联动命令（随报工修正/撤销，由 reporting 合流侧经
 * service.execute 直调）——不设 HTTP 路由（合同 §3"不开放手改"）。
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseCommandBodyForKind,
  parseDateRange,
  parseIdParam,
  parseMonthParam,
  parseOptionalIdParam,
  requireTrade,
  type HoursCommand,
} from './hours-input.js';
import type { HoursCommandResult } from './hours.service.js';
import { HoursService } from './hours.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
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
    command: parsed.command as HoursCommand,
  });
}

@Controller('hours')
export class HoursLedgerController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly hours: HoursService,
  ) {}

  @Post('ingest')
  @RequirePermission('hours:rebuild')
  async ingest(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<HoursCommandResult> {
    return this.hours.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'hours.ingest.v1'));
  }

  @Post('rebuild-month')
  @RequirePermission('hours:rebuild')
  async rebuildMonth(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<HoursCommandResult> {
    return this.hours.execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, body, 'hours.rebuild-month.v1'));
  }

  @Get('machining/stats')
  @RequirePermission('hours:read')
  async machiningStats(
    @Query('workOrderId') workOrderId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ stats: Awaited<ReturnType<HoursService['machiningStats']>> }> {
    const range = parseDateRange(from, to);
    return {
      stats: await this.hours.machiningStats(this.tenantContext.current(), {
        ...(workOrderId === undefined || workOrderId === '' ? {} : { workOrderId: parseIdParam(workOrderId, 'workOrderId') }),
        ...range,
      }),
    };
  }

  @Get('months/:month/summary')
  @RequirePermission('hours:read')
  async monthSummary(@Param('month') month: string): Promise<{
    summary: Awaited<ReturnType<HoursService['monthSummary']>>;
  }> {
    return { summary: await this.hours.monthSummary(this.tenantContext.current(), parseMonthParam(month, 'month 路径参数')) };
  }

  @Get('months/:month/details')
  @RequirePermission('hours:read')
  async monthDetail(
    @Param('month') month: string,
    @Query('workerId') workerId?: string,
    @Query('trade') trade?: string,
  ): Promise<{ entries: Awaited<ReturnType<HoursService['monthDetail']>> }> {
    return {
      entries: await this.hours.monthDetail(
        this.tenantContext.current(),
        parseMonthParam(month, 'month 路径参数'),
        parseOptionalIdParam(workerId, 'workerId'),
        trade === undefined || trade === '' ? undefined : requireTrade(trade, 'trade'),
      ),
    };
  }

  @Get('months/:month/ledgers')
  @RequirePermission('hours:read')
  async monthLedgers(
    @Param('month') month: string,
    @Query('workerId') workerId?: string,
  ): Promise<{ ledgers: Awaited<ReturnType<HoursService['monthLedgers']>> }> {
    return {
      ledgers: await this.hours.monthLedgers(
        this.tenantContext.current(),
        parseMonthParam(month, 'month 路径参数'),
        parseOptionalIdParam(workerId, 'workerId'),
      ),
    };
  }

  @Get('my')
  @RequirePermission('hours:read')
  async myHours(
    @Req() request: AuthenticatedRequest,
    @Query('month') month?: string,
  ): Promise<{ my: Awaited<ReturnType<HoursService['myHours']>> }> {
    return {
      my: await this.hours.myHours(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
        parseOptionalIdParam(month, 'month'),
      ),
    };
  }

  @Get('work-orders/:id')
  @RequirePermission('hours:read')
  async workOrderHours(@Param('id') id: string): Promise<{
    view: Awaited<ReturnType<HoursService['workOrderHours']>>;
  }> {
    return { view: await this.hours.workOrderHours(this.tenantContext.current(), parseIdParam(id, '工作令 id')) };
  }

  @Get('entries/:id')
  @RequirePermission('hours:read')
  async entry(@Param('id') id: string): Promise<{ entry: Awaited<ReturnType<HoursService['entry']>> }> {
    return { entry: await this.hours.entry(this.tenantContext.current(), parseIdParam(id, '工时条目 id')) };
  }

  @Get('events')
  @RequirePermission('hours:read')
  async events(): Promise<{ events: Awaited<ReturnType<HoursService['listEvents']>> }> {
    return { events: await this.hours.listEvents(this.tenantContext.current()) };
  }
}
