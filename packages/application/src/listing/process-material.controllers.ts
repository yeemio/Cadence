/**
 * listing 工序×原材料关联路由（U4）。控制器零逻辑：本人身份取 AuthGuard
 * 写入请求的 REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都
 * 不从请求体进（ADR-0005）。命令体经 parseProcessMaterialBodyForKind 解析后
 * 组装 smes.command.v1 信封交 ProcessMaterialService.execute。
 *
 * 权限码（复用 03-listing.md §5 最小集，不新增码）：
 *   POST /listing/process-materials/replace   listing:write（整表替换关联行集）
 *   GET  /listing/process-materials           listing:read （?listingLineId= 必填；
 *                                                          ?processId= 可选过滤；
 *                                                          空串参数按未传归一）
 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ListingInputError } from './listing-errors.js';
import { parseProcessMaterialBodyForKind } from './process-material-input.js';
import type { ProcessMaterialCommandResult } from './process-material.service.js';
import { ProcessMaterialService } from './process-material.service.js';

@Controller('listing/process-materials')
export class ProcessMaterialsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly materials: ProcessMaterialService,
  ) {}

  @Post('replace')
  @RequirePermission('listing:write')
  async replace(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ProcessMaterialCommandResult> {
    const parsed = parseProcessMaterialBodyForKind(body, 'listing.process-material.replace.v1');
    return this.materials.execute(
      makeCommandEnvelope({
        tenantId: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
        operationId: parsed.operationId,
        expectedRevision: parsed.expectedRevision,
        issuedAt: new Date().toISOString(),
        command: parsed.command,
      }),
    );
  }

  /** 关联行集查询（下单弹窗回填 / A5 项目成本取数面）。 */
  @Get()
  @RequirePermission('listing:read')
  async list(
    @Query('listingLineId') listingLineId?: string,
    @Query('processId') processId?: string,
  ): Promise<{ materials: Awaited<ReturnType<ProcessMaterialService['listByLine']>> }> {
    const line = listingLineId === '' ? undefined : listingLineId;
    if (line === undefined) {
      throw new ListingInputError('listingLineId 查询参数必填（零件清单行 id）');
    }
    const process = processId === '' ? undefined : processId;
    return {
      materials:
        process === undefined
          ? await this.materials.listByLine(this.tenantContext.current(), line)
          : await this.materials.listByProcess(this.tenantContext.current(), line, process),
    };
  }
}
