/**
 * 工时账域错误 -> HTTP 状态映射（M2 Wave-4）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   HoursInputError    -> 400（请求形状/取值非法）
 *   HoursNotFoundError -> 404（条目/月度快照不存在/跨租户）
 *   HoursConflictError -> 409（重算冲突、幂等记账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  HoursConflictError,
  HoursInputError,
  HoursNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(HoursInputError, HoursNotFoundError, HoursConflictError)
export class HoursErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof HoursConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof HoursNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
