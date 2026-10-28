/**
 * DrawingHttpModule —— 图纸专业包的组合根 HTTP 面（M3 第二波，
 * m3-drafts/03-drawing.md v1.0）。
 *
 * 体例对齐 PayrollHttpModule：专业包零框架耦合，控制器/装配归组合根（R-M3-3）。
 * 每个路由必挂 @RequirePermission（权限码按合同 §5：drawing:read / publish /
 * audit-read）——例外见 read-references 开门面（token 即凭证）。
 *
 * 查看者装配（合同 §2 保密两不变量的组合根面）：DrawingViewer = 调用方身份
 * （AuthGuard）+ clearance 保密许可。v1 无租户权限配置面——clearance 作为
 * **显式请求参数**装配（parseClearance 未知词 fail-fast 400，不默认放行）；
 * 租户许可配置面出现后由组合根替换此装配（值集数据归租户，R-M3-6）。
 *
 * 按工作令图纸清单（接线 #23）：refs 由组合根从 workorder 附件装配（钉版
 * 编码 ref='drawingId@vN'，结构同形透传——消费模块不 import 本包，合同 §4
 * 差异表 #3）；workorder 未装配 = 空清单（零接线语义诚实）。
 *
 * P1 增量（drawing-module/CONTRACT.md P1 节）：
 *  - P1-c 图号索引：GET /drawing/drawings?search=&page=&pageSize=&clearance=
 *    （前缀检索+保密过滤+分页；元数据口径不含 fileRef）；
 *  - P1-e 只读引用：view 端点 referenceTtlSeconds 声明即回执附短时效签名
 *    URL；GET /drawing/read-references/:token 开门面（沿 attachment
 *    storage/:token 先例：短时签名 token 即能力凭证，无权限码；兑现仍走
 *    viewRevision 全路径——门禁+每次必落查看留痕，不新增 fileRef 旁路）。
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
  DrawingId,
  DrawingNotFoundError,
  DrawingReadReferenceSigner,
  DrawingService,
  parseClearance,
  parseCommandBodyForKind,
  parseDrawingIdParam,
  parsePageIndexParam,
  parsePageSizeParam,
  parseReadReferenceTtlParam,
  parseSearchParam,
  parseSinceVersionParam,
  parseVersionParam,
  requireDrawingId,
  type DrawingCommandEnvelope,
  type DrawingEnvelopeBody,
  type DrawingStores,
} from '@smes/drawing';
import type { WorkOrderDrawingRefsPort } from './cross-module-wiring.js';

/** workorder 附件钉版引用装配端口的 DI token（接口无运行时形状——Symbol token）。 */
export const WORKORDER_DRAWING_REFS = Symbol('smes.server.workOrderDrawingRefs');

/** 只读引用签发器的 DI token（P1-e：service 签发与开门面验证共用同一实例）。 */
export const DRAWING_READ_REFERENCES = Symbol('smes.server.drawingReadReferences');

/** 信封补全：解析产物 + 合同常量 + 租户/操作者。 */
function envelopeOf(
  tenantContext: TenantContext,
  request: AuthenticatedRequest,
  parsed: DrawingEnvelopeBody,
): DrawingCommandEnvelope {
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

@Controller('drawing')
export class DrawingCommandsController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly drawing: DrawingService,
  ) {}

  /** 发布新修订（version 由链尾+1；发布即联动变更通知）。 */
  @Post('revisions/commands')
  @RequirePermission('drawing:publish')
  async publish(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = parseCommandBodyForKind(body, 'drawing.publish.v1');
    return this.drawing.execute(
      this.tenantContext.current(),
      envelopeOf(this.tenantContext, request, parsed),
    );
  }
}

@Controller('drawing')
export class DrawingQueriesController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly drawing: DrawingService,
    @Inject(WORKORDER_DRAWING_REFS)
    private readonly workOrderRefs: WorkOrderDrawingRefsPort | undefined,
    @Inject(DRAWING_READ_REFERENCES)
    private readonly readReferences: DrawingReadReferenceSigner,
  ) {}

  /**
   * 租户级图号索引（P1-c / O3 裁定=最小）：search 前缀 + clearance 保密过滤
   * + 分页（page 1 起缺省 1 / pageSize 缺省 20 上限 100）。
   * 全链超许可的图纸不进索引；条目=许可内链尾（latestVersion/classification/
   * status），元数据口径不含 fileRef。
   */
  @Get('drawings')
  @RequirePermission('drawing:read')
  async drawingsIndex(
    @Req() request: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('clearance') clearance?: string,
  ): Promise<unknown> {
    return this.drawing.drawingsIndex(this.tenantContext.current(), this.viewerOf(request, clearance), {
      ...(search === undefined ? {} : { search: parseSearchParam(search) }),
      page: parsePageIndexParam(page),
      pageSize: parsePageSizeParam(pageSize),
    });
  }

  /** 修订链（元数据清单口径：clearance 过滤；不含 fileRef——内容走查看留痕路径）。 */
  @Get('revisions/:drawingId')
  @RequirePermission('drawing:read')
  async revisionChain(
    @Req() request: AuthenticatedRequest,
    @Param('drawingId') drawingId: string,
    @Query('clearance') clearance?: string,
  ): Promise<unknown> {
    return this.drawing.revisionChain(
      this.tenantContext.current(),
      this.viewerOf(request, clearance),
      parseDrawingIdParam(drawingId, 'drawingId'),
    );
  }

  /**
   * 查看修订（内容指针 fileRef 的唯一取得路径）：过保密门禁（不可见与不存在
   * 同形 404）→ 必落查看留痕 + DrawingViewed 事件 → 返回内容视图。
   * version 缺省 'latest'；钉版查看传具体修订号。
   * P1-e：referenceTtlSeconds（1..600）声明时回执附短时效只读引用
   * （readReference.url+expiresAt；兑现走 read-references 开门面）。
   */
  @Get('revisions/:drawingId/view')
  @RequirePermission('drawing:read')
  async viewRevision(
    @Req() request: AuthenticatedRequest,
    @Param('drawingId') drawingId: string,
    @Query('version') version?: string,
    @Query('clearance') clearance?: string,
    @Query('referenceTtlSeconds') referenceTtlSeconds?: string,
  ): Promise<unknown> {
    const target =
      version === undefined || version === '' || version === 'latest'
        ? ('latest' as const)
        : parseVersionParam(version, 'version');
    const ttl = parseReadReferenceTtlParam(referenceTtlSeconds);
    return this.drawing.viewRevision(
      this.tenantContext.current(),
      this.viewerOf(request, clearance),
      parseDrawingIdParam(drawingId, 'drawingId'),
      target,
      ttl === undefined ? {} : { readReferenceTtlSeconds: ttl },
    );
  }

  /**
   * 只读引用开门面（P1-e）：短时签名 token 换内容视图。沿 attachment
   * storage/:token 先例**无权限码、无登录门**——token 即唯一凭证（租户绑定=claims 比对；兑现走 viewRevision 全路径门禁+必留痕；登录态加严归 Owner 裁定 P2 安全批）
   * AuthGuard；租户绑定=claims 与当前租户比对）。无效/过期/跨租户一律同形
   * 404（不区分原因，不泄漏存在性）。兑现走 viewRevision 全路径：门禁 +
   **每次必落新查看留痕**（引用不是留痕旁路）。
   */
  @Get('read-references/:token')
  async readReference(@Param('token') token: string): Promise<unknown> {
    const tenant = this.tenantContext.current();
    const claims = this.readReferences.verify(token);
    if (claims === null || claims.tenantId !== tenant) {
      throw new DrawingNotFoundError('图纸只读引用无效或已过期');
    }
    return this.drawing.viewRevision(
      tenant,
      { userId: UserId.create(claims.viewerId), clearance: claims.clearance },
      requireDrawingId(claims.drawingId, 'drawingId'),
      claims.version,
    );
  }

  /** 变更通知读取（sinceVersion 游标；clearance 过滤：通知指向的修订超许可即不可见）。 */
  @Get('notices/:drawingId')
  @RequirePermission('drawing:read')
  async notices(
    @Req() request: AuthenticatedRequest,
    @Param('drawingId') drawingId: string,
    @Query('sinceVersion') sinceVersion?: string,
    @Query('clearance') clearance?: string,
  ): Promise<unknown> {
    return this.drawing.notices(
      this.tenantContext.current(),
      this.viewerOf(request, clearance),
      parseDrawingIdParam(drawingId, 'drawingId'),
      parseSinceVersionParam(sinceVersion),
    );
  }

  /** 按工作令图纸清单（接线 #23：refs 从 workorder 附件装配 + 修订升级视图）。 */
  @Get('work-orders/:workOrderId/drawings')
  @RequirePermission('drawing:read')
  async drawingsForWorkOrder(
    @Req() request: AuthenticatedRequest,
    @Param('workOrderId') workOrderId: string,
    @Query('clearance') clearance?: string,
  ): Promise<unknown> {
    const refs =
      this.workOrderRefs === undefined
        ? []
        : await this.workOrderRefs.listDrawingRefs(this.tenantContext.current(), workOrderId);
    return this.drawing.drawingsForWorkOrder(
      this.tenantContext.current(),
      this.viewerOf(request, clearance),
      refs,
    );
  }

  /** 查看留痕审计（保密管理员；drawing:audit-read 在边缘过滤）。 */
  @Get('view-audit')
  @RequirePermission('drawing:audit-read')
  async viewAudit(
    @Query('drawingId') drawingId?: string,
    @Query('viewedBy') viewedBy?: string,
  ): Promise<unknown> {
    return this.drawing.viewAudit(this.tenantContext.current(), {
      ...(drawingId === undefined || drawingId === ''
        ? {}
        : { drawingId: parseDrawingIdParam(drawingId, 'drawingId') }),
      ...(viewedBy === undefined || viewedBy === '' ? {} : { viewedBy: UserId.create(viewedBy) }),
    });
  }

  /** 事件流（append-only 域事件，审计/调试口径）。 */
  @Get('events')
  @RequirePermission('drawing:read')
  async events(): Promise<unknown> {
    return this.drawing.listEvents(this.tenantContext.current());
  }

  /** 查看者装配：调用方身份 + 显式 clearance（未知词 fail-fast，不默认放行）。 */
  private viewerOf(request: AuthenticatedRequest, clearance: string | undefined) {
    return {
      userId: request[REQUEST_USER_KEY],
      clearance: parseClearance(clearance ?? '', 'clearance'),
    };
  }
}

export interface DrawingHttpModuleOptions {
  /** 五存储端口（组合根注入：PG 句柄或内存缺省）。 */
  readonly stores: DrawingStores;
  /** workorder 附件钉版引用装配端口（接线 #23；drawing+workorder 双侧装配才非空）。 */
  readonly workOrderDrawingRefs?: WorkOrderDrawingRefsPort | undefined;
  /**
   * 只读引用签发器（P1-e 可选注入；缺省=随机密钥实例——重启后旧引用失效，
   * 同附件基座取舍；TTL 逐请求声明，无模块级缺省签发）。
   */
  readonly readReferenceSigner?: DrawingReadReferenceSigner | undefined;
}

@Module({})
export class DrawingHttpModule {
  static register(options: DrawingHttpModuleOptions): DynamicModule {
    const readReferenceSigner = options.readReferenceSigner ?? new DrawingReadReferenceSigner();
    const providers: Provider[] = [
      {
        provide: DrawingService,
        useFactory: () => new DrawingService(options.stores, { readReferences: readReferenceSigner }),
      },
      {
        provide: WORKORDER_DRAWING_REFS,
        useValue: options.workOrderDrawingRefs,
      },
      {
        provide: DRAWING_READ_REFERENCES,
        useValue: readReferenceSigner,
      },
    ];
    return {
      module: DrawingHttpModule,
      controllers: [DrawingCommandsController, DrawingQueriesController],
      providers,
    };
  }
}
