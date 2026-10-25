/**
 * 最小 core 服务 —— 必装基础层代表（ADR-0004：core 组织权限/基础数据/工作台/待办/审批壳/扫码）。
 * M1 后续增量在 CoreModule providers 上续装，本服务保持薄。
 */
import { Injectable } from '@nestjs/common';
import type { TenantId } from '@smes/business-core';
import { TenantContext } from './tenant-context.js';

@Injectable()
export class CoreService {
  constructor(private readonly tenantContext: TenantContext) {}

  /** 组合根 /health 的数据源：tenant 来自 TenantContext 当前值。 */
  health(): { status: 'ok'; tenant: TenantId } {
    return { status: 'ok', tenant: this.tenantContext.current() };
  }
}
