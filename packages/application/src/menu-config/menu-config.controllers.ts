/**
 * 菜单管理路由（T 波 #98/99）。控制器零逻辑：解析输入 → 委托
 * MenuConfigService；租户一律取 TenantContext（ALS）当前值（ADR-0005：
 * 租户身份不从请求体进）。
 *
 * 权限码（ADR-0010 通用词）：
 *   GET  /menu-config/configs               menu:read
 *   POST /menu-config/configs               menu:write
 *   GET  /menu-config/configs/:id           menu:read
 *   PUT  /menu-config/configs/:id           menu:write（期望态更新）
 *   GET  /menu-config/permission-codes      menu:read（读实态定权限码）
 */
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { MenuConfigService } from './menu-config.service.js';

@Controller('menu-config')
export class MenuConfigController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly menuConfig: MenuConfigService,
  ) {}

  @Get('configs')
  @RequirePermission('menu:read')
  async list(): Promise<{ configs: Awaited<ReturnType<MenuConfigService['listConfigs']>> }> {
    return { configs: await this.menuConfig.listConfigs(this.tenantContext.current()) };
  }

  @Post('configs')
  @RequirePermission('menu:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MenuConfigService['createConfig']>>> {
    return this.menuConfig.createConfig(this.tenantContext.current(), body);
  }

  @Get('configs/:id')
  @RequirePermission('menu:read')
  async get(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<MenuConfigService['getConfig']>>> {
    return this.menuConfig.getConfig(this.tenantContext.current(), id);
  }

  @Put('configs/:id')
  @RequirePermission('menu:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MenuConfigService['updateConfig']>>> {
    return this.menuConfig.updateConfig(this.tenantContext.current(), id, body);
  }

  @Get('permission-codes')
  @RequirePermission('menu:read')
  async permissionCodes(): Promise<{
    codes: Awaited<ReturnType<MenuConfigService['listPermissionCodes']>>;
  }> {
    return { codes: await this.menuConfig.listPermissionCodes(this.tenantContext.current()) };
  }
}
