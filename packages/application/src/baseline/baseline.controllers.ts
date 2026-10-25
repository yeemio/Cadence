/**
 * baseline P1 路由（M2-W2）。控制器零逻辑：租户取 TenantContext（ALS）、
 * 操作者取 AuthGuard 写入的 REQUEST_USER_KEY（身份与租户都不从请求体进，
 * ADR-0005）；写端点收命令提交体（operationId/expectedRevision/issuedAt?/
 * command{kind,payload}），组装 smes.command.v1 信封后委托 BaselineService，
 * 返回命令三分结果。物料校验执行**无 HTTP 写端点**：权限码最小集（合同 §5）
 * 无 material-validation 写码，执行走模块端口（listing 注入
 * MaterialValidationExecutor），HTTP 只开放读。
 *
 * 权限码（合同 §5 最小集）：
 *   POST /baseline/processes/commands         process:write
 *   GET  /baseline/processes                  process:read
 *   GET  /baseline/processes/:code            process:read
 *   POST /baseline/outsourcing-rules/commands outsourcing-rule:write
 *   GET  /baseline/outsourcing-rules          outsourcing-rule:read
 *   GET  /baseline/outsourcing-rules/:code    outsourcing-rule:read
 *   POST /baseline/equipment/commands         equipment:write
 *   GET  /baseline/equipment                  equipment:read
 *   GET  /baseline/equipment/:code            equipment:read
 *   GET  /baseline/material-validations       material-validation:read
 *   GET  /baseline/material-validations/:id   material-validation:read
 *
 * P2/P3 件（M2-W7，命令动词与端点绑定——makeBaselineCommandEnvelopeForKind
 * 断言 kind，防跨资源命令经他端点提交；P1 既有端点行为不动）：
 *   POST /baseline/routings/commands          routing:write
 *   GET  /baseline/routings                   routing:read
 *   GET  /baseline/routings/:drawingNo        routing:read   （按图号查）
 *   POST /baseline/standard-times/commands    standardtime:write
 *   GET  /baseline/standard-times             standardtime:read（?scope=&targetCode=）
 *   GET  /baseline/standard-times/:code       standardtime:read
 *   POST /baseline/fault-reports/commands     fault:report    （fault.report）
 *   POST /baseline/fault-reports/:id/resolution fault:resolve （fault.resolve）
 *   GET  /baseline/fault-reports              fault:read      （?state=）
 *   GET  /baseline/fault-reports/:id          fault:read
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import { BaselineInputError } from './baseline-errors.js';
import { BASELINE_COMMAND_KINDS, makeBaselineCommandEnvelope, makeBaselineCommandEnvelopeForKind } from './baseline-input.js';
import { BaselineService } from './baseline.service.js';

@Controller('baseline/processes')
export class BaselineProcessesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('process:write')
  async command(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService["execute"]>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelope(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }),
    );
  }

  @Get()
  @RequirePermission('process:read')
  async list(
    @Query('status') status?: string,
  ): Promise<{ processes: Awaited<ReturnType<BaselineService['listProcesses']>> }> {
    return { processes: await this.baseline.listProcesses(this.tenantContext.current(), status) };
  }

  @Get(':code')
  @RequirePermission('process:read')
  async get(
    @Param('code') code: string,
  ): Promise<Awaited<ReturnType<BaselineService['getProcess']>>> {
    return this.baseline.getProcess(this.tenantContext.current(), code);
  }
}

@Controller('baseline/outsourcing-rules')
export class BaselineOutsourcingRulesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('outsourcing-rule:write')
  async command(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService["execute"]>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelope(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }),
    );
  }

  @Get()
  @RequirePermission('outsourcing-rule:read')
  async list(
    @Query('status') status?: string,
  ): Promise<{ rules: Awaited<ReturnType<BaselineService['listOutsourcingRules']>> }> {
    return { rules: await this.baseline.listOutsourcingRules(this.tenantContext.current(), status) };
  }

  @Get(':code')
  @RequirePermission('outsourcing-rule:read')
  async get(
    @Param('code') code: string,
  ): Promise<Awaited<ReturnType<BaselineService['getOutsourcingRule']>>> {
    return this.baseline.getOutsourcingRule(this.tenantContext.current(), code);
  }
}

@Controller('baseline/equipment')
export class BaselineEquipmentController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('equipment:write')
  async command(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService["execute"]>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelope(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }),
    );
  }

  @Get()
  @RequirePermission('equipment:read')
  async list(
    @Query('status') status?: string,
  ): Promise<{ equipment: Awaited<ReturnType<BaselineService['listEquipment']>> }> {
    return { equipment: await this.baseline.listEquipment(this.tenantContext.current(), status) };
  }

  @Get(':code')
  @RequirePermission('equipment:read')
  async get(
    @Param('code') code: string,
  ): Promise<Awaited<ReturnType<BaselineService['getEquipment']>>> {
    return this.baseline.getEquipment(this.tenantContext.current(), code);
  }
}

@Controller('baseline/material-validations')
export class BaselineMaterialValidationsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Get()
  @RequirePermission('material-validation:read')
  async list(): Promise<{ runs: Awaited<ReturnType<BaselineService['listValidationRuns']>> }> {
    return { runs: await this.baseline.listValidationRuns(this.tenantContext.current()) };
  }

  @Get(':id')
  @RequirePermission('material-validation:read')
  async get(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<BaselineService['getValidationRun']>>> {
    return this.baseline.getValidationRun(this.tenantContext.current(), id);
  }
}

// ---- P2/P3 件（M2-W7：命令动词与端点绑定，见文件头权限码表） ----

@Controller('baseline/routings')
export class BaselineRoutingsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('routing:write')
  async command(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService['execute']>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelopeForKind(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }, [BASELINE_COMMAND_KINDS.routingDefine, BASELINE_COMMAND_KINDS.routingRevise]),
    );
  }

  @Get()
  @RequirePermission('routing:read')
  async list(
    @Query('status') status?: string,
  ): Promise<{ routings: Awaited<ReturnType<BaselineService['listRoutings']>> }> {
    return { routings: await this.baseline.listRoutings(this.tenantContext.current(), status) };
  }

  @Get(':drawingNo')
  @RequirePermission('routing:read')
  async get(
    @Param('drawingNo') drawingNo: string,
  ): Promise<Awaited<ReturnType<BaselineService['getRouting']>>> {
    return this.baseline.getRouting(this.tenantContext.current(), drawingNo);
  }
}

@Controller('baseline/standard-times')
export class BaselineStandardTimesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('standardtime:write')
  async command(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService['execute']>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelopeForKind(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }, [BASELINE_COMMAND_KINDS.standardtimeDefine]),
    );
  }

  @Get()
  @RequirePermission('standardtime:read')
  async list(
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('targetCode') targetCode?: string,
  ): Promise<{ standardTimes: Awaited<ReturnType<BaselineService['listStandardTimes']>> }> {
    const scopeFilter = scope === undefined || scope === '' ? undefined : scope;
    if (scopeFilter !== undefined && scopeFilter !== 'process' && scopeFilter !== 'product') {
      throw new BaselineInputError(`scope 过滤参数须为 'process' 或 'product'，得到 '${scopeFilter}'`);
    }
    return {
      standardTimes: await this.baseline.listStandardTimes(
        this.tenantContext.current(),
        status,
        scopeFilter,
        targetCode === undefined || targetCode === '' ? undefined : targetCode,
      ),
    };
  }

  @Get(':code')
  @RequirePermission('standardtime:read')
  async get(
    @Param('code') code: string,
  ): Promise<Awaited<ReturnType<BaselineService['getStandardTime']>>> {
    return this.baseline.getStandardTime(this.tenantContext.current(), code);
  }
}

@Controller('baseline/fault-reports')
export class BaselineFaultReportsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly baseline: BaselineService,
  ) {}

  @Post('commands')
  @RequirePermission('fault:report')
  async report(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService['execute']>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelopeForKind(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }, [BASELINE_COMMAND_KINDS.faultReport]),
    );
  }

  @Post(':id/resolution')
  @RequirePermission('fault:resolve')
  async resolve(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<BaselineService['execute']>>> {
    return this.baseline.execute(
      this.tenantContext.current(),
      makeBaselineCommandEnvelopeForKind(body, {
        tenant: this.tenantContext.current(),
        issuedBy: request[REQUEST_USER_KEY],
      }, [BASELINE_COMMAND_KINDS.faultResolve]),
      id,
    );
  }

  @Get()
  @RequirePermission('fault:read')
  async list(
    @Query('state') state?: string,
  ): Promise<{ faultReports: Awaited<ReturnType<BaselineService['listFaultReports']>> }> {
    return { faultReports: await this.baseline.listFaultReports(this.tenantContext.current(), state) };
  }

  @Get(':id')
  @RequirePermission('fault:read')
  async get(
    @Param('id') id: string,
  ): Promise<Awaited<ReturnType<BaselineService['getFaultReport']>>> {
    return this.baseline.getFaultReport(this.tenantContext.current(), id);
  }
}
