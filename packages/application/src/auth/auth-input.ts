/**
 * 认证输入解析（M1 收尾波-③）：login 请求体 / Authorization 头。
 * 与 org-input 同一纪律：违规抛 AuthInputError（组合根映射 400），绝不静默丢弃。
 */
import { AuthCredentialsError, AuthInputError } from './auth-errors.js';

export interface LoginPayload {
  readonly username: string;
  readonly password: string;
}

/** 解析 POST /auth/login 请求体。 */
export function parseLoginInput(input: unknown): LoginPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AuthInputError(`登录请求体必须是对象：${JSON.stringify(input)}`);
  }
  const record = input as Record<string, unknown>;
  const username = record['username'];
  if (typeof username !== 'string' || username.trim().length === 0) {
    throw new AuthInputError("字段 'username' 须为非空字符串");
  }
  const password = record['password'];
  if (typeof password !== 'string' || password.length === 0) {
    throw new AuthInputError("字段 'password' 须为非空字符串");
  }
  return { username: username.trim(), password };
}

/**
 * 解析 Authorization 头为 Bearer token（/auth/refresh、/auth/logout、/auth/me 用）。
 * 形状不符属凭据问题而非输入形状问题 → AuthCredentialsError（401）。
 */
export function requireBearerToken(authorization: unknown): string {
  if (typeof authorization !== 'string') {
    throw new AuthCredentialsError('缺少或无效的访问令牌');
  }
  const trimmed = authorization.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    throw new AuthCredentialsError('缺少或无效的访问令牌');
  }
  const token = trimmed.slice(7).trim();
  if (token.length === 0) {
    throw new AuthCredentialsError('缺少或无效的访问令牌');
  }
  return token;
}
