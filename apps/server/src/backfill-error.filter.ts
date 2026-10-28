/**
 * S1 backfill 域错误 -> HTTP 状态映射（0920 #103 操作日志 / #89/91/92/96 标准报表）。
 *
 * NestJS 运行时链路件属组合根（装配纪律见 apps/server/README.md，同 OrgErrorFilter
 * 先例）：application 侧只抛域错误，本过滤器统一翻译——
 *   AuditInputError              -> 400（日志查询入参非法）
 *   StandardReportsInputError    -> 400（报表查询入参非法）
 *   StandardReportsNotFoundError -> 404（引用的口径不存在）
 *   StandardReportsSourceError   -> 503（事实源未绑定/不可用——零 DB 形态求值的
 *                                    诚实失败：口径在、数据面缺，不静默空结果）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AuditInputError,
  StandardReportsInputError,
  StandardReportsNotFoundError,
  StandardReportsSourceError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  AuditInputError,
  StandardReportsInputError,
  StandardReportsNotFoundError,
  StandardReportsSourceError,
)
export class BackfillErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof StandardReportsSourceError
        ? HttpStatus.SERVICE_UNAVAILABLE
        : exception instanceof StandardReportsNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof StandardReportsSourceError
        ? 'standard_reports.source_unavailable'
        : exception instanceof StandardReportsNotFoundError
          ? 'standard_reports.not_found'
          : exception instanceof StandardReportsInputError
            ? 'standard_reports.invalid_input'
            : 'audit.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
