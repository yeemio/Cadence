/**
 * GET /health —— 存活与租户读回：{"status":"ok","tenant":"default"}。
 * tenant 来自 TenantContext 当前值（ADR-0005）；数据源是必装基础层的 CoreService，
 * 因此本端点同时是"core 必装"的运行时证据。
 */
import { Controller, Get } from '@nestjs/common';
import { CoreService } from '@smes/application';

@Controller()
export class HealthController {
  constructor(private readonly core: CoreService) {}

  @Get('health')
  health(): { status: 'ok'; tenant: string } {
    const snapshot = this.core.health();
    return { status: snapshot.status, tenant: snapshot.tenant };
  }
}
