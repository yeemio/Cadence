/**
 * issue 路由（U1）。控制器零逻辑：本人身份一律取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体/
 * 查询串进（ADR-0005）。命令体（{operationId, expectedRevision, command}）经
 * parseIssueCommandBodyForKind 解析后在控制器组装 smes.command.v1 信封交
 * service.execute。
 *
 * 权限码（最小集，沿 dispatch 命名族）：
 *   POST /issue/tasks/sync              issue:write  （派工触发生成/补全——合流
 *                                         联调与运维补发面；正式触发走 dispatch
 *                                         钩子注入 IssueSyncPort）
 *   POST /issue/tasks/cleanup           issue:write  （撤销派工清理钩子面）
 *   GET  /issue/tasks                   issue:read   （?state=&workOrderId=&dispatchKind=&equipmentRef=&rollup=）
 *   GET  /issue/tasks/:id               issue:read   （详情：明细四数量）
 *   GET  /issue/tasks/:id/lines         issue:read   （去发料页：?lineKind=&moduleName=&name=&pendingFilter=&current=&size=）
 *   POST /issue/tasks/:id/confirm       issue:write  （确认发料）
 *   GET  /issue/records                 issue:read   （?taskId=&workOrderId=&state=）
 *   GET  /issue/records/:id             issue:read   （详情快照）
 *   POST /issue/records/:id/revoke      issue:revoke （整单撤销：原路回滚）
 *   GET  /issue/tasks/:id/ship-heads    issue:read   （快递单下拉；任务不存在空列表）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { IssueInputError } from './issue-errors.js';
import {
  parseIssueCommandBodyForKind,
  parseIssueDetailQuery,
  parseIssueIdParam,
  parseIssueRecordStateFilter,
  parseIssueTaskStateFilter,
  parseOptionalFilterParam,
  type IssueCommand,
} from './issue-input.js';
import type { IssueCommandResult } from './issue.service.js';
import { IssueService } from './issue.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseIssueCommandBodyForKind>[1],
): CommandEnvelope<IssueCommand> {
  const parsed = parseIssueCommandBodyForKind(body, expectedKind);
  return makeCommandEnvelope({
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: parsed.command,
  });
}

@Controller('issue')
export class IssueTasksController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly issue: IssueService,
  ) {}

  @Post('tasks/sync')
  @RequirePermission('issue:write')
  async sync(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<IssueCommandResult> {
    return this.issue.execute(envelopeOf(this.tenantContext, request, body, 'issue.sync.v1'));
  }

  @Post('tasks/cleanup')
  @RequirePermission('issue:write')
  async cleanup(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<IssueCommandResult> {
    return this.issue.execute(envelopeOf(this.tenantContext, request, body, 'issue.cleanup.v1'));
  }

  @Get('tasks')
  @RequirePermission('issue:read')
  async list(
    @Query('state') state?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('dispatchKind') dispatchKind?: string,
    @Query('equipmentRef') equipmentRef?: string,
    @Query('rollup') rollup?: string,
  ): Promise<{ tasks: Awaited<ReturnType<IssueService['listTasks']>> }> {
    if (rollup !== undefined && rollup !== '' && rollup !== 'true' && rollup !== 'false') {
      throw new IssueInputError(`rollup 非法：须为 true/false，得到 ${JSON.stringify(rollup)}`);
    }
    return {
      tasks: await this.issue.listTasks(this.tenantContext.current(), {
        ...(parseIssueTaskStateFilter(state) === undefined ? {} : { state: parseIssueTaskStateFilter(state) }),
        ...(parseOptionalFilterParam(workOrderId, 'workOrderId') === undefined
          ? {}
          : { workOrderId: parseOptionalFilterParam(workOrderId, 'workOrderId') }),
        ...(parseOptionalFilterParam(dispatchKind, 'dispatchKind') === undefined
          ? {}
          : { dispatchKind: parseOptionalFilterParam(dispatchKind, 'dispatchKind') }),
        ...(parseOptionalFilterParam(equipmentRef, 'equipmentRef') === undefined
          ? {}
          : { equipmentRef: parseOptionalFilterParam(equipmentRef, 'equipmentRef') }),
        ...(rollup === undefined || rollup === '' ? {} : { rollup: rollup === 'true' }),
      }),
    };
  }

  @Get('tasks/:id')
  @RequirePermission('issue:read')
  async detail(@Param('id') id: string): Promise<Awaited<ReturnType<IssueService['taskDetail']>>> {
    return this.issue.taskDetail(this.tenantContext.current(), parseIssueIdParam(id, '发料任务 id'));
  }

  @Get('tasks/:id/lines')
  @RequirePermission('issue:read')
  async issueDetail(
    @Param('id') id: string,
    @Query('lineKind') lineKind?: string,
    @Query('moduleName') moduleName?: string,
    @Query('name') name?: string,
    @Query('pendingFilter') pendingFilter?: string,
    @Query('current') current?: string,
    @Query('size') size?: string,
  ): Promise<Awaited<ReturnType<IssueService['issueDetail']>>> {
    return this.issue.issueDetail(
      this.tenantContext.current(),
      parseIssueIdParam(id, '发料任务 id'),
      parseIssueDetailQuery({ lineKind, moduleName, name, pendingFilter, current, size }),
    );
  }

  @Post('tasks/:id/confirm')
  @RequirePermission('issue:write')
  async confirm(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<IssueCommandResult> {
    return this.issue.execute(
      envelopeOf(this.tenantContext, request, body, 'issue.confirm.v1'),
      parseIssueIdParam(id, '发料任务 id'),
    );
  }

  @Get('tasks/:id/ship-heads')
  @RequirePermission('issue:read')
  async shipHeads(@Param('id') id: string): Promise<{ expresses: Awaited<ReturnType<IssueService['shipHeads']>> }> {
    return {
      expresses: await this.issue.shipHeads(this.tenantContext.current(), parseIssueIdParam(id, '发料任务 id')),
    };
  }
}

@Controller('issue')
export class IssueRecordsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly issue: IssueService,
  ) {}

  @Get('records')
  @RequirePermission('issue:read')
  async list(
    @Query('taskId') taskId?: string,
    @Query('workOrderId') workOrderId?: string,
    @Query('state') state?: string,
  ): Promise<{ records: Awaited<ReturnType<IssueService['listRecords']>> }> {
    return {
      records: await this.issue.listRecords(this.tenantContext.current(), {
        ...(parseOptionalFilterParam(taskId, 'taskId') === undefined
          ? {}
          : { taskId: parseOptionalFilterParam(taskId, 'taskId') }),
        ...(parseOptionalFilterParam(workOrderId, 'workOrderId') === undefined
          ? {}
          : { workOrderId: parseOptionalFilterParam(workOrderId, 'workOrderId') }),
        ...(parseIssueRecordStateFilter(state) === undefined
          ? {}
          : { state: parseIssueRecordStateFilter(state) }),
      }),
    };
  }

  @Get('records/:id')
  @RequirePermission('issue:read')
  async detail(@Param('id') id: string): Promise<Awaited<ReturnType<IssueService['recordDetail']>>> {
    return this.issue.recordDetail(this.tenantContext.current(), parseIssueIdParam(id, '发料记录 id'));
  }

  @Post('records/:id/revoke')
  @RequirePermission('issue:revoke')
  async revoke(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<IssueCommandResult> {
    return this.issue.execute(
      envelopeOf(this.tenantContext, request, body, 'issue.revoke.v1'),
      parseIssueIdParam(id, '发料记录 id'),
    );
  }
}
