/**
 * InMemoryUserStore / InMemoryRoleStore —— 组织元数据端口先行实现（M1 增量 3-D）。
 *
 * 重启即失；PG 实现在 business-store（`./org` 子路径）。与 InMemoryPolicyStore
 * 同一形态：无 DATABASE_URL / 未注入存储时组合根回落到这里，保证零 DB boot
 * 语义完整（org 模块可装配、端点可用、判定仍经策略存储）。
 */
import { randomUUID } from 'node:crypto';
import { TenantId, UserId } from '@smes/business-core';
import type { RoleName } from '../core/auth/policy-store.js';
import { OrgConflictError } from './org-errors.js';
import type {
  CreateDepartmentInput,
  CreatePositionInput,
  CreateRoleInput,
  CreateUserInput,
  DepartmentMaster,
  DepartmentStore,
  PositionMaster,
  PositionStore,
  RoleDefinition,
  RoleStore,
  UpdateDepartmentInput,
  UpdatePositionInput,
  UserAccount,
  UserCredentials,
  UserStore,
} from './org-stores.js';

interface UserRow {
  readonly tenant: string;
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly active: boolean;
  /** 内存实现同 PG 形状：默认未设口令（不能登录）。 */
  passwordHash: string | null;
}

export class InMemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRow>(); // key: `${tenant}|${id}`

  async create(input: CreateUserInput): Promise<UserAccount> {
    const conflict = [...this.users.values()].find(
      (row) => row.tenant === input.tenant && row.username === input.username,
    );
    if (conflict !== undefined) {
      throw new OrgConflictError(
        `用户名 '${input.username}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: UserRow = {
      tenant: input.tenant,
      id: `user-${input.tenant}-${input.username}`,
      username: input.username,
      displayName: input.displayName,
      active: input.active ?? true,
      passwordHash: input.passwordHash ?? null,
    };
    this.users.set(`${row.tenant}|${row.id}`, row);
    return toAccount(row);
  }

  async list(tenant: TenantId): Promise<readonly UserAccount[]> {
    return [...this.users.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(toAccount);
  }

  async find(tenant: TenantId, id: UserId): Promise<UserAccount | null> {
    const row = this.users.get(`${tenant}|${id}`);
    return row === undefined ? null : toAccount(row);
  }

  async findByUsername(tenant: TenantId, username: string): Promise<UserCredentials | null> {
    const row = [...this.users.values()].find(
      (candidate) => candidate.tenant === tenant && candidate.username === username,
    );
    return row === undefined ? null : { account: toAccount(row), passwordHash: row.passwordHash };
  }

  async updateStatus(tenant: TenantId, id: UserId, active: boolean): Promise<UserAccount | null> {
    const key = `${tenant}|${id}`;
    const row = this.users.get(key);
    if (row === undefined) return null;
    const next: UserRow = { ...row, active };
    this.users.set(key, next);
    return toAccount(next);
  }

  async updatePassword(
    tenant: TenantId,
    id: UserId,
    passwordHash: string,
  ): Promise<UserAccount | null> {
    const key = `${tenant}|${id}`;
    const row = this.users.get(key);
    if (row === undefined) return null;
    const next: UserRow = { ...row, passwordHash };
    this.users.set(key, next);
    return toAccount(next);
  }
}

interface RoleRow {
  readonly tenant: string;
  readonly name: string;
  readonly displayName: string;
}

export class InMemoryRoleStore implements RoleStore {
  private readonly roles = new Map<string, RoleRow>(); // key: `${tenant}|${name}`

  async create(input: CreateRoleInput): Promise<RoleDefinition> {
    const key = `${input.tenant}|${input.name}`;
    if (this.roles.has(key)) {
      throw new OrgConflictError(
        `角色 '${input.name}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: RoleRow = {
      tenant: input.tenant,
      name: input.name,
      displayName: input.displayName,
    };
    this.roles.set(key, row);
    return toDefinition(row);
  }

  async list(tenant: TenantId): Promise<readonly RoleDefinition[]> {
    return [...this.roles.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toDefinition);
  }

  async find(tenant: TenantId, name: RoleName): Promise<RoleDefinition | null> {
    const row = this.roles.get(`${tenant}|${name}`);
    return row === undefined ? null : toDefinition(row);
  }
}

function toAccount(row: UserRow): UserAccount {
  return {
    id: UserId.create(row.id),
    tenant: TenantId.create(row.tenant),
    username: row.username,
    displayName: row.displayName,
    active: row.active,
    // D-2 P3 只读投影：从行内哈希派生存在性，哈希本体不出账户视图。
    hasPassword: row.passwordHash !== null,
  };
}

function toDefinition(row: RoleRow): RoleDefinition {
  return {
    tenant: TenantId.create(row.tenant),
    name: roleNameValue(row.name),
    displayName: row.displayName,
  };
}

function roleNameValue(value: string): RoleName {
  // 行内值由 create 入口（已校验）写入；此处不再重复校验形状
  return value as RoleName;
}

// ---------------------------------------------------------------------------
// 机构/部门与岗位（S1 backfill：0920 #3/#7）——与 InMemoryItemStore 同形态。
// ---------------------------------------------------------------------------

let backfillCounter = 0;

function nextBackfillId(prefix: string): string {
  backfillCounter += 1;
  return `${prefix}-${randomUUID()}-${backfillCounter.toString(36)}`;
}

interface DepartmentRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  parentId: string | null;
  active: boolean;
}

export class InMemoryDepartmentStore implements DepartmentStore {
  private readonly departments = new Map<string, DepartmentRow>(); // key: `${tenant}|${id}`

  async create(input: CreateDepartmentInput): Promise<DepartmentMaster> {
    const conflict = [...this.departments.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new OrgConflictError(
        `机构 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: DepartmentRow = {
      tenant: input.tenant,
      id: nextBackfillId('dept'),
      code: input.code,
      name: input.name,
      parentId: input.parentId ?? null,
      active: input.active ?? true,
    };
    this.departments.set(`${row.tenant}|${row.id}`, row);
    return toDepartmentMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly DepartmentMaster[]> {
    return [...this.departments.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toDepartmentMaster);
  }

  async find(tenant: TenantId, id: string): Promise<DepartmentMaster | null> {
    const row = this.departments.get(`${tenant}|${id}`);
    return row === undefined ? null : toDepartmentMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateDepartmentInput,
  ): Promise<DepartmentMaster | null> {
    const row = this.departments.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.parentId !== undefined) row.parentId = input.parentId;
    if (input.active !== undefined) row.active = input.active;
    return toDepartmentMaster(row);
  }
}

interface PositionRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  departmentRef: string | null;
  active: boolean;
}

export class InMemoryPositionStore implements PositionStore {
  private readonly positions = new Map<string, PositionRow>(); // key: `${tenant}|${id}`

  async create(input: CreatePositionInput): Promise<PositionMaster> {
    const conflict = [...this.positions.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new OrgConflictError(
        `岗位 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const row: PositionRow = {
      tenant: input.tenant,
      id: nextBackfillId('pos'),
      code: input.code,
      name: input.name,
      departmentRef: input.departmentRef ?? null,
      active: input.active ?? true,
    };
    this.positions.set(`${row.tenant}|${row.id}`, row);
    return toPositionMaster(row);
  }

  async list(tenant: TenantId): Promise<readonly PositionMaster[]> {
    return [...this.positions.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toPositionMaster);
  }

  async find(tenant: TenantId, id: string): Promise<PositionMaster | null> {
    const row = this.positions.get(`${tenant}|${id}`);
    return row === undefined ? null : toPositionMaster(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdatePositionInput,
  ): Promise<PositionMaster | null> {
    const row = this.positions.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.departmentRef !== undefined) row.departmentRef = input.departmentRef;
    if (input.active !== undefined) row.active = input.active;
    return toPositionMaster(row);
  }
}

function toDepartmentMaster(row: DepartmentRow): DepartmentMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    parentId: row.parentId,
    active: row.active,
  };
}

function toPositionMaster(row: PositionRow): PositionMaster {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    departmentRef: row.departmentRef,
    active: row.active,
  };
}
