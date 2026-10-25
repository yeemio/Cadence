/**
 * 真实认证会话存储（M1 收尾波-③）：Bearer token 会话的浏览器/内存持久化。
 *
 * 与 mock 会话（session.ts，键 v1）并存不互读：真实登录流写 v2 键；
 * 旧 v1 内容自然作废（用户重新登录一次）。登录 MPA 入口与主壳两个独立
 * bundle 只共享本存储（ADR-0009 隔离前提不变）。
 *
 * 形状（与服务端 /auth/login、/auth/me 响应对齐）：
 *   { userId, tenantId, displayName, permissions, token, expiresAt }
 * token 明文只在本存储与会话内存中流转（服务端只存摘要）。
 */
import { TenantId, UserId } from '@smes/business-core';
import { isPermissionCode, permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 已建立的 token 会话视图模型。 */
export interface TokenSession {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly permissions: readonly PermissionCode[];
  readonly token: string;
  /** 访问期上界（ISO 字符串——保活参数依据；续期响应会整体覆写本会话）。 */
  readonly expiresAt: string;
}

export interface TokenSessionStore {
  read(): TokenSession | null;
  write(session: TokenSession): void;
  clear(): void;
}

export const TOKEN_SESSION_STORAGE_KEY = 'cadence.session.v2';

/** 测试用内存存储。 */
export function createMemoryTokenSessionStore(): TokenSessionStore {
  let current: TokenSession | null = null;
  return {
    read: () => current,
    write: (session) => {
      current = session;
    },
    clear: () => {
      current = null;
    },
  };
}

/** 浏览器存储适配（localStorage / sessionStorage 均可注入）。损坏内容一律读作空。 */
export function createBrowserTokenSessionStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string = TOKEN_SESSION_STORAGE_KEY,
): TokenSessionStore {
  return {
    read() {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try {
        return parseTokenSession(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    write(session: TokenSession): void {
      storage.setItem(key, JSON.stringify(session));
    },
    clear(): void {
      storage.removeItem(key);
    },
  };
}

/** 损坏/缺字段内容一律 null（读作未登录，不抛错）。 */
export function parseTokenSession(value: unknown): TokenSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { userId, tenantId, displayName, permissions, token, expiresAt } = record;
  if (typeof userId !== 'string' || !UserId.is(userId)) return null;
  if (typeof tenantId !== 'string' || !TenantId.is(tenantId)) return null;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  if (!Array.isArray(permissions)) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    userId: UserId.create(userId),
    tenantId: TenantId.create(tenantId),
    displayName,
    permissions: permissions.filter(isPermissionCode).map(permissionCode),
    token,
    expiresAt,
  };
}

/** 会话访问期是否已过（客户端预判——权威判定在服务端）。 */
export function isTokenSessionExpired(session: TokenSession, nowMs: number = Date.now()): boolean {
  return nowMs >= Date.parse(session.expiresAt);
}
