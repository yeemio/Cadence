/**
 * T1 能力子集三域错误 -> HTTP 状态映射（0920 #98/99 菜单管理 / #101 通知
 * 中心 / #102 审批配置；同 BackfillErrorFilter 一线一过滤器的先例）。
 *
 * NestJS 运行时链路件属组合根（装配纪律见 apps/server/README.md）：application
 * 侧只抛域错误，本过滤器统一翻译——
 *   MenuConfigInputError / NotificationInputError /
 *   ApprovalConfigInputError                    -> 400（请求体/参数非法）
 *   MenuConfigNotFoundError / NotificationNotFoundError /
 *   ApprovalConfigNotFoundError                 -> 404（引用对象不存在/非本人）
 *   MenuConfigConflictError / ApprovalConfigConflictError -> 409（唯一键冲突）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ApprovalConfigConflictError,
  ApprovalConfigInputError,
  ApprovalConfigNotFoundError,
  MenuConfigConflictError,
  MenuConfigInputError,
  MenuConfigNotFoundError,
  NotificationInputError,
  NotificationNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  MenuConfigInputError,
  MenuConfigNotFoundError,
  MenuConfigConflictError,
  NotificationInputError,
  NotificationNotFoundError,
  ApprovalConfigInputError,
  ApprovalConfigNotFoundError,
  ApprovalConfigConflictError,
)
export class CapabilityErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof MenuConfigConflictError || exception instanceof ApprovalConfigConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof MenuConfigNotFoundError ||
            exception instanceof NotificationNotFoundError ||
            exception instanceof ApprovalConfigNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
