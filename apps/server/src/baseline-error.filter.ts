/**
 * 技术基线域错误 -> HTTP 状态映射（M2 Wave-1）。
 *
 * 与 ApprovalErrorFilter / WorkOrderErrorFilter 同一装配纪律（域错误类在
 * application，映射在组合根）；独立成过滤器，注册互不重叠：
 *   BaselineInputError    -> 400（请求形状/取值非法）
 *   BaselineNotFoundError -> 404（工序/设备/计价规则不存在/跨租户）
 *   BaselineConflictError -> 409（版本声明过期、code 冲突、修订链不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  BaselineConflictError,
  BaselineInputError,
  BaselineNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(BaselineInputError, BaselineNotFoundError, BaselineConflictError)
export class BaselineErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof BaselineConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof BaselineNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
