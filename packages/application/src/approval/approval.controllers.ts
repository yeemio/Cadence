/**
 * 审批路由（M1 收尾波-①）。控制器零逻辑：本人身份一律取 AuthGuard 写入
 * 请求的 REQUEST_USER_KEY（AuthGuard 经 Bearer 会话或 dev 头写入），租户取 TenantContext（ALS）——
 * 身份与租户都不从请求体进（ADR-0005）。
 *
 * 权限码（ADR-0010 通用词）：
 *   POST /approval/cases               approval:write（发起审批）
 *   GET  /approval/cases               approval:read（列表，?state= 精确过滤）
 *   GET  /approval/cases/:id           approval:read（案件 + 决策记录 + 迁移事件）
 *   POST /approval/cases/:id/decisions approval:write（approve/reject/escalate/withdraw）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  type AuthenticatedRequest,
} from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ApprovalService } from './approval.service.js';

@Controller('approval/cases')
export class ApprovalCasesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly approval: ApprovalService,
  ) {}

  @Post()
  @RequirePermission('approval:write')
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ApprovalService['start']>>> {
    return this.approval.start(this.tenantContext.current(), request[REQUEST_USER_KEY], body);
  }

  @Get()
  @RequirePermission('approval:read')
  async list(
    @Query('state') state?: string,
  ): Promise<{ cases: Awaited<ReturnType<ApprovalService['list']>> }> {
    return { cases: await this.approval.list(this.tenantContext.current(), state) };
  }

  @Get(':id')
  @RequirePermission('approval:read')
  async get(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<ApprovalService['get']>>> {
    return this.approval.get(this.tenantContext.current(), id);
  }

  @Post(':id/decisions')
  @RequirePermission('approval:write')
  async decide(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ApprovalService['act']>>> {
    return this.approval.act(this.tenantContext.current(), id, request[REQUEST_USER_KEY], body);
  }
}
