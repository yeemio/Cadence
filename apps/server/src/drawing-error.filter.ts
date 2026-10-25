/**
 * 图纸专业包域错误 -> HTTP 状态映射（M3 第二波）。
 *
 * 与既有各域过滤器同一装配纪律（域错误类在专业包，映射在组合根）：
 *   DrawingInputError    -> 400（请求形状/取值非法，含未知保密等级词）
 *   DrawingNotFoundError -> 404（修订不存在 / 超保密等级不可见——两者同形，
 *                           不泄漏存在性，合同 §2 内核不变量 1）
 *   DrawingConflictError -> 409（链尾版本乐观锁失配、幂等记账冲突）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  DrawingConflictError,
  DrawingInputError,
  DrawingNotFoundError,
} from '@smes/drawing';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(DrawingInputError, DrawingNotFoundError, DrawingConflictError)
export class DrawingErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof DrawingConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof DrawingNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
