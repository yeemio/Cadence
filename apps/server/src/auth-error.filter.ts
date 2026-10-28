/**
 * 认证域错误 -> HTTP 状态映射（M1 收尾波-③；M2 安全前置批 SP-1 增 429）。
 *
 *   AuthInputError       -> 400（登录请求体形状非法）
 *   AuthCredentialsError -> 401（凭据无效 / 会话失效——四种拒绝路径同态）
 *   AuthRateLimitError   -> 429（登录尝试过于频繁——窗口失败计数锁定）
 *
 * 与 OrgErrorFilter 同一装配纪律：application 侧只抛域错误，组合根翻译。
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { AuthCredentialsError, AuthInputError, AuthRateLimitError } from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(AuthInputError, AuthCredentialsError, AuthRateLimitError)
export class AuthErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof AuthRateLimitError
        ? HttpStatus.TOO_MANY_REQUESTS
        : exception instanceof AuthCredentialsError
          ? HttpStatus.UNAUTHORIZED
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof AuthRateLimitError
        ? 'auth.rate_limited'
        : exception instanceof AuthCredentialsError
          ? 'auth.invalid_credentials'
          : 'auth.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
