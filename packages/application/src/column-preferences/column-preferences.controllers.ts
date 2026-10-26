/**
 * 列显隐偏好路由（fix-wave-6 6b-3，A14 / RREQ-INT-032）。控制器零逻辑：
 * 身份一律取 AuthGuard 写入请求的 REQUEST_USER_KEY（userId 不从请求体进——
 * PRD"忽略请求体 userId"在入口收口），租户取 TenantContext（ALS）。
 *
 * 权限（RREQ-INT-032：无独立权限码，登录即可用——本人本人的偏好数据）：
 *   GET /column-preferences?page=<code>   @RequireLogin（整页表格偏好一次拉取）
 *   PUT /column-preferences               @RequireLogin（幂等 upsert，空数组=显式全显示）
 */
import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequireLogin } from '../core/auth/require-login.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { ColumnPreferenceService } from './column-preferences.service.js';

@Controller('column-preferences')
export class ColumnPreferenceController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly preferences: ColumnPreferenceService,
  ) {}

  @Get()
  @RequireLogin()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('page') page: string | undefined,
  ): Promise<ReturnType<ColumnPreferenceService['listForPage']>> {
    return this.preferences.listForPage(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
      // page 缺失由输入层统一拒绝；URLSearchParams 以键值对构造——@Query 已
      // 解码，不再二次编码（值含 &/= 等字符不截断）
      new URLSearchParams([['page', page ?? '']]),
    );
  }

  @Put()
  @RequireLogin()
  async save(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ hiddenProps: Awaited<ReturnType<ColumnPreferenceService['save']>>['hiddenProps'] }> {
    const saved = await this.preferences.save(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
      body,
    );
    return { hiddenProps: saved.hiddenProps };
  }
}
