/**
 * 认证域错误 -> HTTP 状态映射（M1 收尾波-③）。
 *
 *   AuthInputError       -> 400（登录请求体形状非法）
 *   AuthCredentialsError -> 401（凭据无效 / 会话失效——四种拒绝路径同态）
 *
 * 与 OrgErrorFilter 同一装配纪律：application 侧只抛域错误，组合根翻译。
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { AuthCredentialsError, AuthInputError } from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(AuthInputError, AuthCredentialsError)
export class AuthErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof AuthCredentialsError
        ? HttpStatus.UNAUTHORIZED
        : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status);
    response.json({ statusCode: status, message });
  }
}
