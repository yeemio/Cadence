/**
 * dispatch 售后报销路由（U5 A12）。控制器零逻辑：身份取 AuthGuard 写入请求的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体进
 * （ADR-0005）。命令体经 parseAftercareClaimBodyForKind 解析后组装 smes.command.v1
 * 信封交 AftercareClaimService.execute。
 *
 * 权限码（<环节>:<动作> 两段形状；文档保存权限 after_sales_dispatch_order_
 * reimburse 的 Cadence 重述）：
 *   GET  /dispatch/aftercare/claims/by-dispatch/:id  aftercare:read  （按派工单查报销；
 *                                                     无报销/单不存在 → claim=null，文档 data=null 口径）
 *   GET  /dispatch/aftercare/claims/context          aftercare:read  （?dispatchOrderId= 必填；
 *                                                     派工单不存在 → 404 语义，文档 context 口径）
 *   POST /dispatch/aftercare/claims/save            aftercare:claim （新增：一单一报销）
 *   POST /dispatch/aftercare/claims/update/:id      aftercare:claim （编辑；:id = 派工单 id，
 *                                                     expectedRevision = 报销单 objectVersion）
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { makeCommandEnvelope, type CommandEnvelope } from '@smes/business-core';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { parseIdParam } from './dispatch-input.js';
import { DispatchInputError } from './dispatch-errors.js';
import {
  parseAftercareClaimBodyForKind,
  type AftercareClaimCommand,
} from './aftercare-claim-input.js';
import type { AftercareClaimCommandResult } from './aftercare-claim.service.js';
import { AftercareClaimService } from './aftercare-claim.service.js';

/** 信封组装（零业务逻辑：身份/租户取上下文，命令体取请求体）。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  body: unknown,
  expectedKind: Parameters<typeof parseAftercareClaimBodyForKind>[1],
): CommandEnvelope<AftercareClaimCommand> {
  const parsed = parseAftercareClaimBodyForKind(body, expectedKind);
  return makeCommandEnvelope({
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: parsed.command,
  });
}

@Controller('dispatch/aftercare')
export class AftercareClaimController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly claims: AftercareClaimService,
  ) {}

  @Get('claims/by-dispatch/:id')
  @RequirePermission('aftercare:read')
  async byDispatch(@Param('id') id: string): Promise<{
    claim: Awaited<ReturnType<AftercareClaimService['claimByDispatch']>>;
  }> {
    return { claim: await this.claims.claimByDispatch(this.tenantContext.current(), parseIdParam(id, '派工单 id')) };
  }

  @Get('claims/context')
  @RequirePermission('aftercare:read')
  async context(@Query('dispatchOrderId') dispatchOrderId?: string): Promise<{
    context: Awaited<ReturnType<AftercareClaimService['claimContext']>>;
  }> {
    if (dispatchOrderId === undefined || dispatchOrderId === '') {
      throw new DispatchInputError('dispatchOrderId 查询参数必填（报销上下文）');
    }
    return {
      context: await this.claims.claimContext(
        this.tenantContext.current(),
        parseIdParam(dispatchOrderId, '派工单 id'),
      ),
    };
  }

  @Post('claims/save')
  @RequirePermission('aftercare:claim')
  async save(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<AftercareClaimCommandResult> {
    return this.claims.execute(envelopeOf(this.tenantContext, request, body, 'aftercare.claim.save.v1'));
  }

  @Post('claims/update/:id')
  @RequirePermission('aftercare:claim')
  async update(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<AftercareClaimCommandResult> {
    return this.claims.execute(
      envelopeOf(this.tenantContext, request, body, 'aftercare.claim.update.v1'),
      parseIdParam(id, '派工单 id'),
    );
  }
}
