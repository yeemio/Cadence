/**
 * OrgModule —— 组织/用户/角色管理模块（M1 增量 3-D）。
 *
 * ADR-0004 定位：core 基础层章程（组织权限）以独立可启停模块形态落进注册表
 * （MODULE_DEFINITIONS.org，默认装配）。存储端口注入点与 CoreModule.policyStore
 * 同一模式：组合根注入 PG 实现（business-store `./org`），缺省回落内存实现
 * （零 DB boot 语义完整）。PermissionService 由 CoreModule（global）导出注入。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { PermissionService } from '../core/auth/permission.service.js';
import type { SessionRevoker } from '../auth/session-stores.js';
import {
  InMemoryDepartmentStore,
  InMemoryPositionStore,
  InMemoryRoleStore,
  InMemoryUserStore,
} from './in-memory-org-stores.js';
import {
  OrgDepartmentsController,
  OrgPositionsController,
  OrgRolesController,
  OrgUsersController,
} from './org.controllers.js';
import { OrgService } from './org.service.js';
import type {
  DepartmentStore,
  PositionStore,
  RoleStore,
  UserStore,
} from './org-stores.js';

export const ORG_USER_STORE = Symbol('smes.org.userStore');
export const ORG_ROLE_STORE = Symbol('smes.org.roleStore');
export const ORG_DEPARTMENT_STORE = Symbol('smes.org.departmentStore');
export const ORG_POSITION_STORE = Symbol('smes.org.positionStore');

export interface OrgModuleOptions {
  /** 用户元数据存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly userStore?: UserStore | undefined;
  /** 角色元数据存储；缺省 = 内存实现。显式 undefined 同缺省。 */
  readonly roleStore?: RoleStore | undefined;
  /** 机构/部门存储（S1 backfill：0920 #3）；缺省 = 内存实现。 */
  readonly departmentStore?: DepartmentStore | undefined;
  /** 岗位存储（S1 backfill：0920 #7）；缺省 = 内存实现。 */
  readonly positionStore?: PositionStore | undefined;
  /**
   * 会话撤销依赖（可选，收尾波-③）：users.active=false 全端下线。
   * 组合根注入 SessionStore；缺省 null = 停用不撤会话（单模块装配形态）。
   */
  readonly sessionRevoker?: SessionRevoker | undefined;
}

@Module({})
export class OrgModule {
  static register(options: OrgModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: ORG_USER_STORE, useValue: options.userStore ?? new InMemoryUserStore() },
      { provide: ORG_ROLE_STORE, useValue: options.roleStore ?? new InMemoryRoleStore() },
      {
        provide: ORG_DEPARTMENT_STORE,
        useValue: options.departmentStore ?? new InMemoryDepartmentStore(),
      },
      {
        provide: ORG_POSITION_STORE,
        useValue: options.positionStore ?? new InMemoryPositionStore(),
      },
      {
        provide: OrgService,
        useFactory: (
          users: UserStore,
          roles: RoleStore,
          permissions: PermissionService,
          departments: DepartmentStore,
          positions: PositionStore,
        ) =>
          new OrgService(
            users,
            roles,
            permissions,
            options.sessionRevoker ?? null,
            departments,
            positions,
          ),
        inject: [
          ORG_USER_STORE,
          ORG_ROLE_STORE,
          PermissionService,
          ORG_DEPARTMENT_STORE,
          ORG_POSITION_STORE,
        ],
      },
    ];

    return {
      module: OrgModule,
      controllers: [
        OrgUsersController,
        OrgRolesController,
        OrgDepartmentsController,
        OrgPositionsController,
      ],
      providers,
    };
  }
}
