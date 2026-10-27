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
import { hashPassword } from '../auth/password.js';
import { InMemoryDepartmentStore, InMemoryPositionStore } from './in-memory-org-stores.js';
import { OrgInputError, OrgNotFoundError } from './org-errors.js';
import { DEFAULT_PASSWORD_POLICY, passwordPolicyViolation } from './password-policy.js';
import type { PasswordPolicy } from './password-policy.js';
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
  parseUserPasswordInput,
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
    /**
     * 口令强度策略（M2 安全前置批 SP-4，可选尾参）：校验点仅设置口
     * （createUser 初始口令 / setUserPassword 重置）；登录不校验。缺省 =
     * 缺省策略（min 8、字符类关）；OrgModule.register 注入 env 覆写形态。
     */
    private readonly passwordPolicy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  ) {}

  // ---- 用户 ----

  async createUser(tenant: TenantId, input: unknown): Promise<UserAccount> {
    // 明文口令只到本层：scrypt 哈希后过端口（D-2）；不带 = 未设口令态（登录 401）
    const { password, ...rest } = parseCreateUserInput(input);
    if (password !== undefined) {
      this.requirePolicyPassword(password); // SP-4：设置口校验（登录口不校验）
    }
    return this.users.create({
      tenant,
      ...rest,
      ...(password === undefined ? {} : { passwordHash: hashPassword(password) }),
    });
  }

  /**
   * 用户列表（GET /org/users）：存储行原样透出——含 hasPassword 只读投影
   * （D-2 P3，存储行映射处从 passwordHash 派生），管理员据此区分"未设口令"
   * 用户；哈希本体不在 UserAccount 视图（认证专用，只走 findByUsername）。
   */
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

  /**
   * 管理员设置/重置口令（PUT /org/users/:id/password，D-2）。
   *
   * 取舍（写明）：
   *  - 哈希覆写 = 新口令即刻生效，旧口令即刻失效（同 username 下只有
   *    最新 hash 可验过——旧口令自然 401）；
   *  - 写时全端撤销该用户会话（对齐 users.active 启停的先例）：重置常
   *    出于口令泄露处置，已签发会话不应在旧凭据暴露下继续存活；用户
   *    以新口令重新登录。管理员重置自己也撤自己——无自锁风险（新口令
   *    是操作者刚设置的，重新登录即恢复）；
   *  - 停用用户也可设口令（口令与 active 正交——登录侧 active=false 恒拒）。
   */
  async setUserPassword(tenant: TenantId, userId: string, input: unknown): Promise<UserAccount> {
    const { password } = parseUserPasswordInput(input);
    const id = parseUserIdParam(userId);
    const target = await this.users.find(tenant, id);
    if (target === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在用户 '${userId}'`);
    }
    this.requirePolicyPassword(password); // SP-4：设置口校验（404 判定之后——目标不存在语义优先，与既有测试锚一致）
    const updated = await this.users.updatePassword(tenant, id, hashPassword(password));
    if (updated === null) {
      throw new OrgNotFoundError(`租户 '${tenant}' 内不存在用户 '${userId}'`);
    }
    if (this.sessions !== null) {
      await this.sessions.revokeAllForUser(tenant, id);
    }
    return updated;
  }

  /**
   * SP-4 策略校验：不满足 → OrgInputError 400 同族，文案含策略要求、不含
   * 口令本体与用户存在性（弱口令拒绝与"用户不存在"路径不可区分策略要求之外
   * 的任何信息）。
   */
  private requirePolicyPassword(password: string): void {
    const violation = passwordPolicyViolation(this.passwordPolicy, password);
    if (violation !== null) {
      throw new OrgInputError(violation);
    }
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
