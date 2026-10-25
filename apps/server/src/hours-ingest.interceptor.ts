/**
 * hours.ingest 实时联动拦截器（跨模块接线 #2 的触发机制①，见
 * cross-module-wiring.ts 清单）。
 *
 * 机制：POST /reports/:id/verify 与 /reports/:id/revoke 命中且命令以 committed
 * 收场（ReportVerified/ReportRevoked 事件已落账）时，在同一请求内联动执行
 * hours.ingest.v1——组合态"verified 工时实时进入工时账"的演示面。联动 await
 * 完成后才放行响应（读回即得，无需轮询）；联动失败不改变核查响应（吞错 +
 * console.warn，重放面 = 手动 POST /hours/ingest，hours sourceKey 幂等保证
 * 重放安全）。rejected/indeterminate 不联动（无新 verified/revoked 事件）。
 *
 * 装配：buildAppModule 在 reporting+hours 同时启用时经 APP_INTERCEPTOR 注册，
 * 触发函数经 HOURS_INGEST_TRIGGER token 注入（wiring.hoursIngestTrigger）。
 */
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { REQUEST_USER_KEY, TenantContext } from '@smes/application';
import type { TenantId, UserId } from '@smes/business-core';
import type { Observable } from 'rxjs';
import { mergeMap } from 'rxjs';
import { HOURS_INGEST_TRIGGER } from './cross-module-wiring.js';

/** 触发函数形状（wiring.hoursIngestTrigger）。 */
export type HoursIngestTrigger = (tenant: TenantId, actor: UserId) => Promise<void>;

interface WiredRequest {
  readonly method?: unknown;
  readonly url?: unknown;
  readonly [REQUEST_USER_KEY]?: UserId;
}

/** verify/revoke 路由判定（路径不含全局前缀——组合根未设 setGlobalPrefix）。 */
function isVerifyOrRevokeRequest(request: WiredRequest): boolean {
  if (request.method !== 'POST') return false;
  const raw = typeof request.url === 'string' ? request.url : '';
  const path = raw.split('?')[0] ?? '';
  return /^\/reports\/[^/]+\/(verify|revoke)$/.test(path);
}

function isCommittedOutcome(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { status?: unknown }).status === 'committed'
  );
}

@Injectable()
export class HoursIngestLinkInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantContext: TenantContext,
    @Inject(HOURS_INGEST_TRIGGER) private readonly trigger: HoursIngestTrigger,
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = _context.switchToHttp().getRequest<WiredRequest>();
    if (!isVerifyOrRevokeRequest(request)) {
      return next.handle();
    }
    return next.handle().pipe(
      mergeMap(async (response: unknown) => {
        if (isCommittedOutcome(response)) {
          const actor = request[REQUEST_USER_KEY];
          if (actor !== undefined) {
            try {
              await this.trigger(this.tenantContext.current(), actor);
            } catch (error) {
              console.warn(
                '[smes] hours.ingest 联动失败（核查已落账不受影响；POST /hours/ingest 可重放）:',
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
        return response;
      }),
    );
  }
}
