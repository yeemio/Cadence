/**
 * MetricPackHttpModule —— 口径包专业包的组合根 HTTP 面（M3 第二波，
 * m3-drafts/04-metric-pack.md v1.0）。
 *
 * 体例对齐 PayrollHttpModule：专业包零框架耦合，控制器/装配归组合根（R-M3-3）。
 * 每个路由必挂 @RequirePermission（权限码：metric-pack:read / activate）。
 *
 * 事实源绑定（接线 #24，合同 §4）：六种 sourceKind 的 MetricSource 适配器由
 * business-store 实现（connectMetricSourceBundle——**租户收口=构造注入**：引擎
 * MetricSource 端口不带租户参数）。组合根经 sourceSetFor(tenant) 按请求租户
 * 绑定实例（每租户缓存一个 MetricPackService）；零 DB / 无绑定面 = 空源集
 * （装载/清单语义完整，求值遇已装载口径显式报"源未绑定"——与 payroll 缺省
 * 空源同口径，语义诚实）。导出端口 = ExcelJS 同实例结构同形（#21 先例）。
 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  RequirePermission,
  TenantContext,
  type AuthenticatedRequest,
} from '@smes/application';
import type { TenantId } from '@smes/business-core';
import {
  EMPTY_METRIC_SOURCE_SET,
  MetricPackInputError,
  MetricPackService,
  parseCommandBodyForKind,
  parseEvaluateQuery,
  parseQueryObject,
  type MetricPackCommandEnvelope,
  type MetricPackEnvelopeBody,
  type MetricPackExportPort,
  type MetricPackStores,
  type MetricSourceSet,
} from '@smes/metric-pack';

/** 信封补全：解析产物 + 合同常量 + 租户/操作者。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  parsed: MetricPackEnvelopeBody,
): MetricPackCommandEnvelope {
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

/**
 * 按租户解析 MetricPackService（#24 租户收口）：有绑定面 = 每租户缓存一个
 * 服务实例（source set 构造注入）；无绑定面 = 全租户共享空源集单例。
 */
export class MetricPackServiceResolver {
  private readonly shared: MetricPackService;
  private readonly byTenant = new Map<string, MetricPackService>();

  constructor(
    private readonly stores: MetricPackStores,
    private readonly sourceSetFor: ((tenant: TenantId) => MetricSourceSet) | undefined,
    private readonly exportPort: MetricPackExportPort | undefined,
  ) {
    this.shared = this.make(EMPTY_METRIC_SOURCE_SET);
  }

  forTenant(tenant: TenantId): MetricPackService {
    if (this.sourceSetFor === undefined) return this.shared; // 零接线：空源集语义诚实
    const key = String(tenant);
    let service = this.byTenant.get(key);
    if (service === undefined) {
      service = this.make(this.sourceSetFor(tenant));
      this.byTenant.set(key, service);
    }
    return service;
  }

  private make(sourceSet: MetricSourceSet): MetricPackService {
    return new MetricPackService(
      this.stores,
      sourceSet,
      this.exportPort,
    );
  }
}

/** 求值查询参数（query=JSON 对象字面量——与包内 parseEvaluateQuery 同一守门）。 */
function evaluateQueryOf(raw: string | undefined) {
  return parseEvaluateQuery(parseQueryObject(raw, 'query'));
}

/** resolveMetric 路径参数守门（服务层定位失败=404，形状失败=400）。 */
function requireMetricIdParam(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.trim().length > 64) {
    throw new MetricPackInputError(`metricId 必须为 1~64 个非空白字符（kebab-case 口径 id）：${JSON.stringify(value)}`);
  }
  return value.trim();
}

function requireVersionParam(value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
    throw new MetricPackInputError(`version 须为 >= 1 的整数：${JSON.stringify(value)}`);
  }
  return parsed;
}

@Controller('metric-pack')
export class MetricPackCommandsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly resolver: MetricPackServiceResolver,
  ) {}

  /** 装载/升级口径包（defineMetricPack 逐条校验冻结；版本严格递增）。 */
  @Post('activations/commands')
  @RequirePermission('metric-pack:activate')
  async activate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'metric-pack.activate.v1');
    return this.resolver
      .forTenant(this.tenantContext.current())
      .execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, parsed));
  }

  /** 报表导出（求值即重算 + 端口化导出：json-tables 回声 / xlsx-base64）。 */
  @Post('exports/commands')
  @RequirePermission('metric-pack:read')
  async export(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'metric-pack.export.v1');
    return this.resolver
      .forTenant(this.tenantContext.current())
      .execute(this.tenantContext.current(), envelopeOf(this.tenantContext, request, parsed));
  }
}

@Controller('metric-pack')
export class MetricPackQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly resolver: MetricPackServiceResolver,
  ) {}

  /** 口径求值（metricId@version 钉死定义；结果携口径溯源）。 */
  @Get('evaluate')
  @RequirePermission('metric-pack:read')
  async evaluate(@Query('query') query?: string): Promise<unknown> {
    return this.resolver.forTenant(this.tenantContext.current()).evaluate(
      this.tenantContext.current(),
      evaluateQueryOf(query),
    );
  }

  /** 装载包清单（每 packId 当前激活版本视图）。 */
  @Get('packs')
  @RequirePermission('metric-pack:read')
  async activePacks(): Promise<unknown> {
    return this.resolver.forTenant(this.tenantContext.current()).activePacks(this.tenantContext.current());
  }

  /** 装载版本链（可选 packId 过滤；历史版本只读可复算锚点）。 */
  @Get('packs/versions')
  @RequirePermission('metric-pack:read')
  async packVersions(@Query('packId') packId?: string): Promise<unknown> {
    return this.resolver.forTenant(this.tenantContext.current()).packVersions(
      this.tenantContext.current(),
      packId === undefined || packId === '' ? undefined : packId,
    );
  }

  /** 定义定位 + 溯源视图（复算旧报表的锚点；未装载 404）。 */
  @Get('metrics/resolve')
  @RequirePermission('metric-pack:read')
  async resolveMetric(
    @Query('metricId') metricId?: string,
    @Query('version') version?: string,
  ): Promise<unknown> {
    return this.resolver.forTenant(this.tenantContext.current()).resolveMetric(
      this.tenantContext.current(),
      requireMetricIdParam(metricId),
      requireVersionParam(version),
    );
  }
}

export interface MetricPackHttpModuleOptions {
  /** 三存储端口（组合根注入：PG 句柄或内存缺省）。 */
  readonly stores: MetricPackStores;
  /** 按租户解析源集（接线 #24；缺省 = 空源集——零接线 boot 语义诚实）。 */
  readonly sourceSetFor?: ((tenant: TenantId) => MetricSourceSet) | undefined;
  /** 导出端口（组合根 ExcelJS 适配；缺省=json-tables 回声）。 */
  readonly exportPort?: MetricPackExportPort | undefined;
}

@Module({})
export class MetricPackHttpModule {
  static register(options: MetricPackHttpModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: MetricPackServiceResolver,
        useFactory: () =>
          new MetricPackServiceResolver(options.stores, options.sourceSetFor, options.exportPort),
      },
    ];
    return {
      module: MetricPackHttpModule,
      controllers: [MetricPackCommandsController, MetricPackQueriesController],
      providers,
    };
  }
}
