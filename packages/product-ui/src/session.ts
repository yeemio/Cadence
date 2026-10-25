/**
 * mock 会话与身份（M1 骨架；真实鉴权后端对接是非目标）。
 *
 * 登录 MPA 入口与主壳共享同一 SessionStore：会话事实落在浏览器存储，
 * 两个独立 bundle 之间不共享任何运行时状态——这正是登录独立入口的隔离前提。
 */
import { TenantId, UserId } from '@smes/business-core';
import type { TenantId as TenantIdType, UserId as UserIdType } from '@smes/business-core';
import { isPermissionCode, permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 已建立会话的视图模型。 */
export interface MockSession {
  readonly userId: UserIdType;
  readonly tenantId: TenantIdType;
  readonly displayName: string;
  readonly permissions: readonly PermissionCode[];
}

/** 演示身份表条目（真实实现由鉴权后端取代）。 */
export interface MockIdentity {
  readonly userId: UserIdType;
  readonly tenantId: TenantIdType;
  readonly email: string;
  readonly displayName: string;
  readonly permissions: readonly PermissionCode[];
}

export const DEMO_IDENTITIES: readonly MockIdentity[] = [
  {
    userId: UserId.create('user-demo-admin'),
    tenantId: TenantId.create('tenant-demo'),
    email: 'admin@demo.local',
    displayName: '演示管理员',
    permissions: ['*' as PermissionCode],
  },
  {
    userId: UserId.create('user-demo-org-admin'),
    tenantId: TenantId.create('tenant-demo'),
    email: 'org-admin@demo.local',
    displayName: '演示组织管理员',
    // 精确权限码（非 '*' bypass）：菜单按码过滤的用户管理/角色授权可见性证据
    permissions: [
      permissionCode('user:read'),
      permissionCode('user:write'),
      permissionCode('role:read'),
      permissionCode('role:write'),
    ],
  },
  {
    userId: UserId.create('user-demo-operator'),
    tenantId: TenantId.create('tenant-demo'),
    email: 'operator@demo.local',
    displayName: '演示操作员',
    // M1 增量 4-I：补工作台与物品读取（工作台首页可见 + 基础数据-物品页可见；
    // 资源/待办写/组织管理均不授予——菜单按码过滤的证据面）。
    // M1 收尾波-②：补扫码读取（制造运营-扫码页可见；M2 报工将消费扫码结果）。
    // M5 预研：补报工提交（扫码报工页可见；report 为 ADR-0010 内核白名单通用词，
    // 码与 M2 reporting 后端端点同码 report:submit）。
    // M5 首波：补工时/库存读取（移动端 m.hours/m.stock 页可见——车间工人
    // demo 身份按"移动四页全见"口径授码，与后端 /hours/my、/inventory/stock 同码）。
    permissions: [
      permissionCode('workorder:access'),
      permissionCode('dispatch:access'),
      permissionCode('workbench:read'),
      permissionCode('item:read'),
      permissionCode('scan:read'),
      permissionCode('report:submit'),
      permissionCode('hours:read'),
      permissionCode('stock:read'),
    ],
  },
];

/**
 * mock 凭据校验：邮箱在身份表中精确匹配且口令非空即通过。
 * 返回新会话（不写存储——写入由调用方决定）。
 */
export function authenticateMockIdentity(
  identities: readonly MockIdentity[],
  email: string,
  password: string,
): MockSession | null {
  const normalized = email.trim();
  if (normalized.length === 0 || password.length === 0) return null;
  const identity = identities.find((candidate) => candidate.email === normalized);
  if (identity === undefined) return null;
  return {
    userId: identity.userId,
    tenantId: identity.tenantId,
    displayName: identity.displayName,
    permissions: [...identity.permissions],
  };
}

/** 会话存储抽象：mock 与真实实现都只依赖这四个动作。 */
export interface SessionStore {
  read(): MockSession | null;
  write(session: MockSession): void;
  clear(): void;
}

/** 测试用内存存储。 */
export function createMemorySessionStore(): SessionStore {
  let current: MockSession | null = null;
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

export const DEFAULT_SESSION_STORAGE_KEY = 'cadence.session.v1';

/** 浏览器存储适配（localStorage / sessionStorage 均可注入）。损坏内容一律读作空。 */
export function createBrowserSessionStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string = DEFAULT_SESSION_STORAGE_KEY,
): SessionStore {
  return {
    read() {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try {
        return parseSession(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    write(session: MockSession): void {
      storage.setItem(key, JSON.stringify(session));
    },
    clear(): void {
      storage.removeItem(key);
    },
  };
}

function parseSession(value: unknown): MockSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { userId, tenantId, displayName, permissions } = record;
  if (typeof userId !== 'string' || !UserId.is(userId)) return null;
  if (typeof tenantId !== 'string' || !TenantId.is(tenantId)) return null;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  if (!Array.isArray(permissions)) return null;
  return {
    userId: UserId.create(userId),
    tenantId: TenantId.create(tenantId),
    displayName,
    permissions: permissions.filter(isPermissionCode).map(permissionCode),
  };
}
