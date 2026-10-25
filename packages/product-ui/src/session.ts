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
    // 精确权限码（非 '*' bypass）：菜单按码过滤的用户管理/角色授权可见性证据。
    // S3-a：补组织/基础数据 backfill 六资源码 + audit:read（0920 #3/#7/#8/#9/
    // #100/#103 页面可见面——机构/岗位挂系统管理组，客户/供应商/计量单位挂
    // 基础数据组，操作日志页挂 audit:read；operator 不动，菜单过滤证据面保持）。
    permissions: [
      permissionCode('user:read'),
      permissionCode('user:write'),
      permissionCode('role:read'),
      permissionCode('role:write'),
      permissionCode('department:read'),
      permissionCode('department:write'),
      permissionCode('position:read'),
      permissionCode('position:write'),
      permissionCode('customer:read'),
      permissionCode('customer:write'),
      permissionCode('supplier:read'),
      permissionCode('supplier:write'),
      permissionCode('unit:read'),
      permissionCode('unit:write'),
      permissionCode('audit:read'),
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
    // S2 批次：桌面菜单码全部切后端控制器实态 :read 码——操作员按"车间岗
    // 位桌面可见面"授制造运营 + 报工 + 工时统计 + 库存两页的读码；采购/质检/
    // 盘点/发货/成本/工艺基线/组织管理均不授予（菜单按码过滤的证据面）。
    // （workorder:access/dispatch:access 两个 M1 菜单占位码随占位页退役移除。）
    // S3-d：增授配件申请/故障上报动作码（移动端 m.parts/m.fault 页可见——
    // 117 配件申请与 127 故障上报是现场工人动作；桌面菜单门控全在 :read 码，
    // 桌面可见面不变）。
    permissions: [
      permissionCode('workbench:read'),
      permissionCode('item:read'),
      permissionCode('scan:read'),
      permissionCode('report:submit'),
      permissionCode('hours:read'),
      permissionCode('stock:read'),
      permissionCode('workorder:read'),
      permissionCode('parts:read'),
      permissionCode('listing:read'),
      permissionCode('gap:read'),
      permissionCode('dispatch:read'),
      permissionCode('outsourcing:read'),
      permissionCode('report:read'),
      permissionCode('parts:request'),
      permissionCode('fault:report'),
    ],
  },
  {
    userId: UserId.create('user-demo-lead'),
    tenantId: TenantId.create('tenant-demo'),
    email: 'lead@demo.local',
    displayName: '演示班长',
    // S3-d：移动呈现批次的动作码承载身份（覆盖矩阵 §3.2 19 项的呈现可见面
    // 证据——核查/审批/判定/入库/调拨/盘点全径 + 工人查询页）。小厂单班长
    // 兼质检与库管的演示口径；读码按各移动页队列读取实态同码（verify 队列
    // report:read、配件队列 parts:read、质检队列 inspection:read、盘点台账
    // stocktake:read）。桌面菜单可见面：工作令/配件/报工/核查/质检/库存/
    // 盘点/实时库存（全部 :read 码同构，桌面证据面不受影响）。
    permissions: [
      permissionCode('workbench:read'),
      permissionCode('report:read'),
      permissionCode('report:verify'),
      permissionCode('workorder:read'),
      permissionCode('parts:read'),
      permissionCode('parts:request'),
      permissionCode('parts:approve'),
      permissionCode('inspection:read'),
      permissionCode('inspection:judge'),
      permissionCode('fault:report'),
      permissionCode('stock:read'),
      permissionCode('stock:receive'),
      permissionCode('stock:transfer'),
      permissionCode('stocktake:read'),
      permissionCode('stocktake:record'),
      permissionCode('stocktake:approve'),
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
