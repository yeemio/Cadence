/**
 * 组织管理路由（M1 增量 3-D）——正式 CRUD 端点（替代 dev 策略钩子的使命，
 * 两者并存：本端点带 RBAC 门禁与租户收口，dev 钩子仍默认关闭保留）。
 *
 * 权限码（ADR-0010 通用词）：
 *   GET  /org/users                    user:read
 *   POST /org/users                    user:write
 *   PUT  /org/users/:id/roles          user:write
 *   PUT  /org/users/:id/status         user:write（active 启停，收尾波-③）
 *   GET  /org/roles                    role:read
 *   POST /org/roles                    role:write
 *   PUT  /org/roles/:name/permissions  role:write
 *
 * 控制器零逻辑：解析输入（parse*，违规 OrgInputError → 组合根过滤器 400）、
 * 委托 OrgService、租户一律取 TenantContext（ALS）当前值——租户身份不从
 * 请求体/参数进（ADR-0005：租户身份从上下文进，不依赖请求自报）。
 * status 端点的操作者身份取 REQUEST_USER_KEY（AuthGuard 写入）——
 * "管理员不能停自己"按操作者判定，不从请求体自报。
 */
import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { OrgService } from './org.service.js';

@Controller('org/users')
export class OrgUsersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly org: OrgService,
  ) {}

  @Get()
  @RequirePermission('user:read')
  async list(): Promise<{ users: Awaited<ReturnType<OrgService['listUsers']>> }> {
    return { users: await this.org.listUsers(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('user:write')
  async create(@Body() body: unknown): Promise<Awaited<ReturnType<OrgService['createUser']>>> {
    return this.org.createUser(this.tenantContext.current(), body);
  }

  @Put(':id/roles')
  @RequirePermission('user:write')
  async setRoles(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['setUserRoles']>>> {
    return this.org.setUserRoles(this.tenantContext.current(), id, body);
  }

  @Put(':id/status')
  @RequirePermission('user:write')
  async setStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Awaited<ReturnType<OrgService['setUserStatus']>>> {
    return this.org.setUserStatus(this.tenantContext.current(), id, request[REQUEST_USER_KEY], body);
  }
}

@Controller('org/roles')
export class OrgRolesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly org: OrgService,
  ) {}

  @Get()
  @RequirePermission('role:read')
  async list(): Promise<{ roles: Awaited<ReturnType<OrgService['listRoles']>> }> {
    return { roles: await this.org.listRoles(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('role:write')
  async create(@Body() body: unknown): Promise<Awaited<ReturnType<OrgService['createRole']>>> {
    return this.org.createRole(this.tenantContext.current(), body);
  }

  @Put(':name/permissions')
  @RequirePermission('role:write')
  async setPermissions(
    @Param('name') name: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['setRolePermissions']>>> {
    return this.org.setRolePermissions(this.tenantContext.current(), name, body);
  }
}

/**
 * 机构管理路由（S1 backfill：0920 #3）。
 *
 * 权限码（ADR-0010 通用词三问：department 是跨离散制造行业通用组织词——
 * 不绑定机加工语义，无行业专属名词可替代，动作面恒 read/write 两分）：
 *   GET /org/departments        department:read
 *   POST /org/departments       department:write
 *   PUT /org/departments/:id    department:write
 */
@Controller('org/departments')
export class OrgDepartmentsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly org: OrgService,
  ) {}

  @Get()
  @RequirePermission('department:read')
  async list(): Promise<{ departments: Awaited<ReturnType<OrgService['listDepartments']>> }> {
    return { departments: await this.org.listDepartments(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('department:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['createDepartment']>>> {
    return this.org.createDepartment(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('department:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['updateDepartment']>>> {
    return this.org.updateDepartment(this.tenantContext.current(), id, body);
  }
}

/**
 * 岗位管理路由（S1 backfill：0920 #7；position 为通用词，同上三问通过）：
 *   GET /org/positions        position:read
 *   POST /org/positions       position:write
 *   PUT /org/positions/:id    position:write
 */
@Controller('org/positions')
export class OrgPositionsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly org: OrgService,
  ) {}

  @Get()
  @RequirePermission('position:read')
  async list(): Promise<{ positions: Awaited<ReturnType<OrgService['listPositions']>> }> {
    return { positions: await this.org.listPositions(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('position:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['createPosition']>>> {
    return this.org.createPosition(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('position:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<OrgService['updatePosition']>>> {
    return this.org.updatePosition(this.tenantContext.current(), id, body);
  }
}
