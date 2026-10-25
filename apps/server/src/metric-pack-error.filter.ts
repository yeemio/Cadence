/**
 * 口径包专业包域错误 -> HTTP 状态映射（M3 第二波）。
 *
 * 与既有各域过滤器同一装配纪律（域错误类在专业包，映射在组合根）：
 *   MetricPackInputError    -> 400（请求形状/取值非法，含口径查询谓词非法）
 *   MetricPackNotFoundError -> 404（口径未装载=不可见 / 事实源未绑定）
 *   MetricPackConflictError -> 409（装载版本非严格递增、幂等记账冲突）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  MetricPackConflictError,
  MetricPackInputError,
  MetricPackNotFoundError,
} from '@smes/metric-pack';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(MetricPackInputError, MetricPackNotFoundError, MetricPackConflictError)
export class MetricPackErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof MetricPackConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof MetricPackNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
