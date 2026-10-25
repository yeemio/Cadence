/**
 * 报工域错误 -> HTTP 状态映射（M2 Wave-4）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   ReportInputError    -> 400（请求形状/取值非法）
 *   ReportNotFoundError -> 404（报工单/核查留痕不存在/跨租户）
 *   ReportConflictError -> 409（版本声明过期、幂等记账不符、被修正版取代）
 *   ReportStateError    -> 409（报工状态机无迁移规则/核查守卫拒绝）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ReportConflictError,
  ReportInputError,
  ReportNotFoundError,
  ReportStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  ReportInputError,
  ReportNotFoundError,
  ReportConflictError,
  ReportStateError,
)
export class ReportErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof ReportConflictError || exception instanceof ReportStateError
        ? HttpStatus.CONFLICT
        : exception instanceof ReportNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
