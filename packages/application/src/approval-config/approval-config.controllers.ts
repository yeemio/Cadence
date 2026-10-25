/**
 * 审批配置路由（T 波 #102，approval 域）。控制器零逻辑：解析输入 → 委托
 * ApprovalConfigService；租户一律取 TenantContext（ALS）当前值（ADR-0005：
 * 租户身份不从请求体进）。
 *
 * 权限码（ADR-0010 通用词，approval-config 为"审批配置"环节的通用合成词）：
 *   GET  /approval-config/flows           approval-config:read
 *   POST /approval-config/flows           approval-config:write
 *   GET  /approval-config/flows/:id       approval-config:read
 *   PUT  /approval-config/flows/:id       approval-config:write（期望态更新）
 *   POST /approval-config/flows/:id/activate approval-config:write（启用指定流，
 *                                        租户内单启用收口）
 *   POST /approval-config/validate        approval-config:write（试写预检——
 *                                        校验是写前探测，按写面收权）
 */
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ApprovalConfigService } from './approval-config.service.js';

@Controller('approval-config')
export class ApprovalConfigController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly approvalConfig: ApprovalConfigService,
  ) {}

  @Get('flows')
  @RequirePermission('approval-config:read')
  async list(): Promise<{ flows: Awaited<ReturnType<ApprovalConfigService['listFlows']>> }> {
    return { flows: await this.approvalConfig.listFlows(this.tenantContext.current()) };
  }

  @Post('flows')
  @RequirePermission('approval-config:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ApprovalConfigService['createFlow']>>> {
    return this.approvalConfig.createFlow(this.tenantContext.current(), body);
  }

  @Get('flows/:id')
  @RequirePermission('approval-config:read')
  async get(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<ApprovalConfigService['getFlow']>>> {
    return this.approvalConfig.getFlow(this.tenantContext.current(), id);
  }

  @Put('flows/:id')
  @RequirePermission('approval-config:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ApprovalConfigService['updateFlow']>>> {
    return this.approvalConfig.updateFlow(this.tenantContext.current(), id, body);
  }

  @Post('flows/:id/activate')
  @RequirePermission('approval-config:write')
  async activate(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<ApprovalConfigService['activateFlow']>>> {
    return this.approvalConfig.activateFlow(this.tenantContext.current(), id);
  }

  @Post('validate')
  @RequirePermission('approval-config:write')
  async validate(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ApprovalConfigService['validateFlow']>>> {
    return this.approvalConfig.validateFlow(body);
  }
}
