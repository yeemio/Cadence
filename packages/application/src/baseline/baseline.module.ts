/**
 * BaselineModule —— 技术准备环节模块（M2-W2 P1 + M2-W7 P2/P3 件，ADR-0004
 * 按需启停：组合根经 BaselineModule.register 装配，app-registry 接线由总控
 * 合流完成）。
 *
 * 存储端口注入点与 OrgModule/MasterdataModule 同一模式：组合根注入 PG 实现
 * （business-store `./baseline`），缺省回落内存实现（零 DB boot 语义完整）。
 * P2/P3 件新增注入点全部可选——既有 P1 选项与行为零破坏：
 *  - routings / standardTimes / faultReports 三存储（缺省内存）；
 *  - faultEventStore（engine-flow 机器事件账本，缺省内存）、todoStore（workbench
 *    端口，缺省内存——组合根应注入与 WorkbenchModule 共享的实例）、notifyChannel
 *    （IM 端口，缺省 no-op）、workOrderDrawingSource（下图统计事实源，缺省空）；
 *  - faultConfig（故障单状态机配置，缺省 DEFAULT_FAULT_REPORT_FLOW_CONFIG——
 *    ADR-0010 条 2：可整体替换）。
 *
 * itemLibrary 注意：物料校验的比对基准是 masterdata 物品库——**组合根必须注入
 * 与 MasterdataModule 共享的同一 ItemStore 实例**（缺省 = 全新空 InMemoryItemStore，
 * 仅保证零 DB boot 可装配：空库下校验全部判 unmatched，语义诚实）。
 *
 * 阈值与时钟可注入（对账阶段校准阈值不改代码；测试注入固定时钟）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import type { ApprovalEventStore } from '@smes/engine-flow';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryItemStore } from '../masterdata/in-memory-masterdata-stores.js';
import type { ItemStore } from '../masterdata/masterdata-stores.js';
import { InMemoryTodoStore } from '../workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../workbench/workbench-stores.js';
import { NOOP_NOTIFY_CHANNEL, type NotifyChannel } from '../inspection/inspection-ports.js';
import {
  BaselineEquipmentController,
  BaselineFaultReportsController,
  BaselineMaterialValidationsController,
  BaselineOutsourcingRulesController,
  BaselineProcessesController,
  BaselineRoutingsController,
  BaselineStandardTimesController,
} from './baseline.controllers.js';
import {
  createInMemoryBaselineStores,
  InMemoryBaselineEventStore,
  InMemoryBaselineOperationLedger,
  InMemoryEquipmentStore,
  InMemoryFaultReportStore,
  InMemoryMaterialValidationRunStore,
  InMemoryOutsourcingPriceRuleStore,
  InMemoryProcessDefStore,
  InMemoryRoutingStore,
  InMemoryStandardTimeStore,
} from './in-memory-baseline-stores.js';
import { BaselineService, type BaselineServiceOptions } from './baseline.service.js';
import type {
  BaselineEventStore,
  BaselineOperationLedger,
  BaselineStores,
  EquipmentStore,
  FaultReportStore,
  MaterialValidationRunStore,
  OutsourcingPriceRuleStore,
  ProcessDefStore,
  RoutingStore,
  StandardTimeStore,
} from './baseline-stores.js';
import { EMPTY_WORKORDER_DRAWING_SOURCE, type WorkOrderDrawingSource } from './baseline-ports.js';

export const BASELINE_PROCESS_STORE = Symbol('smes.baseline.processStore');
export const BASELINE_EQUIPMENT_STORE = Symbol('smes.baseline.equipmentStore');
export const BASELINE_OUTSOURCING_RULE_STORE = Symbol('smes.baseline.outsourcingRuleStore');
export const BASELINE_VALIDATION_RUN_STORE = Symbol('smes.baseline.validationRunStore');
export const BASELINE_EVENT_STORE = Symbol('smes.baseline.eventStore');
export const BASELINE_OPERATION_LEDGER = Symbol('smes.baseline.operationLedger');
export const BASELINE_ITEM_LIBRARY = Symbol('smes.baseline.itemLibrary');
export const BASELINE_ROUTING_STORE = Symbol('smes.baseline.routingStore');
export const BASELINE_STANDARD_TIME_STORE = Symbol('smes.baseline.standardTimeStore');
export const BASELINE_FAULT_REPORT_STORE = Symbol('smes.baseline.faultReportStore');
export const BASELINE_FAULT_EVENT_STORE = Symbol('smes.baseline.faultEventStore');
export const BASELINE_TODO_STORE = Symbol('smes.baseline.todoStore');
export const BASELINE_NOTIFY_CHANNEL = Symbol('smes.baseline.notifyChannel');
export const BASELINE_WORKORDER_DRAWING_SOURCE = Symbol('smes.baseline.workOrderDrawingSource');

export interface BaselineModuleOptions {
  /** 工序库存储；缺省 = 内存实现。显式 undefined 同缺省。 */
  readonly processStore?: ProcessDefStore | undefined;
  /** 设备台账存储；缺省 = 内存实现。 */
  readonly equipmentStore?: EquipmentStore | undefined;
  /** 外协计价规则存储；缺省 = 内存实现。 */
  readonly outsourcingRuleStore?: OutsourcingPriceRuleStore | undefined;
  /** 物料校验运行存储；缺省 = 内存实现。 */
  readonly validationRunStore?: MaterialValidationRunStore | undefined;
  /** 事件（+Outbox）存储；缺省 = 内存实现。 */
  readonly eventStore?: BaselineEventStore | undefined;
  /** 命令幂等账本；缺省 = 内存实现。 */
  readonly operationLedger?: BaselineOperationLedger | undefined;
  /** 物料库比对基准（masterdata ItemStore）；缺省 = 空内存库（见文件头注意）。 */
  readonly itemLibrary?: ItemStore | undefined;
  /** 物料校验阈值（缺省 DEFAULT_MATERIAL_VALIDATION_THRESHOLDS）。 */
  readonly thresholds?: BaselineServiceOptions['thresholds'];
  /** 时钟注入（缺省真实时钟）。 */
  readonly now?: BaselineServiceOptions['now'];
  // ---- P2/P3 件（M2-W7；全部可选，P1 装配面零破坏） ----
  /** 工艺路线存储（P2）；缺省 = 内存实现。 */
  readonly routingStore?: RoutingStore | undefined;
  /** 额定工时存储（P3）；缺省 = 内存实现。 */
  readonly standardTimeStore?: StandardTimeStore | undefined;
  /** 故障单投影存储（P2）；缺省 = 内存实现。 */
  readonly faultReportStore?: FaultReportStore | undefined;
  /** 故障单状态机事件账本（engine-flow 端口）；缺省 = 内存实现。 */
  readonly faultEventStore?: ApprovalEventStore | undefined;
  /** 待办存储（workbench 端口）；缺省 = 内存实现（组合根注入共享实例见 app-registry）。 */
  readonly todoStore?: TodoStore | undefined;
  /** IM 推送端口（integration-im / 组合根实现）；缺省 = no-op。 */
  readonly notifyChannel?: NotifyChannel | undefined;
  /** 工作令附件图纸计数来源（workorder 线实现）；缺省 = 空实现。 */
  readonly workOrderDrawingSource?: WorkOrderDrawingSource | undefined;
  /** 故障单状态机配置（缺省 DEFAULT_FAULT_REPORT_FLOW_CONFIG；可整体替换）。 */
  readonly faultConfig?: BaselineServiceOptions['faultConfig'];
}

/**
 * 全端口集装配（共享 PG 组合根句柄 connectBaselineStore 的输出形状可直接传入；
 * 内存路径直接缺省）。导出供组合根/测试拼装。P2/P3 三存储随缺省补齐。
 */
export interface BaselineStoreInputs {
  readonly processStore?: ProcessDefStore | undefined;
  readonly equipmentStore?: EquipmentStore | undefined;
  readonly outsourcingRuleStore?: OutsourcingPriceRuleStore | undefined;
  readonly validationRunStore?: MaterialValidationRunStore | undefined;
  readonly eventStore?: BaselineEventStore | undefined;
  readonly operationLedger?: BaselineOperationLedger | undefined;
  readonly routingStore?: RoutingStore | undefined;
  readonly standardTimeStore?: StandardTimeStore | undefined;
  readonly faultReportStore?: FaultReportStore | undefined;
}

/** 从可选端口集补全为全集（缺项回落内存实现）。 */
export function completeBaselineStores(inputs: BaselineStoreInputs = {}): BaselineStores {
  return {
    processes: inputs.processStore ?? new InMemoryProcessDefStore(),
    equipment: inputs.equipmentStore ?? new InMemoryEquipmentStore(),
    outsourcingRules: inputs.outsourcingRuleStore ?? new InMemoryOutsourcingPriceRuleStore(),
    validationRuns: inputs.validationRunStore ?? new InMemoryMaterialValidationRunStore(),
    events: inputs.eventStore ?? new InMemoryBaselineEventStore(),
    operations: inputs.operationLedger ?? new InMemoryBaselineOperationLedger(),
    routings: inputs.routingStore ?? new InMemoryRoutingStore(),
    standardTimes: inputs.standardTimeStore ?? new InMemoryStandardTimeStore(),
    faultReports: inputs.faultReportStore ?? new InMemoryFaultReportStore(),
  };
}

@Module({})
export class BaselineModule {
  static register(options: BaselineModuleOptions = {}): DynamicModule {
    const stores = completeBaselineStores(options);
    const serviceOptions: BaselineServiceOptions = {
      ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.faultConfig === undefined ? {} : { faultConfig: options.faultConfig }),
    };
    const providers: Provider[] = [
      { provide: BASELINE_PROCESS_STORE, useValue: stores.processes },
      { provide: BASELINE_EQUIPMENT_STORE, useValue: stores.equipment },
      { provide: BASELINE_OUTSOURCING_RULE_STORE, useValue: stores.outsourcingRules },
      { provide: BASELINE_VALIDATION_RUN_STORE, useValue: stores.validationRuns },
      { provide: BASELINE_EVENT_STORE, useValue: stores.events },
      { provide: BASELINE_OPERATION_LEDGER, useValue: stores.operations },
      { provide: BASELINE_ITEM_LIBRARY, useValue: options.itemLibrary ?? new InMemoryItemStore() },
      { provide: BASELINE_ROUTING_STORE, useValue: stores.routings },
      { provide: BASELINE_STANDARD_TIME_STORE, useValue: stores.standardTimes },
      { provide: BASELINE_FAULT_REPORT_STORE, useValue: stores.faultReports },
      {
        provide: BaselineService,
        useFactory: (itemLibrary: ItemStore) =>
          new BaselineService(stores, itemLibrary, serviceOptions, {
            machineEvents: options.faultEventStore ?? createInMemoryApprovalEventStore(),
            todos: options.todoStore ?? new InMemoryTodoStore(),
            notify: options.notifyChannel ?? NOOP_NOTIFY_CHANNEL,
            workOrderDrawings: options.workOrderDrawingSource ?? EMPTY_WORKORDER_DRAWING_SOURCE,
          }),
        inject: [BASELINE_ITEM_LIBRARY],
      },
    ];

    return {
      module: BaselineModule,
      controllers: [
        BaselineProcessesController,
        BaselineOutsourcingRulesController,
        BaselineEquipmentController,
        BaselineMaterialValidationsController,
        BaselineRoutingsController,
        BaselineStandardTimesController,
        BaselineFaultReportsController,
      ],
      providers,
    };
  }
}

export { createInMemoryBaselineStores };
