/**
 * ai-query 域错误（AI 问数首版，CONTRACT v1 · 2026-10-28）。
 *
 * 与 reporting/workorder 域错误同一纪律：application 零框架，HTTP 状态映射由
 * 组合根异常过滤器完成（apps/server AiQueryErrorFilter 接线属 WP-B 合流，
 * 本包只定错误形状；先例 report-error.filter.ts）：
 *   AiQueryInputError    -> 400（请求形状/取值非法：question 长度、selectedOptionId
 *                            非法、limit 越界等）
 *   AiQueryNotFoundError -> 404（session 不存在 / 跨用户读——同形不泄漏存在性）
 *   AiQueryConflictError -> 409（会话状态冲突：selectedOptionId 回传但当前无待澄清问题）
 *
 * 注意：能力域权限缺失**不是错误**——回答通道内 kind:'denied'（HTTP 200，
 * 合同 §三域能力）；缺 ai-query:read 由 AuthGuard 403（既有行为，不经本组错误）。
 */
export class AiQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiQueryInputError';
  }
}

/** session 不存在或非本人（HTTP 404；租户+用户双键收口）。 */
export class AiQueryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiQueryNotFoundError';
  }
}

/** 会话状态冲突（HTTP 409）：澄清回传与会话当前态不符。 */
export class AiQueryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiQueryConflictError';
  }
}
