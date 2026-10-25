/**
 * AuditWriteInterceptor —— 写操作日志拦截器（S1 backfill：0920 #103）。
 *
 * 拦截语义（写明）：
 *  - 只记**写方法**（POST/PUT/PATCH/DELETE）且**成功收场**的请求——handler
 *    正常返回即视为操作完成；抛错路径不落日志（失败的操作没有改变系统状态，
 *    且异常过滤器属组合根，域各异，v1 不横切记失败）。
 *  - 记录字段：tenant（TenantContext ALS）/ user（REQUEST_USER_KEY，AuthGuard
 *    写入；公开写路由为 null）/ method / path（去查询串）/ summary（截断策略
 *    见 audit-stores.ts）/ occurredAt。**不打载荷全文**——载荷可能含口令与
 *    大单据 JSON（脱敏 + 体积双取舍，口径在 audit-stores.ts 文件头）。
 *  - **自身不记**（防递归）：/audit/* 路径一律跳过——本模块无写端点，该规则
 *    同时防未来在 audit 下加写端点时的自触发循环。
 *  - 性能取舍（异步 fire-and-forget vs 同步——选**同步 await**）：单行 INSERT
 *    与业务写共用连接池，延迟毫秒级；换来写后立即可查的确定性（e2e 与管理页
 *    读回即得，无轮询）。fire-and-forget 会在崩溃时丢最近日志且让读回竞态。
 *    失败隔离：日志写失败只 console.warn，**绝不改变业务响应**（审计是旁路
 *    事实，不是业务事务参与者）。
 *
 * 装配：buildAppModule 在 audit 模块启用时经 APP_INTERCEPTOR 注册（同
 * HoursIngestLinkInterceptor 先例——条件装配，未启用零开销）。
 */
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { mergeMap } from 'rxjs';
import { REQUEST_USER_KEY } from '../core/auth/request-user.js';
import { TenantContext } from '../core/tenant-context.js';
import { AuditService } from './audit.service.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDIT_PATH_PREFIX = '/audit';

interface WiredRequest {
  readonly method?: unknown;
  readonly url?: unknown;
  readonly [REQUEST_USER_KEY]?: unknown;
}

function isAuditableWrite(request: WiredRequest): boolean {
  if (typeof request.method !== 'string' || !WRITE_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  const raw = typeof request.url === 'string' ? request.url : '';
  const path = raw.split('?')[0] ?? '';
  if (path === '' || path === '/') return false;
  return !path.startsWith(AUDIT_PATH_PREFIX); // 自身路径不记（防递归）
}

@Injectable()
export class AuditWriteInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<WiredRequest>();
    if (!isAuditableWrite(request)) {
      return next.handle();
    }
    const method = String(request.method).toUpperCase();
    const path = (typeof request.url === 'string' ? request.url : '').split('?')[0] ?? '';
    const rawUser = request[REQUEST_USER_KEY];
    const userId = typeof rawUser === 'string' ? rawUser : null;
    const tenant = this.tenantContext.current();

    return next.handle().pipe(
      mergeMap(async (response: unknown) => {
        try {
          await this.audit.record({ tenant, userId, method, path });
        } catch (error) {
          // 审计旁路失败不阻断业务响应（见文件头失败隔离取舍）
          console.warn(
            '[smes] 操作日志落账失败（业务响应不受影响）:',
            error instanceof Error ? error.message : String(error),
          );
        }
        return response;
      }),
    );
  }
}
