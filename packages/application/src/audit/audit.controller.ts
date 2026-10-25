/**
 * 操作日志查询路由（S1 backfill：0920 #103）。
 *
 * 权限码（ADR-0010 通用词三问：audit 是跨行业通用审计词，无行业专属替代，
 * 只读查询面恒 read——本模块没有用户可发起的写操作，无 audit:write）：
 *   GET /audit/logs   audit:read
 *
 * 控制器零逻辑：解析查询串 → 委托 AuditService；租户一律取 TenantContext
 * （ALS）当前值（ADR-0005）。自身只读——拦截器对 /audit/* 路径一律跳过
 * （防递归是双保险：本模块无写端点，跳过规则见 audit-write.interceptor.ts）。
 */
import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { parseAuditQueryInput } from './audit-input.js';
import { AuditService } from './audit.service.js';

@Controller('audit/logs')
export class AuditController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('audit:read')
  async list(
    @Query() query: URLSearchParams | Record<string, string | undefined>,
  ): Promise<{ logs: Awaited<ReturnType<AuditService['query']>> }> {
    const parsed = parseAuditQueryInput(query);
    return { logs: await this.audit.query({ tenant: this.tenantContext.current(), ...parsed }) };
  }
}
