/**
 * AI 问数域错误 -> HTTP 状态映射（CONTRACT v1 · 2026-10-28，WP-B）。
 *
 * 与既有各域过滤器同一装配纪律（体例 report-error.filter.ts）：
 *   AiQueryInputError    -> 400（请求形状/取值非法：question 长度、limit、
 *                           selectedOptionId 不在待澄清选项内等）
 *   AiQueryNotFoundError -> 404（会话不存在/跨用户读——不泄漏存在性）
 *   AiQueryConflictError -> 409（会话无待澄清问题却回传选项、澄清选项映射缺失）
 *
 * code 前缀 ai_query.*：snake 形态与本测试表既有不变量一致
 * （error-code-mapping.test.ts 的 /^[a-z0-9_]+(\.[a-z0-9_]+)+$/ 不含连字符，
 * 先例 metric_pack / column_preference / menu_config 同体例）。
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AiQueryConflictError,
  AiQueryInputError,
  AiQueryNotFoundError,
} from '@smes/application';

interface MinimalResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch(
  AiQueryInputError,
  AiQueryNotFoundError,
  AiQueryConflictError,
)
export class AiQueryErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof AiQueryConflictError
        ? HttpStatus.CONFLICT
        : exception instanceof AiQueryNotFoundError
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
    const message = exception instanceof Error ? exception.message : String(exception);
    const code =
      exception instanceof AiQueryConflictError
        ? 'ai_query.conflict'
        : exception instanceof AiQueryNotFoundError
          ? 'ai_query.not_found'
          : 'ai_query.invalid_input';
    response.status(status);
    response.json({ statusCode: status, code, message });
  }
}
