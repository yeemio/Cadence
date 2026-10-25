/**
 * IssueModule —— 发料任务/发料记录模块（U1，A11 增量）。
 *
 * 存储端口注入点与 Listing/Dispatch 模块同一模式：组合根注入 PG 实现
 * （business-store `./issue`，子路径导出登记归合流），缺省回落内存实现（零 DB
 * boot 语义完整）。TenantContext 由 CoreModule（global）导出注入。
 * 跨模块端口缺省：IssueDemandSourcePort → 空实现（同步不生成任何行）；
 * IssueMaterialPort → NOOP（库存联动恒放行、扣减全走可用量——真实联动由
 * inventory 侧合流注入）。dispatch→issue 派工触发钩子（IssueSyncPort 注入
 * dispatch 事件点）与撤销派工清理钩子归合流。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  InMemoryIssueDomainEventStore,
  InMemoryIssueExpressStore,
  InMemoryIssueOperationStore,
  InMemoryIssueRecordStore,
  InMemoryIssueTaskLineStore,
  InMemoryIssueTaskStore,
} from './in-memory-issue-stores.js';
import { IssueRecordsController, IssueTasksController } from './issue.controllers.js';
import { IssueService, type IssueServiceOptions } from './issue.service.js';
import {
  EMPTY_ISSUE_DEMAND_PORT,
  NOOP_ISSUE_MATERIAL_PORT,
  type IssueDemandSourcePort,
  type IssueMaterialPort,
} from './issue-ports.js';
import type {
  IssueDomainEventStore,
  IssueExpressStore,
  IssueOperationStore,
  IssueRecordStore,
  IssueTaskLineStore,
  IssueTaskStore,
} from './issue-stores.js';

export const ISSUE_TASK_STORE = Symbol('smes.issue.taskStore');
export const ISSUE_TASK_LINE_STORE = Symbol('smes.issue.taskLineStore');
export const ISSUE_RECORD_STORE = Symbol('smes.issue.recordStore');
export const ISSUE_EXPRESS_STORE = Symbol('smes.issue.expressStore');
export const ISSUE_OPERATION_STORE = Symbol('smes.issue.operationStore');
export const ISSUE_DOMAIN_EVENT_STORE = Symbol('smes.issue.domainEventStore');
export const ISSUE_DEMAND_SOURCE = Symbol('smes.issue.demandSource');
export const ISSUE_MATERIAL = Symbol('smes.issue.material');

export interface IssueModuleOptions {
  /** 各存储端口；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly taskStore?: IssueTaskStore | undefined;
  readonly taskLineStore?: IssueTaskLineStore | undefined;
  readonly recordStore?: IssueRecordStore | undefined;
  readonly expressStore?: IssueExpressStore | undefined;
  readonly operationStore?: IssueOperationStore | undefined;
  readonly domainEventStore?: IssueDomainEventStore | undefined;
  /** 清单需求行源（合流接线 listing 侧实现）；缺省空实现。 */
  readonly demandSource?: IssueDemandSourcePort | undefined;
  /** 库存/预占联动端口（合流接线 inventory 侧实现）；缺省 NOOP。 */
  readonly material?: IssueMaterialPort | undefined;
  /** 服务选项（时钟注入等）。 */
  readonly serviceOptions?: IssueServiceOptions | undefined;
}

@Module({})
export class IssueModule {
  static register(options: IssueModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: ISSUE_TASK_STORE, useValue: options.taskStore ?? new InMemoryIssueTaskStore() },
      { provide: ISSUE_TASK_LINE_STORE, useValue: options.taskLineStore ?? new InMemoryIssueTaskLineStore() },
      { provide: ISSUE_RECORD_STORE, useValue: options.recordStore ?? new InMemoryIssueRecordStore() },
      { provide: ISSUE_EXPRESS_STORE, useValue: options.expressStore ?? new InMemoryIssueExpressStore() },
      { provide: ISSUE_OPERATION_STORE, useValue: options.operationStore ?? new InMemoryIssueOperationStore() },
      {
        provide: ISSUE_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryIssueDomainEventStore(),
      },
      { provide: ISSUE_DEMAND_SOURCE, useValue: options.demandSource ?? EMPTY_ISSUE_DEMAND_PORT },
      { provide: ISSUE_MATERIAL, useValue: options.material ?? NOOP_ISSUE_MATERIAL_PORT },
      {
        provide: IssueService,
        useFactory: (
          taskStore: IssueTaskStore,
          taskLineStore: IssueTaskLineStore,
          recordStore: IssueRecordStore,
          expressStore: IssueExpressStore,
          operationStore: IssueOperationStore,
          domainEventStore: IssueDomainEventStore,
          demandSource: IssueDemandSourcePort,
          material: IssueMaterialPort,
        ) =>
          new IssueService(
            taskStore,
            taskLineStore,
            recordStore,
            expressStore,
            operationStore,
            domainEventStore,
            demandSource,
            material,
            options.serviceOptions ?? {},
          ),
        inject: [
          ISSUE_TASK_STORE,
          ISSUE_TASK_LINE_STORE,
          ISSUE_RECORD_STORE,
          ISSUE_EXPRESS_STORE,
          ISSUE_OPERATION_STORE,
          ISSUE_DOMAIN_EVENT_STORE,
          ISSUE_DEMAND_SOURCE,
          ISSUE_MATERIAL,
        ],
      },
    ];

    return {
      module: IssueModule,
      controllers: [IssueTasksController, IssueRecordsController],
      providers,
      exports: [IssueService],
    };
  }
}
