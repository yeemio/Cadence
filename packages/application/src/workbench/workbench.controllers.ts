/**
 * 工作台路由（M1 增量 4-I）。控制器零逻辑：本人身份一律取 AuthGuard 写入
 * 请求的 REQUEST_USER_KEY（AuthGuard 经 Bearer 会话或 dev 头写入），租户取 TenantContext（ALS）——
 * 身份与租户都不从请求体进（ADR-0005）。
 *
 * 权限码（ADR-0010 通用词）：
 *   GET  /workbench/summary          workbench:read（本人 open 计数按 source 分组）
 *   GET  /workbench/todos            workbench:read（仅本人，数据级过滤）
 *   POST /workbench/todos            todo:write（为指定 assignee 创建）
 *   POST /workbench/todos/:id/done   todo:write（且仅本人可完成——用例层数据级过滤）
 */
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  type AuthenticatedRequest,
} from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { WorkbenchService } from './workbench.service.js';

@Controller('workbench')
export class WorkbenchController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly workbench: WorkbenchService,
  ) {}

  @Get('summary')
  @RequirePermission('workbench:read')
  async summary(
    @Req() request: AuthenticatedRequest,
  ): Promise<Awaited<ReturnType<WorkbenchService['summary']>>> {
    return this.workbench.summary(this.tenantContext.current(), request[REQUEST_USER_KEY]);
  }

  @Get('todos')
  @RequirePermission('workbench:read')
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ todos: Awaited<ReturnType<WorkbenchService['listOwnTodos']>> }> {
    return {
      todos: await this.workbench.listOwnTodos(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
      ),
    };
  }

  @Post('todos')
  @RequirePermission('todo:write')
  async create(@Body() body: unknown): Promise<Awaited<ReturnType<WorkbenchService['createTodo']>>> {
    return this.workbench.createTodo(this.tenantContext.current(), body);
  }

  @Post('todos/:id/done')
  @RequirePermission('todo:write')
  async done(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Awaited<ReturnType<WorkbenchService['completeOwn']>>> {
    return this.workbench.completeOwn(this.tenantContext.current(), request[REQUEST_USER_KEY], id);
  }
}
