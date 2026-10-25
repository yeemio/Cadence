/**
 * OrgService —— 组织/用户/角色管理用例（M1 增量 3-D，core 基础层章程）。
 *
 * 零框架业务类（不 import @nestjs/*）：元数据/账户存 UserStore/RoleStore 端口，
 * 授权绑定（用户-角色 g 规则、角色-权限 p 规则）一律经 PermissionService
 * 走 casbin autoSave → PolicyStore 同一条写通路径——与 dev 策略钩子写的
 * 是同一事实源，正式端点与测试钩子并存而不分叉。
 *
 * 授权语义 = 期望态 set（PUT）：与现状 diff 后 apply 新增 / revoke 移除，
 * 幂等可重放；不做增量 patch（管理页一次提交全量期望，避免乱序补丁）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import { PermissionService } from '../core/auth/permission.service.js';
import { splitPermissionCode } from '../core/auth/permission-code.js';
import type { PermissionCode } from '../core/auth/permission-code.js';
import type { PolicyRule, RoleName } from '../core/auth/policy-store.js';
import type { SessionRevoker } from '../auth/session-stores.js';
import { InMemoryDepartmentStore, InMemoryPositionStore } from './in-memory-org-stores.js';
import { OrgInputError, OrgNotFoundError } from './org-errors.js';
import {
  parseBackfillIdParam,
  parseCreateDepartmentInput,
  parseCreatePositionInput,
  parseCreateRoleInput,
  parseCreateUserInput,
  parsePermissionCodesInput,
  parseRoleNameParam,
  parseRoleNamesInput,
  parseUpdateDepartmentInput,
  parseUpdatePositionInput,
  parseUserIdParam,
  parseUserStatusInput,
} from './org-input.js';
import type {
  DepartmentMaster,
  DepartmentStore,
  PositionMaster,
  PositionStore,
  RoleDefinition,
  RoleStore,
  UserAccount,
  UserStore,
} from './org-stores.js';

/** 角色管理页视图：元数据 + 该角色在当前租户被直接授予的权限码（不含 admin bypass）。 */
export interface RoleGrantView {
  readonly name: RoleName;
  readonly displayName: string;
  readonly permissions: readonly PermissionCode[];
}

export interface GrantDiff {
  readonly granted: number;
  readonly revoked: number;
}

export class OrgService {
  constructor(
    private readonly users: UserStore,
    private readonly roles: RoleStore,
    private readonly permissions: PermissionService,
    /**
     * 会话撤销依赖（可选，收尾波-③）：users.active=false 时全端下线。
     * 组合根注入 SessionStore；独立装配（单模块测试）缺省 null = 不撤销。
     */
    private readonly sessions: SessionRevoker | null = null,
    /**
     * 机构/岗位主数据存储（S1 backfill，可选尾参）：OrgModule.register 恒显式
     * 注入（PG 或内存实例）；缺省回落内存实现，兼容只测 users/roles 的既有
     * 直接构造形态（构造签名零破坏）。
     */
    private readonly departments: DepartmentStore = new InMemoryDepartmentStore(),
    private readonly positions: PositionStore = new InMemoryPositionStore(),
  ) {}

  // ---- 用户 ----

  async createUser(tenant: TenantId, input: unknown): Promise<UserAccount> {
    const parsed = parseCreateUserInput(input);
    return this.users.create({ tenant, ...parsed });
  }

  async listUsers(tenant: TenantId): Promise<readonly UserAccount[]> {
    return this.users.list(tenant);
  }

  /**
   * 期望态设置 users.active（PUT /org/users/:id/status，收尾波-③）。
   *
   * 取舍（写明）：
   *  - 管理员不能停自己（active=false 且目标 = 操作者 → 400）——防止唯一
   *    管理员把自己锁在门外；重新激活自己不受限（本就 active）；
   *  - 停用即全端撤销该用户会话（写时撤销，主防线）；refresh 口的 active
   *    复查是双保险（见 AuthService.refresh）；
   *  - 恢复启用不自动恢复任何会话——用户重新登录。
   */
  async setUserStatus(
    tenant: TenantId,
    userId: string,
    actor: UserId,
    input: unknown,
  ): Promise<UserAccount> {
    const { active } = parseUserStatusInput(input);
    const id = parseUserIdParam(userId);
    const target = await this.users.find(tenant, id);
    if (target === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在用户 '${userId}'`);
    }
    if (!active && target.id === actor) {
      throw new OrgInputError(
        `不能停用自己的账户（操作者 '${actor}' 即目标用户）——请由其他管理员操作`,
      );
    }
    const updated = await this.users.updateStatus(tenant, id, active);
    if (updated === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在用户 '${userId}'`);
    }
    if (!active && this.sessions !== null) {
      await this.sessions.revokeAllForUser(tenant, id);
    }
    return updated;
  }

  /** 期望态设置用户在当前租户的角色集合（PUT /org/users/:id/roles）。 */
  async setUserRoles(tenant: TenantId, userId: string, input: unknown): Promise<GrantDiff> {
    const user = await this.users.find(tenant, parseUserIdParam(userId));
    if (user === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在用户 '${userId}'`);
    }
    const nextNames = parseRoleNamesInput(input);
    for (const name of nextNames) {
      const exists = await this.roles.find(tenant, name);
      if (exists === null) {
        throw new OrgNotFoundError(`租户 '${tenant}' 内不存在角色 '${name}'（先创建角色元数据）`);
      }
    }

    const currentNames = await this.permissions.rolesOf(tenant, user.id);
    const current = new Set(currentNames);
    const next = new Set<string>(nextNames);
    const toGrant = [...next].filter((name) => !current.has(name));
    const toRevoke = [...current].filter((name) => !next.has(name));

    await this.permissions.apply(
      toGrant.map<PolicyRule>((name) => ({
        kind: 'grant-role',
        tenant,
        user: user.id,
        role: name as RoleName,
      })),
    );
    await this.permissions.revoke(
      toRevoke.map<PolicyRule>((name) => ({
        kind: 'grant-role',
        tenant,
        user: user.id,
        role: name as RoleName,
      })),
    );
    return { granted: toGrant.length, revoked: toRevoke.length };
  }

  // ---- 角色 ----

  async createRole(tenant: TenantId, input: unknown): Promise<RoleDefinition> {
    const parsed = parseCreateRoleInput(input);
    return this.roles.create({ tenant, ...parsed });
  }

  async listRoles(tenant: TenantId): Promise<readonly RoleGrantView[]> {
    const definitions = await this.roles.list(tenant);
    return Promise.all(
      definitions.map(async (definition) => ({
        name: definition.name,
        displayName: definition.displayName,
        permissions: await this.permissions.permissionsOfRole(tenant, definition.name),
      })),
    );
  }

  /** 期望态设置角色在当前租户的权限码集合（PUT /org/roles/:name/permissions）。 */
  async setRolePermissions(
    tenant: TenantId,
    roleNameParam: string,
    input: unknown,
  ): Promise<GrantDiff> {
    const name = parseRoleNameParam(roleNameParam);
    const definition = await this.roles.find(tenant, name);
    if (definition === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在角色 '${name}'`);
    }
    const nextCodes = parsePermissionCodesInput(input);
    const currentCodes = await this.permissions.permissionsOfRole(tenant, name);
    const current = new Set<string>(currentCodes);
    const next = new Set<string>(nextCodes);
    const toGrant = [...next].filter((code) => !current.has(code));
    const toRevoke = [...current].filter((code) => !next.has(code));

    await this.permissions.apply(
      toGrant.map<PolicyRule>((code) => {
        const { resource, action } = splitPermissionCode(code as PermissionCode);
        return { kind: 'grant-permission', tenant, role: name, resource, action };
      }),
    );
    await this.permissions.revoke(
      toRevoke.map<PolicyRule>((code) => {
        const { resource, action } = splitPermissionCode(code as PermissionCode);
        return { kind: 'grant-permission', tenant, role: name, resource, action };
      }),
    );
    return { granted: toGrant.length, revoked: toRevoke.length };
  }

  // ---- 机构/部门（S1 backfill：0920 #3） ----

  /**
   * 创建机构节点。parentId 存在性校验（404）；树形取舍（写明）：
   * 服务端守卫"父存在 + 换挂不成环"，**不做删除级联与层级深度限制**（M2 用户
   * 归属/数据权限只消费引用，深度由实施配置决定）；list 返回平铺全集
   * （code 升序），前端组树——后端不产嵌套视图（组树是纯呈现变换，避免
   * 双份形状漂移）。
   */
  async createDepartment(tenant: TenantId, input: unknown): Promise<DepartmentMaster> {
    const parsed = parseCreateDepartmentInput(input);
    await this.requireDepartment(tenant, parsed.parentId ?? null, 'parentId');
    return this.departments.create({ tenant, ...parsed });
  }

  async listDepartments(tenant: TenantId): Promise<readonly DepartmentMaster[]> {
    return this.departments.list(tenant);
  }

  async updateDepartment(tenant: TenantId, idParam: string, input: unknown): Promise<DepartmentMaster> {
    const id = parseBackfillIdParam(idParam, '机构');
    const parsed = parseUpdateDepartmentInput(input);
    const target = await this.departments.find(tenant, id);
    if (target === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在机构 '${id}'`);
    }
    if (parsed.parentId !== undefined) {
      // 自引用与成环守卫：父链从新父出发上溯，遇自身即拒绝（400）；挂顶层（null）免检。
      if (parsed.parentId === id) {
        throw new OrgInputError(`机构 '${id}' 不能以自身为父（parentId = id）`);
      }
      await this.requireDepartment(tenant, parsed.parentId, 'parentId');
      if (parsed.parentId !== null) {
        await this.assertNoCycle(tenant, id, parsed.parentId);
      }
    }
    const updated = await this.departments.update(tenant, id, parsed);
    if (updated === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在机构 '${id}'`);
    }
    return updated;
  }

  private async requireDepartment(tenant: TenantId, id: string | null, field: string): Promise<void> {
    if (id === null) return;
    const parent = await this.departments.find(tenant, id);
    if (parent === null) {
      throw new OrgNotFoundError(`字段 '${field}' 引用的机构 '${id}' 在租户 '${tenant}' 内不存在（先创建父机构）`);
    }
  }

  /** 换挂成环校验：沿新父的父链上溯，命中自身 = 环（深度上界 = 节点总数守卫）。 */
  private async assertNoCycle(tenant: TenantId, selfId: string, newParentId: string): Promise<void> {
    const all = await this.departments.list(tenant);
    const byId = new Map(all.map((node) => [node.id, node]));
    let cursor: string | null = newParentId;
    for (let hops = 0; hops <= all.length; hops += 1) {
      if (cursor === null) return; // 到达顶层：无环
      if (cursor === selfId) {
        throw new OrgInputError(
          `机构 '${selfId}' 不能挂到自身后代 '${newParentId}' 之下（将成环）`,
        );
      }
      const node = byId.get(cursor);
      if (node === undefined) {
        throw new OrgNotFoundError(`字段 'parentId' 引用的机构 '${cursor}' 在租户 '${tenant}' 内不存在`);
      }
      cursor = node.parentId;
    }
    // 父链超过节点总数仍未到顶层 = 存量数据本身成环（防御分支，正常不可达）
    throw new OrgInputError(`机构父链超过节点总数（存量数据疑似成环），拒绝换挂`);
  }

  // ---- 岗位（S1 backfill：0920 #7） ----

  async createPosition(tenant: TenantId, input: unknown): Promise<PositionMaster> {
    const parsed = parseCreatePositionInput(input);
    await this.requireDepartment(tenant, parsed.departmentRef ?? null, 'departmentRef');
    return this.positions.create({ tenant, ...parsed });
  }

  async listPositions(tenant: TenantId): Promise<readonly PositionMaster[]> {
    return this.positions.list(tenant);
  }

  async updatePosition(tenant: TenantId, idParam: string, input: unknown): Promise<PositionMaster> {
    const id = parseBackfillIdParam(idParam, '岗位');
    const parsed = parseUpdatePositionInput(input);
    const target = await this.positions.find(tenant, id);
    if (target === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在岗位 '${id}'`);
    }
    if (parsed.departmentRef !== undefined) {
      await this.requireDepartment(tenant, parsed.departmentRef, 'departmentRef');
    }
    const updated = await this.positions.update(tenant, id, parsed);
    if (updated === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在岗位 '${id}'`);
    }
    return updated;
  }
}
