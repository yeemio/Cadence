/**
 * 报表中心路由（功能补齐第一波：A1/A2/A4/A6/A7——r2/r7/r9/r12/r13）。
 *
 * 权限码：复用 'report:read'（本面是 standardreports 服务面的第六张报表
 * 扩展——r9 口径 description 冻结的「随标准版交付形态（standardreports 服务
 * 面）」；同资源词不分裂新码，ADR-0010 通用词三问同判。metric-pack 激活价
 * 售卖面另持 metric-pack:read，两呈现面并存）。
 *   GET  /report-center/metrics   report:read（口径清单）
 *   POST /report-center/query     report:read（求值：口径引用+时间窗+维度切片
 *                                 +查询期 filter——r2 双日期范围承载面）
 *
 * 控制器零逻辑：解析输入 → 委托 ReportCenterReportsService；出参 = engine-
 * reporting 的 MetricResult（自描述：口径溯源 + dimensionFields + measureIds，
 * 页面列结构按响应实态生成）。
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ReportCenterReportsService } from './report-center.service.js';

@Controller('report-center')
export class ReportCenterController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly reports: ReportCenterReportsService,
  ) {}

  @Get('metrics')
  @RequirePermission('report:read')
  async listMetrics(): Promise<{
    packId: string;
    version: number;
    metrics: Awaited<ReturnType<ReportCenterReportsService['listMetrics']>>;
  }> {
    const metrics = this.reports.listMetrics();
    return { packId: 'report-center', version: 3, metrics };
  }

  @Post('query')
  @RequirePermission('report:read')
  async query(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<ReportCenterReportsService['query']>>> {
    return this.reports.query(this.tenantContext.current(), body);
  }
}
