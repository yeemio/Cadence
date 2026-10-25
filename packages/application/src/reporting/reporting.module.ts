/**
 * ReportingModule —— 五类报工与核查模块（M2-W7，05-reporting.md"执行申报"环节）。
 *
 * 体例与 Listing/DispatchModule 同一模式：存储端口注入点 + 缺省内存回落（零 DB
 * boot 语义完整）；机器事件账本采用 engine-flow 端口形状（ADR-0011：application
 * 可依赖 engine-*）。跨模块端口（dispatch 有效派工单读 / baseline 工序合法性与
 * 末道判定 / inspection 末道报工触发）缺省空实现，兄弟模块与边缘包合流时经
 * register 注入真实端口——本模块只经端口互调（依赖铁律；application 禁依赖
 * integration-*）。
 *
 * 配置注入形状：报工状态机配置整体可注入（换配置 = 换合法集，ADR-0010 条 2）；
 * 可报派工单状态集 / 批量上限 / 末道质检 kind 集为初版口径参数（默认配置层，
 * 客户口径整体替换）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   reporting: (stores) =>
 *     ReportingModule.register({
 *       reportStore: stores.workReportStore, // …PG 注入点，余类推
 *       // 跨模块端口（合流接线）：
 *       validDispatch, operationValidity, finalOperation, inspectionIntake,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { createInMemoryApprovalEventStore, type ApprovalEventStore } from '@smes/engine-flow';
import {
  InMemoryReportAuditStore,
  InMemoryReportDomainEventStore,
  InMemoryReportOperationStore,
  InMemoryWorkReportStore,
} from './in-memory-reporting-stores.js';
import type {
  ReportAuditStore,
  ReportDomainEventStore,
  ReportOperationStore,
  WorkReportStore,
} from './reporting-stores.js';
import {
  ALL_OPERATIONS_VALID,
  EMPTY_VALID_DISPATCH_SOURCE,
  NEVER_FINAL_OPERATION,
  REPORTING_NOOP_INSPECTION_INTAKE,
  type FinalOperationJudgePort,
  type InspectionIntakePort,
  type OperationValidityPort,
  type ValidDispatchSource,
} from './reporting-ports.js';
import { ReportsController, ReportingQueriesController } from './reporting.controllers.js';
import { ReportingService, type ReportingServiceOptions } from './reporting.service.js';

export const WORK_REPORT_STORE = Symbol('smes.reporting.workReportStore');
export const REPORT_AUDIT_STORE = Symbol('smes.reporting.reportAuditStore');
export const REPORT_OPERATION_STORE = Symbol('smes.reporting.operationStore');
export const REPORT_DOMAIN_EVENT_STORE = Symbol('smes.reporting.domainEventStore');
export const REPORT_MACHINE_EVENT_STORE = Symbol('smes.reporting.machineEventStore');
export const REPORT_VALID_DISPATCH_SOURCE = Symbol('smes.reporting.validDispatchSource');
export const REPORT_OPERATION_VALIDITY = Symbol('smes.reporting.operationValidity');
export const REPORT_FINAL_OPERATION = Symbol('smes.reporting.finalOperation');
export const REPORT_INSPECTION_INTAKE = Symbol('smes.reporting.inspectionIntake');
export const REPORTING_SERVICE_OPTIONS = Symbol('smes.reporting.serviceOptions');

export interface ReportingModuleOptions {
  /** 报工单投影存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly reportStore?: WorkReportStore | undefined;
  /** 核查留痕存储；缺省 = 内存实现。 */
  readonly auditStore?: ReportAuditStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: ReportOperationStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly domainEventStore?: ReportDomainEventStore | undefined;
  /** 状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly machineEventStore?: ApprovalEventStore | undefined;
  /** dispatch 有效派工单读端口（submit 前置校验 + 工艺快照）；缺省 = 空（fail-closed 拒）。 */
  readonly validDispatch?: ValidDispatchSource | undefined;
  /** baseline 工序合法性端口；缺省 = 恒合法（fail-open 复检）。 */
  readonly operationValidity?: OperationValidityPort | undefined;
  /** baseline 工艺路线末道判定端口；缺省 = 恒非末道（不触发质检）。 */
  readonly finalOperation?: FinalOperationJudgePort | undefined;
  /** inspection 末道报工触发端口；缺省 = 空实现（回执 created:false，申报不阻塞）。 */
  readonly inspectionIntake?: InspectionIntakePort | undefined;
  /** 服务选项（状态机配置/可报状态集/批量上限/末道质检集/时钟）；缺省 = 初版默认。 */
  readonly serviceOptions?: Partial<ReportingServiceOptions> | undefined;
}

@Module({})
export class ReportingModule {
  static register(options: ReportingModuleOptions = {}): DynamicModule {
    const serviceOptions: Partial<ReportingServiceOptions> = options.serviceOptions ?? {};
    const providers: Provider[] = [
      { provide: WORK_REPORT_STORE, useValue: options.reportStore ?? new InMemoryWorkReportStore() },
      { provide: REPORT_AUDIT_STORE, useValue: options.auditStore ?? new InMemoryReportAuditStore() },
      { provide: REPORT_OPERATION_STORE, useValue: options.operationStore ?? new InMemoryReportOperationStore() },
      {
        provide: REPORT_DOMAIN_EVENT_STORE,
        useValue: options.domainEventStore ?? new InMemoryReportDomainEventStore(),
      },
      {
        provide: REPORT_MACHINE_EVENT_STORE,
        useValue: options.machineEventStore ?? createInMemoryApprovalEventStore(),
      },
      {
        provide: REPORT_VALID_DISPATCH_SOURCE,
        useValue: options.validDispatch ?? EMPTY_VALID_DISPATCH_SOURCE,
      },
      {
        provide: REPORT_OPERATION_VALIDITY,
        useValue: options.operationValidity ?? ALL_OPERATIONS_VALID,
      },
      { provide: REPORT_FINAL_OPERATION, useValue: options.finalOperation ?? NEVER_FINAL_OPERATION },
      {
        provide: REPORT_INSPECTION_INTAKE,
        useValue: options.inspectionIntake ?? REPORTING_NOOP_INSPECTION_INTAKE,
      },
      { provide: REPORTING_SERVICE_OPTIONS, useValue: serviceOptions },
      {
        provide: ReportingService,
        useFactory: (
          reports: WorkReportStore,
          audits: ReportAuditStore,
          operations: ReportOperationStore,
          domainEvents: ReportDomainEventStore,
          machineEvents: ApprovalEventStore,
          validDispatch: ValidDispatchSource,
          operationValidity: OperationValidityPort,
          finalOperation: FinalOperationJudgePort,
          inspectionIntake: InspectionIntakePort,
          serviceOpts: Partial<ReportingServiceOptions>,
        ) =>
          new ReportingService(
            reports,
            audits,
            operations,
            domainEvents,
            machineEvents,
            { validDispatch, operationValidity, finalOperation, inspectionIntake },
            serviceOpts,
          ),
        inject: [
          WORK_REPORT_STORE,
          REPORT_AUDIT_STORE,
          REPORT_OPERATION_STORE,
          REPORT_DOMAIN_EVENT_STORE,
          REPORT_MACHINE_EVENT_STORE,
          REPORT_VALID_DISPATCH_SOURCE,
          REPORT_OPERATION_VALIDITY,
          REPORT_FINAL_OPERATION,
          REPORT_INSPECTION_INTAKE,
          REPORTING_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: ReportingModule,
      controllers: [ReportsController, ReportingQueriesController],
      providers,
    };
  }
}
