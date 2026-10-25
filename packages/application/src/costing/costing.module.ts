/**
 * CostingModule —— 项目成本账模块（M2-W6，09-costing.md v1.0）。账本域：无
 * 状态机、无 engine-flow 依赖（ADR-0010）；体例与 BaselineModule/HoursModule
 * 同模式——存储端口注入点 + 缺省内存回落（零 DB boot 语义完整）。跨模块端口
 * （材料金额 / 工时量 / 外协价格 / 归集主体 / Excel 导出）缺省空实现或内建
 * json-tables 实现，兄弟模块合流时经 register 注入真实端口——本模块只经端口
 * 互调（依赖铁律）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   costing: (stores) =>
 *     CostingModule.register({
 *       entryStore: stores.costingEntryStore, // …PG 注入点，余类推
 *       modelStore: stores.costingModelStore,
 *       snapshotStore: stores.costingSnapshotStore,
 *       eventStore: stores.costingEventStore,
 *       operationStore: stores.costingOperationStore,
 *       // 跨模块端口（合流接线：inventory 金额 / hours 工时 / dispatch 外协 /
 *       // workorder 主体 / ExcelJS 适配器）：
 *       materialSource, laborSource, outsourcingSource, workOrderSubject, excel,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  InMemoryCostEntryStore,
  InMemoryCostSnapshotStore,
  InMemoryCostingDomainEventStore,
  InMemoryCostingModelStore,
  InMemoryCostingOperationStore,
} from './in-memory-costing-stores.js';
import type {
  CostEntryStore,
  CostSnapshotStore,
  CostingDomainEventStore,
  CostingModelStore,
  CostingOperationStore,
} from './costing-stores.js';
import {
  ALWAYS_WORK_ORDER_SUBJECT,
  EMPTY_LABOR_COST_SOURCE,
  EMPTY_MATERIAL_COST_SOURCE,
  EMPTY_OUTSOURCING_COST_SOURCE,
  type LaborCostSourcePort,
  type MaterialCostSourcePort,
  type OutsourcingCostSourcePort,
  type WorkOrderSubjectPort,
} from './costing-ports.js';
import { JsonTablesCostingExcelPort, type CostingExcelPort } from './costing-excel-port.js';
import { CostingLedgerController, CostingModelsController } from './costing.controllers.js';
import { CostingService, type CostingServiceOptions } from './costing.service.js';

export const COSTING_ENTRY_STORE = Symbol('smes.costing.entryStore');
export const COSTING_MODEL_STORE = Symbol('smes.costing.modelStore');
export const COSTING_SNAPSHOT_STORE = Symbol('smes.costing.snapshotStore');
export const COSTING_EVENT_STORE = Symbol('smes.costing.eventStore');
export const COSTING_OPERATION_STORE = Symbol('smes.costing.operationStore');
export const COSTING_MATERIAL_SOURCE = Symbol('smes.costing.materialSource');
export const COSTING_LABOR_SOURCE = Symbol('smes.costing.laborSource');
export const COSTING_OUTSOURCING_SOURCE = Symbol('smes.costing.outsourcingSource');
export const COSTING_WORK_ORDER_SUBJECT = Symbol('smes.costing.workOrderSubject');
export const COSTING_EXCEL_PORT = Symbol('smes.costing.excelPort');
export const COSTING_SERVICE_OPTIONS = Symbol('smes.costing.serviceOptions');

export interface CostingModuleOptions {
  /** 成本条目存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly entryStore?: CostEntryStore | undefined;
  /** 口径版本存储；缺省 = 内存实现。 */
  readonly modelStore?: CostingModelStore | undefined;
  /** 成本快照存储；缺省 = 内存实现。 */
  readonly snapshotStore?: CostSnapshotStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly eventStore?: CostingDomainEventStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: CostingOperationStore | undefined;
  /** inventory 材料金额端口；缺省 = 空实现（材料类归集为空）。 */
  readonly materialSource?: MaterialCostSourcePort | undefined;
  /** hours 工时量端口；缺省 = 空实现。 */
  readonly laborSource?: LaborCostSourcePort | undefined;
  /** dispatch 外协价格端口；缺省 = 空实现。 */
  readonly outsourcingSource?: OutsourcingCostSourcePort | undefined;
  /** workorder 归集主体校验端口；缺省 = 恒真（零接线不阻塞重算）。 */
  readonly workOrderSubject?: WorkOrderSubjectPort | undefined;
  /** Excel 导出端口；缺省 = JsonTablesCostingExcelPort（json-tables 回声；ExcelJS 适配器合流替换）。 */
  readonly excelPort?: CostingExcelPort | undefined;
  /** 服务选项（时钟注入）；缺省 = 系统时钟。 */
  readonly serviceOptions?: CostingServiceOptions | undefined;
}

@Module({})
export class CostingModule {
  static register(options: CostingModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: COSTING_ENTRY_STORE, useValue: options.entryStore ?? new InMemoryCostEntryStore() },
      { provide: COSTING_MODEL_STORE, useValue: options.modelStore ?? new InMemoryCostingModelStore() },
      { provide: COSTING_SNAPSHOT_STORE, useValue: options.snapshotStore ?? new InMemoryCostSnapshotStore() },
      { provide: COSTING_EVENT_STORE, useValue: options.eventStore ?? new InMemoryCostingDomainEventStore() },
      { provide: COSTING_OPERATION_STORE, useValue: options.operationStore ?? new InMemoryCostingOperationStore() },
      { provide: COSTING_MATERIAL_SOURCE, useValue: options.materialSource ?? EMPTY_MATERIAL_COST_SOURCE },
      { provide: COSTING_LABOR_SOURCE, useValue: options.laborSource ?? EMPTY_LABOR_COST_SOURCE },
      { provide: COSTING_OUTSOURCING_SOURCE, useValue: options.outsourcingSource ?? EMPTY_OUTSOURCING_COST_SOURCE },
      { provide: COSTING_WORK_ORDER_SUBJECT, useValue: options.workOrderSubject ?? ALWAYS_WORK_ORDER_SUBJECT },
      { provide: COSTING_EXCEL_PORT, useValue: options.excelPort ?? new JsonTablesCostingExcelPort() },
      { provide: COSTING_SERVICE_OPTIONS, useValue: options.serviceOptions ?? {} },
      {
        provide: CostingService,
        useFactory: (
          entries: CostEntryStore,
          models: CostingModelStore,
          snapshots: CostSnapshotStore,
          events: CostingDomainEventStore,
          operations: CostingOperationStore,
          material: MaterialCostSourcePort,
          labor: LaborCostSourcePort,
          outsourcing: OutsourcingCostSourcePort,
          workOrder: WorkOrderSubjectPort,
          excel: CostingExcelPort,
          serviceOptions: CostingServiceOptions,
        ) =>
          new CostingService(
            { entries, models, snapshots, events, operations },
            { material, labor, outsourcing, workOrder },
            excel,
            serviceOptions,
          ),
        inject: [
          COSTING_ENTRY_STORE,
          COSTING_MODEL_STORE,
          COSTING_SNAPSHOT_STORE,
          COSTING_EVENT_STORE,
          COSTING_OPERATION_STORE,
          COSTING_MATERIAL_SOURCE,
          COSTING_LABOR_SOURCE,
          COSTING_OUTSOURCING_SOURCE,
          COSTING_WORK_ORDER_SUBJECT,
          COSTING_EXCEL_PORT,
          COSTING_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: CostingModule,
      controllers: [CostingModelsController, CostingLedgerController],
      providers,
    };
  }
}
