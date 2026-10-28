/**
 * ai-query 路由（CONTRACT v1 §Wire 合同）。控制器零逻辑：本人身份一律取
 * AuthGuard 写入请求的 REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份
 * 与租户都不从请求体进（ADR-0005，先例 reporting.controllers.ts）。
 *
 * 权限码（端点级统一 ai-query:read；域码由能力执行前经 PermissionResolver
 * 逐码复核，缺码走回答通道 denied 而非 403）：
 *   GET  /ai-query/capabilities        ai-query:read （能力目录）
 *   POST /ai-query/ask                 ai-query:read （问数：AskResponse 五态）
 *   GET  /ai-query/sessions            ai-query:read （本人会话列表 ?limit=50）
 *   GET  /ai-query/sessions/:id        ai-query:read （会话线程；跨用户读 404）
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  AI_QUERY_SESSION_LIMIT_DEFAULT,
  parseAskBody,
  parseSessionIdParam,
  parseSessionLimit,
} from './ai-query-input.js';
import type { AskResponse } from './ai-query-ports.js';
import { AiQueryService } from './ai-query.service.js';

@Controller('ai-query')
export class AiQueryController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly aiQuery: AiQueryService,
  ) {}

  @Get('capabilities')
  @RequirePermission('ai-query:read')
  capabilities(): { items: ReturnType<AiQueryService['capabilities']> } {
    return { items: this.aiQuery.capabilities() };
  }

  @Post('ask')
  @HttpCode(200) // 合同冻结：POST ask → 200（Nest 缺省 201；denied 走 200 回答通道）
  @RequirePermission('ai-query:read')
  async ask(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<AskResponse> {
    return this.aiQuery.ask(this.tenantContext.current(), request[REQUEST_USER_KEY], parseAskBody(body));
  }
}

@Controller('ai-query/sessions')
export class AiQuerySessionsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly aiQuery: AiQueryService,
  ) {}

  @Get()
  @RequirePermission('ai-query:read')
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<{ items: Awaited<ReturnType<AiQueryService['listSessions']>> }> {
    return {
      items: await this.aiQuery.listSessions(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
        parseSessionLimit(limit) ?? AI_QUERY_SESSION_LIMIT_DEFAULT,
      ),
    };
  }

  @Get(':id')
  @RequirePermission('ai-query:read')
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<ReturnType<AiQueryService['sessionDetail']>> {
    return this.aiQuery.sessionDetail(this.tenantContext.current(), request[REQUEST_USER_KEY], parseSessionIdParam(id));
  }
}
