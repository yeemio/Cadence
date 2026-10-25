/**
 * 跨模块端口组合根接线（M2 后第一增量，status.md M2 Wave-4 验收登记项①）。
 *
 * 接线清单（端口 → 来源 → 机制 → 口径说明；两侧模块同时装配才接线，否则回落
 * 各模块缺省实现——fail-closed 语义与未接线形态一致）：
 *
 *  1. reporting.validDispatch ← dispatch 有效单读
 *     机制：store 级——DispatchOrderStore.find 直读 + toDispatchFactForReport 投影。
 *  2. hours.reportFeed ← reporting 域事件（ReportVerified/ReportRevoked）
 *     机制：store 级——WorkReportStore.list 链尾发现 + 沿 supersedes 上溯全链
 *     成员 + ReportDomainEventStore.byAggregate('work-report') 过滤两类事件；
 *     消费位 = 适配器内存 Set（重启重放——hours 侧 sourceKey 幂等保证重放零
 *     漂移；持久化消费位对账阶段与 outbox 投递记录对齐后校正）。
 *     口径：laborMinutes→hours 用 minutesToHours（hours-config 已导出）；
 *     workDate = businessTime 前 10 位；revokeReason 仅 revoked 事件。
 *     ingest 触发机制（自选并文档化）：①组合态实时联动——POST /reports/:id/verify
 *     与 /:id/revoke 提交成功（outcome committed）后由 hours-ingest.interceptor
 *     联动执行 hours.ingest.v1（失败不阻塞核查响应，console.warn 留痕）；
 *     ②重放面——手动 POST /hours/ingest（hours 模块既有端点，补漏/对账用）。
 *  3. costing.laborSource ← hours 劳动条目净额
 *     机制：service 级迟到绑定——createHoursCostSource(HoursService.costingLines)，
 *     组合根构造后（bind）注入真实实例。
 *  4. costing.outsourcingSource ← dispatch 外协明细
 *     机制：store 级——DispatchOrderStore.list({workOrderId}) ×
 *     OutsourcingLineStore.listByDispatch。口径：金额 = unitPriceMinor × quantity
 *     （OutsourcingPriced 口径）；未定价行（unitPriceMinor=null）不返回——无金额
 *     不可归集（与 costing-ports 合同同词）。
 *  5. costing.materialSource ← inventory 流水 + 金额口径
 *     机制：store 级——StockMovementStore.list({workOrderId}) 只取 kind='issue-out'
 *     （生产/配件发料=材料消耗事实；shipping-out 成品发运、transfer/盘点不属
 *     材料成本）。金额口径（初版自定，对账阶段校正）：inventory 流水无金额列，
 *     单价 = listing 采购订单行**最新已定价** unitPriceMinor（按 itemId 取
 *     createdAt 降序首见）；无可用价该行跳过（不静默估算、不归集）；
 *     amountMinor = +quantity × 单价（初版无退库冲减流水词汇，冲减面对账阶段
 *     随采购退货链路补）。
 *  6. costing.workOrderSubject ← workorder 工作令存在性
 *     机制：store 级——WorkOrderStore.find 直读。
 *  7. dispatch.kitCheck ← workorder kit_checks 最新快照读
 *     机制：store 级——KitCheckStore.latestByWorkOrder + toKitCheckFact 投影
 *     （gapLineCount = gapLines.length）。
 *  8. dispatch.priceSource ← baseline 外协计价规则
 *     机制：service 级迟到绑定——BaselineService.resolve；BaselineNotFoundError
 *     → null 翻译（端口合同：无规则 = 未定价待补录）。
 *  9. dispatch.inspectionIntake ← inspection 回厂触发
 *     机制：service 级迟到绑定——InspectionService.receiveSourceFact。
 * 10. dispatch.print ← integration-print PrintPort（apps/server 侧适配）
 *     机制：本文件结构化适配（DispatchPrintDocument → pdf 文档族 PrintJob
 *     载荷）+ 可注入 sink。依赖已装配（M2 后第一增量）：main.ts 经
 *     integration-edge-adapters.createIntegrationPrintSink 注入受理口
 *     （makePrintJob 构造期校验 + createInMemoryPrintPort('pdf') 受理发回执；
 *     真实设备传输属后续接线增量）；测试/零接线形态缺省 sink = 拒绝
 *     （printed:false + 部署原因——不伪证打印）。
 * 11. listing.workOrderFeed ← workorder WorkOrderCreated 事件
 *     机制：store 级——WorkOrderStore.list 发现聚合 + WorkOrderDomainEventStore
 *     .byAggregate('work-order') 过滤 created 事件；消费位 = 适配器内存 Set
 *     （重启重放：listing 导入幂等由其命令 operationId 兜底；持久化消费位同 #2
 *     对账阶段校正）。
 * 12. listing.materialValidation ← baseline 校验执行器
 *     机制：service 级迟到绑定——BaselineService.execute（模块默认实现）。
 * 13. listing.inventoryPort（可用量） ← inventory
 *     机制：service 级迟到绑定——createInventoryAvailabilityAdapter(
 *     InventoryService.availableQtyOf)（跨仓 Σ max(0, 总量−预占) 恒等式口径）。
 * 14. listing.receiptPort ← inventory 采购收货入库
 *     机制：service 级迟到绑定——createInventoryReceiptAdapter(
 *     InventoryService.receivePurchaseStock)（receiptKey 幂等）。
 * 15. workorder.progressPort ← dispatch 进度上卷
 *     机制：service 级迟到绑定——createDispatchProgressAdapter(
 *     DispatchService.progressFacts)。
 * 16. workorder.issuePort ← inventory 配件出库
 *     机制：service 级迟到绑定——createPartsIssueAdapter(
 *     InventoryService.issuePartsStock)（requestId 幂等）。
 * 17. inspection.stockReleasePort ← inventory 放行事实登记
 *     机制：service 级迟到绑定——createStockReleaseRecorder(
 *     InventoryService.recordInspectionRelease)（direct@releasedAt 幂等锚点）。
 * 18. inspection.notifyChannel / baseline.notifyChannel ← integration-im（server 侧）
 *     机制：本文件 IM 适配（NotifyMessage → 卡片消息形状 kind/to/title/fields）
 *     + 可注入 sink；两模块共用同一实例。依赖已装配（M2 后第一增量）：main.ts
 *     经 integration-edge-adapters.createIntegrationEdgeSinks 按 SMES_IM_*
 *     环境装配 WecomImChannel/FeishuImChannel（fetch 传输 + env:VAR 凭据引用）；
 *     无外部配置 → imSink 缺省 = 结构化 console 日志降级（不炸 boot）。
 * 19. baseline.workOrderDrawingSource ← workorder 附件图纸计数
 *     机制：store 级——WorkOrderStore.list × WorkOrderAttachmentStore
 *     .listByWorkOrder 计 kind='drawing' 挂接数（全部工作令返回，含 0）。
 * 20. listing.excelPort / costing.excelPort ← ExcelJS 适配器（apps/server 侧，
 *     M2 后第一增量——status.md Wave-2 "ExcelJS 适配器待统一装依赖接线"补口）
 *     机制：本文件构造 ExcelJsExcelPort（xlsx-bytes ↔ 结构化表互译；语义层
 *     委托 application parseListingTable/JsonTablesExcelPort——表头别名与错误
 *     行语义只定义一次），单实例注入两模块（costing 侧为 exportWorkbook
 *     结构子集）。
 *
 * 迟到绑定（"组合根构造后注入"）：Nest 动态模块在 register() 时自建 service，
 * 组合根无法在建模块前拿到实例——消费这些 service 的端口先包一层 late-bound
 * 代理（未绑定 = 模块缺省语义），NestFactory.create 之后 bind(app) 经
 * app.get(token, {strict:false}) 解析真实实例回填。boot/单模块测试不调 bind
 * 也不受影响（回落缺省）。
 * 21. payroll.source/exportPort ← hours 工时条目（store 级：按月聚合净工时
 *     +trade→工种词逆映射）+ ExcelJS 导出适配（同实例结构同形）。
 *
 * M3 第二波（maintenance/drawing/metric-pack 组合根接线）：
 * 22. maintenance.faultLinkage ← baseline Outbox 故障事件
 *     机制：store 级——BaselineEventStore.list 过滤 FaultReported/FaultResolved
 *     → FaultTaskSuggestion（equipmentCode→resourceRef、faultReportId→faultRef、
 *     事件 assignee→suggestedAssignee，#11 workOrderFeed 体例：聚合发现 + 内存
 *     消费位）。FaultResolved 联动口径（合同 §4 / §10）：**不自动同步任务状态**
 *     ——已闭环故障的未联动建议撤销（resolved 即不再建议），已联动任务与故障
 *     的悬挂态归对账阶段提醒。触发面 = 组合根 HTTP 显式命令（POST
 *     /maintenance/fault-linkage/commands，手动/定时轮询——体例对齐 POST
 *     /hours/ingest 重放先例）。幂等三防线：确定性 operationId
 *     `wiring-fault-linkage-<eventId>`（重启重放 claim 拒绝→skipped）+ 任务
 *     面 faultRef 去重扫描 + 内存消费位。
 * 23. drawing.workOrderDrawingRefs ← workorder 附件钉版引用
 *     机制：store 级——WorkOrderAttachmentStore.listByWorkOrder 取 kind='drawing'
 *     附件，ref 按钉版编码 `drawingId@vN` 解析为 DrawingRef 结构同形透传（不进
 *     drawing 包——消费模块不 import 专业包，合同 §4 差异表 #3；激活前附件
 *     ref=普通文件指针不匹配编码即不进清单）。
 * 24. metric-pack.sourceSetFor/exportPort ← 六源 PG 适配器束 + ExcelJS
 *     机制：connectMetricSourceBundle 的六源绑定按**请求租户**解析（租户收口=
 *     构造注入——引擎 MetricSource 端口不带租户参数；main.ts 每租户缓存一个
 *     MetricSourceSet，HTTP 面经 resolver 每租户一个 MetricPackService）。六源
 *     各读不同模块表（workorder/listing×2/inspection/costing），仅 PG 形态有
 *     值；零 DB = 空源集（装载/清单语义完整，求值显式报"源未绑定"——与
 *     payroll 缺省空源同口径，语义诚实）。导出端口 = ExcelJS 同实例结构同形
 *     （#21 先例）。
 */
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { ExcelJsExcelPort } from './exceljs-excel-port.js';
import type { PayrollExportPort, PayrollSource, VerifiedLaborFact } from '@smes/payroll';
import { MaintenanceService, type FaultTaskSuggestion } from '@smes/maintenance';
import type { DrawingRefInput } from '@smes/drawing';
import type { MetricPackExportPort, MetricSourceSet } from '@smes/metric-pack';
import {
  BASELINE_EVENT_TYPES,
  BaselineNotFoundError,
  BaselineService,
  createDispatchProgressAdapter,
  createHoursCostSource,
  createInventoryAvailabilityAdapter,
  createInventoryReceiptAdapter,
  createPartsIssueAdapter,
  createStockReleaseRecorder,
  DISPATCH_NOOP_INSPECTION_INTAKE,
  DispatchService,
  HoursService,
  InspectionService,
  InventoryService,
  LISTING_UNWIRED_MATERIAL_VALIDATION,
  minutesToHours,
  REPORT_EVENT_TYPES,
  WORKORDER_EVENT_TYPES,
  WORK_ORDER_AGGREGATE_TYPE,
  WORK_REPORT_AGGREGATE_TYPE,
  toDispatchFactForReport,
  toKitCheckFact,
  type BaselineCommandEnvelope,
  type BaselineEventStore,
  type CostingExcelPort,
  type DispatchOrderStore,
  type DispatchPrintPort,
  type ExcelPort,
  type InspectionIntakePort,
  type KitCheckReadPort,
  type KitCheckStore,
  type MaterialCostLine,
  type MaterialCostSourcePort,
  type MaterialValidationExecutor,
  type NotifyChannel,
  type OutsourcingCostLine,
  type OutsourcingCostSourcePort,
  type OutsourcingLineStore,
  type OutsourcingPriceSource,
  type PartsIssuePort,
  type PurchaseOrderStore,
  type ReportDomainEventStore,
  type ReportEventFeedPort,
  type ReportEventMessage,
  type LaborEntryStore,
  type StockMovementStore,
  type StockReleasePort,
  type ValidDispatchSource,
  type WorkOrderAttachmentStore,
  type WorkOrderCreatedEventMessage,
  type WorkOrderCreatedFeedPort,
  type WorkOrderDomainEventStore,
  type WorkOrderDrawingSource,
  type WorkOrderStore,
  type WorkOrderSubjectPort,
  type WorkReportStore,
} from '@smes/application';
import {
  makeCommandEnvelope,
  OperationId,
  UserId,
  WorkOrderId,
  type BusinessEvent,
  type CommandOutcome,
  type TenantId,
} from '@smes/business-core';

// ---- 组合根注入 wiring 句柄的 DI token（buildAppModule 注册，main/测试 bind） ----

/** buildAppModule 把 wiring 对象挂进容器；bindCrossModuleWiring 经此取回。 */
export const CROSS_MODULE_WIRING = Symbol('smes.server.crossModuleWiring');

/** hours.ingest 联动触发函数 token（仅 reporting+hours 同时装配时注册）。 */
export const HOURS_INGEST_TRIGGER = Symbol('smes.server.hoursIngestTrigger');

/** wiring 消费的共享存储实例（模块禁用 = undefined；由 app-registry 裁决同源）。 */
export interface CrossModuleWiringStores {
  /** dispatch 派工单投影（validDispatch / outsourcingSource 事实源）。 */
  readonly dispatchOrders?: DispatchOrderStore | undefined;
  /** dispatch 外协明细投影（outsourcingSource 事实源）。 */
  readonly dispatchOutsourcingLines?: OutsourcingLineStore | undefined;
  /** workorder 工作令投影（workOrderSubject / 事件发现 / 图纸计数源）。 */
  readonly workOrders?: WorkOrderStore | undefined;
  /** workorder 附件事实（workOrderDrawingSource 计数源）。 */
  readonly workOrderAttachments?: WorkOrderAttachmentStore | undefined;
  /** workorder 齐套快照（dispatch.kitCheck 事实源）。 */
  readonly workOrderKitChecks?: KitCheckStore | undefined;
  /** workorder 域事件（listing.workOrderFeed 事实源）。 */
  readonly workOrderEvents?: WorkOrderDomainEventStore | undefined;
  /** reporting 报工投影（reportFeed 链发现源）。 */
  readonly workReports?: WorkReportStore | undefined;
  /** reporting 域事件（reportFeed 事件源）。 */
  readonly reportEvents?: ReportDomainEventStore | undefined;
  /** inventory 出入库流水（materialSource 事实源）。 */
  readonly inventoryMovements?: StockMovementStore | undefined;
  /** listing 采购订单投影（materialSource 单价口径源；可缺——缺则材料行全跳过）。 */
  readonly purchaseOrders?: PurchaseOrderStore | undefined;
  /** hours 工时条目（payroll 事实源 store 级读取，#21）。 */
  readonly hoursEntries?: LaborEntryStore | undefined;
  /** baseline 域事件（maintenance 故障联动事实源，#22；与 BaselineModule 同源）。 */
  readonly baselineEvents?: BaselineEventStore | undefined;
}

/** 各模块 register 的跨模块端口注入面（形状与 *ModuleOptions 对应字段同构）。 */
export interface CrossModuleRegisterPorts {
  readonly workorder?: {
    readonly progressPort?: Parameters<typeof createDispatchProgressAdapter>[0] | undefined;
    readonly issuePort?: PartsIssuePort | undefined;
  };
  readonly listing?: {
    readonly workOrderFeed?: WorkOrderCreatedFeedPort | undefined;
    readonly inventoryPort?: ReturnType<typeof createInventoryAvailabilityAdapter> | undefined;
    readonly receiptPort?: ReturnType<typeof createInventoryReceiptAdapter> | undefined;
    readonly materialValidation?: MaterialValidationExecutor | undefined;
    /** Excel 导入导出（xlsx-bytes ↔ 结构化表，ExcelJS 适配器——本 wiring 构造）。 */
    readonly excelPort?: ExcelPort | undefined;
  };
  readonly dispatch?: {
    readonly kitCheck?: KitCheckReadPort | undefined;
    readonly priceSource?: OutsourcingPriceSource | undefined;
    readonly inspectionIntake?: InspectionIntakePort | undefined;
    readonly print?: DispatchPrintPort | undefined;
  };
  readonly reporting?: {
    readonly validDispatch?: ValidDispatchSource | undefined;
  };
  readonly hours?: {
    readonly reportFeed?: ReportEventFeedPort | undefined;
  };
  /** M3 payroll（#21）：hours 事实源 + 导出端口。 */
  readonly payroll?: {
    readonly source?: PayrollSource | undefined;
    readonly exportPort?: PayrollExportPort | undefined;
  } | undefined;
  /** M3 maintenance（#22）：baseline 故障事件 → 维保任务联动。 */
  readonly maintenance?: {
    readonly faultLinkage?: MaintenanceFaultLinkagePort | undefined;
  } | undefined;
  /** M3 drawing（#23）：workorder 附件钉版引用装配。 */
  readonly drawing?: {
    readonly workOrderDrawingRefs?: WorkOrderDrawingRefsPort | undefined;
  } | undefined;
  /** M3 metric-pack（#24）：六源适配器束（按租户解析）+ 导出端口。 */
  readonly 'metric-pack'?: {
    readonly sourceSetFor?: ((tenant: TenantId) => MetricSourceSet) | undefined;
    readonly exportPort?: MetricPackExportPort | undefined;
  } | undefined;
  readonly costing?: {
    readonly materialSource?: MaterialCostSourcePort | undefined;
    readonly laborSource?: ReturnType<typeof createHoursCostSource> | undefined;
    readonly outsourcingSource?: OutsourcingCostSourcePort | undefined;
    readonly workOrderSubject?: WorkOrderSubjectPort | undefined;
    /** 成本快照导出（xlsx-base64 字节，ExcelJS 适配器——与 listing 共享实例）。 */
    readonly excelPort?: CostingExcelPort | undefined;
  };
  readonly inspection?: {
    readonly stockReleasePort?: StockReleasePort | undefined;
    readonly notifyChannel?: NotifyChannel | undefined;
  };
  readonly baseline?: {
    readonly notifyChannel?: NotifyChannel | undefined;
    readonly workOrderDrawingSource?: WorkOrderDrawingSource | undefined;
  };
}

// ---- M3 接线端口形状（#22/#23；实现见下方适配器） ----

/** 故障联动同步回执（触发面 = POST /maintenance/fault-linkage/commands）。 */
export interface FaultLinkageSyncResult {
  /** 本次扫描的待联动建议（触发后已在消费位，重触发不重复出现）。 */
  readonly suggestions: readonly FaultTaskSuggestion[];
  /** 成功落账的维修任务数（maintenance.task.create committed）。 */
  readonly tasksCreated: number;
  /** 跳过数（已联动过 faultRef / 幂等重放 claim 拒绝）。 */
  readonly skipped: number;
}

/**
 * maintenance 故障联动端口（#22）：baseline FaultReported 事件 → 维保任务建议
 * → maintenance.task.create 提交。双侧零 import（maintenance 与 baseline 各自
 * 不知对方，组合根粘合——合同 §4 差异表 #4）。
 */
export interface MaintenanceFaultLinkagePort {
  pendingSuggestions(tenant: TenantId): Promise<readonly FaultTaskSuggestion[]>;
  syncFaultTasks(tenant: TenantId, actor: UserId): Promise<FaultLinkageSyncResult>;
}

/**
 * drawing 按工作令图纸清单的 refs 装配端口（#23）：从 workorder 附件事实解析
 * 钉版引用（ref='drawingId@vN' 编码约定），结构同形透传给
 * DrawingService.drawingsForWorkOrder。
 */
export interface WorkOrderDrawingRefsPort {
  listDrawingRefs(tenant: TenantId, workOrderId: string): Promise<readonly DrawingRefInput[]>;
}

// ---- 迟到绑定（组合根构造后注入） ----

/** 未绑定期间回落缺省语义的迟到引用（bind 前后行为确定性由调用方保证）。 */
class LateBound<T> {
  private impl: T | undefined;
  bind(impl: T): void {
    this.impl = impl;
  }
  resolve(): T | undefined {
    return this.impl;
  }
}

// ---- store 级事件适配（#2 reportFeed / #11 workOrderFeed 共用体例） ----

/** ReportVerified/ReportRevoked 载荷的最小结构读面（防御性窄化，不引载荷类型）。 */
interface ReportSignalPayload {
  readonly [key: string]: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * reporting 域事件 → hours 订阅消息（#2）。laborMinutes 在 reporting 侧建单时
 * 已按 MAX_LABOR_MINUTES 校验（(0, 44640] 与 minutesToHours 合法域一致）——
 * 此处直接换算；形状不符的事件不投递（防御），量纲不变量被破坏则 fail-loud。
 */
function toReportEventMessage(event: BusinessEvent): ReportEventMessage | null {
  const signal =
    event.eventType === REPORT_EVENT_TYPES.reportVerified
      ? ('ReportVerified' as const)
      : event.eventType === REPORT_EVENT_TYPES.reportRevoked
        ? ('ReportRevoked' as const)
        : null;
  if (signal === null) return null;
  const payload = (event.payload ?? {}) as ReportSignalPayload;
  const laborMinutes = payload['laborMinutes'];
  if (typeof laborMinutes !== 'number') return null;
  return {
    eventId: String(event.eventId),
    tenantId: String(event.tenantId),
    occurredAt: event.occurredAt,
    signal,
    payload: {
      reportId: readString(payload['reportId']) ?? '',
      kind: (readString(payload['kind']) ?? '') as ReportEventMessage['payload']['kind'],
      dispatchId: readString(payload['dispatchId']),
      workOrderId: readString(payload['workOrderId']),
      drawingNo: readString(payload['drawingNo']),
      processCode: readString(payload['operationCode']),
      worker: readString(payload['reporter']) ?? '',
      doneQty: typeof payload['doneQty'] === 'number' ? payload['doneQty'] : 0,
      hours: minutesToHours(laborMinutes),
      workDate: (readString(payload['businessTime']) ?? event.occurredAt).slice(0, 10),
      revokeReason: signal === 'ReportRevoked' ? readString(payload['revokeReason']) : null,
      actor: readString(payload['actor']) ?? '',
    },
  };
}

/** hours.reportFeed 适配器（#2）：修正链发现 + 事件过滤 + 内存消费位。 */
class ReportingEventFeedAdapter implements ReportEventFeedPort {
  private readonly acknowledged = new Set<string>();

  constructor(
    private readonly reports: WorkReportStore,
    private readonly events: ReportDomainEventStore,
  ) {}

  async pending(tenant: TenantId): Promise<readonly ReportEventMessage[]> {
    const messages: ReportEventMessage[] = [];
    for (const tail of await this.reports.list(tenant)) {
      // 修正链发现：list 只回链尾——沿 supersedes 上溯收集全链成员（原单的
      // verified/revoked 事件挂在原单 id 上，缺了会漏入账）。
      const ids = new Set<string>([tail.id]);
      let current = tail;
      for (let guard = 0; guard < 100 && current.supersedes !== null; guard += 1) {
        const previous = await this.reports.find(tenant, current.supersedes);
        if (previous === null) break;
        ids.add(previous.id);
        current = previous;
      }
      for (const id of ids) {
        const aggregate = await this.events.byAggregate({ id, type: WORK_REPORT_AGGREGATE_TYPE });
        for (const event of aggregate) {
          const message = toReportEventMessage(event);
          if (message !== null && !this.acknowledged.has(message.eventId)) {
            messages.push(message);
          }
        }
      }
    }
    return messages.sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
    );
  }

  async acknowledge(eventId: string): Promise<void> {
    this.acknowledged.add(eventId);
  }
}

/** workorder created 事件 → listing 订阅消息（#11；防御性窄化同上）。 */
function toWorkOrderCreatedMessage(event: BusinessEvent): WorkOrderCreatedEventMessage {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const listingKinds = Array.isArray(payload['listingKinds'])
    ? payload['listingKinds'].filter((kind): kind is string => typeof kind === 'string')
    : [];
  return {
    eventId: String(event.eventId),
    tenantId: String(event.tenantId),
    occurredAt: event.occurredAt,
    payload: {
      workOrderId: readString(payload['workOrderId']) ?? '',
      projectName: readString(payload['projectName']) ?? '',
      customerRef: readString(payload['customerRef']),
      salesRep: readString(payload['salesRep']),
      manager: readString(payload['manager']),
      plannedDeliveryAt: readString(payload['plannedDeliveryAt']),
      packagingArrivalAt: readString(payload['packagingArrivalAt']),
      listingKinds,
      actor: readString(payload['actor']) ?? '',
    },
  };
}

/** listing.workOrderFeed 适配器（#11）：聚合发现 + created 过滤 + 内存消费位。 */
class WorkOrderCreatedFeedAdapter implements WorkOrderCreatedFeedPort {
  private readonly acknowledged = new Set<string>();

  constructor(
    private readonly workOrders: WorkOrderStore,
    private readonly events: WorkOrderDomainEventStore,
  ) {}

  async pendingCreatedEvents(tenant: TenantId): Promise<readonly WorkOrderCreatedEventMessage[]> {
    const messages: WorkOrderCreatedEventMessage[] = [];
    for (const order of await this.workOrders.list(tenant)) {
      const aggregate = await this.events.byAggregate({ id: order.id, type: WORK_ORDER_AGGREGATE_TYPE });
      for (const event of aggregate) {
        if (event.eventType !== WORKORDER_EVENT_TYPES.created) continue;
        if (this.acknowledged.has(String(event.eventId))) continue;
        messages.push(toWorkOrderCreatedMessage(event));
      }
    }
    return messages.sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
    );
  }

  async acknowledge(eventId: string): Promise<void> {
    this.acknowledged.add(eventId);
  }
}

// ---- store 级故障/附件适配（#22 faultLinkage / #23 workOrderDrawingRefs） ----

/** FaultReported 事件载荷的最小结构读面（防御性窄化，不引载荷类型）。 */
interface FaultSignalPayload {
  readonly [key: string]: unknown;
}

/** baseline FaultReported 事件 → FaultTaskSuggestion（载荷结构同形镜像，#22）。 */
function toFaultTaskSuggestion(event: BusinessEvent): {
  readonly eventId: string;
  readonly suggestion: FaultTaskSuggestion;
} | null {
  const payload = (event.payload ?? {}) as FaultSignalPayload;
  const faultReportId = readString(payload['faultReportId']);
  const equipmentCode = readString(payload['equipmentCode']);
  if (faultReportId === null || equipmentCode === null) return null; // 形状不符不投递（防御）
  const assignee = readString(payload['assignee']);
  return {
    eventId: String(event.eventId),
    suggestion: {
      resourceRef: equipmentCode, // 组合根按台账存在性校验位（v1 字符串引用直透）
      faultRef: faultReportId,
      description: readString(payload['description']) ?? '',
      suggestedAssignee: assignee === null || assignee === '' ? null : UserId.create(assignee),
      reportedAt: event.occurredAt,
    },
  };
}

/**
 * maintenance 故障联动适配器（#22）：baseline 事件扫描 + FaultResolved 对账口径
 * （已闭环不推荐）+ 内存消费位；sync 把建议组装 maintenance.task.create 提交
 * （确定性 operationId——重启重放幂等由 claim 兜底）。
 */
class BaselineFaultLinkageAdapter implements MaintenanceFaultLinkagePort {
  private readonly acknowledged = new Set<string>();

  constructor(
    private readonly events: BaselineEventStore,
    private readonly maintenance: LateBound<MaintenanceService>,
  ) {}

  async pendingSuggestions(tenant: TenantId): Promise<readonly FaultTaskSuggestion[]> {
    const events = await this.events.list(tenant);
    // FaultResolved 对账口径（合同 §4 / §10）：不自动同步任务状态——未联动且已
    // 闭环的故障不再建议（维修处置已无意义）；已联动任务的悬挂态归对账提醒。
    const resolvedFaultIds = new Set<string>();
    for (const event of events) {
      if (event.eventType !== BASELINE_EVENT_TYPES.faultResolved) continue;
      const faultReportId = readString(((event.payload ?? {}) as FaultSignalPayload)['faultReportId']);
      if (faultReportId !== null) resolvedFaultIds.add(faultReportId);
    }
    const suggestions: { eventId: string; occurredAt: string; suggestion: FaultTaskSuggestion }[] = [];
    for (const event of events) {
      if (event.eventType !== BASELINE_EVENT_TYPES.faultReported) continue;
      const parsed = toFaultTaskSuggestion(event);
      if (parsed === null) continue;
      if (this.acknowledged.has(parsed.eventId)) continue;
      if (resolvedFaultIds.has(parsed.suggestion.faultRef)) continue;
      suggestions.push({ eventId: parsed.eventId, occurredAt: event.occurredAt, suggestion: parsed.suggestion });
    }
    return suggestions
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId))
      .map((item) => item.suggestion);
  }

  async syncFaultTasks(tenant: TenantId, actor: UserId): Promise<FaultLinkageSyncResult> {
    const maintenance = this.maintenance.resolve();
    if (maintenance === undefined) {
      throw new Error('maintenance service 未绑定（bindCrossModuleWiring 未调用）——组合根装配缺陷');
    }
    const events = await this.events.list(tenant);
    const pending: { eventId: string; suggestion: FaultTaskSuggestion }[] = [];
    for (const event of events) {
      if (event.eventType !== BASELINE_EVENT_TYPES.faultReported) continue;
      const parsed = toFaultTaskSuggestion(event);
      if (parsed === null) continue;
      if (this.acknowledged.has(parsed.eventId)) continue;
      pending.push(parsed);
    }
    // faultRef 去重第二防线：已存在 source=fault 任务同故障引用的不再建（含人工
    // 抢先创建的联动任务——faultRef 是故障联动的业务身份）。
    const linkedFaultRefs = new Set(
      (await maintenance.taskQueue(tenant, { source: 'fault' }))
        .map((task) => task.faultRef ?? ''),
    );
    let tasksCreated = 0;
    let skipped = 0;
    for (const { eventId, suggestion } of pending) {
      this.acknowledged.add(eventId); // 处理过即消费（含拒绝——幂等重放不重复出现）
      if (linkedFaultRefs.has(suggestion.faultRef)) {
        skipped += 1;
        continue;
      }
      const outcome = await maintenance.execute(
        tenant,
        makeCommandEnvelope<{
          kind: 'maintenance.task.create.v1';
          payload: Record<string, unknown>;
        }>({
          tenantId: tenant,
          issuedBy: actor,
          // 确定性幂等锚：同事件重触发（重启/重放）claim 拒绝 → skipped，不重建。
          operationId: OperationId.create(`wiring-fault-linkage-${eventId}`),
          expectedRevision: 'initial',
          issuedAt: new Date().toISOString(),
          command: {
            kind: 'maintenance.task.create.v1',
            payload: {
              resourceRef: suggestion.resourceRef,
              kind: 'repair',
              faultRef: suggestion.faultRef,
              ...(suggestion.suggestedAssignee === null
                ? {}
                : { assignee: suggestion.suggestedAssignee }),
            },
          },
        }),
      );
      if (outcome.status === 'committed') {
        tasksCreated += 1;
        linkedFaultRefs.add(suggestion.faultRef);
      } else {
        skipped += 1;
      }
    }
    return { suggestions: pending.map((item) => item.suggestion), tasksCreated, skipped };
  }
}

/**
 * workorder 附件 → drawing 钉版引用适配器（#23）：kind='drawing' 附件的 ref 按
 * `drawingId@vN` 钉版编码解析（激活前 ref=普通文件指针不匹配即不进清单——
 * 引用存在性升级是显式动作，合同 §4 差异表 #3"激活后可升级钉版引用"）。
 */
const PINNED_DRAWING_REF_PATTERN = /^(.+)@v([1-9]\d*)$/;

class WorkOrderAttachmentDrawingRefsAdapter implements WorkOrderDrawingRefsPort {
  constructor(private readonly attachments: WorkOrderAttachmentStore) {}

  async listDrawingRefs(tenant: TenantId, workOrderId: string): Promise<readonly DrawingRefInput[]> {
    const rows = await this.attachments.listByWorkOrder(tenant, WorkOrderId.create(workOrderId));
    const refs: DrawingRefInput[] = [];
    for (const row of rows) {
      if (row.kind !== 'drawing') continue;
      const match = PINNED_DRAWING_REF_PATTERN.exec(row.ref);
      if (match === null) continue;
      refs.push({ drawingId: match[1]!, version: Number(match[2]) });
    }
    return refs;
  }
}

/** itemId → 最新已定价采购单价（分；createdAt 降序首见——#5 金额口径）。 */
async function latestPurchasePrices(
  tenant: TenantId,
  orders: PurchaseOrderStore | undefined,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (orders === undefined) return prices; // listing 未装配：无单价口径，材料行全跳过
  const rows = [...(await orders.list(tenant))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const order of rows) {
    for (const line of order.lines) {
      if (line.unitPriceMinor === null || prices.has(line.itemId)) continue;
      prices.set(line.itemId, line.unitPriceMinor);
    }
  }
  return prices;
}

// ---- integration 边缘口的 sink 接口（清单 #10/#18；实现见 integration-edge-adapters.ts） ----

/**
 * 打印提交 sink（integration-print PrintPort.submit('pdf' 族) 的形状镜像）。
 * 实现注入位：createIntegrationPrintSink（main.ts）；缺省 = 未部署拒绝。
 */
export interface PrintSubmitSink {
  submit(job: {
    readonly jobId: string;
    readonly kind: 'document';
    readonly payload: unknown;
    readonly copies: number;
    readonly createdAt: string;
  }): Promise<{ readonly jobId: string; readonly submittedAt: string }>;
}

/** 未接设备的受理 sink：拒绝（printed:false + 部署原因——不伪证打印）。 */
const UNDEPLOYED_PRINT_SINK: PrintSubmitSink = {
  submit: async () => {
    throw new Error('print 设备通道未部署：@smes/integration-print 依赖装配后注入真实 PrintPort');
  },
};

/**
 * IM 发送 sink（integration-im IMessageChannel.send 的卡片消息形状镜像）。
 * 实现注入位：createIntegrationImSink（main.ts，按 SMES_IM_* 环境装配渠道）；
 * 缺省 = 结构化 console 日志降级。
 */
export interface ImNotifySink {
  send(message: {
    readonly kind: 'card';
    readonly to: string;
    readonly title: string;
    readonly fields: readonly { readonly name: string; readonly value: string }[];
  }): Promise<{ readonly ok: boolean }>;
}

/** 初版 sink：结构化 console 日志（可观察、不外呼；通知式语义不阻塞业务）。 */
const CONSOLE_IM_SINK: ImNotifySink = {
  send: async (message) => {
    console.log(JSON.stringify({ channel: 'smes-im-wiring', ...message }));
    return { ok: true };
  },
};

// ---- 边缘适配器构造 ----

/**
 * DispatchPrintPort 适配（#10）：DispatchPrintDocument → 打印任务形状（pdf 文档
 * 族）→ sink.submit。sink 拒绝（未部署/设备不可用）→ printed:false + 原因
 * （端口合同：printed=false 携拒绝原因——打印失败不炸查询/命令）。
 */
function createPrintPortAdapter(sink: PrintSubmitSink): DispatchPrintPort {
  return {
    print: async (_tenant, document) => {
      try {
        const submission = await sink.submit({
          jobId: `prn-${randomUUID()}`,
          kind: 'document',
          // 载荷 = integration-print PdfDefinition 合法形状（table.body 矩形 +
          // headerRows；makePrintJob 构造期 isPdfDefinition 校验对齐）
          payload: {
            family: 'pdf',
            definition: {
              content: [
                { text: document.title, style: 'header' },
                ...document.fields.map((field) => ({ text: `${field.label}：${field.value}` })),
                ...(document.lines.length === 0
                  ? []
                  : [
                      {
                        table: {
                          headerRows: 1,
                          widths: ['auto', 'auto', '*', 'auto', 'auto', 'auto'],
                          body: [
                            ['行', '工序', '图号', '数量', '单价', '交期'].map((text) => ({ text })),
                            ...document.lines.map((line) => [
                              { text: String(line.lineNo) },
                              { text: line.processCode },
                              { text: line.drawingNo ?? '' },
                              { text: String(line.quantity) },
                              { text: line.unitPriceLabel },
                              { text: line.promisedAt ?? '' },
                            ]),
                          ],
                        },
                      },
                    ]),
              ],
              styles: { header: { bold: true, fontSize: 16 } },
            },
          },
          copies: 1,
          createdAt: new Date().toISOString(),
        });
        return { printed: true, jobId: submission.jobId };
      } catch (error) {
        return {
          printed: false,
          jobId: null,
          refusedReason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * NotifyChannel 适配（#18）：业务通知 → IM 卡片消息形状（title + 正文/指向字段）
 * → sink.send。通知式合同：sink 失败吞掉（不阻塞业务判定），console.warn 留痕。
 */
function createImNotifyChannel(sink: ImNotifySink): NotifyChannel {
  return {
    notify: async (tenant, message) => {
      try {
        await sink.send({
          kind: 'card',
          to: 'smes-ops',
          title: message.title,
          fields: [
            { name: '正文', value: message.body },
            { name: '租户', value: String(tenant) },
            ...(message.refType === undefined ? [] : [{ name: '业务类型', value: message.refType }]),
            ...(message.refId === undefined ? [] : [{ name: '业务单据', value: message.refId }]),
          ],
        });
      } catch (error) {
        console.warn(
          '[smes] IM 通知投递失败（notify 通知式合同，不阻塞业务）:',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

// ---- wiring 装配 ----

/** wiring 构造入参。 */
export interface CrossModuleWiringInput {
  /** 装配模块名清单（parseModulesEnabled 输出）。 */
  readonly enabled: readonly string[];
  /** 共享存储实例（模块禁用对应项 undefined；app-registry 裁决与模块同源）。 */
  readonly stores: CrossModuleWiringStores;
  /**
   * print 提交 sink（#10 注入位；main.ts 注入 integration-print 适配
   * createIntegrationPrintSink）。缺省 = UNDEPLOYED_PRINT_SINK（拒绝 + 部署
   * 原因——零接线/测试形态不伪证打印）。
   */
  readonly printSink?: PrintSubmitSink | undefined;
  /**
   * IM 发送 sink（#18 注入位；main.ts 注入 integration-im 适配
   * createIntegrationEdgeSinks 的 imSink）。缺省 = CONSOLE_IM_SINK（结构化
   * console 日志——无外部配置降级，不炸 boot）。
   */
  readonly imSink?: ImNotifySink | undefined;
  /**
   * 六源适配器束的租户解析工厂（#24 注入位；main.ts PG 形态注入
   * connectMetricSourceBundle 的每租户缓存包装；零 DB 不注入 = 空源集——
   * 装载/清单语义完整，求值显式报"源未绑定"）。
   */
  readonly metricPackSourceSetFor?: ((tenant: TenantId) => MetricSourceSet) | undefined;
}

/** 组合根接线句柄：register 端口集 + 构造后绑定 + hours ingest 联动触发。 */
export interface CrossModuleWiring {
  /** 注入各模块 register 的端口面（未接线条目缺省——模块回落自身缺省实现）。 */
  readonly register: CrossModuleRegisterPorts;
  /** 组合根构造后注入：解析各模块 service 实例回填迟到引用（幂等可重复调用）。 */
  bind(app: INestApplicationContext): void;
  /**
   * hours.ingest 联动触发（验证/撤销命令提交成功后由拦截器调用；手动端点
   * POST /hours/ingest 是等价重放面）。仅 reporting+hours 同时装配时非空。
   */
  readonly hoursIngestTrigger: ((tenant: TenantId, actor: UserId) => Promise<void>) | undefined;
}

/** 组装全部跨模块接线（清单见文件头；两侧装配才接，机制各见条目注释）。 */
export function createCrossModuleWiring(input: CrossModuleWiringInput): CrossModuleWiring {
  const { enabled, stores } = input;
  const has = (module: string): boolean => enabled.includes(module);

  // 迟到引用（#3/#8/#9/#12~#17 的 service 级端口；#22 的 maintenance）
  const lateInventory = new LateBound<InventoryService>();
  const lateDispatch = new LateBound<DispatchService>();
  const lateBaseline = new LateBound<BaselineService>();
  const lateInspection = new LateBound<InspectionService>();
  const lateHours = new LateBound<HoursService>();
  const lateMaintenance = new LateBound<MaintenanceService>();

  // #1 reporting.validDispatch（store 级）
  const validDispatch: ValidDispatchSource | undefined =
    has('reporting') && has('dispatch') && stores.dispatchOrders !== undefined
      ? {
          findDispatch: async (tenant, dispatchId) => {
            const order = await stores.dispatchOrders!.find(tenant, dispatchId);
            return order === null ? null : toDispatchFactForReport(dispatchId, order);
          },
        }
      : undefined;

  // #2 hours.reportFeed（store 级）
  const reportFeed: ReportEventFeedPort | undefined =
    has('hours') && has('reporting') && stores.workReports !== undefined && stores.reportEvents !== undefined
      ? new ReportingEventFeedAdapter(stores.workReports, stores.reportEvents)
      : undefined;

  // #3 costing.laborSource（service 级迟到绑定）
  const laborSource =
    has('costing') && has('hours')
      ? createHoursCostSource({
          costingLines: (tenant, workOrderId) => {
            const hours = lateHours.resolve();
            return hours === undefined ? Promise.resolve([]) : hours.costingLines(tenant, workOrderId);
          },
        })
      : undefined;

  // #4 costing.outsourcingSource（store 级）
  const outsourcingSource: OutsourcingCostSourcePort | undefined =
    has('costing') &&
    has('dispatch') &&
    stores.dispatchOrders !== undefined &&
    stores.dispatchOutsourcingLines !== undefined
      ? {
          outsourcingLines: async (tenant, workOrderId): Promise<readonly OutsourcingCostLine[]> => {
            const lines: OutsourcingCostLine[] = [];
            const orders = await stores.dispatchOrders!.list(tenant, { workOrderId });
            for (const order of orders) {
              const rows = await stores.dispatchOutsourcingLines!.listByDispatch(tenant, order.id);
              for (const row of rows) {
                if (row.unitPriceMinor === null) continue; // 未定价行不返回（无金额不归集）
                lines.push({
                  dispatchId: row.dispatchId,
                  lineNo: row.lineNo,
                  workOrderId,
                  processCode: row.processCode,
                  supplierRef: row.supplierRef,
                  unitPriceMinor: row.unitPriceMinor,
                  quantity: row.quantity,
                  amountMinor: row.unitPriceMinor * row.quantity,
                });
              }
            }
            return lines;
          },
        }
      : undefined;

  // #5 costing.materialSource（store 级 + listing 单价口径）
  const materialSource: MaterialCostSourcePort | undefined =
    has('costing') && has('inventory') && stores.inventoryMovements !== undefined
      ? {
          materialLines: async (tenant, workOrderId): Promise<readonly MaterialCostLine[]> => {
            const movements = await stores.inventoryMovements!.list(tenant, { workOrderId });
            const prices = await latestPurchasePrices(tenant, stores.purchaseOrders);
            const lines: MaterialCostLine[] = [];
            for (const movement of movements) {
              if (movement.kind !== 'issue-out') continue; // 仅发料消耗=材料成本（口径见清单 #5；kind 单值即方向）
              const unitPriceMinor = prices.get(movement.itemId);
              if (unitPriceMinor === undefined) continue; // 无单价口径不估算、不归集
              lines.push({
                movementId: movement.id,
                workOrderId,
                itemId: movement.itemId,
                quantity: movement.quantity,
                amountMinor: movement.quantity * unitPriceMinor,
                occurredAt: movement.occurredAt,
              });
            }
            return lines.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
          },
        }
      : undefined;

  // #6 costing.workOrderSubject（store 级）
  const workOrderSubject: WorkOrderSubjectPort | undefined =
    has('costing') && has('workorder') && stores.workOrders !== undefined
      ? {
          exists: async (tenant, workOrderId) =>
            (await stores.workOrders!.find(tenant, WorkOrderId.create(workOrderId))) !== null,
        }
      : undefined;

  // #7 dispatch.kitCheck（store 级）
  const kitCheck: KitCheckReadPort | undefined =
    has('dispatch') && has('workorder') && stores.workOrderKitChecks !== undefined
      ? {
          latestKitCheck: async (tenant, workOrderId) => {
            const snapshot = await stores
              .workOrderKitChecks!.latestByWorkOrder(tenant, WorkOrderId.create(workOrderId));
            return snapshot === null ? null : toKitCheckFact(workOrderId, snapshot);
          },
        }
      : undefined;

  // #8 dispatch.priceSource（service 级迟到绑定；NotFound→null 翻译）
  const priceSource: OutsourcingPriceSource | undefined =
    has('dispatch') && has('baseline')
      ? {
          resolve: async (tenant, processCode) => {
            const baseline = lateBaseline.resolve();
            if (baseline === undefined) return null; // 未绑定 = DISPATCH_EMPTY_PRICE_SOURCE 同语义
            try {
              return await baseline.resolve(tenant, processCode);
            } catch (error) {
              if (error instanceof BaselineNotFoundError) return null;
              throw error;
            }
          },
        }
      : undefined;

  // #9 dispatch.inspectionIntake（service 级迟到绑定）
  const inspectionIntake: InspectionIntakePort | undefined =
    has('dispatch') && has('inspection')
      ? {
          receiveSourceFact: (tenant, fact) => {
            const inspection = lateInspection.resolve();
            return inspection === undefined
              ? DISPATCH_NOOP_INSPECTION_INTAKE.receiveSourceFact(tenant, fact)
              : inspection.receiveSourceFact(tenant, fact);
          },
        }
      : undefined;

  // #10 dispatch.print（结构化适配 + sink 注入位：main.ts 注入 integration-print
  // 受理适配；缺省/测试形态 = UNDEPLOYED_PRINT_SINK 拒绝——不伪证打印）
  const print: DispatchPrintPort | undefined = has('dispatch')
    ? createPrintPortAdapter(input.printSink ?? UNDEPLOYED_PRINT_SINK)
    : undefined;

  // #11 listing.workOrderFeed（store 级）
  const workOrderFeed: WorkOrderCreatedFeedPort | undefined =
    has('listing') && has('workorder') && stores.workOrders !== undefined && stores.workOrderEvents !== undefined
      ? new WorkOrderCreatedFeedAdapter(stores.workOrders, stores.workOrderEvents)
      : undefined;

  // #12 listing.materialValidation（service 级迟到绑定）
  const materialValidation: MaterialValidationExecutor | undefined =
    has('listing') && has('baseline')
      ? {
          execute: (tenant: TenantId, envelope: BaselineCommandEnvelope): Promise<CommandOutcome> => {
            const baseline = lateBaseline.resolve();
            return baseline === undefined
              ? LISTING_UNWIRED_MATERIAL_VALIDATION.execute(tenant, envelope)
              : baseline.execute(tenant, envelope);
          },
        }
      : undefined;

  // #13 listing.inventoryPort（service 级迟到绑定；与 #14/#16/#17 共用同一 InventoryService）
  const listingInventoryPort =
    has('listing') && has('inventory')
      ? createInventoryAvailabilityAdapter({
          availableQtyOf: async (tenant, itemIds) => {
            const inventory = lateInventory.resolve();
            return inventory === undefined
              ? new Map<string, number>()
              : inventory.availableQtyOf(tenant, itemIds);
          },
        })
      : undefined;

  // #14 listing.receiptPort（service 级迟到绑定；未绑定回落恒放行缺省语义）
  const receiptPort =
    has('listing') && has('inventory')
      ? createInventoryReceiptAdapter({
          receivePurchaseStock: (tenant, command) => {
            const inventory = lateInventory.resolve();
            return inventory === undefined
              ? Promise.resolve({ received: true })
              : inventory.receivePurchaseStock(tenant, command);
          },
        })
      : undefined;

  // #15 workorder.progressPort（service 级迟到绑定）
  const progressPort =
    has('workorder') && has('dispatch')
      ? createDispatchProgressAdapter({
          progressFacts: (tenant, workOrderId) => {
            const dispatch = lateDispatch.resolve();
            return dispatch === undefined ? Promise.resolve([]) : dispatch.progressFacts(tenant, workOrderId);
          },
        })
      : undefined;

  // #16 workorder.issuePort（service 级迟到绑定；未绑定回落恒放行缺省语义）
  const issuePort: PartsIssuePort | undefined =
    has('workorder') && has('inventory')
      ? createPartsIssueAdapter({
          issuePartsStock: (tenant, command) => {
            const inventory = lateInventory.resolve();
            return inventory === undefined
              ? Promise.resolve({ issued: true })
              : inventory.issuePartsStock(tenant, command);
          },
        })
      : undefined;

  // #17 inspection.stockReleasePort（service 级迟到绑定；未绑定回落 no-op 缺省语义）
  const stockReleasePort: StockReleasePort | undefined =
    has('inspection') && has('inventory')
      ? createStockReleaseRecorder({
          recordInspectionRelease: (tenant, fact) => {
            const inventory = lateInventory.resolve();
            return inventory === undefined
              ? Promise.resolve()
              : inventory.recordInspectionRelease(tenant, fact);
          },
        })
      : undefined;

  // #18 inspection/baseline.notifyChannel（结构化 IM 适配 + sink 注入位：main.ts
  // 注入 integration-im 渠道适配；缺省/无外部配置 = 结构化 console 日志降级）
  const notifyChannel: NotifyChannel | undefined =
    has('inspection') || has('baseline')
      ? createImNotifyChannel(input.imSink ?? CONSOLE_IM_SINK)
      : undefined;

  // Excel 端口（listing 导入导出 + costing/metric-pack/payroll 导出，ExcelJS
  // xlsx-bytes 适配——单实例注入各模块，语义层委托 application 纯函数，见
  // exceljs-excel-port.ts）
  const excel =
    has('listing') || has('costing') || has('payroll') || has('metric-pack')
      ? new ExcelJsExcelPort()
      : undefined;

  // #21 payroll：hours 事实源（store 级：按月聚合净工时 + trade→工种词逆映射，
  // 逆映射表=application hours REPORT_KIND_TO_TRADE 的反函数）+ 导出端口
  // （ExcelJS 同实例结构同形喂 PayrollExportPort）。
  const TRADE_TO_LABOR_KIND = {
    machining: 'part',
    assembly: 'assembly',
    electrical: 'electrical',
    aftercare: 'aftermarket',
    misc: 'oddjob',
  } as const;
  const payrollSource: PayrollSource | undefined =
    has('payroll') && stores.hoursEntries !== undefined
      ? {
          readVerifiedLabor: async ({ tenantId, periodKey, personIds }) => {
            const rows = await stores.hoursEntries!.list(tenantId, { month: periodKey });
            const wanted =
              personIds === undefined ? null : new Set<string>([...personIds]);
            const grouped = new Map<
              string,
              { personId: string; laborKind: string; hours: number; ids: string[] }
            >();
            for (const row of rows) {
              if (wanted !== null && !wanted.has(row.workerId)) continue;
              const laborKind = (TRADE_TO_LABOR_KIND as Record<string, string | undefined>)[
                row.trade
              ];
              if (laborKind === undefined) continue; // hours 侧词表受控，防御性跳过
              const key = `${row.workerId}|${laborKind}`;
              const acc =
                grouped.get(key) ??
                { personId: row.workerId, laborKind, hours: 0, ids: [] as string[] };
              acc.hours += row.direction === 'reverse' ? -row.hours : row.hours;
              acc.ids.push(row.id);
              grouped.set(key, acc);
            }
            const facts: VerifiedLaborFact[] = [];
            for (const acc of grouped.values()) {
              if (acc.hours === 0) continue; // 全冲销净额为零不投递
              facts.push({
                personId: acc.personId as never, // UserId 品牌结构同形（组合根粘合层）
                periodKey,
                laborKind: acc.laborKind as never,
                hours: acc.hours,
                sourceEntryIds: acc.ids,
              });
            }
            return facts;
          },
        }
      : undefined;
  const payrollExportPort: PayrollExportPort | undefined =
    has('payroll') && excel !== undefined
      ? {
          exportWorkbook: async (sheets) =>
            (await excel.exportWorkbook(sheets as never)) as never,
        }
      : undefined;

  // #24 metric-pack：导出端口（ExcelJS 同实例结构同形，#21 先例）；源集按请求
  // 租户解析（main.ts 注入 PG 六源束的租户缓存工厂；零 DB = 不注入 = 空源集）。
  const metricPackExportPort: MetricPackExportPort | undefined =
    has('metric-pack') && excel !== undefined
      ? {
          exportWorkbook: async (sheets) =>
            (await excel.exportWorkbook(sheets as never)) as never,
        }
      : undefined;

  // #22 maintenance.faultLinkage（store 级：baseline 事件扫描 + maintenance
  // 迟到绑定——服务由 MaintenanceHttpModule 构造，bind 后回填）。
  const faultLinkage: MaintenanceFaultLinkagePort | undefined =
    has('maintenance') && has('baseline') && stores.baselineEvents !== undefined
      ? new BaselineFaultLinkageAdapter(stores.baselineEvents, lateMaintenance)
      : undefined;

  // #23 drawing.workOrderDrawingRefs（store 级：workorder 附件钉版编码解析）。
  const workOrderDrawingRefs: WorkOrderDrawingRefsPort | undefined =
    has('drawing') && has('workorder') && stores.workOrderAttachments !== undefined
      ? new WorkOrderAttachmentDrawingRefsAdapter(stores.workOrderAttachments)
      : undefined;

  // #19 baseline.workOrderDrawingSource（store 级）
  const workOrderDrawingSource: WorkOrderDrawingSource | undefined =
    has('baseline') && has('workorder') && stores.workOrders !== undefined && stores.workOrderAttachments !== undefined
      ? {
          listDrawingCounts: async (tenant) => {
            const facts: { readonly workOrderId: string; readonly drawingCount: number }[] = [];
            for (const order of await stores.workOrders!.list(tenant)) {
              const attachments = await stores.workOrderAttachments!.listByWorkOrder(
                tenant,
                WorkOrderId.create(order.id),
              );
              facts.push({
                workOrderId: order.id,
                drawingCount: attachments.filter((attachment) => attachment.kind === 'drawing').length,
              });
            }
            return facts;
          },
        }
      : undefined;

  // hours.ingest 联动触发（#2 的实时触发面；envelope 构造同 hours 控制器口径）
  const hoursIngestTrigger =
    has('hours') && has('reporting')
      ? async (tenant: TenantId, actor: UserId): Promise<void> => {
          const hours = lateHours.resolve();
          if (hours === undefined) return;
          const envelope = makeCommandEnvelope<{ kind: 'hours.ingest.v1'; payload: Record<string, never> }>({
            tenantId: tenant,
            issuedBy: actor,
            operationId: OperationId.create(`wiring-hours-ingest-${randomUUID()}`),
            expectedRevision: 'initial',
            issuedAt: new Date().toISOString(),
            command: { kind: 'hours.ingest.v1', payload: {} },
          });
          await hours.execute(tenant, envelope);
        }
      : undefined;

  return {
    register: {
      ...(progressPort !== undefined || issuePort !== undefined
        ? {
            workorder: {
              ...(progressPort !== undefined ? { progressPort } : {}),
              ...(issuePort !== undefined ? { issuePort } : {}),
            },
          }
        : {}),
      ...(workOrderFeed !== undefined ||
      listingInventoryPort !== undefined ||
      receiptPort !== undefined ||
      materialValidation !== undefined ||
      (has('listing') && excel !== undefined)
        ? {
            listing: {
              ...(workOrderFeed !== undefined ? { workOrderFeed } : {}),
              ...(listingInventoryPort !== undefined ? { inventoryPort: listingInventoryPort } : {}),
              ...(receiptPort !== undefined ? { receiptPort } : {}),
              ...(materialValidation !== undefined ? { materialValidation } : {}),
              ...(has('listing') && excel !== undefined ? { excelPort: excel } : {}),
            },
          }
        : {}),
      ...(kitCheck !== undefined || priceSource !== undefined || inspectionIntake !== undefined || print !== undefined
        ? {
            dispatch: {
              ...(kitCheck !== undefined ? { kitCheck } : {}),
              ...(priceSource !== undefined ? { priceSource } : {}),
              ...(inspectionIntake !== undefined ? { inspectionIntake } : {}),
              ...(print !== undefined ? { print } : {}),
            },
          }
        : {}),
      ...(validDispatch !== undefined ? { reporting: { validDispatch } } : {}),
      ...(reportFeed !== undefined ? { hours: { reportFeed } } : {}),
      ...(payrollSource !== undefined || payrollExportPort !== undefined
        ? {
            payroll: {
              ...(payrollSource !== undefined ? { source: payrollSource } : {}),
              ...(payrollExportPort !== undefined ? { exportPort: payrollExportPort } : {}),
            },
          }
        : {}),
      ...(faultLinkage !== undefined ? { maintenance: { faultLinkage } } : {}),
      ...(workOrderDrawingRefs !== undefined ? { drawing: { workOrderDrawingRefs } } : {}),
      ...(input.metricPackSourceSetFor !== undefined || metricPackExportPort !== undefined
        ? {
            'metric-pack': {
              ...(input.metricPackSourceSetFor !== undefined
                ? { sourceSetFor: input.metricPackSourceSetFor }
                : {}),
              ...(metricPackExportPort !== undefined ? { exportPort: metricPackExportPort } : {}),
            },
          }
        : {}),
      ...(materialSource !== undefined ||
      laborSource !== undefined ||
      outsourcingSource !== undefined ||
      workOrderSubject !== undefined ||
      (has('costing') && excel !== undefined)
        ? {
            costing: {
              ...(materialSource !== undefined ? { materialSource } : {}),
              ...(laborSource !== undefined ? { laborSource } : {}),
              ...(outsourcingSource !== undefined ? { outsourcingSource } : {}),
              ...(workOrderSubject !== undefined ? { workOrderSubject } : {}),
              ...(has('costing') && excel !== undefined ? { excelPort: excel } : {}),
            },
          }
        : {}),
      ...(stockReleasePort !== undefined || (has('inspection') && notifyChannel !== undefined)
        ? {
            inspection: {
              ...(stockReleasePort !== undefined ? { stockReleasePort } : {}),
              ...(has('inspection') && notifyChannel !== undefined ? { notifyChannel } : {}),
            },
          }
        : {}),
      ...(workOrderDrawingSource !== undefined || (has('baseline') && notifyChannel !== undefined)
        ? {
            baseline: {
              ...(has('baseline') && notifyChannel !== undefined ? { notifyChannel } : {}),
              ...(workOrderDrawingSource !== undefined ? { workOrderDrawingSource } : {}),
            },
          }
        : {}),
    },
    bind(app: INestApplicationContext): void {
      const resolveOptional = <T>(token: Type<T>): T | undefined => {
        try {
          return app.get(token, { strict: false });
        } catch {
          return undefined; // 模块未装配或实例缺失——保持迟到绑定回落语义
        }
      };
      if (has('inventory')) {
        const inventory = resolveOptional(InventoryService);
        if (inventory !== undefined) lateInventory.bind(inventory);
      }
      if (has('dispatch')) {
        const dispatch = resolveOptional(DispatchService);
        if (dispatch !== undefined) lateDispatch.bind(dispatch);
      }
      if (has('baseline')) {
        const baseline = resolveOptional(BaselineService);
        if (baseline !== undefined) lateBaseline.bind(baseline);
      }
      if (has('inspection')) {
        const inspection = resolveOptional(InspectionService);
        if (inspection !== undefined) lateInspection.bind(inspection);
      }
      if (has('hours')) {
        const hours = resolveOptional(HoursService);
        if (hours !== undefined) lateHours.bind(hours);
      }
      if (has('maintenance')) {
        const maintenance = resolveOptional(MaintenanceService);
        if (maintenance !== undefined) lateMaintenance.bind(maintenance);
      }
    },
    hoursIngestTrigger,
  };
}

/** 组合根构造后接线入口：main/tests 在 NestFactory.create 后调用（幂等）。 */
export function bindCrossModuleWiring(app: INestApplicationContext): void {
  const wiring = app.get<CrossModuleWiring>(CROSS_MODULE_WIRING, { strict: false });
  wiring.bind(app);
}
