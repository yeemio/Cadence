/**
 * PayrollHttpModule —— 薪酬专业包的组合根 HTTP 面（M3 首波，m3-drafts/01-payroll.md v1.0）。
 *
 * 为什么在组合根：payroll 是纯专业包（pro-pack-tier-edges：仅依赖 business-core），
 * 不含 Nest 依赖——控制器/装配归组合根（R-M3-3 裁定：组合根适配器/HTTP 面，
 * 专业包零框架耦合）。体例对齐 M2 各模块控制器：租户取 TenantContext（ALS）、
 * 操作者取 AuthGuard 写入的 REQUEST_USER_KEY；命令经 smes.command.v1 信封。
 *
 * 激活语义（合同 §1）：本模块仅经 MODULES_ENABLED 显式开启（专业包=激活价，
 * 报价单可选行↔注册行，D9）；关闭时入口/权限码/事件消费全部不可见。
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  RequirePermission,
  TenantContext,
  type AuthenticatedRequest,
} from '@smes/application';
import { UserId } from '@smes/business-core';
import {
  PayrollInputError,
  PayRunId,
  PayrollService,
  parseCommandBodyForKind,
  parseMonthParam,
  requireRuleId,
  type PayrollCommandEnvelope,
  type PayrollEnvelopeBody,
  type PayrollExportPort,
  type PayrollSource,
  type PayrollStores,
} from '@smes/payroll';

/** 信封补全：解析产物（operationId/expectedRevision/command）+ 合同常量 + 租户/操作者。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  parsed: PayrollEnvelopeBody,
): PayrollCommandEnvelope {
  return Object.freeze({
    contract: 'smes.command.v1',
    tenantId: tenantContext.current(),
    issuedBy: request[REQUEST_USER_KEY],
    operationId: parsed.operationId,
    expectedRevision: parsed.expectedRevision,
    issuedAt: new Date().toISOString(),
    command: Object.freeze({ ...parsed.command }),
  });
}

@Controller('payroll')
export class PayrollCommandsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly payroll: PayrollService,
  ) {}

  /** 计薪规则发布/修订（86 人员时薪维护面）。 */
  @Post('rules/commands')
  @RequirePermission('payroll:rule-manage')
  async publishRule(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'payroll.rule.publish.v1');
    return this.payroll.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 月度核算/重算（87 工资核算；幂等，重算=新 PayRun 版本）。 */
  @Post('runs/commands')
  @RequirePermission('payroll:run')
  async runMonth(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'payroll.run.month.v1');
    return this.payroll.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 核算结果导出（json-tables 回声 / xlsx-base64——组合根注入 ExcelJS 适配）。 */
  @Post('exports/commands')
  @RequirePermission('payroll:export')
  async export(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'payroll.export.v1');
    return this.payroll.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }
}

@Controller('payroll')
export class PayrollQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly payroll: PayrollService,
  ) {}

  /** 规则版本列表（全部或指定 ruleId 链）。 */
  @Get('rules')
  @RequirePermission('payroll:read')
  async rules(@Query('ruleId') ruleId?: string): Promise<unknown> {
    return this.payroll.ruleVersions(
      this.tenantContext.current(),
      ruleId === undefined ? undefined : requireRuleId(ruleId, 'ruleId'),
    );
  }

  /** 规则链详情（当前版+全版本）。 */
  @Get('rules/detail/:ruleId')
  @RequirePermission('payroll:read')
  async ruleDetail(@Param('ruleId') ruleId: string): Promise<unknown> {
    return this.payroll.ruleDetail(
      this.tenantContext.current(),
      requireRuleId(ruleId, 'ruleId'),
    );
  }

  /** 规则版本对比（合同 §3 查询面）。 */
  @Get('rules/compare')
  @RequirePermission('payroll:read')
  async compareRules(
    @Query('ruleId') ruleId: string,
    @Query('a') versionA: string,
    @Query('b') versionB: string,
  ): Promise<unknown> {
    const a = Number(versionA);
    const b = Number(versionB);
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      throw new PayrollInputError('对比版本号 a/b 须为整数');
    }
    return this.payroll.compareRules(
      this.tenantContext.current(),
      requireRuleId(ruleId, 'ruleId'),
      a,
      b,
    );
  }

  /** 月度核算结果（人×月，可带 personId 过滤）。 */
  @Get('runs')
  @RequirePermission('payroll:read')
  async runs(
    @Query('month') month: string,
    @Query('personId') personId?: string,
  ): Promise<unknown> {
    const periodKey = parseMonthParam(month, 'month');
    return this.payroll.runResults(
      this.tenantContext.current(),
      periodKey,
      personId === undefined ? undefined : UserId.create(personId),
    );
  }

  /** 核算批次版本链（人×月：重算留痕回看）。 */
  @Get('runs/chain')
  @RequirePermission('payroll:read')
  async runChain(
    @Query('month') month: string,
    @Query('personId') personId: string,
  ): Promise<unknown> {
    const periodKey = parseMonthParam(month, 'month');
    return this.payroll.runChain(
      this.tenantContext.current(),
      periodKey,
      UserId.create(personId),
    );
  }

  /** 指定批次详情+薪酬记录（历史版本按当时规则复算回看）。 */
  @Get('runs/detail/:payRunId')
  @RequirePermission('payroll:read')
  async runDetail(@Param('payRunId') payRunId: string): Promise<unknown> {
    return this.payroll.runDetail(
      this.tenantContext.current(),
      PayRunId.create(payRunId),
    );
  }

  /** 我的工资（数据权限"本人"——personId 只取调用方身份，合同 §5）。 */
  @Get('my')
  @RequirePermission('payroll:read')
  async my(@Req() request: AuthenticatedRequest, @Query('month') month?: string): Promise<unknown> {
    const periodKey = month === undefined ? undefined : parseMonthParam(month, 'month');
    return this.payroll.myPayroll(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
      periodKey,
    );
  }

  /** 按来源工时账目反查薪酬记录（下钻对账锚点）。 */
  @Get('earnings/by-source/:sourceRef')
  @RequirePermission('payroll:read')
  async earningsBySource(@Param('sourceRef') sourceRef: string): Promise<unknown> {
    return this.payroll.earningsBySourceRef(this.tenantContext.current(), sourceRef);
  }

  /** 事件流（append-only 域事件）。 */
  @Get('events')
  @RequirePermission('payroll:read')
  async events(): Promise<unknown> {
    return this.payroll.listEvents(this.tenantContext.current());
  }
}

export interface PayrollHttpModuleOptions {
  /** 五存储端口（组合根注入：PG 句柄或内存缺省）。 */
  readonly stores: PayrollStores;
  /** hours 事实源（跨模块接线 #21；缺省=空源，零接线 boot 语义诚实）。 */
  readonly source?: PayrollSource | undefined;
  /** 导出端口（组合根 ExcelJS 适配；缺省=json-tables 回声）。 */
  readonly exportPort?: PayrollExportPort | undefined;
}

@Module({})
export class PayrollHttpModule {
  static register(options: PayrollHttpModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: PayrollService,
        useFactory: () =>
          new PayrollService(
            options.stores,
            options.source,
            options.exportPort,
          ),
      },
    ];
    return {
      module: PayrollHttpModule,
      controllers: [PayrollCommandsController, PayrollQueriesController],
      providers,
    };
  }
}
