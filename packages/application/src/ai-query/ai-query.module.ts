/**
 * AiQueryModule —— AI 问数模块（CONTRACT v1 · 2026-10-28，WP-A）。
 *
 * 只读消费面：不写业务 store，取数一律经注入的兄弟域 store 端口（组合根注入
 * 共享实例，先例 MODULE_DEFINITIONS 各行）；会话存储缺省内存回落（轻量线程
 * 历史，重启即失）；意图路由缺省规则引擎（DSH 接入时替换 IntentRouter 实现层）。
 * 域权限复核端口必传（组合根用 core/auth PermissionService.authorize 适配，
 * admin bypass 语义由实现方承载）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表；opt-in 模块）：
 *   ai-query: (stores, wiring) =>
 *     AiQueryModule.register({
 *       workOrderStore: stores.workorderOrderStore,
 *       progressFacts: wiring.workorder?.progressPort,
 *       gapCheckStore: stores.listingGapStore,
 *       purchaseRequestStore: stores.listingRequestStore,
 *       purchaseOrderStore: stores.listingOrderStore,
 *       inspectionOrderStore: stores.inspectionOrderStore,
 *       nonconformStore: stores.inspectionNonconformStore,
 *       permissionResolver,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import type { GapCheckStore, PurchaseOrderStore, PurchaseRequestStore } from '../listing/listing-stores.js';
import type { InspectionOrderStore, NonconformStore } from '../inspection/inspection-stores.js';
import type { ProgressFactPort } from '../workorder/workorder-ports.js';
import type { WorkOrderStore } from '../workorder/workorder-stores.js';
import type { AiQueryPermissionResolver, AiQuerySessionStore, IntentRouter } from './ai-query-ports.js';
import { InMemoryAiQuerySessionStore } from './in-memory-ai-query-stores.js';
import { RuleIntentRouter } from './rule-intent-router.js';
import { AiQueryController, AiQuerySessionsController } from './ai-query.controllers.js';
import { AiQueryService, type AiQueryServiceOptions } from './ai-query.service.js';

export const AI_QUERY_WORK_ORDER_STORE = Symbol('smes.aiQuery.workOrderStore');
export const AI_QUERY_PROGRESS_FACTS = Symbol('smes.aiQuery.progressFacts');
export const AI_QUERY_GAP_CHECK_STORE = Symbol('smes.aiQuery.gapCheckStore');
export const AI_QUERY_PURCHASE_REQUEST_STORE = Symbol('smes.aiQuery.purchaseRequestStore');
export const AI_QUERY_PURCHASE_ORDER_STORE = Symbol('smes.aiQuery.purchaseOrderStore');
export const AI_QUERY_INSPECTION_ORDER_STORE = Symbol('smes.aiQuery.inspectionOrderStore');
export const AI_QUERY_NONCONFORM_STORE = Symbol('smes.aiQuery.nonconformStore');
export const AI_QUERY_SESSION_STORE = Symbol('smes.aiQuery.sessionStore');
export const AI_QUERY_PERMISSION_RESOLVER = Symbol('smes.aiQuery.permissionResolver');
export const AI_QUERY_INTENT_ROUTER = Symbol('smes.aiQuery.intentRouter');
export const AI_QUERY_SERVICE_OPTIONS = Symbol('smes.aiQuery.serviceOptions');

export interface AiQueryModuleOptions {
  /** workorder 域工作令投影（必传，组合根注入共享实例）。 */
  readonly workOrderStore: WorkOrderStore;
  /** 进度事实只读端口（必传；与 WorkOrderModule 的 WORKORDER_PROGRESS_PORT 同源实例）。 */
  readonly progressFacts: ProgressFactPort;
  /** listing 域缺口核查快照（必传）。 */
  readonly gapCheckStore: GapCheckStore;
  /** listing 域采购申请（必传）。 */
  readonly purchaseRequestStore: PurchaseRequestStore;
  /** listing 域采购订单（必传）。 */
  readonly purchaseOrderStore: PurchaseOrderStore;
  /** inspection 域质检单（必传）。 */
  readonly inspectionOrderStore: InspectionOrderStore;
  /** inspection 域不合格处置（必传）。 */
  readonly nonconformStore: NonconformStore;
  /** 域权限逐码复核（必传；admin bypass 语义由实现方承载）。 */
  readonly permissionResolver: AiQueryPermissionResolver;
  /** 会话存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly sessionStore?: AiQuerySessionStore | undefined;
  /** 意图路由；缺省 = 规则引擎（RuleIntentRouter）。 */
  readonly intentRouter?: IntentRouter | undefined;
  /** 服务选项（时钟/澄清上限/行表上限）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<AiQueryServiceOptions> | undefined;
}

@Module({})
export class AiQueryModule {
  static register(options: AiQueryModuleOptions): DynamicModule {
    const serviceOptions: Partial<AiQueryServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: AI_QUERY_WORK_ORDER_STORE, useValue: options.workOrderStore },
      { provide: AI_QUERY_PROGRESS_FACTS, useValue: options.progressFacts },
      { provide: AI_QUERY_GAP_CHECK_STORE, useValue: options.gapCheckStore },
      { provide: AI_QUERY_PURCHASE_REQUEST_STORE, useValue: options.purchaseRequestStore },
      { provide: AI_QUERY_PURCHASE_ORDER_STORE, useValue: options.purchaseOrderStore },
      { provide: AI_QUERY_INSPECTION_ORDER_STORE, useValue: options.inspectionOrderStore },
      { provide: AI_QUERY_NONCONFORM_STORE, useValue: options.nonconformStore },
      { provide: AI_QUERY_SESSION_STORE, useValue: options.sessionStore ?? new InMemoryAiQuerySessionStore() },
      { provide: AI_QUERY_PERMISSION_RESOLVER, useValue: options.permissionResolver },
      { provide: AI_QUERY_INTENT_ROUTER, useValue: options.intentRouter ?? new RuleIntentRouter() },
      { provide: AI_QUERY_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: AiQueryService,
        useFactory: (
          workOrders: WorkOrderStore,
          progressFacts: ProgressFactPort,
          gapChecks: GapCheckStore,
          purchaseRequests: PurchaseRequestStore,
          purchaseOrders: PurchaseOrderStore,
          inspectionOrders: InspectionOrderStore,
          nonconforms: NonconformStore,
          sessions: AiQuerySessionStore,
          permissionResolver: AiQueryPermissionResolver,
          intentRouter: IntentRouter,
          serviceOpts: Partial<AiQueryServiceOptions>,
        ) =>
          new AiQueryService(
            {
              workOrders,
              progressFacts,
              gapChecks,
              purchaseRequests,
              purchaseOrders,
              inspectionOrders,
              nonconforms,
            },
            sessions,
            permissionResolver,
            intentRouter,
            serviceOpts,
          ),
        inject: [
          AI_QUERY_WORK_ORDER_STORE,
          AI_QUERY_PROGRESS_FACTS,
          AI_QUERY_GAP_CHECK_STORE,
          AI_QUERY_PURCHASE_REQUEST_STORE,
          AI_QUERY_PURCHASE_ORDER_STORE,
          AI_QUERY_INSPECTION_ORDER_STORE,
          AI_QUERY_NONCONFORM_STORE,
          AI_QUERY_SESSION_STORE,
          AI_QUERY_PERMISSION_RESOLVER,
          AI_QUERY_INTENT_ROUTER,
          AI_QUERY_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: AiQueryModule,
      controllers: [AiQueryController, AiQuerySessionsController],
      providers,
    };
  }
}
