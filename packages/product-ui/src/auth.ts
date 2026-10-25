/**
 * refine 无头模式 authProvider 形状与 mock 实现（ADR-0006：CRUD 数据层 refine headless，
 * UI 层自持——本包不引入任何 UI 组件库预设）。
 *
 * refine v5 契约：login / logout / check / onError 必选；
 * getPermissions / getIdentity 可选。响应形状：
 * - AuthActionResponse（login/logout）：{ success, redirectTo?, error? }
 * - CheckResponse（check）：{ authenticated, redirectTo?, logout?, error? }
 */
import type {
  AuthActionResponse,
  AuthProvider,
  CheckResponse,
  OnErrorResponse,
} from '@refinedev/core';
import { TenantId, UserId } from '@smes/business-core';
import { ADMIN_PERMISSION, isPermissionCode, permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';
import {
  authenticateMockIdentity,
  createMemorySessionStore,
  DEMO_IDENTITIES,
} from './session.js';
import type { MockIdentity, MockSession, SessionStore } from './session.js';
import { createMemoryTokenSessionStore } from './token-session.js';
import type { TokenSession, TokenSessionStore } from './token-session.js';

export interface MockAuthProviderOptions {
  /** mock 身份表，默认 DEMO_IDENTITIES */
  readonly identities?: readonly MockIdentity[];
  /** 会话存储，默认内存存储（浏览器装配层应注入 browser store） */
  readonly store?: SessionStore;
  /** 未认证跳转路径，默认 '/login' */
  readonly loginPath?: string;
  /** 登录成功跳转路径，默认 '/' */
  readonly homePath?: string;
}

/**
 * mock authProvider：login / check / logout / getPermissions（+getIdentity）骨架。
 * 凭据语义见 authenticateMockIdentity；会话事实全部落在注入的 SessionStore。
 */
export function createMockAuthProvider(options: MockAuthProviderOptions = {}): AuthProvider {
  const identities = options.identities ?? DEMO_IDENTITIES;
  const store: SessionStore = options.store ?? createMemorySessionStore();
  const loginPath = options.loginPath ?? '/login';
  const homePath = options.homePath ?? '/';

  const session = (): MockSession | null => store.read();

  return {
    login: async (params: { email?: unknown; password?: unknown }): Promise<AuthActionResponse> => {
      const next = authenticateMockIdentity(
        identities,
        typeof params?.email === 'string' ? params.email : '',
        typeof params?.password === 'string' ? params.password : '',
      );
      if (next === null) {
        return { success: false, error: new Error('登录失败：邮箱或口令不符合演示身份表') };
      }
      store.write(next);
      return { success: true, redirectTo: homePath };
    },
    logout: async (): Promise<AuthActionResponse> => {
      store.clear();
      return { success: true, redirectTo: loginPath };
    },
    check: async (): Promise<CheckResponse> => {
      if (session() === null) {
        return { authenticated: false, redirectTo: loginPath };
      }
      return { authenticated: true };
    },
    onError: async (): Promise<OnErrorResponse> => ({}),
    getPermissions: async (): Promise<readonly PermissionCode[]> =>
      session()?.permissions ?? [],
    getIdentity: async (): Promise<
      { userId: string; tenantId: string; displayName: string } | null
    > => {
      const current = session();
      return current === null
        ? null
        : { userId: current.userId, tenantId: current.tenantId, displayName: current.displayName };
    },
  };
}

/** refine usePermissions 返回 unknown——装配层用本函数收敛为权限码数组。 */
export function toPermissionCodes(value: unknown): readonly PermissionCode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPermissionCode);
}

/** 会话是否具备给定权限码（admin bypass 含在内）。 */
export function sessionHasPermission(
  permissions: readonly PermissionCode[],
  code: PermissionCode,
): boolean {
  return permissions.includes(ADMIN_PERMISSION) || permissions.includes(code);
}

// ---------------------------------------------------------------------------
// 真实认证 authProvider（M1 收尾波-③）：Bearer token 会话 + 注入式传输层。
// 本包保持零 fetch 纪律（视图模型/无头形状层）——HTTP 装配在 apps/web
// （src/data/authApi.ts 以 AuthTransport 形状注入）。
// ---------------------------------------------------------------------------

/**
 * 服务端明确拒绝（401）——与网络失败（其他 Error）可区分：
 * 会话规则据此判定"仅服务端明确拒绝才登出，网络失败不清会话"。
 */
export class AuthRejectedError extends Error {
  constructor(message = '服务端拒绝了当前会话') {
    super(message);
    this.name = 'AuthRejectedError';
  }
}

/** /auth/login 与 /auth/refresh 的响应形状（token 只在此出现）。 */
export interface AuthSessionPayload {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: {
    readonly id: string;
    readonly tenant: string;
    readonly username: string;
    readonly displayName: string;
  };
  /** admin=true 时前端以 '*'（ADMIN_PERMISSION）参与本地权限过滤。 */
  readonly admin: boolean;
  readonly permissions: readonly PermissionCode[];
}

/** 认证传输层（apps/web 装配 fetch；测试注入假实现）。 */
export interface AuthTransport {
  login(username: string, password: string): Promise<AuthSessionPayload>;
  /** 会话检查（GET /auth/me）：token 无效抛 AuthRejectedError。 */
  me(token: string): Promise<AuthSessionPayload>;
  /** 续期（POST /auth/refresh）：旧 token 换新；无效/过窗抛 AuthRejectedError。 */
  refresh(token: string): Promise<AuthSessionPayload>;
  /** 登出（POST /auth/logout）：尽力而为——网络失败也应继续本地清会话。 */
  logout(token: string): Promise<void>;
}

export interface TokenAuthProviderOptions {
  readonly transport: AuthTransport;
  /** token 会话存储，默认内存存储（浏览器装配层应注入 browser store）。 */
  readonly store?: TokenSessionStore;
  /** 未认证跳转路径，默认 '/login'。 */
  readonly loginPath?: string;
  /** 登录成功跳转路径，默认 '/'。 */
  readonly homePath?: string;
}

function toSession(payload: AuthSessionPayload): TokenSession {
  return {
    userId: UserId.create(payload.user.id),
    tenantId: TenantId.create(payload.user.tenant),
    displayName: payload.user.displayName,
    permissions: payload.admin
      ? [ADMIN_PERMISSION]
      : payload.permissions.filter(isPermissionCode).map(permissionCode),
    token: payload.token,
    expiresAt: payload.expiresAt,
  };
}

/**
 * 服务端会话载荷 → 本地 TokenSession（admin 投影为 ADMIN_PERMISSION 通配码）。
 * authProvider 与保活模块共用同一投影（登录/检查/续期三路写入不分叉）。
 */
export function toTokenSession(payload: AuthSessionPayload): TokenSession {
  return toSession(payload);
}

/**
 * 真实 authProvider（refine v5 契约同 mock 版）：
 *  - login：transport.login → 写会话存储；
 *  - check：有 token → transport.me 验证并刷新存储（权限/有效期以服务端为准）；
 *    服务端明确拒绝（AuthRejectedError）→ 清会话跳登录；网络失败 → 保留会话
 *    （authenticated: true，下次 check 再验）；
 *  - logout：真实登出（尽力而为）+ 清本地；
 *  - getPermissions/getIdentity：读会话存储。
 */
export function createTokenAuthProvider(
  options: TokenAuthProviderOptions,
): AuthProvider {
  const transport = options.transport;
  const store: TokenSessionStore = options.store ?? createMemoryTokenSessionStore();
  const loginPath = options.loginPath ?? '/login';
  const homePath = options.homePath ?? '/';

  const session = (): TokenSession | null => store.read();

  return {
    login: async (params: {
      username?: unknown;
      password?: unknown;
    }): Promise<AuthActionResponse> => {
      const username = typeof params?.username === 'string' ? params.username.trim() : '';
      const password = typeof params?.password === 'string' ? params.password : '';
      if (username.length === 0 || password.length === 0) {
        return { success: false, error: new Error('请输入用户名与口令') };
      }
      try {
        const payload = await transport.login(username, password);
        store.write(toSession(payload));
        return { success: true, redirectTo: homePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error('登录失败'),
        };
      }
    },
    logout: async (): Promise<AuthActionResponse> => {
      const current = session();
      if (current !== null) {
        try {
          await transport.logout(current.token); // 尽力而为：网络失败也继续清本地
        } catch {
          /* 服务端会话至多存活到 TTL/撤销，本地清会话优先 */
        }
      }
      store.clear();
      return { success: true, redirectTo: loginPath };
    },
    check: async (): Promise<CheckResponse> => {
      const current = session();
      if (current === null) {
        return { authenticated: false, redirectTo: loginPath };
      }
      try {
        const payload = await transport.me(current.token);
        store.write(toSession(payload)); // 权限与有效期以服务端为准
        return { authenticated: true };
      } catch (error) {
        if (error instanceof AuthRejectedError) {
          store.clear();
          return { authenticated: false, redirectTo: loginPath, logout: true };
        }
        // 网络失败不清会话（ADR-0009 会话规则）：保留本地会话，下次再验
        return { authenticated: true };
      }
    },
    onError: async (error: unknown): Promise<OnErrorResponse> => {
      // 数据层 401 清会话由 apiClient 统一处理（装配层）；此处仅透传
      if (error instanceof AuthRejectedError) {
        return { logout: true };
      }
      return {};
    },
    getPermissions: async (): Promise<readonly PermissionCode[]> =>
      session()?.permissions ?? [],
    getIdentity: async (): Promise<
      { userId: string; tenantId: string; displayName: string } | null
    > => {
      const current = session();
      return current === null
        ? null
        : {
            userId: current.userId,
            tenantId: current.tenantId,
            displayName: current.displayName,
          };
    },
  };
}
