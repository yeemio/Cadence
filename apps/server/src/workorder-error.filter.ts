/**
 * 工作令域错误 -> HTTP 状态映射（M2 Wave-1）。
 *
 * 与 ApprovalErrorFilter 同一装配纪律（域错误类在 application，映射在组合根）；
 * 独立成过滤器，注册互不重叠（@Catch 按异常类型命中）：
 *   WorkOrderInputError    -> 400（请求形状/取值非法）
 *   WorkOrderNotFoundError -> 404（工作令/配件/齐套不存在/跨租户）
 *   WorkOrderConflictError -> 409（版本声明过期、id 冲突、幂等记账不符）
 *   WorkOrderStateError    -> 409（九态无迁移规则/守卫拒绝/账本对账不符）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  WorkOrderConflictError,
  WorkOrderInputError,
  WorkOrderNotFoundError,
  WorkOrderStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  WorkOrderInputError,
  WorkOrderNotFoundError,
  WorkOrderConflictError,
  WorkOrderStateError,
)
export class WorkOrderErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof WorkOrderConflictError || exception instanceof WorkOrderStateError
        ? HttpStatus.CONFLICT
        : exception instanceof WorkOrderNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
