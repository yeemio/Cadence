/**
 * 基础数据路由（M1 增量 4-I）。控制器零逻辑：解析输入 → 委托 MasterdataService；
 * 租户一律取 TenantContext（ALS）当前值（ADR-0005：租户身份不从请求体进）。
 *
 * 权限码（ADR-0010 通用词，与 product-ui 常量一一对应）：
 *   GET  /masterdata/items        item:read
 *   POST /masterdata/items        item:write
 *   PUT  /masterdata/items/:id    item:write
 *   GET  /masterdata/resources    resource:read
 *   POST /masterdata/resources    resource:write
 *   PUT  /masterdata/resources/:id resource:write
 */
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { MasterdataService } from './masterdata.service.js';

@Controller('masterdata/items')
export class MasterdataItemsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly masterdata: MasterdataService,
  ) {}

  @Get()
  @RequirePermission('item:read')
  async list(): Promise<{ items: Awaited<ReturnType<MasterdataService['listItems']>> }> {
    return { items: await this.masterdata.listItems(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('item:write')
  async create(@Body() body: unknown): Promise<Awaited<ReturnType<MasterdataService['createItem']>>> {
    return this.masterdata.createItem(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('item:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['updateItem']>>> {
    return this.masterdata.updateItem(this.tenantContext.current(), id, body);
  }
}

@Controller('masterdata/resources')
export class MasterdataResourcesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly masterdata: MasterdataService,
  ) {}

  @Get()
  @RequirePermission('resource:read')
  async list(): Promise<{ resources: Awaited<ReturnType<MasterdataService['listResources']>> }> {
    return { resources: await this.masterdata.listResources(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('resource:write')
  async create(@Body() body: unknown): Promise<Awaited<ReturnType<MasterdataService['createResource']>>> {
    return this.masterdata.createResource(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('resource:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['updateResource']>>> {
    return this.masterdata.updateResource(this.tenantContext.current(), id, body);
  }
}

/**
 * 客户管理路由（S1 backfill：0920 #8）。权限码（ADR-0010 通用词三问：
 * customer 是跨离散制造行业通用交易对手词，无行业专属替代词，动作面两分）：
 *   GET  /masterdata/customers        customer:read
 *   POST /masterdata/customers        customer:write
 *   PUT  /masterdata/customers/:id    customer:write
 */
@Controller('masterdata/customers')
export class MasterdataCustomersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly masterdata: MasterdataService,
  ) {}

  @Get()
  @RequirePermission('customer:read')
  async list(): Promise<{ customers: Awaited<ReturnType<MasterdataService['listCustomers']>> }> {
    return { customers: await this.masterdata.listCustomers(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('customer:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['createCustomer']>>> {
    return this.masterdata.createCustomer(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('customer:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['updateCustomer']>>> {
    return this.masterdata.updateCustomer(this.tenantContext.current(), id, body);
  }
}

/** 供应商管理路由（S1 backfill：0920 #9；supplier 通用词，同上三问通过）。 */
@Controller('masterdata/suppliers')
export class MasterdataSuppliersController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly masterdata: MasterdataService,
  ) {}

  @Get()
  @RequirePermission('supplier:read')
  async list(): Promise<{ suppliers: Awaited<ReturnType<MasterdataService['listSuppliers']>> }> {
    return { suppliers: await this.masterdata.listSuppliers(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('supplier:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['createSupplier']>>> {
    return this.masterdata.createSupplier(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('supplier:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['updateSupplier']>>> {
    return this.masterdata.updateSupplier(this.tenantContext.current(), id, body);
  }
}

/**
 * 计量单位管理路由（S1 backfill：0920 #100；unit 通用词——与 ItemMaster.unit
 * 字段同名同义，无行业专属名词，三问通过）。
 */
@Controller('masterdata/units')
export class MasterdataUnitsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly masterdata: MasterdataService,
  ) {}

  @Get()
  @RequirePermission('unit:read')
  async list(): Promise<{ units: Awaited<ReturnType<MasterdataService['listUnits']>> }> {
    return { units: await this.masterdata.listUnits(this.tenantContext.current()) };
  }

  @Post()
  @RequirePermission('unit:write')
  async create(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['createUnit']>>> {
    return this.masterdata.createUnit(this.tenantContext.current(), body);
  }

  @Put(':id')
  @RequirePermission('unit:write')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<MasterdataService['updateUnit']>>> {
    return this.masterdata.updateUnit(this.tenantContext.current(), id, body);
  }
}
