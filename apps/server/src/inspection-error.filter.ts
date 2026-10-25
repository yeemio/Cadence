/**
 * 质检域错误 -> HTTP 状态映射（M2 Wave-2）。
 *
 * 与既有各域过滤器同一装配纪律：
 *   InspectionInputError    -> 400（请求形状/取值非法）
 *   InspectionNotFoundError -> 404（质检单/不合格处置不存在/跨租户）
 *   InspectionConflictError -> 409（版本声明过期、来源引用重复、幂等记账不符）
 *   InspectionStateError    -> 409（质检状态机无迁移规则/闭环守卫拒绝）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  InspectionConflictError,
  InspectionInputError,
  InspectionNotFoundError,
  InspectionStateError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  InspectionInputError,
  InspectionNotFoundError,
  InspectionConflictError,
  InspectionStateError,
)
export class InspectionErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof InspectionConflictError || exception instanceof InspectionStateError
        ? HttpStatus.CONFLICT
        : exception instanceof InspectionNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
