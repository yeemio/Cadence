/**
 * 组织域错误 -> HTTP 状态映射（M1 增量 3-D）。
 *
 * NestJS 运行时链路件属组合根（装配纪律见 apps/server/README.md，同 AuthGuard
 * 先例）：application 侧只抛域错误（OrgInputError 等），本过滤器统一翻译——
 *   OrgInputError    -> 400（请求形状/取值非法）
 *   OrgNotFoundError -> 404（用户/角色不存在）
 *   OrgConflictError -> 409（租户内唯一键冲突）
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  OrgConflictError,
  OrgInputError,
  OrgNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(OrgInputError, OrgNotFoundError, OrgConflictError)
export class OrgErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof OrgConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof OrgNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof OrgConflictError
        ? 'org.conflict'
        : exception instanceof OrgNotFoundError
          ? 'org.not_found'
          : 'org.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
