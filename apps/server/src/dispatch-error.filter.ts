/**
 * 派工域错误 -> HTTP 状态映射（M2 Wave-3）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   DispatchInputError    -> 400（请求形状/取值非法）
 *   DispatchNotFoundError -> 404（派工单/外协明细不存在/跨租户）
 *   DispatchConflictError -> 409（版本声明过期、幂等记账不符）
 *   DispatchStateError    -> 409（状态机无迁移规则/齐套拦截/守卫拒绝）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  DispatchConflictError,
  DispatchInputError,
  DispatchNotFoundError,
  DispatchStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  DispatchInputError,
  DispatchNotFoundError,
  DispatchConflictError,
  DispatchStateError,
)
export class DispatchErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof DispatchConflictError || exception instanceof DispatchStateError
        ? HttpStatus.CONFLICT
        : exception instanceof DispatchNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
