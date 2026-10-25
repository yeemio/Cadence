/**
 * ApprovalModule —— 审批模块（M1 收尾波-①，engine-flow 的组合根消费者）。
 *
 * ADR-0004 定位：审批属基础层章程（组织权限/基础数据/工作台之后的第 5 个
 * 默认装配模块）。存储端口注入点与 OrgModule/WorkbenchModule 同一模式：
 * 组合根注入 PG 实现（business-store `./approval`），缺省回落内存实现
 * （零 DB boot 语义完整）。记录/事件端口直接采用 engine-flow 端口形状
 * （ADR-0011：application 可依赖 engine-*）；待办端口复用 workbench
 * TodoStore——组合根保证注入同一实例（todo 联动与工作台端点同源）。
 *
 * 配置注入形状（非目标：多级会签配置端点）：config / submitEvent /
 * reviewEvent 整体可注入——换一份 engine-flow 配置即得到不同状态集行为，
 * 本模块编排代码零改动（ADR-0010 条 2）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  DEFAULT_APPROVAL_FLOW_CONFIG,
  createInMemoryApprovalEventStore,
  createInMemoryApprovalRecordStore,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalRecordStore,
} from '@smes/engine-flow';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import { ApprovalCasesController } from './approval.controllers.js';
import { ApprovalService, type ApprovalServiceOptions } from './approval.service.js';
import { InMemoryApprovalCaseStore } from './in-memory-approval-stores.js';
import type { ApprovalCaseStore } from './approval-stores.js';

export const APPROVAL_CASE_STORE = Symbol('smes.approval.caseStore');
export const APPROVAL_RECORD_STORE = Symbol('smes.approval.recordStore');
export const APPROVAL_EVENT_STORE = Symbol('smes.approval.eventStore');
export const APPROVAL_TODO_STORE = Symbol('smes.approval.todoStore');

export interface ApprovalModuleOptions {
  /** 案件行存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly caseStore?: ApprovalCaseStore | undefined;
  /** 决策记录存储（engine-flow 端口）；缺省 = 内存实现。 */
  readonly recordStore?: ApprovalRecordStore | undefined;
  /** 迁移事件存储（engine-flow 端口）；缺省 = 内存实现。 */
  readonly eventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** 审批流配置（缺省 DEFAULT_APPROVAL_FLOW_CONFIG）。 */
  readonly config?: ApprovalFlowConfig | undefined;
  /** 发起命令动词（缺省 'SUBMIT'）。 */
  readonly submitEvent?: string | undefined;
  /** 进审跳步命令动词（缺省 'START_REVIEW'；显式 null = 发起后不自动进审）。 */
  readonly reviewEvent?: string | null | undefined;
}

@Module({})
export class ApprovalModule {
  static register(options: ApprovalModuleOptions = {}): DynamicModule {
    const serviceOptions: ApprovalServiceOptions = {
      config: options.config ?? DEFAULT_APPROVAL_FLOW_CONFIG,
      submitEvent: options.submitEvent ?? 'SUBMIT',
      reviewEvent: options.reviewEvent === undefined ? 'START_REVIEW' : options.reviewEvent,
    };
    const providers: Provider[] = [
      { provide: APPROVAL_CASE_STORE, useValue: options.caseStore ?? new InMemoryApprovalCaseStore() },
      {
        provide: APPROVAL_RECORD_STORE,
        useValue: options.recordStore ?? createInMemoryApprovalRecordStore(),
      },
      {
        provide: APPROVAL_EVENT_STORE,
        useValue: options.eventStore ?? createInMemoryApprovalEventStore(),
      },
      { provide: APPROVAL_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      {
        provide: ApprovalService,
        useFactory: (
          cases: ApprovalCaseStore,
          records: ApprovalRecordStore,
          events: ApprovalEventStore,
          todos: TodoStore,
        ) => new ApprovalService(cases, records, events, todos, serviceOptions),
        inject: [APPROVAL_CASE_STORE, APPROVAL_RECORD_STORE, APPROVAL_EVENT_STORE, APPROVAL_TODO_STORE],
      },
    ];

    return {
      module: ApprovalModule,
      controllers: [ApprovalCasesController],
      providers,
    };
  }
}
