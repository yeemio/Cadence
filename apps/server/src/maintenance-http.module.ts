/**
 * MaintenanceHttpModule —— 维保专业包的组合根 HTTP 面（M3 第二波，
 * m3-drafts/02-maintenance.md v1.0）。
 *
 * 体例对齐 PayrollHttpModule（M3 首波先例）：专业包零框架耦合（pro-pack-
 * tier-edges：仅 business-core + engine-flow），控制器/装配归组合根（R-M3-3）。
 * 租户取 TenantContext（ALS）、操作者取 AuthGuard 写入的 REQUEST_USER_KEY；
 * 命令经 smes.command.v1 信封；**每个路由必挂 @RequirePermission**（payroll
 * 初版漏挂被 401 探针抓红的教训，权限码按合同 §5 最小集）。
 *
 * 激活语义（合同 §1）：仅经 MODULES_ENABLED 显式开启；关闭时 18/19 入口、
 * 权限码、到期扫描全不可见，baseline 故障上报不受影响。
 *
 * 故障联动面（接线 #22）：GET /maintenance/fault-linkage 读 pending 建议、
 * POST /maintenance/fault-linkage/commands 触发同步（读 baseline Outbox 事件
 * → maintenance.task.create）——手动/定时触发面，体例对齐 POST /hours/ingest
 * 重放先例（组合根不订阅 Outbox，轮询触发是 v1 诚实形态）。
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  REQUEST_USER_KEY,
  RequirePermission,
  TenantContext,
  type AuthenticatedRequest,
} from '@smes/application';
import { UserId } from '@smes/business-core';
import {
  MaintenanceInputError,
  MaintenanceService,
  isTaskKind,
  isTaskSource,
  parseCommandBodyForKind,
  parseIdParam,
  parseOptionalIsoParam,
  requirePlanId,
  requireTaskId,
  type MaintenanceCommandEnvelope,
  type MaintenanceEnvelopeBody,
  type MaintenanceStores,
} from '@smes/maintenance';
import type { MaintenanceFaultLinkagePort } from './cross-module-wiring.js';

/** 故障联动端口的 DI token（接口无运行时形状——Symbol token，#22 注入位）。 */
export const MAINTENANCE_FAULT_LINKAGE = Symbol('smes.server.maintenanceFaultLinkage');

/** 信封补全：解析产物（operationId/expectedRevision/command）+ 合同常量 + 租户/操作者。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  parsed: MaintenanceEnvelopeBody,
): MaintenanceCommandEnvelope {
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

// ---- 查询参数守门（违规 400，绝不静默丢弃） ----

function optionalTaskSource(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isTaskSource(value)) {
    throw new MaintenanceInputError(`source 非法：须为 plan-due/fault/manual 之一，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalTaskKind(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isTaskKind(value)) {
    throw new MaintenanceInputError(`kind 非法：须为 repair/upkeep/checkpoint 之一，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

const ACTIVITY_KINDS = ['checkpoint', 'upkeep', 'repair'] as const;

function optionalActivityKind(value: string | undefined): (typeof ACTIVITY_KINDS)[number] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(ACTIVITY_KINDS as readonly string[]).includes(value)) {
    throw new MaintenanceInputError(`kind 非法：须为 checkpoint/upkeep/repair 之一，得到 ${JSON.stringify(value)}`);
  }
  return value as (typeof ACTIVITY_KINDS)[number];
}

@Controller('maintenance')
export class MaintenanceCommandsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly maintenance: MaintenanceService,
  ) {}

  /** 计划发布/修订（演进 = 新版本行，expectedRevision 乐观锁）。 */
  @Post('plans/commands')
  @RequirePermission('maintenance:plan-write')
  async publishPlan(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.plan.publish.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 到期扫描（信封命令，体例对齐 overdue.scan 先例；载荷无必填字段）。 */
  @Post('plans/due-scan/commands')
  @RequirePermission('maintenance:task-arrange')
  async dueScan(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.plan.due-scan.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 手工/故障联动建任务（faultRef 携带即 fault 联动——组合根粘合或人工）。 */
  @Post('tasks/commands')
  @RequirePermission('maintenance:task-arrange')
  async createTask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.task.create.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 任务开始执行（scheduled -> executing；迁移乐观锁 = 任务 objectVersion）。 */
  @Post('tasks/start/commands')
  @RequirePermission('maintenance:record')
  async startTask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.task.start.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 任务完成（executing -> done 终态；三态记录另行 append 留痕）。 */
  @Post('tasks/complete/commands')
  @RequirePermission('maintenance:record')
  async completeTask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.task.complete.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 任务撤销（仅 scheduled 可撤；原因留痕进迁移事件）。 */
  @Post('tasks/cancel/commands')
  @RequirePermission('maintenance:record')
  async cancelTask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.task.cancel.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }

  /** 三态记录追加（点检 pass/fail / 保养动作 / 维修处置，append-only）。 */
  @Post('records/commands')
  @RequirePermission('maintenance:record')
  async appendRecord(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'maintenance.record.append.v1');
    return this.maintenance.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }
}

/** 故障联动触发面（接线 #22 的组合根 HTTP 面；未接线 = 显式拒绝）。 */
@Controller('maintenance/fault-linkage')
export class MaintenanceFaultLinkageController {
  constructor(
    private readonly tenantContext: TenantContext,
    @Inject(MAINTENANCE_FAULT_LINKAGE)
    private readonly faultLinkage: MaintenanceFaultLinkagePort | undefined,
  ) {}

  /** 待联动故障建议清单（FaultReported 事件 → 任务建议视图）。 */
  @Get()
  @RequirePermission('maintenance:task-arrange')
  async pending(): Promise<unknown> {
    if (this.faultLinkage === undefined) {
      throw new MaintenanceInputError('故障联动未接线（需 maintenance 与 baseline 同时装配）');
    }
    return this.faultLinkage.pendingSuggestions(this.tenantContext.current());
  }

  /** 触发同步：把 pending 建议组装 maintenance.task.create 提交（幂等可重放）。 */
  @Post('commands')
  @RequirePermission('maintenance:task-arrange')
  async sync(@Req() request: AuthenticatedRequest): Promise<unknown> {
    if (this.faultLinkage === undefined) {
      throw new MaintenanceInputError('故障联动未接线（需 maintenance 与 baseline 同时装配）');
    }
    return this.faultLinkage.syncFaultTasks(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
    );
  }
}

@Controller('maintenance')
export class MaintenanceQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly maintenance: MaintenanceService,
  ) {}

  /** 计划表（按设备可选过滤；当前版在前）。 */
  @Get('plans')
  @RequirePermission('maintenance:read')
  async plans(@Query('resourceRef') resourceRef?: string): Promise<unknown> {
    return this.maintenance.plans(
      this.tenantContext.current(),
      resourceRef === undefined || resourceRef === '' ? undefined : parseIdParam(resourceRef, 'resourceRef'),
    );
  }

  /** 计划版本链（改版溯源旧版可解释的读面；不存在 404）。 */
  @Get('plans/:planId/versions')
  @RequirePermission('maintenance:read')
  async planVersions(@Param('planId') planId: string): Promise<unknown> {
    return this.maintenance.planVersions(this.tenantContext.current(), requirePlanId(planId, 'planId'));
  }

  /** 任务队列（全部；source/kind/state/resourceRef/planId/assignee 过滤）。 */
  @Get('tasks')
  @RequirePermission('maintenance:read')
  async tasks(
    @Query('source') source?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('resourceRef') resourceRef?: string,
    @Query('planId') planId?: string,
    @Query('assignee') assignee?: string,
  ): Promise<unknown> {
    return this.maintenance.taskQueue(this.tenantContext.current(), {
      ...(optionalTaskSource(source) === undefined ? {} : { source: optionalTaskSource(source) as never }),
      ...(optionalTaskKind(kind) === undefined ? {} : { kind: optionalTaskKind(kind) as never }),
      ...(state === undefined || state === '' ? {} : { state }),
      ...(resourceRef === undefined || resourceRef === '' ? {} : { resourceRef: parseIdParam(resourceRef, 'resourceRef') }),
      ...(planId === undefined || planId === '' ? {} : { planId: requirePlanId(planId, 'planId') }),
      ...(assignee === undefined || assignee === '' ? {} : { assignee: UserId.create(assignee) }),
    });
  }

  /** 我的任务（数据权限"本人执行"——personId 只取调用方身份，合同 §5）。 */
  @Get('my')
  @RequirePermission('maintenance:read')
  async my(
    @Req() request: AuthenticatedRequest,
    @Query('state') state?: string,
  ): Promise<unknown> {
    return this.maintenance.myTasks(
      this.tenantContext.current(),
      request[REQUEST_USER_KEY],
      state === undefined || state === '' ? undefined : state,
    );
  }

  /** 任务详情（125/126 移动同 API 的服务面）。 */
  @Get('tasks/:taskId')
  @RequirePermission('maintenance:read')
  async taskDetail(@Param('taskId') taskId: string): Promise<unknown> {
    return this.maintenance.taskDetail(this.tenantContext.current(), requireTaskId(taskId, 'taskId'));
  }

  /** 到期日历（scheduled ∧ dueAt ∈ [from,to]；缺省无界，dueAt 升序）。 */
  @Get('due-calendar')
  @RequirePermission('maintenance:read')
  async dueCalendar(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    return this.maintenance.dueCalendar(
      this.tenantContext.current(),
      parseOptionalIsoParam(from, 'from'),
      parseOptionalIsoParam(to, 'to'),
    );
  }

  /** 设备维保历史（三态记录按设备×kind×时间窗——台账维度下钻）。 */
  @Get('history')
  @RequirePermission('maintenance:read')
  async history(
    @Query('resourceRef') resourceRef?: string,
    @Query('kind') kind?: string,
    @Query('taskId') taskId?: string,
    @Query('planId') planId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    const historyKind = optionalActivityKind(kind);
    const historyFrom = parseOptionalIsoParam(from, 'from');
    const historyTo = parseOptionalIsoParam(to, 'to');
    return this.maintenance.resourceHistory(this.tenantContext.current(), {
      ...(resourceRef === undefined || resourceRef === ''
        ? {}
        : { resourceRef: parseIdParam(resourceRef, 'resourceRef') }),
      ...(historyKind === undefined ? {} : { kind: historyKind }),
      ...(taskId === undefined || taskId === '' ? {} : { taskId: requireTaskId(taskId, 'taskId') }),
      ...(planId === undefined || planId === '' ? {} : { planId: requirePlanId(planId, 'planId') }),
      ...(historyFrom === undefined ? {} : { from: historyFrom }),
      ...(historyTo === undefined ? {} : { to: historyTo }),
    });
  }

  /** 事件流（append-only 域事件，审计/调试口径）。 */
  @Get('events')
  @RequirePermission('maintenance:read')
  async events(): Promise<unknown> {
    return this.maintenance.listEvents(this.tenantContext.current());
  }
}

export interface MaintenanceHttpModuleOptions {
  /** 五存储端口（组合根注入：PG 句柄或内存缺省）。 */
  readonly stores: MaintenanceStores;
  /** 故障联动端口（接线 #22；maintenance+baseline 双侧装配才非空）。 */
  readonly faultLinkage?: MaintenanceFaultLinkagePort | undefined;
}

@Module({})
export class MaintenanceHttpModule {
  static register(options: MaintenanceHttpModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: MaintenanceService,
        useFactory: () => new MaintenanceService(options.stores),
      },
      {
        provide: MAINTENANCE_FAULT_LINKAGE,
        useValue: options.faultLinkage,
      },
    ];
    return {
      module: MaintenanceHttpModule,
      controllers: [
        MaintenanceCommandsController,
        MaintenanceFaultLinkageController,
        MaintenanceQueriesController,
      ],
      providers,
    };
  }
}
