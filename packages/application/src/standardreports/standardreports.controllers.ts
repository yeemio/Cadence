/**
 * 标准报表路由（S1 backfill：0920 #89/#91/#92/#96）。
 *
 * 权限码：复用既有 'report:read'（reporting 模块报工查询同一资源词——报表
 * 中心读取面，ADR-0010 通用词三问同判；本模块无写面，不引入 report:write
 * 的新语义分裂）。
 *   GET  /standard-reports/metrics   report:read（口径清单）
 *   POST /standard-reports/query     report:read（求值：口径引用+时间窗+维度切片）
 *
 * 控制器零逻辑：解析输入 → 委托 StandardReportsService；租户一律取
 * TenantContext（ALS）当前值（ADR-0005）。出参 = engine-reporting 的
 * MetricResult（含口径溯源 metricId/version 与实际生效 timeBasis）。
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { StandardReportsService } from './standardreports.service.js';

@Controller('standard-reports')
export class StandardReportsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly reports: StandardReportsService,
  ) {}

  @Get('metrics')
  @RequirePermission('report:read')
  async listMetrics(): Promise<{
    packId: string;
    version: number;
    metrics: Awaited<ReturnType<StandardReportsService['listMetrics']>>;
  }> {
    return {
      packId: 'standard-reports',
      version: 1,
      metrics: this.reports.listMetrics(),
    };
  }

  @Post('query')
  @RequirePermission('report:read')
  async query(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<StandardReportsService['query']>>> {
    return this.reports.query(this.tenantContext.current(), body);
  }
}
