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
import {
  InMemoryCostPriceEntryStore,
  InMemoryCostProjectEntryStore,
  InMemoryCostProjectSnapshotStore,
} from './in-memory-project-cost-stores.js';
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
import {
  EMPTY_PROJECT_AFTERCARE_CLAIM_SOURCE,
  EMPTY_PROJECT_EQUIPMENT_PURCHASE_SOURCE,
  EMPTY_PROJECT_ISSUE_SOURCE,
  NOOP_ISSUE_PRICE_WRITEBACK,
  type IssuePriceWritebackPort,
  type ProjectAftercareClaimSourcePort,
  type ProjectEquipmentPurchaseSourcePort,
  type ProjectIssueCostSourcePort,
  type ProjectCostSourcePorts,
} from './project-cost-ports.js';
import type {
  CostPriceEntryStore,
  CostProjectEntryStore,
  CostProjectSnapshotStore,
  ProjectCostStores,
} from './project-cost-stores.js';
import { JsonTablesCostingExcelPort, type CostingExcelPort } from './costing-excel-port.js';
import { CostingLedgerController, CostingModelsController } from './costing.controllers.js';
import { ProjectCostController } from './project-cost.controllers.js';
import { CostingService, type CostingServiceOptions } from './costing.service.js';
import { ProjectCostService, type ProjectCostServiceOptions } from './project-cost.service.js';

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
// ---- U7 项目成本注入点（六块取数源 + 三存储 + 写回端口 + 服务选项） ----
export const COSTING_PROJECT_ENTRY_STORE = Symbol('smes.costing.projectEntryStore');
export const COSTING_PROJECT_SNAPSHOT_STORE = Symbol('smes.costing.projectSnapshotStore');
export const COSTING_PRICE_ENTRY_STORE = Symbol('smes.costing.priceEntryStore');
export const COSTING_PROJECT_ISSUE_SOURCE = Symbol('smes.costing.projectIssueSource');
export const COSTING_PROJECT_EQUIPMENT_SOURCE = Symbol('smes.costing.projectEquipmentSource');
export const COSTING_PROJECT_AFTERCARE_SOURCE = Symbol('smes.costing.projectAftercareSource');
export const COSTING_PROJECT_PRICE_WRITEBACK = Symbol('smes.costing.projectPriceWriteback');
export const COSTING_PROJECT_SERVICE_OPTIONS = Symbol('smes.costing.projectServiceOptions');

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
  // ---- U7 项目成本（六块聚合；缺省 = 内存存储 + 空源——零接线各块归集为空） ----
  /** 项目成本段事实存储；缺省 = 内存实现。 */
  readonly projectEntryStore?: CostProjectEntryStore | undefined;
  /** 项目成本快照存储；缺省 = 内存实现。 */
  readonly projectSnapshotStore?: CostProjectSnapshotStore | undefined;
  /** 录入价格存储；缺省 = 内存实现。 */
  readonly priceEntryStore?: CostPriceEntryStore | undefined;
  /** issue 发料行段源（②材料 + ⑥利库段）；缺省 = 空实现。 */
  readonly projectIssueSource?: ProjectIssueCostSourcePort | undefined;
  /** listing 外购设备采购源（⑥采购段）；缺省 = 空实现。 */
  readonly projectEquipmentSource?: ProjectEquipmentPurchaseSourcePort | undefined;
  /** dispatch 售后报销源（⑤报销段）；缺省 = 空实现。 */
  readonly projectAftercareSource?: ProjectAftercareClaimSourcePort | undefined;
  /** 录入价格写回端口（单向通知）；缺省 = NOOP。 */
  readonly priceWriteback?: IssuePriceWritebackPort | undefined;
  /** 项目成本服务选项（时钟/写回失败钩子）；缺省 = 系统时钟 + console.warn。 */
  readonly projectServiceOptions?: ProjectCostServiceOptions | undefined;
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
      // ---- U7 项目成本：存储缺省内存 + 源缺省空 + 共享三存储复用上面同实例 ----
      { provide: COSTING_PROJECT_ENTRY_STORE, useValue: options.projectEntryStore ?? new InMemoryCostProjectEntryStore() },
      { provide: COSTING_PROJECT_SNAPSHOT_STORE, useValue: options.projectSnapshotStore ?? new InMemoryCostProjectSnapshotStore() },
      { provide: COSTING_PRICE_ENTRY_STORE, useValue: options.priceEntryStore ?? new InMemoryCostPriceEntryStore() },
      { provide: COSTING_PROJECT_ISSUE_SOURCE, useValue: options.projectIssueSource ?? EMPTY_PROJECT_ISSUE_SOURCE },
      { provide: COSTING_PROJECT_EQUIPMENT_SOURCE, useValue: options.projectEquipmentSource ?? EMPTY_PROJECT_EQUIPMENT_PURCHASE_SOURCE },
      { provide: COSTING_PROJECT_AFTERCARE_SOURCE, useValue: options.projectAftercareSource ?? EMPTY_PROJECT_AFTERCARE_CLAIM_SOURCE },
      { provide: COSTING_PROJECT_PRICE_WRITEBACK, useValue: options.priceWriteback ?? NOOP_ISSUE_PRICE_WRITEBACK },
      { provide: COSTING_PROJECT_SERVICE_OPTIONS, useValue: options.projectServiceOptions ?? {} },
      {
        provide: ProjectCostService,
        useFactory: (
          projectEntries: CostProjectEntryStore,
          projectSnapshots: CostProjectSnapshotStore,
          priceEntries: CostPriceEntryStore,
          models: CostingModelStore,
          events: CostingDomainEventStore,
          operations: CostingOperationStore,
          labor: LaborCostSourcePort,
          outsourcing: OutsourcingCostSourcePort,
          workOrder: WorkOrderSubjectPort,
          issueSegments: ProjectIssueCostSourcePort,
          equipmentPurchases: ProjectEquipmentPurchaseSourcePort,
          aftercareClaims: ProjectAftercareClaimSourcePort,
          priceWriteback: IssuePriceWritebackPort,
          projectServiceOptions: ProjectCostServiceOptions,
        ) => {
          const sources: ProjectCostSourcePorts = {
            issueSegments,
            equipmentPurchases,
            aftercareClaims,
            labor,
            outsourcing,
            workOrder,
            priceWriteback,
          };
          const stores: ProjectCostStores = { projectEntries, projectSnapshots, priceEntries };
          return new ProjectCostService(stores, { models, events, operations }, sources, projectServiceOptions);
        },
        inject: [
          COSTING_PROJECT_ENTRY_STORE,
          COSTING_PROJECT_SNAPSHOT_STORE,
          COSTING_PRICE_ENTRY_STORE,
          COSTING_MODEL_STORE,
          COSTING_EVENT_STORE,
          COSTING_OPERATION_STORE,
          // ④/⑤ 工时段与 ③ 外协段、主体校验复用既有三源注入令牌（同一实例）
          COSTING_LABOR_SOURCE,
          COSTING_OUTSOURCING_SOURCE,
          COSTING_WORK_ORDER_SUBJECT,
          COSTING_PROJECT_ISSUE_SOURCE,
          COSTING_PROJECT_EQUIPMENT_SOURCE,
          COSTING_PROJECT_AFTERCARE_SOURCE,
          COSTING_PROJECT_PRICE_WRITEBACK,
          COSTING_PROJECT_SERVICE_OPTIONS,
        ],
      },
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
      controllers: [CostingModelsController, CostingLedgerController, ProjectCostController],
      providers,
    };
  }
}
