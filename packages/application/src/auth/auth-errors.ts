/**
 * 认证域错误（M1 收尾波-③；M2 安全前置批 SP-1 增 429）。与 org 域错误同一
 * 纪律：application 零框架，域错误用普通 Error 子类；HTTP 映射在组合根
 * （apps/server/src/auth-error.filter.ts：AuthInputError → 400、
 * AuthCredentialsError → 401、AuthRateLimitError → 429）。
 *
 * 不泄漏差异（写明）：用户不存在 / 口令不符 / 账户停用 / 未设口令，四种
 * 拒绝路径抛同一 AuthCredentialsError + 同一 message——响应体不可区分。
 */
export class AuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthInputError';
  }
}

/** 凭据无效 / 会话失效（HTTP 401；message 保持同一句，不区分拒绝路径）。 */
export class AuthCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialsError';
  }
}

/**
 * 登录尝试过于频繁（HTTP 429，SP-1 窗口失败计数锁定）。message 固定一句
 * （auth.service 的 LOGIN_RATE_LIMITED_MESSAGE），不含用户存在性信息。
 */
export class AuthRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRateLimitError';
  }
}
