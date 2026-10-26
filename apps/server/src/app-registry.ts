/**
 * 应用注册表（ADR-0004 机器形态）：读 MODULES_ENABLED 决定装配哪些模块、以什么顺序。
 * core 是必装基础层，注册表拒绝缺省；报价单的可选模块行 ↔ 本表条目一一对应。
 *
 * 新增模块 = packages/application/src/<module>/ 新增 XxxModule.register(options)
 * + 在 MODULE_DEFINITIONS 登记一行。九循环环节模块随 M2 增补，增补不改机制。
 */
import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  ApprovalModule,
  AuditModule,
  AuditWriteInterceptor,
  AuthModule,
  BaselineModule,
  CoreModule,
  CostingModule,
  DemoModule,
  DispatchModule,
  AftercareClaimModule,
  AttachmentModule,
  IssueModule,
  HoursModule,
  InspectionModule,
  InMemoryDispatchOrderStore,
  InMemoryItemStore,
  InMemoryLaborEntryStore,
  InMemoryBaselineEventStore,
  InMemoryKitCheckStore,
  InMemoryOutsourcingLineStore,
  InMemoryPurchaseOrderStore,
  InMemoryReportDomainEventStore,
  InMemorySessionStore,
  InMemoryStockMovementStore,
  InMemoryTodoStore,
  InMemoryUserStore,
  InMemoryWorkOrderAttachmentStore,
  InMemoryWorkOrderDomainEventStore,
  InMemoryWorkOrderStore,
  InMemoryWorkReportStore,
  InMemoryAftercareClaimStore,
  InMemoryIssueRecordStore,
  InMemoryListingLineStore,
  InventoryModule,
  ListingModule,
  MasterdataModule,
  MenuConfigModule,
  NotificationsModule,
  ApprovalConfigModule,
  InMemoryMenuConfigStore,
  InMemoryNotificationStore,
  InMemoryApprovalFlowConfigStore,
  InMemoryDispatchOperationStore,
  InMemoryDispatchDomainEventStore,
  InMemoryStockReservationStore,
  InMemoryInventoryDomainEventStore,
  OrgModule,
  ReportingModule,
  // A8/A10 首波：数字运营大屏（SSE 推送 + A10 日跑批；组合根 HTTP 面）
  // ScreenHttpModule 从本仓 screen-http.module 导入（A8 装配，writer 写于 apps/server）：
  StandardReportsModule,
  InMemoryMachiningDailyStatsStore,
  WorkbenchModule,
  WorkOrderModule,
  type ApprovalCaseStore,
  type AuditLogStore,
  type BaselineEventStore,
  type BaselineOperationLedger,
  type CostEntryStore,
  type CostingDomainEventStore,
  type CostingModelStore,
  type CostingOperationStore,
  type CostSnapshotStore,
  type CostProjectEntryStore,
  type CostProjectSnapshotStore,
  type CostPriceEntryStore,
  type CustomerStore,
  type DepartmentStore,
  type DispatchDomainEventStore,
  type DispatchOperationStore,
  type DispatchOrderStore,
  type EquipmentStore,
  type FaultReportStore,
  type GapCheckStore,
  type HoursDomainEventStore,
  type HoursOperationStore,
  type InspectionDomainEventStore,
  type InspectionOperationStore,
  type InventoryDomainEventStore,
  type InventoryOperationStore,
  type ItemStore,
  type KitCheckStore,
  type ListingDomainEventStore,
  type ListingLineStore,
  type ListingOperationStore,
  type ListingSheetStore,
  type MachiningDailyStatsStore,
  type StockLocationBalanceStore,
  type MaterialValidationRunStore,
  type StockMovementStore,
  type NonconformStore,
  type OutsourcingLineStore,
  type OutsourcingPriceRuleStore,
  type PartsRequestStore,
  type PolicyStore,
  type LaborEntryStore,
  type LaborLedgerMonthStore,
  type PositionStore,
  type ProcessDefStore,
  type ReportAuditStore,
  type ReportDomainEventStore,
  type ReportOperationStore,
  type PurchaseOrderStore,
  type PurchaseRequestStore,
  type PurchaseReturnStore,
  type ReleaseFactStore,
  type ReportSourceProvider,
  type StockReservationStore,
  type ResourceStore,
  type RoleStore,
  type SessionStore,
  type ShippingOrderStore,
  type StockAccountStore,
  type StocktakeStore,
  type SupplierStore,
  type TodoStore,
  type UnitStore,
  type UserStore,
  type WarehouseStore,
  type InspectionOrderStore,
  type WorkReportStore,
  type WorkOrderAttachmentStore,
  type WorkOrderDomainEventStore,
  type WorkOrderOperationStore,
  type WorkOrderStore,
  type RoutingStore,
  type StandardTimeStore,
  type MenuConfigStore,
  type NotificationStore,
  type ApprovalFlowConfigStore,
  type AftercareClaimStore,
  type AttachmentStore,
  type ObjectStoragePort,
  type IssueTaskStore,
  type IssueTaskLineStore,
  type IssueRecordStore,
  type IssueExpressStore,
  type IssueOperationStore,
  type IssueDomainEventStore,
  type ProcessMaterialLinkStore,
} from '@smes/application';
import { parseDailyTenants, ScreenHttpModule } from './screen-http.module.js';
import { inMemoryPayrollStores, type PayrollStores } from '@smes/payroll';
import { PayrollHttpModule } from './payroll-http.module.js';
import { inMemoryMaintenanceStores, type MaintenanceStores } from '@smes/maintenance';
import { MaintenanceHttpModule } from './maintenance-http.module.js';
import { inMemoryDrawingStores, type DrawingStores } from '@smes/drawing';
import { DrawingHttpModule } from './drawing-http.module.js';
import { inMemoryMetricPackStores, type MetricPackStores, type MetricSourceSet } from '@smes/metric-pack';
import { MetricPackHttpModule } from './metric-pack-http.module.js';
import type {
  ApprovalEventStore,
  ApprovalRecordStore,
} from '@smes/engine-flow';
import type { TenantId } from '@smes/business-core';
import { UserId } from '@smes/business-core';
import { AuthGuard } from './auth.guard.js';
import {
  createCrossModuleWiring,
  createTodoNotifyingStore,
  CROSS_MODULE_WIRING,
  HOURS_INGEST_TRIGGER,
  type CrossModuleRegisterPorts,
  type CrossModuleWiringStores,
  type ImNotifySink,
  type PrintSubmitSink,
} from './cross-module-wiring.js';
import { DevPolicyController } from './dev-policy.controller.js';
import { HealthController } from './health.controller.js';
import { HoursIngestLinkInterceptor } from './hours-ingest.interceptor.js';
import { ENABLED_MODULE_NAMES, ModulesController } from './modules.controller.js';

/** 必装基础层（ADR-0004 基础层：core）。 */
export const REQUIRED_MODULE = 'core';

/**
 * MODULES_ENABLED 缺省值（M1 收尾波-①：审批 approval 进默认装配，六模块——
 * 组织权限/基础数据/工作台待办/审批均属 core 基础层章程，ADR-0004 基础层
 * 清单；engine-flow 经 ApprovalModule 首次进组合根，ADR-0011 首个消费者）。
 */
export const DEFAULT_MODULES_ENABLED = 'core,org,masterdata,workbench,approval,demo';

/** 组合根注入的持久化端口集合（缺省回落 application 内存实现——零 DB boot 语义完整）。 */
export interface StorePorts {
  /** casbin 策略存储（CoreModule.policyStore 注入点）。 */
  readonly policyStore?: PolicyStore | undefined;
  /** 用户元数据存储（OrgModule 与 AuthModule 共享注入点——同一实例）。 */
  readonly userStore?: UserStore | undefined;
  /** 角色元数据存储（OrgModule 注入点）。 */
  readonly roleStore?: RoleStore | undefined;
  /** 机构/部门主数据存储（OrgModule 注入点，S1 backfill：0920 #3）。 */
  readonly departmentStore?: DepartmentStore | undefined;
  /** 岗位主数据存储（OrgModule 注入点，S1 backfill：0920 #7）。 */
  readonly positionStore?: PositionStore | undefined;
  /** 会话存储（AuthModule 注入点；users.active 停用撤销同源，收尾波-③）。 */
  readonly sessionStore?: SessionStore | undefined;
  /** 物品主数据存储（MasterdataModule 注入点）。 */
  readonly itemStore?: ItemStore | undefined;
  /** 资源主数据存储（MasterdataModule 注入点）。 */
  readonly resourceStore?: ResourceStore | undefined;
  /** 客户主数据存储（MasterdataModule 注入点，S1 backfill：0920 #8）。 */
  readonly customerStore?: CustomerStore | undefined;
  /** 供应商主数据存储（MasterdataModule 注入点，S1 backfill：0920 #9）。 */
  readonly supplierStore?: SupplierStore | undefined;
  /** 计量单位字典存储（MasterdataModule 注入点，S1 backfill：0920 #100）。 */
  readonly unitStore?: UnitStore | undefined;
  /** 待办存储（WorkbenchModule 与 ApprovalModule 共享注入点——待办联动同源）。 */
  readonly todoStore?: TodoStore | undefined;
  /** 审批案件存储（ApprovalModule 注入点）。 */
  readonly approvalCaseStore?: ApprovalCaseStore | undefined;
  /** 审批决策记录存储（engine-flow 端口，ApprovalModule 注入点）。 */
  readonly approvalRecordStore?: ApprovalRecordStore | undefined;
  /** 审批迁移事件存储（engine-flow 端口，ApprovalModule 注入点）。 */
  readonly approvalEventStore?: ApprovalEventStore | undefined;
  /** 工序库存储（BaselineModule 注入点，M2 Wave-1）。 */
  readonly baselineProcessStore?: ProcessDefStore | undefined;
  /** 设备台账存储（BaselineModule 注入点）。 */
  readonly baselineEquipmentStore?: EquipmentStore | undefined;
  /** 外协计价规则存储（BaselineModule 注入点）。 */
  readonly baselineOutsourcingRuleStore?: OutsourcingPriceRuleStore | undefined;
  /** 物料校验运行存储（BaselineModule 注入点）。 */
  readonly baselineValidationRunStore?: MaterialValidationRunStore | undefined;
  /** baseline 域事件（+Outbox）存储（BaselineModule 注入点）。 */
  readonly baselineEventStore?: BaselineEventStore | undefined;
  /** baseline 命令幂等账本（BaselineModule 注入点）。 */
  readonly baselineOperationLedger?: BaselineOperationLedger | undefined;
  /** 工作令投影存储（WorkOrderModule 注入点，M2 Wave-1）。 */
  readonly workOrderStore?: WorkOrderStore | undefined;
  /** 工作令附件事实存储（WorkOrderModule 注入点）。 */
  readonly workOrderAttachmentStore?: WorkOrderAttachmentStore | undefined;
  /** 配件申请投影存储（WorkOrderModule 注入点）。 */
  readonly workOrderPartsStore?: PartsRequestStore | undefined;
  /** 齐套快照存储（WorkOrderModule 注入点）。 */
  readonly workOrderKitStore?: KitCheckStore | undefined;
  /** 工作令命令幂等记账存储（WorkOrderModule 注入点）。 */
  readonly workOrderOperationStore?: WorkOrderOperationStore | undefined;
  /** 工作令域事件（BusinessEvent + Outbox）存储（WorkOrderModule 注入点）。 */
  readonly workOrderDomainEventStore?: WorkOrderDomainEventStore | undefined;
  /** 工作令状态机事件账本（engine-flow 端口，WorkOrderModule 注入点）。 */
  readonly workOrderMachineEventStore?: ApprovalEventStore | undefined;
  /** 清单单据头存储（ListingModule 注入点，M2 Wave-2）。 */
  readonly listingSheetStore?: ListingSheetStore | undefined;
  /** 清单行存储（ListingModule 注入点）。 */
  readonly listingLineStore?: ListingLineStore | undefined;
  /** A10 机加日统计存储（ScreenHttpModule 注入点，A8/A10 首波：PG 句柄或内存缺省）。 */
  readonly machiningDailyStatsStore?: MachiningDailyStatsStore | undefined;
  /** 缺口核查快照存储（ListingModule 注入点）。 */
  readonly listingGapStore?: GapCheckStore | undefined;
  /** 工序×原材料关联存储（ListingModule 注入点，U4；U7 验收发现 2 补齐——缺省回落内存实现）。 */
  readonly listingProcessMaterialStore?: ProcessMaterialLinkStore | undefined;
  /** 采购申请投影存储（ListingModule 注入点）。 */
  readonly listingRequestStore?: PurchaseRequestStore | undefined;
  /** 采购订单投影存储（ListingModule 注入点）。 */
  readonly listingOrderStore?: PurchaseOrderStore | undefined;
  /** 退货单投影存储（ListingModule 注入点）。 */
  readonly listingReturnStore?: PurchaseReturnStore | undefined;
  /** listing 命令幂等记账存储（ListingModule 注入点）。 */
  readonly listingOperationStore?: ListingOperationStore | undefined;
  /** listing 域事件（BusinessEvent + Outbox）存储（ListingModule 注入点）。 */
  readonly listingDomainEventStore?: ListingDomainEventStore | undefined;
  /** 采购订单状态机事件账本（engine-flow 端口，ListingModule 注入点）。 */
  readonly listingMachineEventStore?: ApprovalEventStore | undefined;
  /** 质检单投影存储（InspectionModule 注入点，M2 Wave-2）。 */
  readonly inspectionOrderStore?: InspectionOrderStore | undefined;
  /** 不合格处置投影存储（InspectionModule 注入点）。 */
  readonly inspectionNonconformStore?: NonconformStore | undefined;
  /** inspection 命令幂等记账存储（InspectionModule 注入点）。 */
  readonly inspectionOperationStore?: InspectionOperationStore | undefined;
  /** inspection 域事件（BusinessEvent + Outbox）存储（InspectionModule 注入点）。 */
  readonly inspectionDomainEventStore?: InspectionDomainEventStore | undefined;
  /** 质检状态机事件账本（engine-flow 端口，InspectionModule 注入点）。 */
  readonly inspectionMachineEventStore?: ApprovalEventStore | undefined;
  /** 仓库主数据存储（InventoryModule 注入点，M2 Wave-3）。 */
  readonly inventoryWarehouseStore?: WarehouseStore | undefined;
  /** 库存账（现存量+预占）存储（InventoryModule 注入点）。 */
  readonly inventoryAccountStore?: StockAccountStore | undefined;
  /** 库位余额存储（InventoryModule 注入点）。 */
  readonly inventoryLocationBalanceStore?: StockLocationBalanceStore | undefined;
  /** 出入库流水存储（InventoryModule 注入点）。 */
  readonly inventoryMovementStore?: StockMovementStore | undefined;
  /** 预占存储（InventoryModule 注入点）。 */
  readonly inventoryReservationStore?: StockReservationStore | undefined;
  /** 盘点单存储（InventoryModule 注入点）。 */
  readonly inventoryStocktakeStore?: StocktakeStore | undefined;
  /** 发货任务存储（InventoryModule 注入点）。 */
  readonly inventoryShippingStore?: ShippingOrderStore | undefined;
  /** 质检放行事实存储（InventoryModule 注入点）。 */
  readonly inventoryReleaseFactStore?: ReleaseFactStore | undefined;
  /** inventory 命令幂等记账存储（InventoryModule 注入点）。 */
  readonly inventoryOperationStore?: InventoryOperationStore | undefined;
  /** inventory 域事件（BusinessEvent + Outbox）存储（InventoryModule 注入点）。 */
  readonly inventoryDomainEventStore?: InventoryDomainEventStore | undefined;
  /** 盘点/发货状态机事件账本（engine-flow 端口，InventoryModule 注入点）。 */
  readonly inventoryMachineEventStore?: ApprovalEventStore | undefined;
  /** 派工单投影存储（DispatchModule 注入点，M2 Wave-3）。 */
  readonly dispatchOrderStore?: DispatchOrderStore | undefined;
  /** 外协明细存储（DispatchModule 注入点）。 */
  readonly dispatchOutsourcingLineStore?: OutsourcingLineStore | undefined;
  /** dispatch 命令幂等记账存储（DispatchModule 注入点）。 */
  readonly dispatchOperationStore?: DispatchOperationStore | undefined;
  /** dispatch 域事件（BusinessEvent + Outbox）存储（DispatchModule 注入点）。 */
  readonly dispatchDomainEventStore?: DispatchDomainEventStore | undefined;
  /** 派工状态机事件账本（engine-flow 端口，DispatchModule 注入点）。 */
  readonly dispatchMachineEventStore?: ApprovalEventStore | undefined;
  /** 报工投影存储（ReportingModule 注入点，M2 Wave-4）。 */
  readonly reportingReportStore?: WorkReportStore | undefined;
  /** 报工核查留痕存储（ReportingModule 注入点）。 */
  readonly reportingAuditStore?: ReportAuditStore | undefined;
  /** reporting 命令幂等记账存储（ReportingModule 注入点）。 */
  readonly reportingOperationStore?: ReportOperationStore | undefined;
  /** reporting 域事件（BusinessEvent + Outbox）存储（ReportingModule 注入点）。 */
  readonly reportingDomainEventStore?: ReportDomainEventStore | undefined;
  /** 报工状态机事件账本（engine-flow 端口，ReportingModule 注入点）。 */
  readonly reportingMachineEventStore?: ApprovalEventStore | undefined;
  /** 工时条目存储（HoursModule 注入点）。 */
  readonly hoursEntryStore?: LaborEntryStore | undefined;
  /** 月度归集快照存储（HoursModule 注入点）。 */
  readonly hoursMonthStore?: LaborLedgerMonthStore | undefined;
  /** hours 域事件存储（HoursModule 注入点）。 */
  readonly hoursEventStore?: HoursDomainEventStore | undefined;
  /** hours 命令幂等记账存储（HoursModule 注入点）。 */
  readonly hoursOperationStore?: HoursOperationStore | undefined;
  /** 成本条目存储（CostingModule 注入点）。 */
  readonly costingEntryStore?: CostEntryStore | undefined;
  /** 口径版本存储（CostingModule 注入点）。 */
  readonly costingModelStore?: CostingModelStore | undefined;
  /** 成本快照存储（CostingModule 注入点）。 */
  readonly costingSnapshotStore?: CostSnapshotStore | undefined;
  /** costing 域事件存储（CostingModule 注入点）。 */
  readonly costingEventStore?: CostingDomainEventStore | undefined;
  /** costing 命令幂等记账存储（CostingModule 注入点）。 */
  readonly costingOperationStore?: CostingOperationStore | undefined;
  /** 项目成本段事实存储（CostingModule 注入点，U7：六块 append-only 事实）。 */
  readonly costingProjectEntryStore?: CostProjectEntryStore | undefined;
  /** 项目成本六块快照存储（CostingModule 注入点，U7）。 */
  readonly costingProjectSnapshotStore?: CostProjectSnapshotStore | undefined;
  /** 录入价格存储（CostingModule 注入点，U7：非标/设备利库单价录入）。 */
  readonly costingPriceEntryStore?: CostPriceEntryStore | undefined;
  /** 工艺路线存储（BaselineModule P2 注入点）。 */
  readonly baselineRoutingStore?: RoutingStore | undefined;
  /** 额定工时存储（BaselineModule P3 注入点）。 */
  readonly baselineStandardTimeStore?: StandardTimeStore | undefined;
  /** 故障单投影存储（BaselineModule P2 注入点）。 */
  readonly baselineFaultReportStore?: FaultReportStore | undefined;
  /** 故障单状态机事件账本（engine-flow 端口，BaselineModule 注入点）。 */
  readonly baselineFaultEventStore?: ApprovalEventStore | undefined;
  /** payroll 五存储束（PayrollHttpModule 注入点，M3 首波）。 */
  readonly payrollStores?: PayrollStores | undefined;
  /** maintenance 五存储束（MaintenanceHttpModule 注入点，M3 第二波）。 */
  readonly maintenanceStores?: MaintenanceStores | undefined;
  /** drawing 五存储束（DrawingHttpModule 注入点，M3 第二波）。 */
  readonly drawingStores?: DrawingStores | undefined;
  /** metric-pack 三存储束（MetricPackHttpModule 注入点，M3 第二波）。 */
  readonly metricPackStores?: MetricPackStores | undefined;
  /** 操作日志存储（AuditModule 注入点，S1 backfill：0920 #103）。 */
  readonly auditLogStore?: AuditLogStore | undefined;
  /** 标准报表事实源解析（StandardReportsModule 注入点，S1 backfill：0920 #89/91/92/96）。 */
  readonly standardReportsSourceProvider?: ReportSourceProvider | undefined;
  /** 菜单配置存储（MenuConfigModule 注入点，T1 能力子集：0920 #98/99）。 */
  readonly menuConfigStore?: MenuConfigStore | undefined;
  /**
   * 通知存储（NotificationsModule 注入点 + 待办桥发布面，T1 能力子集：0920
   * #101——组合根保证模块与待办桥拿到同一实例，同 sharedTodoStore 裁决）。
   */
  readonly notificationStore?: NotificationStore | undefined;
  /**
   * 审批流配置存储（ApprovalConfigModule 注入点 + approval 运行时解析器事实源，
   * T1 能力子集：0920 #102——组合根保证配置面与案件运行时同源）。
   */
  readonly approvalFlowConfigStore?: ApprovalFlowConfigStore | undefined;
  /** 发料任务主表存储（IssueModule 注入点，U6：PG 形态经 connectIssueStore 注入）。 */
  readonly issueTaskStore?: IssueTaskStore | undefined;
  /** 发料任务子行存储（IssueModule 注入点）。 */
  readonly issueTaskLineStore?: IssueTaskLineStore | undefined;
  /** 发料记录存储（IssueModule 注入点）。 */
  readonly issueRecordStore?: IssueRecordStore | undefined;
  /** 快递单存储（IssueModule 注入点）。 */
  readonly issueExpressStore?: IssueExpressStore | undefined;
  /** issue 命令幂等记账存储（IssueModule 注入点）。 */
  readonly issueOperationStore?: IssueOperationStore | undefined;
  /** issue 域事件存储（IssueModule 注入点）。 */
  readonly issueDomainEventStore?: IssueDomainEventStore | undefined;
  /** 售后报销单存储（AftercareClaimModule 注入点，U6：PG 形态随 dispatch 束注入）。 */
  readonly aftercareClaimStore?: AftercareClaimStore | undefined;
  /** 附件元数据存储（AttachmentModule 注入点，U6：PG 形态经 connectAttachmentStore 注入）。 */
  readonly attachmentStore?: AttachmentStore | undefined;
  /** 对象存储端口（AttachmentModule 注入点；字节持久面——缺省 = 模块内存实现）。 */
  readonly objectStorage?: ObjectStoragePort | undefined;
}

/**
 * 全部可装配模块（工厂接收组合根注入的存储端口 + 跨模块接线端口集——
 * M2 后第一增量：接线清单与机制见 cross-module-wiring.ts 文件头）。
 */
export const MODULE_DEFINITIONS: Record<
  string,
  (stores: StorePorts, wiring: CrossModuleRegisterPorts) => DynamicModule
> = {
  core: (stores) => CoreModule.register({ policyStore: stores.policyStore }),
  org: (stores) =>
    OrgModule.register({
      userStore: stores.userStore,
      roleStore: stores.roleStore,
      // 停用撤销同源：注入同一会话存储（auth 判定与 org 停用撤销不分叉）
      sessionRevoker: stores.sessionStore,
      departmentStore: stores.departmentStore,
      positionStore: stores.positionStore,
    }),
  masterdata: (stores) =>
    MasterdataModule.register({
      itemStore: stores.itemStore,
      resourceStore: stores.resourceStore,
      customerStore: stores.customerStore,
      supplierStore: stores.supplierStore,
      unitStore: stores.unitStore,
    }),
  workbench: (stores) => WorkbenchModule.register({ todoStore: stores.todoStore }),
  approval: (stores) =>
    ApprovalModule.register({
      caseStore: stores.approvalCaseStore,
      recordStore: stores.approvalRecordStore,
      eventStore: stores.approvalEventStore,
      todoStore: stores.todoStore,
      userStore: stores.userStore,
      // T1 接线 #102：approval-config 装配时，案件发起/决策按租户读当前启用
      // 配置（active 行；无 active 行回落静态默认配置）。stores.todoStore 在
      // buildAppModule 已是待办桥包装实例（notifications 装配时）——审批派
      // 待办即进收件箱（接线 #27）。
      ...(stores.approvalFlowConfigStore === undefined
        ? {}
        : {
            flowConfigResolver: (tenant: import('@smes/business-core').TenantId) =>
              stores.approvalFlowConfigStore!.list(tenant).then(
                (flows) => flows.find((row) => row.active)?.config ?? null,
              ),
          }),
    }),
  // M2 Wave-1 环节模块（按需启停，不进默认清单——D9 插件装配；跨模块端口
  // listing/inventory/progress/customer 暂用模块缺省空实现，Wave-2 模块合流后接线）
  baseline: (stores, wiring) =>
    BaselineModule.register({
      processStore: stores.baselineProcessStore,
      equipmentStore: stores.baselineEquipmentStore,
      outsourcingRuleStore: stores.baselineOutsourcingRuleStore,
      validationRunStore: stores.baselineValidationRunStore,
      eventStore: stores.baselineEventStore,
      operationLedger: stores.baselineOperationLedger,
      // P2/P3 件存储（Wave-4）与故障待办（与 workbench 同源）
      routingStore: stores.baselineRoutingStore,
      standardTimeStore: stores.baselineStandardTimeStore,
      faultReportStore: stores.baselineFaultReportStore,
      faultEventStore: stores.baselineFaultEventStore,
      todoStore: stores.todoStore,
      // 物料校验比对基准与 masterdata 同源：组合根保证同一 ItemStore 实例
      itemLibrary: stores.itemStore,
      // 跨模块接线（#18/#19）：IM 通知 + workorder 附件图纸计数
      notifyChannel: wiring.baseline?.notifyChannel,
      workOrderDrawingSource: wiring.baseline?.workOrderDrawingSource,
    }),
  workorder: (stores, wiring) =>
    WorkOrderModule.register({
      orderStore: stores.workOrderStore,
      attachmentStore: stores.workOrderAttachmentStore,
      partsStore: stores.workOrderPartsStore,
      kitStore: stores.workOrderKitStore,
      operationStore: stores.workOrderOperationStore,
      domainEventStore: stores.workOrderDomainEventStore,
      machineEventStore: stores.workOrderMachineEventStore,
      // 待办联动与工作台/审批同源（sharedTodoStore 见 buildAppModule）
      todoStore: stores.todoStore,
      // 跨模块接线（#15/#16/#25/#26）：dispatch 进度上卷 + inventory 配件出库
      // + listing 需求行 + inventory 可用量（齐套刷新的真实判定输入——S3-e
      // 接线：此前两端口按模块缺省"零行全齐套"，缺口驱动拦截不生效）
      progressPort: wiring.workorder?.progressPort,
      issuePort: wiring.workorder?.issuePort,
      listingPort: wiring.workorder?.listingPort,
      inventoryPort: wiring.workorder?.inventoryPort,
    }),
  // M2 Wave-2 环节模块（同上按需启停；跨模块端口 workOrderFeed/inventory/receipt/
  // excel/materialValidation 暂用模块缺省——workOrderFeed 空实现时骨架走四类缺省集、
  // materialValidation 显式拒绝（导入命令接线前不可用，语义诚实），Wave-3 接线替换）
  listing: (stores, wiring) =>
    ListingModule.register({
      sheetStore: stores.listingSheetStore,
      lineStore: stores.listingLineStore,
      gapStore: stores.listingGapStore,
      requestStore: stores.listingRequestStore,
      orderStore: stores.listingOrderStore,
      returnStore: stores.listingReturnStore,
      operationStore: stores.listingOperationStore,
      domainEventStore: stores.listingDomainEventStore,
      machineEventStore: stores.listingMachineEventStore,
      todoStore: stores.todoStore,
      // U4 接线漏项补齐（U7 验收发现 2）：不传则 PG 形态下 HTTP 录入落内存
      // store，与 costing 读面（main.ts 注入的 PG processMaterialStore）读写分家。
      processMaterialStore: stores.listingProcessMaterialStore,
      // 跨模块接线（#11~#14 + #20 + #38）：workorder 创建事件订阅 + inventory
      // 可用量/收货/利库预占 + baseline 物料校验 + ExcelJS 导入导出
      workOrderFeed: wiring.listing?.workOrderFeed,
      inventoryPort: wiring.listing?.inventoryPort,
      receiptPort: wiring.listing?.receiptPort,
      // #38：gap.check 确认→inventory 预占创建（利库预占）
      useReservationPort: wiring.listing?.useReservationPort,
      materialValidation: wiring.listing?.materialValidation,
      excelPort: wiring.listing?.excelPort,
      // fix-wave-3 W3-1（#37）：inspection 收货触发三类采购质检
      inspectionIntake: wiring.listing?.inspectionIntake,
    }),
  inspection: (stores, wiring) =>
    InspectionModule.register({
      orderStore: stores.inspectionOrderStore,
      nonconformStore: stores.inspectionNonconformStore,
      operationStore: stores.inspectionOperationStore,
      domainEventStore: stores.inspectionDomainEventStore,
      machineEventStore: stores.inspectionMachineEventStore,
      todoStore: stores.todoStore,
      // 跨模块接线（#17/#18）：inventory 放行事实登记 + IM 通知
      stockReleasePort: wiring.inspection?.stockReleasePort,
      notifyChannel: wiring.inspection?.notifyChannel,
    }),
  // M2 Wave-3 环节模块（同上按需启停；跨模块端口 kitCheck/priceSource/inspectionIntake/
  // print 与 inventory 预占/放行/收货适配归跨模块接线增量——见 status.md 待办）
  inventory: (stores) =>
    InventoryModule.register({
      warehouseStore: stores.inventoryWarehouseStore,
      accountStore: stores.inventoryAccountStore,
      locationBalanceStore: stores.inventoryLocationBalanceStore,
      movementStore: stores.inventoryMovementStore,
      reservationStore: stores.inventoryReservationStore,
      stocktakeStore: stores.inventoryStocktakeStore,
      shippingStore: stores.inventoryShippingStore,
      releaseFactStore: stores.inventoryReleaseFactStore,
      operationStore: stores.inventoryOperationStore,
      domainEventStore: stores.inventoryDomainEventStore,
      machineEventStore: stores.inventoryMachineEventStore,
      // D-15：默认收货仓 env 注入（收货载荷未显式指定 warehouseId 时的落位仓）。
      // 取舍（写明）：① 空串/未配 = 不设默认仓（compose 插值缺省空串，收货必须
      // 显式传仓）；② 不做"唯一启用仓"自动回落——warehouse 模型无启用位、回落
      // 判定逻辑属 InventoryService（禁碰面），且装配期查库违反零 DB boot 合同
      // （启动不碰数据库，见 seed.mjs 头注）；env 配错 id 得到"仓库不存在"明确
      // 拒绝，fail-visible 可诊断。
      serviceOptions: {
        defaultWarehouseId: process.env['SMES_DEFAULT_WAREHOUSE_ID'] || null,
      },
    }),
  dispatch: (stores, wiring) =>
    DispatchModule.register({
      // U6 #29：issue 装配时组合根在工厂实参里注入装饰态派工单存储
      //（advance→assigned 触发发料任务同步）；operation/domainEvent 两存储
      // 同经 wiringStores 共享面（aftercare-claim 须与 DispatchModule 同实例
      //——模块头注共享裁决）。
      orderStore: stores.dispatchOrderStore,
      outsourcingLineStore: stores.dispatchOutsourcingLineStore,
      operationStore: stores.dispatchOperationStore,
      domainEventStore: stores.dispatchDomainEventStore,
      machineEventStore: stores.dispatchMachineEventStore,
      todoStore: stores.todoStore,
      // 跨模块接线（#7~#10）：workorder 齐套读 + baseline 取价 + inspection
      // 回厂触发 + 打印
      kitCheck: wiring.dispatch?.kitCheck,
      priceSource: wiring.dispatch?.priceSource,
      inspectionIntake: wiring.dispatch?.inspectionIntake,
      print: wiring.dispatch?.print,
    }),
  // M2 Wave-4 账本模块（跨模块消费端口 validDispatch/reportFeed/各成本源暂缺省，
  // 组合根接线增量统一承接——见 status.md 待办）
  reporting: (stores, wiring) =>
    ReportingModule.register({
      reportStore: stores.reportingReportStore,
      auditStore: stores.reportingAuditStore,
      operationStore: stores.reportingOperationStore,
      domainEventStore: stores.reportingDomainEventStore,
      machineEventStore: stores.reportingMachineEventStore,
      // 跨模块接线（#1）：dispatch 有效派工单读（submit 前置校验 fail-closed）
      validDispatch: wiring.reporting?.validDispatch,
      // fix-wave-3 W3-1（#34~#36）：baseline 工序合法性/工艺路线末道判定 +
      // inspection 末道报工触发（此前组合态为 no-op 缺省）
      operationValidity: wiring.reporting?.operationValidity,
      finalOperation: wiring.reporting?.finalOperation,
      inspectionIntake: wiring.reporting?.inspectionIntake,
    }),
  hours: (stores, wiring) =>
    HoursModule.register({
      entryStore: stores.hoursEntryStore,
      monthStore: stores.hoursMonthStore,
      eventStore: stores.hoursEventStore,
      operationStore: stores.hoursOperationStore,
      // 跨模块接线（#2）：reporting verified/revoked 订阅（ingest 触发面见
      // wiring 文件头清单 #2）
      reportFeed: wiring.hours?.reportFeed,
    }),
  costing: (stores, wiring) =>
    CostingModule.register({
      entryStore: stores.costingEntryStore,
      modelStore: stores.costingModelStore,
      snapshotStore: stores.costingSnapshotStore,
      eventStore: stores.costingEventStore,
      operationStore: stores.costingOperationStore,
      // 跨模块接线（#3~#6 + #20）：三类成本事实源 + workorder 归集主体校验
      // + ExcelJS 快照导出
      materialSource: wiring.costing?.materialSource,
      laborSource: wiring.costing?.laborSource,
      outsourcingSource: wiring.costing?.outsourcingSource,
      workOrderSubject: wiring.costing?.workOrderSubject,
      excelPort: wiring.costing?.excelPort,
      // U7 六块源（#31~#33）+ 三存储（段事实/六块快照/录入价格）
      projectEntryStore: stores.costingProjectEntryStore,
      projectSnapshotStore: stores.costingProjectSnapshotStore,
      priceEntryStore: stores.costingPriceEntryStore,
      projectIssueSource: wiring.costing?.projectIssueSource,
      projectEquipmentSource: wiring.costing?.projectEquipmentSource,
      projectAftercareSource: wiring.costing?.projectAftercareSource,
    }),
  // M3 首波专业包（激活价语义：仅显式 MODULES_ENABLED 开启；HTTP 面在组合根
  // payroll-http.module——pro-pack 零框架耦合，R-M3-3 裁定）
  payroll: (stores, wiring) =>
    PayrollHttpModule.register({
      stores: stores.payrollStores ?? inMemoryPayrollStores(),
      source: wiring.payroll?.source,
      exportPort: wiring.payroll?.exportPort,
    }),
  // M3 第二波专业包（同 payroll 体例：激活价 + 组合根 HTTP 面 + wiring 注入）
  maintenance: (stores, wiring) =>
    MaintenanceHttpModule.register({
      stores: stores.maintenanceStores ?? inMemoryMaintenanceStores(),
      faultLinkage: wiring.maintenance?.faultLinkage,
    }),
  drawing: (stores, wiring) =>
    DrawingHttpModule.register({
      stores: stores.drawingStores ?? inMemoryDrawingStores(),
      workOrderDrawingRefs: wiring.drawing?.workOrderDrawingRefs,
    }),
  'metric-pack': (stores, wiring) =>
    MetricPackHttpModule.register({
      stores: stores.metricPackStores ?? inMemoryMetricPackStores(),
      sourceSetFor: wiring['metric-pack']?.sourceSetFor,
      exportPort: wiring['metric-pack']?.exportPort,
    }),
  // S1 backfill 两模块（激活价语义：仅显式 MODULES_ENABLED 开启，同 M2/M3 环节
  // 模块口径；取舍见 application src/audit/audit.module.ts 与
  // src/standardreports/standardreports.module.ts 文件头）
  audit: (stores) => AuditModule.register({ logStore: stores.auditLogStore }),
  standardreports: (stores) =>
    StandardReportsModule.register({
      sourceProvider: stores.standardReportsSourceProvider,
    }),
  // T1 能力子集三模块（激活价语义：仅显式 MODULES_ENABLED 开启，同上先例——
  // 0920 #98/99 菜单管理 / #101 通知中心 / #102 审批配置；存储实例由
  // buildAppModule 裁决共享，见 shared* 构造注释）。
  'menu-config': (stores) =>
    MenuConfigModule.register({ menuConfigStore: stores.menuConfigStore }),
  notifications: (stores) =>
    NotificationsModule.register({ notificationStore: stores.notificationStore }),
  'approval-config': (stores) =>
    ApprovalConfigModule.register({ flowConfigStore: stores.approvalFlowConfigStore }),
  // U6 接线波三模块（激活价语义：仅显式 MODULES_ENABLED 开启，同 T1/S1 先例；
  // 存储缺省回落模块内存实现——零 DB boot 语义完整）：
  // - issue：跨模块端口 material ← wiring #28（inventory 适配器；缺省 NOOP）；
  // - attachment：objectStorage 由 main.ts 按部署环境注入本地文件适配器
  //   （SMES_ATTACHMENT_DIR），缺省内存适配器（合同 U3：零对象存储运行时依赖）；
  // - aftercare-claim：order/operation/domainEvent 三存储与 DispatchModule
  //   共享（buildAppModule 裁决同源）；reportPort ← wiring #30（reporting）。
  issue: (stores, wiring) =>
    IssueModule.register({
      taskStore: stores.issueTaskStore,
      taskLineStore: stores.issueTaskLineStore,
      recordStore: stores.issueRecordStore,
      expressStore: stores.issueExpressStore,
      operationStore: stores.issueOperationStore,
      domainEventStore: stores.issueDomainEventStore,
      material: wiring.issue?.material,
    }),
  attachment: (stores) =>
    AttachmentModule.register({
      attachmentStore: stores.attachmentStore,
      objectStorage: stores.objectStorage,
    }),
  'aftercare-claim': (stores, wiring) =>
    AftercareClaimModule.register({
      orderStore: stores.dispatchOrderStore,
      claimStore: stores.aftercareClaimStore,
      operationStore: stores.dispatchOperationStore,
      domainEventStore: stores.dispatchDomainEventStore,
      reportPort: wiring['aftercare-claim']?.reportPort,
    }),
  demo: () => DemoModule.register(),
  // A8/A10 首波（激活价语义：仅显式 MODULES_ENABLED 开启）：数字运营大屏组合根
  // HTTP/推送面——SSE 数据帧通道 + 5s 聚合节拍 + A10 日跑批定时器。事实源从
  // StorePorts 逐项解析（各源模块未启用 → 对应读面 undefined → 块级降级占位，
  // screen-ports.ts 头注契约）；日统计存储 = PG 句柄或组合根内存缺省。
  screen: (stores) =>
    ScreenHttpModule.register({
      sources: {
        workOrders: stores.workOrderStore,
        dispatchOrders: stores.dispatchOrderStore,
        outsourcingLines: stores.dispatchOutsourcingLineStore,
        workReports: stores.reportingReportStore,
        inspections: stores.inspectionOrderStore,
        listingLines: stores.listingLineStore,
        machiningDailyStats: stores.machiningDailyStatsStore,
        // 报工排名显示名：org UserStore 读面（userStore 恒装配——sharedUserStore）
        userNameOf:
          stores.userStore === undefined
            ? undefined
            : async (tenant, reporter) => {
                try {
                  const account = await stores.userStore!.find(tenant, UserId.create(reporter));
                  return account?.displayName ?? null;
                } catch {
                  return null; // 非法 reporter id 形状 → 回退原样显示（service 头注）
                }
              },
      },
      dailyStore: stores.machiningDailyStatsStore!,
      // 屏显静态配置 env 注入（部署期覆盖缺省值；非法值回落 DEFAULT——呈现面容错）
      config: {
        companyNameLines: [
          process.env['SMES_SCREEN_COMPANY_LINE_1'] ?? '',
          process.env['SMES_SCREEN_COMPANY_LINE_2'] ?? '',
        ].filter((line) => line.length > 0),
        ...(process.env['SMES_SCREEN_SAFE_BASELINE_DATE'] !== undefined
          ? { safeProductionBaselineDate: process.env['SMES_SCREEN_SAFE_BASELINE_DATE'] }
          : {}),
      },
      frameIntervalMs: Number(process.env['SMES_SCREEN_FRAME_INTERVAL_MS'] ?? '') || undefined,
      // A10 跑批租户集：saas 形态 SMES_TENANTS 逗号清单；缺省单租户 'default'
      dailyTenants: parseDailyTenants(process.env['SMES_TENANTS']),
      publicStream: process.env['SMES_SCREEN_PUBLIC_STREAM'] === 'on',
    }),
};

/** 组合根装配选项。 */
export interface BuildAppModuleOptions {
  /**
   * 装配策略注入测试钩子（POST /dev/policies）。
   * 默认 false（生产形态不开）；main.ts 由 SMES_DEV_POLICY_ENDPOINT=on 开启。
   */
  readonly devPolicyEndpoint?: boolean;
  /**
   * 持久化端口注入（M1 增量 3-D/4-I；收尾波-① 增审批三端口，收尾波-③ 增
   * 会话端口）：设 DATABASE_URL 时 main.ts 经 connectBusinessStore /
   * connectMasterdataStore / connectWorkbenchStore / connectApprovalStore
   * 注入 PG 实现；缺省回落内存实现（启动零 DB 依赖）。
   */
  readonly policyStore?: PolicyStore | undefined;
  readonly userStore?: UserStore | undefined;
  readonly roleStore?: RoleStore | undefined;
  readonly departmentStore?: DepartmentStore | undefined;
  readonly positionStore?: PositionStore | undefined;
  readonly sessionStore?: SessionStore | undefined;
  readonly itemStore?: ItemStore | undefined;
  readonly resourceStore?: ResourceStore | undefined;
  readonly customerStore?: CustomerStore | undefined;
  readonly supplierStore?: SupplierStore | undefined;
  readonly unitStore?: UnitStore | undefined;
  readonly todoStore?: TodoStore | undefined;
  readonly approvalCaseStore?: ApprovalCaseStore | undefined;
  readonly approvalRecordStore?: ApprovalRecordStore | undefined;
  readonly approvalEventStore?: ApprovalEventStore | undefined;
  readonly baselineProcessStore?: ProcessDefStore | undefined;
  readonly baselineEquipmentStore?: EquipmentStore | undefined;
  readonly baselineOutsourcingRuleStore?: OutsourcingPriceRuleStore | undefined;
  readonly baselineValidationRunStore?: MaterialValidationRunStore | undefined;
  readonly baselineEventStore?: BaselineEventStore | undefined;
  readonly baselineOperationLedger?: BaselineOperationLedger | undefined;
  readonly workOrderStore?: WorkOrderStore | undefined;
  readonly workOrderAttachmentStore?: WorkOrderAttachmentStore | undefined;
  readonly workOrderPartsStore?: PartsRequestStore | undefined;
  readonly workOrderKitStore?: KitCheckStore | undefined;
  readonly workOrderOperationStore?: WorkOrderOperationStore | undefined;
  readonly workOrderDomainEventStore?: WorkOrderDomainEventStore | undefined;
  readonly workOrderMachineEventStore?: ApprovalEventStore | undefined;
  readonly listingSheetStore?: ListingSheetStore | undefined;
  readonly listingLineStore?: ListingLineStore | undefined;
  readonly listingGapStore?: GapCheckStore | undefined;
  readonly listingRequestStore?: PurchaseRequestStore | undefined;
  readonly listingOrderStore?: PurchaseOrderStore | undefined;
  readonly listingReturnStore?: PurchaseReturnStore | undefined;
  readonly listingOperationStore?: ListingOperationStore | undefined;
  readonly listingDomainEventStore?: ListingDomainEventStore | undefined;
  readonly listingMachineEventStore?: ApprovalEventStore | undefined;
  readonly inspectionOrderStore?: InspectionOrderStore | undefined;
  readonly inspectionNonconformStore?: NonconformStore | undefined;
  readonly inspectionOperationStore?: InspectionOperationStore | undefined;
  readonly inspectionDomainEventStore?: InspectionDomainEventStore | undefined;
  readonly inspectionMachineEventStore?: ApprovalEventStore | undefined;
  readonly inventoryWarehouseStore?: WarehouseStore | undefined;
  readonly inventoryAccountStore?: StockAccountStore | undefined;
  readonly inventoryLocationBalanceStore?: StockLocationBalanceStore | undefined;
  readonly inventoryMovementStore?: StockMovementStore | undefined;
  readonly inventoryReservationStore?: StockReservationStore | undefined;
  readonly inventoryStocktakeStore?: StocktakeStore | undefined;
  readonly inventoryShippingStore?: ShippingOrderStore | undefined;
  readonly inventoryReleaseFactStore?: ReleaseFactStore | undefined;
  readonly inventoryOperationStore?: InventoryOperationStore | undefined;
  readonly inventoryDomainEventStore?: InventoryDomainEventStore | undefined;
  readonly inventoryMachineEventStore?: ApprovalEventStore | undefined;
  readonly dispatchOrderStore?: DispatchOrderStore | undefined;
  readonly dispatchOutsourcingLineStore?: OutsourcingLineStore | undefined;
  readonly dispatchOperationStore?: DispatchOperationStore | undefined;
  readonly dispatchDomainEventStore?: DispatchDomainEventStore | undefined;
  readonly dispatchMachineEventStore?: ApprovalEventStore | undefined;
  readonly reportingReportStore?: WorkReportStore | undefined;
  readonly reportingAuditStore?: ReportAuditStore | undefined;
  readonly reportingOperationStore?: ReportOperationStore | undefined;
  readonly reportingDomainEventStore?: ReportDomainEventStore | undefined;
  readonly reportingMachineEventStore?: ApprovalEventStore | undefined;
  readonly hoursEntryStore?: LaborEntryStore | undefined;
  readonly hoursMonthStore?: LaborLedgerMonthStore | undefined;
  readonly hoursEventStore?: HoursDomainEventStore | undefined;
  readonly hoursOperationStore?: HoursOperationStore | undefined;
  readonly costingEntryStore?: CostEntryStore | undefined;
  readonly costingModelStore?: CostingModelStore | undefined;
  readonly costingSnapshotStore?: CostSnapshotStore | undefined;
  readonly costingEventStore?: CostingDomainEventStore | undefined;
  readonly costingOperationStore?: CostingOperationStore | undefined;
  readonly costingProjectEntryStore?: CostProjectEntryStore | undefined;
  readonly costingProjectSnapshotStore?: CostProjectSnapshotStore | undefined;
  readonly costingPriceEntryStore?: CostPriceEntryStore | undefined;
  readonly baselineRoutingStore?: RoutingStore | undefined;
  readonly baselineStandardTimeStore?: StandardTimeStore | undefined;
  readonly baselineFaultReportStore?: FaultReportStore | undefined;
  readonly baselineFaultEventStore?: ApprovalEventStore | undefined;
  /**
   * print 提交 sink（M2 后第一增量，接线 #10 注入位）：main.ts 注入
   * createIntegrationPrintSink（integration-print 受理口）；缺省 = 拒绝 sink
   * （printed:false + 部署原因——测试/零接线形态不伪证打印）。
   */
  readonly printSink?: PrintSubmitSink | undefined;
  /**
   * IM 发送 sink（M2 后第一增量，接线 #18 注入位）：main.ts 按 SMES_IM_* 环境
   * 注入 integration-im 渠道适配；缺省 = 结构化 console 日志降级（不炸 boot）。
   */
  readonly imSink?: ImNotifySink | undefined;
  readonly payrollStores?: PayrollStores | undefined;
  /** maintenance 五存储束（PG 形态经 connectMaintenanceStore 注入）。 */
  readonly maintenanceStores?: MaintenanceStores | undefined;
  /** drawing 五存储束（PG 形态经 connectDrawingStore 注入）。 */
  readonly drawingStores?: DrawingStores | undefined;
  /** metric-pack 三存储束（PG 形态经 connectMetricPackStore 注入）。 */
  readonly metricPackStores?: MetricPackStores | undefined;
  /**
   * 六源适配器束的租户解析工厂（接线 #24 注入位；main.ts PG 形态注入
   * connectMetricSourceBundle 每租户缓存包装；零 DB / e2e 内存形态可注入假源集，
   * 缺省 = 空源集——零接线 boot 语义诚实）。
   */
  readonly metricPackSourceSetFor?: ((tenant: TenantId) => MetricSourceSet) | undefined;
  /** 操作日志存储（PG 形态经 connectAuditStore 注入，S1 backfill：0920 #103）。 */
  readonly auditLogStore?: AuditLogStore | undefined;
  /**
   * 标准报表四源适配器束的租户解析（S1 backfill：0920 #89/91/92/96；PG 形态
   * main.ts 注入 connectStandardReportsSources 每租户缓存包装；缺省 = 未绑定
   * 源——零 DB boot 求值显式 503，口径装载完整、数据面诚实缺失）。
   */
  readonly standardReportsSourceProvider?: ReportSourceProvider | undefined;
  /** 菜单配置存储（PG 形态经 connectMenuConfigStore 注入，T1 能力子集：0920 #98/99）。 */
  readonly menuConfigStore?: MenuConfigStore | undefined;
  /**
   * 通知存储（PG 形态经 connectNotificationStore 注入，T1 能力子集：0920
   * #101；模块与待办桥共享同源——零 DB 形态组合根裁决内存实例）。
   */
  readonly notificationStore?: NotificationStore | undefined;
  /**
   * 审批流配置存储（PG 形态经 connectApprovalConfigStore 注入，T1 能力子集：
   * 0920 #102；配置面与 approval 案件运行时解析器共享同源）。
   */
  readonly approvalFlowConfigStore?: ApprovalFlowConfigStore | undefined;
  /** issue 六存储（PG 形态经 connectIssueStore 注入，U6 接线波）。 */
  readonly issueTaskStore?: IssueTaskStore | undefined;
  readonly issueTaskLineStore?: IssueTaskLineStore | undefined;
  readonly issueRecordStore?: IssueRecordStore | undefined;
  readonly issueExpressStore?: IssueExpressStore | undefined;
  readonly issueOperationStore?: IssueOperationStore | undefined;
  readonly issueDomainEventStore?: IssueDomainEventStore | undefined;
  /** 售后报销单存储（PG 形态经 connectDispatchStore().aftercareClaimStore 注入）。 */
  readonly aftercareClaimStore?: AftercareClaimStore | undefined;
  /** 工序×原材料关联存储（U7 #31：②原材料段尺寸/单价读面；PG 形态经 connectListingStore().processMaterialStore 注入）。 */
  readonly processMaterialLinkStore?: ProcessMaterialLinkStore | undefined;
  /** 附件元数据存储（PG 形态经 connectAttachmentStore 注入）。 */
  readonly attachmentStore?: AttachmentStore | undefined;
  /**
   * 对象存储端口（U6：main.ts 按 SMES_ATTACHMENT_DIR 注入本地文件适配器；
   * 缺省 = 模块内存适配器——字节重启即失，部署期换装 MinIO/S3 不动业务面）。
   */
  readonly objectStorage?: ObjectStoragePort | undefined;
}

export class ModuleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRegistryError';
  }
}

/**
 * 解析并校验 MODULES_ENABLED：容忍空白与大小写、去重、core 置首；
 * 拒绝未知模块（fail-fast：配置拼写错误不能静默缺模块启动）、拒绝缺 core。
 * undefined/null → 默认清单；显式置空 → 启动失败。
 */
export function parseModulesEnabled(raw: string | undefined | null): string[] {
  const requested = (raw ?? DEFAULT_MODULES_ENABLED)
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  if (requested.length === 0) {
    throw new ModuleRegistryError(
      'MODULES_ENABLED 解析结果为空：至少要装配必装基础层 core',
    );
  }

  const unknown = requested.filter((name) => !Object.hasOwn(MODULE_DEFINITIONS, name));
  if (unknown.length > 0) {
    throw new ModuleRegistryError(
      `MODULES_ENABLED 含未知模块：${unknown.join(',')}；可用：${Object.keys(MODULE_DEFINITIONS).join(',')}`,
    );
  }

  if (!requested.includes(REQUIRED_MODULE)) {
    throw new ModuleRegistryError(
      `模块 '${REQUIRED_MODULE}' 是必装基础层（ADR-0004），不允许从 MODULES_ENABLED 停用`,
    );
  }

  const deduped = [...new Set(requested)];
  const isRequired = (name: string): boolean => name === REQUIRED_MODULE;
  return deduped
    .filter(isRequired)
    .concat(deduped.filter((name) => !isRequired(name)));
}

/**
 * 组合根模块：imports = 注册表装配结果；/health 与 /modules 属组合根本身，
 * 不随 flag 启停。全局鉴权守卫（AuthGuard，M1 增量 2-B）经 APP_GUARD 注册：
 * 未声明 @RequirePermission 的路由守卫直通（既有行为零回归）。
 * 返回普通 Type，NestFactory.create 直接收。
 */
export function buildAppModule(
  enabled: readonly string[],
  options: BuildAppModuleOptions = {},
): Type<unknown> {
  // 待办存储共享（M1 收尾波-①）：workbench / approval / workorder 的待办必须
  // 同源——审批派的待办、工作令状态流转待办对 /workbench 端点均可见（零 DB
  // 形态组合根是共享实例的唯一裁决点；模块各自回落只服务单模块装配形态）。
  const todoConsumers = [
    'workbench',
    'approval',
    'workorder',
    'listing',
    'inspection',
    'dispatch',
    'baseline',
  ].filter((m) => enabled.includes(m));
  const sharedTodoStore =
    options.todoStore ?? (todoConsumers.length > 0 ? new InMemoryTodoStore() : undefined);

  // T1 能力子集共享实例（零 DB 形态组合根是唯一裁决点，同 sharedTodoStore
  // 先例；PG 形态经 options 注入同源）：
  // - 菜单配置：menu-config 模块自身消费（读写同实例天然同源）；
  // - 通知：notifications 模块与待办桥（接线 #27）必须同一实例——否则桥写
  //   的收件箱行对模块端点不可见；
  // - 审批流配置：approval-config 模块与 approval 案件运行时解析器必须同一
  //   实例——配置页启用行对案件发起实时生效。
  const sharedMenuConfigStore =
    options.menuConfigStore ?? (enabled.includes('menu-config') ? new InMemoryMenuConfigStore() : undefined);
  const sharedNotificationStore =
    options.notificationStore ?? (enabled.includes('notifications') ? new InMemoryNotificationStore() : undefined);
  const sharedApprovalFlowConfigStore =
    options.approvalFlowConfigStore ??
    (enabled.includes('approval-config') ? new InMemoryApprovalFlowConfigStore() : undefined);

  // 待办 → 站内通知桥（T1 接线 #27）：notifications 装配且共享待办存在时，
  // 在共享待办外包一层"创建即投收件箱"装饰——七方待办联动（approval/
  // workorder/listing/inspection/dispatch/baseline + 工作台手动）全量进
  // 通知中心，不逐模块加钩子。通知失败不阻塞待办创建（通知式合同）。
  const effectiveTodoStore =
    sharedTodoStore !== undefined && sharedNotificationStore !== undefined
      ? createTodoNotifyingStore(sharedTodoStore, sharedNotificationStore)
      : sharedTodoStore;

  // 物品主数据共享（M2 Wave-1）：baseline 物料校验的比对基准与 masterdata
  // 物品库必须是同一实例（零 DB 形态组合根裁决；PG 形态经 itemStore 注入同源）。
  const sharedItemStore =
    options.itemStore ??
    (enabled.includes('masterdata') && enabled.includes('baseline')
      ? new InMemoryItemStore()
      : undefined);

  // 用户存储共享（M1 收尾波-③）：auth 恒装配且 org 依赖同一 UserStore——组合根
  // 未注入 PG 实现时统一构造一个内存实例分给两模块（登录与组织管理同源）。
  const sharedUserStore = options.userStore ?? new InMemoryUserStore();
  // 会话撤销同源：org 的 users.active 停用撤销与 auth 的会话判定必须同一存储
  // （零 DB 形态同样成立——内存实例只此一个）。
  const sharedSessionStore = options.sessionStore ?? new InMemorySessionStore();

  // 跨模块接线共享存储（M2 后第一增量，ADR-0004 装配/ADR-0011 依赖方向）：组合根
  // 在零 DB 形态下为已装配模块预建与模块缺省**同实现**的内存实例——生产模块的
  // register 与消费模块的 store 级适配器拿到同一句柄（"组合根是共享实例的唯一
  // 裁决点"，同 sharedTodoStore 先例）；PG 形态经 options 注入同源。禁用模块
  // 对应项 undefined（wiring 与模块缺省都不受影响）。
  const wiringStores: CrossModuleWiringStores = {
    dispatchOrders:
      options.dispatchOrderStore ?? (enabled.includes('dispatch') ? new InMemoryDispatchOrderStore() : undefined),
    dispatchOutsourcingLines:
      options.dispatchOutsourcingLineStore ??
      (enabled.includes('dispatch') ? new InMemoryOutsourcingLineStore() : undefined),
    workOrders:
      options.workOrderStore ?? (enabled.includes('workorder') ? new InMemoryWorkOrderStore() : undefined),
    workOrderAttachments:
      options.workOrderAttachmentStore ??
      (enabled.includes('workorder') ? new InMemoryWorkOrderAttachmentStore() : undefined),
    workOrderKitChecks:
      options.workOrderKitStore ?? (enabled.includes('workorder') ? new InMemoryKitCheckStore() : undefined),
    workOrderEvents:
      options.workOrderDomainEventStore ??
      (enabled.includes('workorder') ? new InMemoryWorkOrderDomainEventStore() : undefined),
    workReports:
      options.reportingReportStore ?? (enabled.includes('reporting') ? new InMemoryWorkReportStore() : undefined),
    reportEvents:
      options.reportingDomainEventStore ??
      (enabled.includes('reporting') ? new InMemoryReportDomainEventStore() : undefined),
    inventoryMovements:
      options.inventoryMovementStore ?? (enabled.includes('inventory') ? new InMemoryStockMovementStore() : undefined),
    purchaseOrders:
      options.listingOrderStore ?? (enabled.includes('listing') ? new InMemoryPurchaseOrderStore() : undefined),
    hoursEntries:
      options.hoursEntryStore ??
      (enabled.includes('hours') ? new InMemoryLaborEntryStore() : undefined),
    // #22：baseline 域事件与 BaselineModule 同源（零 DB 形态组合根裁决共享实例；
    // PG 形态经 options.baselineEventStore 注入同源——工厂参数行同步改读 wiringStores）。
    baselineEvents:
      options.baselineEventStore ??
      (enabled.includes('baseline') ? new InMemoryBaselineEventStore() : undefined),
    // U6 #29/#30：dispatch 幂等/域事件两存储与 DispatchModule、AftercareClaimModule
    // 三方同源（模块头注共享裁决——零 DB 形态组合根预建，PG 形态 options 注入）。
    dispatchOperations:
      options.dispatchOperationStore ??
      (enabled.includes('dispatch') || enabled.includes('aftercare-claim')
        ? new InMemoryDispatchOperationStore()
        : undefined),
    dispatchDomainEvents:
      options.dispatchDomainEventStore ??
      (enabled.includes('dispatch') || enabled.includes('aftercare-claim')
        ? new InMemoryDispatchDomainEventStore()
        : undefined),
    // U6 #28：inventory 预占/域事件与 InventoryModule 同源（issue.material 适配器
    // 读面 + 撤销恢复事实源——零 DB 形态组合根预建共享实例，PG 形态注入同源）。
    inventoryReservations:
      options.inventoryReservationStore ??
      (enabled.includes('inventory') ? new InMemoryStockReservationStore() : undefined),
    inventoryDomainEvents:
      options.inventoryDomainEventStore ??
      (enabled.includes('inventory') ? new InMemoryInventoryDomainEventStore() : undefined),
    // U7 #31~#33：六块源读面（issue 发料记录 / listing 清单行 / dispatch 售后
    // 报销——零 DB 形态组合根预建共享实例，PG 形态 options 注入同源；工序×
    // 原材料关联仅 PG 形态有值——模块未注册组合根，读面缺省 undefined = 原材料
    // 段不计，语义诚实）。
    issueRecords:
      options.issueRecordStore ?? (enabled.includes('issue') ? new InMemoryIssueRecordStore() : undefined),
    listingLines:
      options.listingLineStore ?? (enabled.includes('listing') ? new InMemoryListingLineStore() : undefined),
    processMaterialLinks: options.processMaterialLinkStore,
    aftercareClaims:
      options.aftercareClaimStore ??
      (enabled.includes('aftercare-claim') ? new InMemoryAftercareClaimStore() : undefined),
  };
  // 跨模块端口接线（清单与机制见 cross-module-wiring.ts 文件头；print/IM sink
  // 由 main.ts 注入 integration 适配，缺省回落拒绝/console 降级——清单 #10/#18；
  // metric-pack 六源束按租户解析工厂 #24——零 DB 缺省 = 空源集）。
  const wiring = createCrossModuleWiring({
    enabled,
    stores: wiringStores,
    printSink: options.printSink,
    imSink: options.imSink,
    metricPackSourceSetFor: options.metricPackSourceSetFor,
  });

  const imports = [
    // 认证恒装配（收尾波-③）：基础层（与 /health 同类），不经 MODULES_ENABLED
    // 开关——守卫的 Bearer 解析与 /auth/* 端点不随模块启停消失；/modules 清单不变。
    AuthModule.register({ userStore: sharedUserStore, sessionStore: sharedSessionStore }),
    ...enabled.map((name) => {
      const factory = MODULE_DEFINITIONS[name];
      if (!factory) {
        throw new ModuleRegistryError(`未注册的模块：${name}`);
      }
      return factory({
        policyStore: options.policyStore,
        userStore: sharedUserStore,
        roleStore: options.roleStore,
        departmentStore: options.departmentStore,
        positionStore: options.positionStore,
        sessionStore: sharedSessionStore,
        itemStore: sharedItemStore,
        resourceStore: options.resourceStore,
        customerStore: options.customerStore,
        supplierStore: options.supplierStore,
        unitStore: options.unitStore,
        todoStore: effectiveTodoStore,
        approvalCaseStore: options.approvalCaseStore,
        approvalRecordStore: options.approvalRecordStore,
        approvalEventStore: options.approvalEventStore,
        baselineProcessStore: options.baselineProcessStore,
        baselineEquipmentStore: options.baselineEquipmentStore,
        baselineOutsourcingRuleStore: options.baselineOutsourcingRuleStore,
        baselineValidationRunStore: options.baselineValidationRunStore,
        baselineEventStore: wiringStores.baselineEvents,
        baselineOperationLedger: options.baselineOperationLedger,
        workOrderStore: wiringStores.workOrders,
        workOrderAttachmentStore: wiringStores.workOrderAttachments,
        workOrderPartsStore: options.workOrderPartsStore,
        workOrderKitStore: wiringStores.workOrderKitChecks,
        workOrderOperationStore: options.workOrderOperationStore,
        workOrderDomainEventStore: wiringStores.workOrderEvents,
        workOrderMachineEventStore: options.workOrderMachineEventStore,
        listingSheetStore: options.listingSheetStore,
        listingLineStore: options.listingLineStore,
        listingGapStore: options.listingGapStore,
        listingProcessMaterialStore: options.processMaterialLinkStore,
        listingRequestStore: options.listingRequestStore,
        listingOrderStore: wiringStores.purchaseOrders,
        listingReturnStore: options.listingReturnStore,
        listingOperationStore: options.listingOperationStore,
        listingDomainEventStore: options.listingDomainEventStore,
        listingMachineEventStore: options.listingMachineEventStore,
        inspectionOrderStore: options.inspectionOrderStore,
        inspectionNonconformStore: options.inspectionNonconformStore,
        inspectionOperationStore: options.inspectionOperationStore,
        inspectionDomainEventStore: options.inspectionDomainEventStore,
        inspectionMachineEventStore: options.inspectionMachineEventStore,
        inventoryWarehouseStore: options.inventoryWarehouseStore,
        inventoryAccountStore: options.inventoryAccountStore,
        inventoryLocationBalanceStore: options.inventoryLocationBalanceStore,
        inventoryMovementStore: wiringStores.inventoryMovements,
        inventoryReservationStore: wiringStores.inventoryReservations,
        inventoryStocktakeStore: options.inventoryStocktakeStore,
        inventoryShippingStore: options.inventoryShippingStore,
        inventoryReleaseFactStore: options.inventoryReleaseFactStore,
        inventoryOperationStore: options.inventoryOperationStore,
        inventoryDomainEventStore: wiringStores.inventoryDomainEvents,
        inventoryMachineEventStore: options.inventoryMachineEventStore,
        // U6 #29：issue 装配时派工单存储为装饰态实例（advance→assigned 触发
        // 发料任务同步）；operation/domainEvent 与 aftercare-claim 三方同源。
        dispatchOrderStore: wiring.storeOverrides.dispatchOrders ?? wiringStores.dispatchOrders,
        dispatchOutsourcingLineStore: wiringStores.dispatchOutsourcingLines,
        dispatchOperationStore: wiringStores.dispatchOperations,
        dispatchDomainEventStore: wiringStores.dispatchDomainEvents,
        dispatchMachineEventStore: options.dispatchMachineEventStore,
        reportingReportStore: wiringStores.workReports,
        reportingAuditStore: options.reportingAuditStore,
        reportingOperationStore: options.reportingOperationStore,
        reportingDomainEventStore: wiringStores.reportEvents,
        reportingMachineEventStore: options.reportingMachineEventStore,
        hoursEntryStore: wiringStores.hoursEntries ?? options.hoursEntryStore,
        hoursMonthStore: options.hoursMonthStore,
        hoursEventStore: options.hoursEventStore,
        hoursOperationStore: options.hoursOperationStore,
        costingEntryStore: options.costingEntryStore,
        costingModelStore: options.costingModelStore,
        costingSnapshotStore: options.costingSnapshotStore,
        costingEventStore: options.costingEventStore,
        costingOperationStore: options.costingOperationStore,
        costingProjectEntryStore: options.costingProjectEntryStore,
        costingProjectSnapshotStore: options.costingProjectSnapshotStore,
        costingPriceEntryStore: options.costingPriceEntryStore,
        baselineRoutingStore: options.baselineRoutingStore,
        baselineStandardTimeStore: options.baselineStandardTimeStore,
        baselineFaultReportStore: options.baselineFaultReportStore,
        baselineFaultEventStore: options.baselineFaultEventStore,
        payrollStores:
          options.payrollStores ??
          (enabled.includes('payroll') ? inMemoryPayrollStores() : undefined),
        maintenanceStores:
          options.maintenanceStores ??
          (enabled.includes('maintenance') ? inMemoryMaintenanceStores() : undefined),
        drawingStores:
          options.drawingStores ??
          (enabled.includes('drawing') ? inMemoryDrawingStores() : undefined),
        metricPackStores:
          options.metricPackStores ??
          (enabled.includes('metric-pack') ? inMemoryMetricPackStores() : undefined),
        auditLogStore: options.auditLogStore,
        standardReportsSourceProvider: options.standardReportsSourceProvider,
        menuConfigStore: sharedMenuConfigStore,
        notificationStore: sharedNotificationStore,
        approvalFlowConfigStore: sharedApprovalFlowConfigStore,
        issueTaskStore: options.issueTaskStore,
        issueTaskLineStore: options.issueTaskLineStore,
        issueRecordStore: options.issueRecordStore,
        issueExpressStore: options.issueExpressStore,
        issueOperationStore: options.issueOperationStore,
        issueDomainEventStore: options.issueDomainEventStore,
        aftercareClaimStore: options.aftercareClaimStore,
        attachmentStore: options.attachmentStore,
        objectStorage: options.objectStorage,
      }, wiring.register);
    }),
  ];

  const controllers: Type<unknown>[] = [HealthController, ModulesController];
  if (options.devPolicyEndpoint) {
    controllers.push(DevPolicyController);
  }

  const providers: Provider[] = [
    { provide: ENABLED_MODULE_NAMES, useValue: [...enabled] },
    { provide: APP_GUARD, useClass: AuthGuard },
    // 跨模块接线句柄入容器：main/集成测试经 bindCrossModuleWiring(app) 完成
    // "组合根构造后注入"（迟到绑定的 service 级端口在此刻回填真实实例）。
    { provide: CROSS_MODULE_WIRING, useValue: wiring },
    // hours.ingest 实时联动（接线 #2 触发机制①）：reporting+hours 同时装配才
    // 注册（否则 trigger token 缺位——拦截器不装配即零开销）。
    ...(wiring.hoursIngestTrigger !== undefined
      ? [
          { provide: HOURS_INGEST_TRIGGER, useValue: wiring.hoursIngestTrigger },
          { provide: APP_INTERCEPTOR, useClass: HoursIngestLinkInterceptor },
        ]
      : []),
    // 操作日志写拦截（S1 backfill：0920 #103）：audit 模块装配才注册（同
    // HoursIngestLinkInterceptor 条件装配先例——未启用零开销；AuditService 由
    // AuditModule 导出，DI 随模块可用）。
    ...(enabled.includes('audit') ? [{ provide: APP_INTERCEPTOR, useClass: AuditWriteInterceptor }] : []),
  ];

  @Module({ imports, controllers, providers })
  class ComposedRootModule {}

  return ComposedRootModule;
}
