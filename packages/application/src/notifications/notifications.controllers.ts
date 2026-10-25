/**
 * 通知中心路由（T 波 #101）。控制器零逻辑：本人身份一律取 AuthGuard 写入
 * 请求的 REQUEST_USER_KEY（AuthGuard 经 Bearer 会话或 dev 头写入），租户取
 * TenantContext（ALS）——身份与租户都不从请求体/查询串进（ADR-0005）。
 *
 * 权限码（ADR-0010 通用词）：
 *   GET  /notifications                 notification:read（本人收件箱，数据级过滤）
 *   GET  /notifications/unread-count    notification:read
 *   POST /notifications/:id/read        notification:write（且仅本人可标记）
 *   POST /notifications/read-all        notification:write（仅本人）
 *   POST /notifications                 notification:write（发布：为指定 recipient 代发，
 *                                       事件点发布钩子接线归合流，本端点服务联调/运维补发）
 */
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  type AuthenticatedRequest,
} from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { NotificationService } from './notifications.service.js';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly notifications: NotificationService,
  ) {}

  @Get()
  @RequirePermission('notification:read')
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ notifications: Awaited<ReturnType<NotificationService['listOwn']>> }> {
    return {
      notifications: await this.notifications.listOwn(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
      ),
    };
  }

  @Get('unread-count')
  @RequirePermission('notification:read')
  async unreadCount(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ count: number }> {
    return {
      count: await this.notifications.countUnread(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
      ),
    };
  }

  @Post(':id/read')
  @RequirePermission('notification:write')
  async markRead(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Awaited<ReturnType<NotificationService['markRead']>>> {
    return this.notifications.markRead(this.tenantContext.current(), request[REQUEST_USER_KEY], id);
  }

  @Post('read-all')
  @RequirePermission('notification:write')
  async markAllRead(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ updated: number }> {
    return {
      updated: await this.notifications.markAllRead(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
      ),
    };
  }

  @Post()
  @RequirePermission('notification:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<NotificationService['create']>>> {
    return this.notifications.create(this.tenantContext.current(), body);
  }
}
