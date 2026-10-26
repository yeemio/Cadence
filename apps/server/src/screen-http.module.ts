/**
 * ScreenHttpModule —— 数字运营大屏的组合根 HTTP/推送面（A8 首波，PRD 20 册
 * RREQ-RP-023~027）。
 *
 * 为什么在组合根：screen 聚合用例（DigitalOperationScreenService / A10
 * MachiningDailyStatsService）在 application 包零框架；SSE 通道、定时节拍与
 * 控制器装配归组合根（体例同 payroll-http.module——R-M3-3 裁定）。通道形态
 * 取舍（SSE vs WS）与节拍设计见 screen-broadcast.ts 文件头。
 *
 * 端点面：
 *  - GET /screen/digital-operation —— 快照查询（report:read 门禁，6a-3 裁决
 *    2 修复：此前两端点未声明权限码 = AuthGuard 语义公开路由，零凭据 200。
 *    权限码取舍（写明）：复用既有 'report:read'（standardreports 控制器同码
 *    先例——大屏快照/A10 日表是只读报表面，与标准报表同一资源词族），不新造
 *    'screen:read'——新码需同时落角色策略种子，否则全租户无人有权=端点死锁；
 *    report:read 已随报表角色面存在，最小权限集变更）；
 *  - GET /screen/digital-operation/stream —— SSE 推送通道（EventSource 不能
 *    带 Authorization 头 → 会话 token 经 ?token= 查询参传入；校验语义与
 *    AuthGuard 同源：resolveSession + 会话租户 = 请求租户，**且同样判定
 *    report:read**（D-21 修复：修复前只校会话+租户，viewer/approver 快照 403
 *    而流 200——SSE 帧与快照同构，权限面必须同码；401/403 分离同 AuthGuard
 *    合同：会话缺失/无效/跨租户 = 401，身份有效但无权限码 = 403）。开放访问
 *    部署形态 SMES_SCREEN_PUBLIC_STREAM=on 显式解锁——该形态是部署侧对整条
 *    通道（含权限面）的显式放弃，不静默；源契约通道无鉴权（OQ-3 待定），
 *    Cadence 缺省收紧为带 token + 权限码，取舍写明不静默）；
 *  - GET /screen/machining-daily-stats —— A10 日表最近 N 天（?days=30 上限
 *    366；report:read，同快照端点取舍）。
 *
 * 激活语义：仅经 MODULES_ENABLED 显式开启（同 payroll/maintenance 专业包——
 * 激活价）；关闭时端点/节拍/权限码全部不可见。
 */
import { Controller, Get, Injectable, Module, Query, Req, Res } from '@nestjs/common';
import {
  OnApplicationShutdown,
  OnModuleInit,
  type DynamicModule,
  type Provider,
} from '@nestjs/common';
import {
  AuthService,
  DigitalOperationScreenService,
  MachiningDailyStatsService,
  PermissionService,
  RequirePermission,
  TenantContext,
  permissionCode,
  type DigitalOperationScreenConfig,
  type MachiningDailyStatsStore,
  type ScreenSourceStores,
} from '@smes/application';
import { TenantId, UserId, type TenantId as TenantIdType } from '@smes/business-core';
import {
  MachiningDailyScheduler,
  ScreenFrameBroadcaster,
  SCREEN_FRAME_INTERVAL_MS_DEFAULT,
  ssePreamble,
} from './screen-broadcast.js';

/** SSE 请求/响应的最小结构面（组合根不依赖 express 类型——main.ts 同取舍）。 */
interface ScreenStreamRequest {
  on(event: 'close', listener: () => void): unknown;
  readonly headers?: Record<string, unknown> | undefined;
}

interface ScreenStreamResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

/** dev/test 身份回落开关（与 AuthGuard 同名 env 同语义；仅 SMES_DEV_AUTH=on 接受）。 */
const DEV_AUTH_FLAG = 'SMES_DEV_AUTH';
const DEV_USER_HEADER = 'x-smes-user';

/**
 * 大屏读权限码（三端点同码，单一事实源）：快照 / SSE 流 / A10 日表都是只读
 * 报表面（文件头权限码取舍）。品牌类型形态供流通道手动判定（不走装饰器——
 * EventSource 场景鉴权在 handler 内自持，见 ScreenStreamController.authorized）。
 */
const SCREEN_READ_CODE = permissionCode('report:read');

@Controller('screen')
export class ScreenQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly screen: DigitalOperationScreenService,
    private readonly daily: MachiningDailyStatsService,
  ) {}

  /** 全屏数据帧快照（按需聚合一帧；report:read——文件头权限码取舍）。 */
  @RequirePermission(SCREEN_READ_CODE)
  @Get('digital-operation')
  async snapshot(): Promise<unknown> {
    return this.screen.buildFrame(this.tenantContext.current());
  }

  /** A10 日统计最近 N 天（降序；?days 缺省 30、上限 366；report:read）。 */
  @RequirePermission(SCREEN_READ_CODE)
  @Get('machining-daily-stats')
  async dailyStats(@Query('days') days?: string): Promise<unknown> {
    const parsed = days === undefined ? 30 : Number(days);
    const window = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 366) : 30;
    return {
      rows: await this.daily.listRecent(this.tenantContext.current(), window),
    };
  }
}

/** SSE 通道开放访问开关（注入面——构造期固化，避免请求路径读 env）。 */
export class ScreenStreamAccess {
  constructor(readonly allow: boolean) {}
}

@Controller('screen')
export class ScreenStreamController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly broadcaster: ScreenFrameBroadcaster,
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
    private readonly access: ScreenStreamAccess,
  ) {}

  /**
   * SSE 推送通道：鉴权（token 查询参 / publicStream / dev 头三形态）→ 订阅
   * 广播器 → 连接 close 摘除。首帧随下一节拍（≤ 帧周期），retry 提示 3s。
   */
  @Get('digital-operation/stream')
  async stream(
    @Query('token') token: string | undefined,
    @Req() request: ScreenStreamRequest,
    @Res() response: ScreenStreamResponse,
  ): Promise<void> {
    const denial = await this.authorized(token, request);
    if (denial !== null) {
      // 401/403 分离同 AuthGuard 合同：缺/坏会话 = 401；身份有效但无
      // report:read = 403（D-21——修复前任意有效会话即 200）。
      response.statusCode = denial;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        `${JSON.stringify({
          statusCode: denial,
          message:
            denial === 403
              ? "大屏通道需要权限码 'report:read'（与快照端点同码；会话有效但无权限）"
              : '大屏通道缺少有效会话（?token= 或 SMES_SCREEN_PUBLIC_STREAM=on）',
        })}\n`,
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    // 反代透传提示（nginx 缓冲会攒帧——显式关缓冲，帧级实时性）
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    response.write(ssePreamble());
    const unsubscribe = this.broadcaster.subscribe(this.tenantContext.current(), {
      write: (chunk: string) => response.write(chunk),
    });
    request.on('close', unsubscribe);
  }

  /**
   * 通道鉴权（OQ-3 开放的 Cadence 缺省收紧形态；D-21 补权限面）：
   *  1. publicStream.allow（SMES_SCREEN_PUBLIC_STREAM=on）→ 放行（部署对
   *     整条通道含权限面的显式解锁）；
   *  2. ?token= 会话：resolveSession 有效且会话租户 = 请求租户（与 AuthGuard
   *     同语义）→ 再判 report:read（PermissionService.authorize——与快照端点
   *     同一条判定链，含域内 admin bypass）；会话缺失/无效/跨租户 → 401，
   *     身份有效但无权限码 → 403；
   *  3. dev/test 回落：仅 SMES_DEV_AUTH=on 时接受 x-smes-user 头（AuthGuard
   *     同名开关同语义——EventSource 场景浏览器端不发该头，仅测试用），
   *     同样判 report:read（D-21：dev 头与 token 同权判定，不放裸身份）。
   *
   * 返回 null = 放行；401/403 = 拒绝并以此状态回 JSON（401/403 分离合同）。
   */
  private async authorized(
    token: string | undefined,
    request: ScreenStreamRequest,
  ): Promise<401 | 403 | null> {
    if (this.access.allow) return null;
    if (token !== undefined && token.length > 0) {
      const session = await this.auth.resolveSession(token);
      if (session === null || session.tenant !== this.tenantContext.current()) {
        return 401;
      }
      return (await this.readable(session.userId)) ? null : 403;
    }
    if (process.env[DEV_AUTH_FLAG] === 'on') {
      const raw = request.headers?.[DEV_USER_HEADER];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.trim().length > 0) {
        return (await this.readable(UserId.create(value.trim()))) ? null : 403;
      }
    }
    return 401;
  }

  /** report:read 判定（与快照端点同一条 PermissionService 链）。 */
  private async readable(user: UserId): Promise<boolean> {
    return this.permissions.authorize(this.tenantContext.current(), user, SCREEN_READ_CODE);
  }
}

/** 节拍生命周期：模块就绪起定时器，应用关闭停（Nest 生命周期钩子）。 */
@Injectable()
export class ScreenPushLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly broadcaster: ScreenFrameBroadcaster,
    private readonly scheduler: MachiningDailyScheduler,
  ) {}

  onModuleInit(): void {
    this.broadcaster.start();
    this.scheduler.start();
  }

  onApplicationShutdown(): void {
    this.broadcaster.stop();
    this.scheduler.stop();
  }
}

export interface ScreenHttpModuleOptions {
  /** 大屏事实源读面（组合根从 StorePorts 逐项解析；缺面 = 块级降级占位）。 */
  readonly sources: ScreenSourceStores;
  /** A10 日统计存储（组合根解析：PG 句柄或内存实例——screen 启用时恒有值）。 */
  readonly dailyStore: MachiningDailyStatsStore;
  /** 屏显静态配置（公司名/安全生产基准日等；缺省 DEFAULT_SCREEN_CONFIG）。 */
  readonly config?: DigitalOperationScreenConfig | undefined;
  /** 帧节拍毫秒（源契约 5s；测试可放大/缩小）。 */
  readonly frameIntervalMs?: number | undefined;
  /** A10 日跑批租户集（main 侧由 SMES_TENANTS 解析；缺省 ['default']）。 */
  readonly dailyTenants?: readonly TenantIdType[] | undefined;
  /** SSE 通道开放访问（SMES_SCREEN_PUBLIC_STREAM=on 部署形态；缺省关）。 */
  readonly publicStream?: boolean | undefined;
}

@Module({})
export class ScreenHttpModule {
  static register(options: ScreenHttpModuleOptions): DynamicModule {
    const screen = new DigitalOperationScreenService(options.sources, options.config);
    const daily = new MachiningDailyStatsService(options.dailyStore);
    const broadcaster = new ScreenFrameBroadcaster(
      screen,
      options.frameIntervalMs ?? SCREEN_FRAME_INTERVAL_MS_DEFAULT,
    );
    const scheduler = new MachiningDailyScheduler(
      daily,
      options.dailyTenants ?? [TenantId.create('default')],
    );
    const providers: Provider[] = [
      { provide: DigitalOperationScreenService, useValue: screen },
      { provide: MachiningDailyStatsService, useValue: daily },
      { provide: ScreenFrameBroadcaster, useValue: broadcaster },
      { provide: MachiningDailyScheduler, useValue: scheduler },
      { provide: ScreenStreamAccess, useValue: new ScreenStreamAccess(options.publicStream === true) },
      { provide: ScreenPushLifecycle, useClass: ScreenPushLifecycle },
    ];
    return {
      module: ScreenHttpModule,
      controllers: [ScreenQueriesController, ScreenStreamController],
      providers,
    };
  }
}

/** A10 跑批租户集：saas 形态 SMES_TENANTS 逗号清单；缺省单租户 'default'。 */
export function parseDailyTenants(raw: string | undefined): readonly TenantId[] {
  const list = (raw ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  return (list.length > 0 ? list : ['default']).map((t) => TenantId.create(t));
}
