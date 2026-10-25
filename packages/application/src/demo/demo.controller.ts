/**
 * demo 模块的路由存在性证据端点：模块装配时 GET /demo/ping 200，
 * 停用后 404 —— 用于验收"注册表 feature flag 真实生效"（ADR-0004）。
 *
 * M1 增量 2-B 增：GET /demo/data —— 受保护示例端点（@RequirePermission('demo:read')，
 * 通用权限码形状 <环节>:<动作>，ADR-0010）。身份/租户读回用于验收守卫与
 * TenantContext（ALS）协同；判定逻辑零本地实现（AuthGuard + PermissionService）。
 */
import { Controller, Get, Req } from '@nestjs/common';
import type { TenantId, UserId } from '@smes/business-core';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import {
  REQUEST_USER_KEY,
  type AuthenticatedRequest,
} from '../core/auth/request-user.js';
import { TenantContext } from '../core/tenant-context.js';

@Controller('demo')
export class DemoController {
  constructor(private readonly tenantContext: TenantContext) {}

  @Get('ping')
  ping(): { module: string; pong: boolean } {
    return { module: 'demo', pong: true };
  }

  @Get('data')
  @RequirePermission('demo:read')
  data(
    @Req() request: AuthenticatedRequest,
  ): { module: string; permission: string; tenant: TenantId; user: UserId } {
    return {
      module: 'demo',
      permission: 'demo:read',
      tenant: this.tenantContext.current(),
      user: request[REQUEST_USER_KEY],
    };
  }
}
