/**
 * 成本账域错误 -> HTTP 状态映射（M2 Wave-4）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   CostingInputError    -> 400（请求形状/取值非法）
 *   CostingNotFoundError -> 404（条目/口径/快照不存在/跨租户）
 *   CostingConflictError -> 409（口径版本冲突、重算冲突、幂等记账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  CostingConflictError,
  CostingInputError,
  CostingNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(CostingInputError, CostingNotFoundError, CostingConflictError)
export class CostingErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof CostingConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof CostingNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof CostingConflictError
        ? 'costing.conflict'
        : exception instanceof CostingNotFoundError
          ? 'costing.not_found'
          : 'costing.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
