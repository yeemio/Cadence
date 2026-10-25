/**
 * 清单与采购域错误 -> HTTP 状态映射（M2 Wave-2）。
 *
 * 与既有各域过滤器同一装配纪律（域错误类在 application，映射在组合根）：
 *   ListingInputError    -> 400（请求形状/取值非法）
 *   ListingNotFoundError -> 404（清单/订单/退货不存在/跨租户）
 *   ListingConflictError -> 409（版本声明过期、id 冲突、幂等记账不符）
 *   ListingStateError    -> 409（订单五态无迁移规则/守卫拒绝/账本对账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ListingConflictError,
  ListingInputError,
  ListingNotFoundError,
  ListingStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  ListingInputError,
  ListingNotFoundError,
  ListingConflictError,
  ListingStateError,
)
export class ListingErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof ListingConflictError || exception instanceof ListingStateError
        ? HttpStatus.CONFLICT
        : exception instanceof ListingNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
