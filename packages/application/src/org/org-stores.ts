/**
 * UserStore / RoleStore —— 组织元数据存储端口（M1 增量 3-D）。
 *
 * 与 PolicyStore 同一模式：端口在本包定义（业务形状），内存实现先行，
 * PG adapter 由 business-store 按 `./org` 子路径接入（组合根经
 * connectBusinessStore 装配）。词汇纪律（ADR-0010）：user/role/tenant
 * 均为跨离散制造行业通用词。
 *
 * 取舍：users/roles 是组织配置数据，不是业务事实——不套证据公共列、
 * 不套 append-only/supersedes 修正链（修正 = 直接改行；纪律只约束
 * 事实表，见 business-store 包 README）。端口因此只有 create/list/find
 * （+ 收尾波-③ 认证与启停扩展：findByUsername 含凭据读取、updateStatus），
 * 不含 delete（用户以 active=false 停用替代删除，避免悬挂引用）。
 */
import { TenantId, UserId } from '@smes/business-core';
import type { RoleName } from '../core/auth/policy-store.js';

/** 用户账户（组织元数据视图；不承载凭据——哈希只在 UserCredentials 出现）。 */
export interface UserAccount {
  readonly id: UserId;
  readonly tenant: TenantId;
  readonly username: string;
  readonly displayName: string;
  readonly active: boolean;
}

/**
 * 凭据视图（findByUsername 专用，M1 收尾波-③）：账户 + 口令哈希。
 * 哈希绝不出认证用例边界（不进 API 响应、不进日志）。
 */
export interface UserCredentials {
  readonly account: UserAccount;
  /** scrypt 自述格式串；组织端点创建的用户默认未设口令（null = 不能登录）。 */
  readonly passwordHash: string | null;
}

export interface CreateUserInput {
  readonly tenant: TenantId;
  readonly username: string;
  readonly displayName: string;
  /** 缺省 true。 */
  readonly active?: boolean;
  /**
   * 初始口令哈希（可选，收尾波-③ + D-2）：允许带哈希创建（种子/测试/
   * 管理端带初始口令建用户）。HTTP 端点入参带 password 时由用例层
   * hashPassword 后透传；不带 = null（未设口令态，不能登录）。
   */
  readonly passwordHash?: string;
}

/** 用户元数据存储端口。实现方保证：create 在租户内 username 冲突时抛 OrgConflictError。 */
export interface UserStore {
  create(input: CreateUserInput): Promise<UserAccount>;
  list(tenant: TenantId): Promise<readonly UserAccount[]>;
  /** 按 id 精确查找（租户内收口）。 */
  find(tenant: TenantId, id: UserId): Promise<UserAccount | null>;
  /** 按租户内 username 精确查找（含口令哈希——认证专用；租户内收口）。 */
  findByUsername(tenant: TenantId, username: string): Promise<UserCredentials | null>;
  /** 期望态设置 active（users.active 启停）；目标不存在返回 null（用例层转 404）。 */
  updateStatus(tenant: TenantId, id: UserId, active: boolean): Promise<UserAccount | null>;
  /**
   * 覆写口令哈希（D-2：管理员设置/重置口令）；目标不存在返回 null
   * （用例层转 404）。只收哈希——明文口令绝不过端口边界。
   */
  updatePassword(
    tenant: TenantId,
    id: UserId,
    passwordHash: string,
  ): Promise<UserAccount | null>;
}

/** 角色元数据（RBAC 角色名；角色-权限与用户-角色绑定存 PolicyStore，不在本表）。 */
export interface RoleDefinition {
  readonly tenant: TenantId;
  readonly name: RoleName;
  readonly displayName: string;
}

export interface CreateRoleInput {
  readonly tenant: TenantId;
  readonly name: RoleName;
  readonly displayName: string;
}

/** 角色元数据存储端口。实现方保证：create 在租户内角色名冲突时抛 OrgConflictError。 */
export interface RoleStore {
  create(input: CreateRoleInput): Promise<RoleDefinition>;
  list(tenant: TenantId): Promise<readonly RoleDefinition[]>;
  /** 按角色名精确查找（租户内收口）。 */
  find(tenant: TenantId, name: RoleName): Promise<RoleDefinition | null>;
}

// ---------------------------------------------------------------------------
// 机构/部门与岗位主数据（S1 backfill：0920 清单 #3 机构管理 / #7 岗位管理）。
// 与 users/roles 同一取舍：组织配置数据，非业务事实——不套证据公共列、
// 不套 append-only（修正 = 直接改行）。无 delete：机构/岗位将被用户归属与
// 数据权限引用，硬删引入悬挂引用；停用路径 = active=false（软停用）。
// ---------------------------------------------------------------------------

/** 机构/部门节点（树形最小集：code/name + parentId 自引用；层级语义由用例层守卫）。 */
export interface DepartmentMaster {
  readonly id: string;
  readonly tenant: TenantId;
  /** 租户内唯一业务键（人读稳定码，如 ORG-01）。 */
  readonly code: string;
  readonly name: string;
  /** 父机构 id（可空 = 顶层）；引用同租户 departments.id。 */
  readonly parentId: string | null;
  readonly active: boolean;
}

export interface CreateDepartmentInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly active?: boolean;
}

/** 字段级期望态更新：未提供的键不变；code 不可变；parentId 换挂须过环校验（用例层）。 */
export interface UpdateDepartmentInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly active?: boolean;
}

/**
 * 机构存储端口。实现方保证：
 * create 在租户内 code 冲突时抛 OrgConflictError；
 * update 对不存在的 id 返回 null（404 语义由用例层翻译）。
 */
export interface DepartmentStore {
  create(input: CreateDepartmentInput): Promise<DepartmentMaster>;
  list(tenant: TenantId): Promise<readonly DepartmentMaster[]>;
  find(tenant: TenantId, id: string): Promise<DepartmentMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateDepartmentInput): Promise<DepartmentMaster | null>;
}

/** 岗位主数据（供人员分类及工时统计引用——0920 #7；归属机构为可空引用）。 */
export interface PositionMaster {
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  /** 归属机构 id（可空 = 不挂机构）；引用同租户 departments.id。 */
  readonly departmentRef: string | null;
  readonly active: boolean;
}

export interface CreatePositionInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly departmentRef?: string | null;
  readonly active?: boolean;
}

export interface UpdatePositionInput {
  readonly name?: string;
  readonly departmentRef?: string | null;
  readonly active?: boolean;
}

/** 岗位存储端口（合同同 DepartmentStore，唯一键为租户内 code）。 */
export interface PositionStore {
  create(input: CreatePositionInput): Promise<PositionMaster>;
  list(tenant: TenantId): Promise<readonly PositionMaster[]>;
  find(tenant: TenantId, id: string): Promise<PositionMaster | null>;
  update(tenant: TenantId, id: string, input: UpdatePositionInput): Promise<PositionMaster | null>;
}
