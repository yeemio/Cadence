/**
 * 库存域错误 -> HTTP 状态映射（M2 Wave-3）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   InventoryInputError    -> 400（请求形状/取值非法）
 *   InventoryNotFoundError -> 404（仓库/库位/流水/盘点/发货单不存在/跨租户）
 *   InventoryConflictError -> 409（版本声明过期、receiptKey/幂等键冲突）
 *   InventoryStateError    -> 409（可用量守卫/盘点状态机/放行咬合校验拒绝）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  InventoryConflictError,
  InventoryInputError,
  InventoryNotFoundError,
  InventoryStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  InventoryInputError,
  InventoryNotFoundError,
  InventoryConflictError,
  InventoryStateError,
)
export class InventoryErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof InventoryConflictError || exception instanceof InventoryStateError
        ? HttpStatus.CONFLICT
        : exception instanceof InventoryNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
