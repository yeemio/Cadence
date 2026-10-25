/**
 * 薪酬专业包域错误 -> HTTP 状态映射（M3 首波）。
 *
 * 与既有各域过滤器同一装配纪律（域错误类在专业包，映射在组合根）：
 *   PayrollInputError    -> 400（请求形状/取值非法，含未知工种词）
 *   PayrollNotFoundError -> 404（规则/批次/记录不存在/跨租户）
 *   PayrollConflictError -> 409（版本声明过期、规则歧义、幂等记账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  PayrollConflictError,
  PayrollInputError,
  PayrollNotFoundError,
} from '@smes/payroll';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(PayrollInputError, PayrollNotFoundError, PayrollConflictError)
export class PayrollErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof PayrollConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof PayrollNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
