/**
 * AftercareClaimModule —— 售后报销模块（U5 A12）。
 *
 * 独立 DynamicModule（不动 DispatchModule 既有装配面）：存储端口注入点 + 缺省
 * 内存回落（零 DB boot 语义完整），幂等记账/域事件复用 dispatch 既有端口形状。
 * 派工单读、幂等记账、域事件三存储须与 DispatchModule 共享同一实例——组合根
 * 注册时把 DispatchModule.register 用的同批 store 经本模块 options 传入
 * （接线归合流，注册示例）：
 *   const dispatchStores = connectDispatchStore();          // business-store PG 装配
 *   DispatchModule.register({ orderStore: dispatchStores.orderStore, ... });
 *   AftercareClaimModule.register({
 *     orderStore: dispatchStores.orderStore,               // 同一派工单投影
 *     claimStore: dispatchStores.aftercareClaimStore,
 *     operationStore: dispatchStores.operationStore,        // 同一幂等账本
 *     domainEventStore: dispatchStores.domainEventStore,    // 同一事件/Outbox 面
 *     reportPort: createAftercareReportPort(reportingService), // reporting 合流接线
 *   });
 * 跨模块端口（审批通过报工读）缺省空实现 = fail-closed（未接线时报销新增被拒，
 * 体例同 EMPTY_KIT_CHECK_PORT）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  InMemoryDispatchDomainEventStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchOrderStore,
} from './in-memory-dispatch-stores.js';
import { InMemoryAftercareClaimStore } from './in-memory-aftercare-claim-stores.js';
import type {
  AftercareClaimStore,
} from './aftercare-claim-stores.js';
import type {
  DispatchDomainEventStore,
  DispatchOperationStore,
  DispatchOrderStore,
} from './dispatch-stores.js';
import {
  EMPTY_AFTERCARE_REPORT_PORT,
  type AftercareApprovedReportPort,
} from './aftercare-claim-ports.js';
import { AftercareClaimController } from './aftercare-claim.controllers.js';
import { AftercareClaimService, type AftercareClaimServiceOptions } from './aftercare-claim.service.js';

export const AFTERCARE_CLAIM_ORDER_STORE = Symbol('smes.dispatch.aftercareClaim.orderStore');
export const AFTERCARE_CLAIM_STORE = Symbol('smes.dispatch.aftercareClaim.store');
export const AFTERCARE_CLAIM_OPERATION_STORE = Symbol('smes.dispatch.aftercareClaim.operationStore');
export const AFTERCARE_CLAIM_DOMAIN_EVENT_STORE = Symbol('smes.dispatch.aftercareClaim.domainEventStore');
export const AFTERCARE_CLAIM_REPORT_PORT = Symbol('smes.dispatch.aftercareClaim.reportPort');
export const AFTERCARE_CLAIM_SERVICE_OPTIONS = Symbol('smes.dispatch.aftercareClaim.serviceOptions');

export interface AftercareClaimModuleOptions {
  /** 派工单投影存储（须与 DispatchModule 共享实例）；缺省 = 内存实现。 */
  readonly orderStore?: DispatchOrderStore | undefined;
  /** 报销单存储；缺省 = 内存实现。 */
  readonly claimStore?: AftercareClaimStore | undefined;
  /** 命令幂等记账存储（须与 DispatchModule 共享实例）；缺省 = 内存实现。 */
  readonly operationStore?: DispatchOperationStore | undefined;
  /** 域事件存储（须与 DispatchModule 共享实例）；缺省 = 内存实现。 */
  readonly domainEventStore?: DispatchDomainEventStore | undefined;
  /** 审批通过报工读端口（reporting 合流接线）；缺省 = 空实现（fail-closed）。 */
  readonly reportPort?: AftercareApprovedReportPort | undefined;
  /** 服务选项（时钟）；缺省 = 真实时间。 */
  readonly serviceOptions?: Partial<AftercareClaimServiceOptions> | undefined;
}

@Module({})
export class AftercareClaimModule {
  static register(options: AftercareClaimModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<AftercareClaimServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: AFTERCARE_CLAIM_ORDER_STORE, useValue: options.orderStore ?? new InMemoryDispatchOrderStore() },
      { provide: AFTERCARE_CLAIM_STORE, useValue: options.claimStore ?? new InMemoryAftercareClaimStore() },
      {
        provide: AFTERCARE_CLAIM_OPERATION_STORE,
        useValue: options.operationStore ?? new InMemoryDispatchOperationStore(),
      },
      {
        provide: AFTERCARE_CLAIM_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryDispatchDomainEventStore(),
      },
      { provide: AFTERCARE_CLAIM_REPORT_PORT, useValue: options.reportPort ?? EMPTY_AFTERCARE_REPORT_PORT },
      { provide: AFTERCARE_CLAIM_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: AftercareClaimService,
        useFactory: (
          orders: DispatchOrderStore,
          claims: AftercareClaimStore,
          operations: DispatchOperationStore,
          domainEvents: DispatchDomainEventStore,
          reports: AftercareApprovedReportPort,
          serviceOpts: Partial<AftercareClaimServiceOptions>,
        ) =>
          new AftercareClaimService(orders, claims, operations, domainEvents, reports, {
            ...(serviceOpts.now === undefined ? {} : { now: serviceOpts.now }),
          }),
        inject: [
          AFTERCARE_CLAIM_ORDER_STORE,
          AFTERCARE_CLAIM_STORE,
          AFTERCARE_CLAIM_OPERATION_STORE,
          AFTERCARE_CLAIM_DOMAIN_EVENT_STORE,
          AFTERCARE_CLAIM_REPORT_PORT,
          AFTERCARE_CLAIM_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: AftercareClaimModule,
      controllers: [AftercareClaimController],
      providers,
    };
  }
}

// 本模块无状态机——机器事件账本（ApprovalEventStore）不在报销面：报销单是
// 版本化数据（体例同 outsourcing_lines），乐观推进即 updateFees +1。
