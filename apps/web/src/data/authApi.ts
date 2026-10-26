/**
 * 认证传输层（M1 收尾波-③）：AuthTransport 的 fetch 装配（product-ui 定义形状，
 * 本文件提供 HTTP 实现——product-ui 保持零 fetch 纪律）。
 *
 * 错误语义（会话规则的传输侧合同）：
 *  - 服务端 401 → AuthRejectedError（服务端明确拒绝）；
 *  - 其他非 2xx → Error（含 message）；
 *  - 网络失败 → fetch 原生 TypeError 抛出（≠ AuthRejectedError，不清会话）。
 */
import { AuthRejectedError, type AuthSessionPayload, type AuthTransport } from '@smes/product-ui';

const API_BASE = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '';

async function authRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    // 登录 401 = 账密错误（2026-10-26 部署实览：此前统一报"服务端拒绝了
    // 当前会话"误导为会话过期）；其余 401（refresh/me）维持会话拒绝语义。
    const serverMessage =
      typeof body === 'object' && body !== null && 'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
        ? (body as { message: string }).message
        : null;
    throw new AuthRejectedError(
      path.startsWith('/auth/login')
        ? (serverMessage ?? '账号或口令不正确')
        : '服务端拒绝了当前会话',
    );
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function toPayload(raw: unknown): AuthSessionPayload {
  // 形状由服务端 /auth/* 端点保证；此处只做最小收窄（失败即抛，不静默）
  const record = raw as Partial<AuthSessionPayload> | null | undefined;
  if (
    typeof record?.token !== 'string' ||
    typeof record?.expiresAt !== 'string' ||
    typeof record?.user?.id !== 'string' ||
    typeof record?.admin !== 'boolean' ||
    !Array.isArray(record?.permissions)
  ) {
    throw new Error('认证响应形状非法');
  }
  return record as AuthSessionPayload;
}

export const authTransport: AuthTransport = {
  async login(username: string, password: string): Promise<AuthSessionPayload> {
    return toPayload(
      await authRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    );
  },
  async me(token: string): Promise<AuthSessionPayload> {
    // /auth/me 响应无 token 字段（当前 token 仍是有效凭据，原样保留）
    const raw = (await authRequest('/auth/me', { headers: bearer(token) })) as Partial<AuthSessionPayload>;
    return toPayload({ ...raw, token });
  },
  async refresh(token: string): Promise<AuthSessionPayload> {
    return toPayload(
      await authRequest('/auth/refresh', { method: 'POST', headers: bearer(token) }),
    );
  },
  async logout(token: string): Promise<void> {
    await authRequest('/auth/logout', { method: 'POST', headers: bearer(token) });
  },
};
