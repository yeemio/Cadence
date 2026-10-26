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
 *
 * S3-e（workorder 齐套判定输入接线——S3-b e2e 发现的组合根缺口：注册表
 * workorder 只注 #15/#16，齐套刷新按模块缺省"零行全齐套"）：
 * 25. workorder.listingPort ← listing 清单需求行投影
 *     机制：service 级迟到绑定——createListingRequirementAdapter(
 *     ListingService.requirementLines)（仅 itemId 已解析行；装备类不入齐套
 *     范围由 workorder 侧 kitScopeKinds 过滤，口径在消费方）。
 * 26. workorder.inventoryPort ← inventory 可用量
 *     机制：service 级迟到绑定——createInventoryAvailabilityAdapter(
 *     InventoryService.availableQtyOf)（跨仓 Σ max(0, 总量−预占) 恒等式口径；
 *     与 #13 listing 可用量共用同一迟到绑定的 InventoryService）。
 *     接线效果：workorder.kit.refresh.v1 的快照由真实需求行 × 可用量驱动
 * （缺口 → complete=false → dispatch 齐套拦截真实生效）；未接线形态的
 * 模块缺省（零行全齐套）语义不变——单模块装配/测试不受影响。
 *
 * T1 能力子集（#101 通知中心的业务事件发布钩子）：
 * 27. notifications.inbox ← 共享 TodoStore 创建面（待办/审批/派修/点名全量）
 *     机制：store 级装饰——createTodoNotifyingStore(共享 TodoStore,
 *     NotificationStore)。组合根在 sharedTodoStore 裁决点包一层：每次待办
 *     创建同发一条站内通知（recipient=assignee、source=todo.source、
 *     refType/refId 透传；body=null——短通知只投标题）。发布失败不回滚业务
 *     命令（catch + console.warn 留痕——通知是投影视图，事实源在各业务域
 *     事件账本，见 notifications-stores.ts 文件头分工）。0920 #101 原文口径
 *     "将待办、审批等业务消息推送至站内消息"：approval/workorder/listing/
 *     inspection/dispatch/baseline 七方待办联动全部经此一点进收件箱，
 *     不逐模块加钩子。notifications 模块未装配 = 不包（零行为变化）。
 *
 * U6 接线波（issue/attachment/aftercare-claim 三模块进组合根 + 四端口适配）：
 * 28. issue.material ← inventory 库存/预占联动（IssueMaterialPort）
 *     机制：service+store 混级——读面 InventoryService.availableQtyOf（迟到
 *     绑定）+ 预占/流水/域事件三个 store 级共享实例（app-registry 裁决同源）；
 *     写面经 InventoryService.execute stock.issue.v1（库位分配逐行子命令，
 *     子键 `<issueKey>@<i>r|@<i>a` 承载 sourceKey 幂等）；撤销 = 逐子流水
 *     stock.receive.v1(kind=production) 原路回补 + StockIssued 事件载荷恢复
 *     预占（restoreKey 确定性幂等）。预占锚点取舍见适配器头注（itemId 粒度，
 *     清单行粒度未加维——粒度待定项归对账阶段）。
 * 29. dispatch→issue 派工生成钩子（IssueSyncPort.syncFromDispatch）
 *     机制：store 级装饰——DispatchOrderStore.advance→'assigned' 且
 *     kind∈{assembly,electrical} 且挂工作令时触发（#27 待办桥同体例单点包一层，
 *     不动 dispatch 源码）。assembly 走 rollup=true 整线归拢（dispatch 单面无
 *     设备选择维，归拢是唯一可解析模式）；electrical 须 equipmentRefs（组合根
 *     无解析源——demand 行源本波为空实现）不触发，显式同步面 POST
 *     /issue/tasks/sync 兜底。通知式合同：派工已提交，同步失败仅 console.warn
 *     不回滚派工。W3-2 扩展：advance→'cancelled'（撤销派工）且 kind=assembly
 *     且挂工作令时同装饰器触发 issue.cleanup.v1 清理发料任务（目标任务集按
 *     issue 现存任务推导，确定性 operationId 幂等，清理被拒/异常 console.warn
 *     不回滚撤销——机制与取舍见 createIssueSyncDispatchStore 头注）。
 * 30. aftercare-claim.reportPort ← reporting 审批通过报工读
 *     机制：service 级迟到绑定——createAftercareReportPort(ReportingService
 *     .listReports)（投影 application 已备，此处只粘迟到引用）。
 * NotificationSourcePort（点名/派修）裁决：组合根直投不可行——NotifyChannel
 *     消息无 recipient 面；两事件点（inspection 闭环超时点名 / baseline 故障
 *     派修）均建待办，收件箱投递经 #27 待办桥完成（收件人 = 事件点侧经办人，
 *     正确同源）。站内通知不加第二投递（避免与桥重复行）——本波接线不缺口。
 *
 * U7 接线波（costing 项目成本六块三源适配，A5）：
 * 31. costing.projectIssueSource ← issue 发料记录段事实（②材料两段/原材料段 +
 *     ⑥设备利库段数量）
 *     机制：store 级——IssueRecordStore.list(state=active) 明细快照按行拆段：
 *     part 利库段=reservedConsumedQty（金额归 costing 录入价格表，端口行金额
 *     null）、采购段=max(0,thisQty−reserved)×本令 PO 加权价、原材料段=工序×
 *     原材料关联行（尺寸×件数×单价×净发料）；std/elec 两段=Σ allocations 的
 *     reserved/available 回执（合同 U7 两段拆分口径）；equipment 利库段=
 *     useInventoryConsumedQty。无价段金额 null（跑批不计、remark 留痕）。
 * 32. costing.projectEquipmentSource ← listing 外购设备采购行（⑥采购段）
 *     机制：store 级——PO 行 × equipment 清单行按 itemId/drawingNo 匹配；金额
 *     = receivedQty × unitPriceMinor（listing 既定金额汇总口径；未收货/未价=0
 *     不计）。
 * 33. costing.projectAftercareSource ← dispatch 售后报销（⑤报销段）
 *     机制：store 级——DispatchOrderStore.list(kind=aftermarket, workOrder) ×
 *     AftercareClaimStore.findByDispatch（四费合计 aftercareClaimTotalMinor；
 *     无工作令归属的售后单不入项目成本——口径差异登记）。
 *     ④/⑤ 工时段与 ③ 外协段复用 #3/#4 既有源；录入价格写回端口缺省 NOOP
 *     （issue 源码冻结，写回交互归后续波裁定）。
 *
 * fix-wave-3 W3-1（两路质检来源触发组合根接线——17 册 PRD §8 开放问题①：
 * 域层接收面已实现有测试，组合根此前未接线，线上组合为 no-op 缺省）：
 * 34. reporting.operationValidity ← baseline 工序合法性
 *     机制：service 级迟到绑定——BaselineService.getProcess；未绑定回落
 *     ALL_OPERATIONS_VALID 同构（恒合法）；绑定后当前版生效（active）→true，
 *     NotFound→false（接线后未知工序 submit rejected 是设计语义——fail-closed 复检）。
 * 35. reporting.finalOperation ← baseline 工艺路线末道判定
 *     机制：service 级迟到绑定——BaselineService.getRouting(drawingNo) 取
 *     current.steps 的 max-seq 步 processCode 比对；未绑定回落
 *     NEVER_FINAL_OPERATION 同构，NotFound/无路线→false（恒非末道，不抛）。
 *     末道=max seq（PRD 17 §7 第 10 条：与源"sort_order 最大"同构）。
 * 36. reporting.inspectionIntake ← inspection 末道报工触发（RQ-017）
 *     机制：service 级迟到绑定——InspectionService.receiveSourceFact（#9 同体例；
 *     未绑定回落 REPORTING_NOOP_INSPECTION_INTAKE 同构）。
 * 37. listing.inspectionIntake ← inspection 收货触发三类采购质检（RQ-019）
 *     机制：service 级迟到绑定——InspectionService.receiveSourceFact（#9 同体例；
 *     未绑定回落 LISTING_NOOP_INSPECTION_INTAKE 同构——事实不落地不报错）。
 *     kind 由 listing 收货侧经申请链推导后显式携带（PRD 14 §6）。
 *
 * 技术欠账清偿（HANDOFF §6 "IssueMaterialPort.reserveStock 无创建方（核销空集）"
 * 精确化：U6 #28 已接发料核销/回滚，预占**创建**面缺调用方）：
 * 38. listing.useReservationPort ← inventory 利库预占（gap.check 确认→预占创建）
 *     机制：service+store 混级——写面 InventoryService.reserveStock（迟到绑定；
 *     refType 'issue' 订单级锚立锚，键 = issue-rsv 约定追加 :g:<gapCheckId>:wh:<仓>
 *     段——核查批次唯一不复用键（consumed 键不复用约束），锚点归并消费同 #28）；
 *     跨仓可用拆分经 InventoryService.stockLevels（per-仓 availableQty 顺序
 *     分配，仓库 id 升序确定性）；读面 StockReservationStore 共享实例按锚点汇
 *     活跃预占（供给基数自有部分 + 写时折差收敛）。目标量 = min(Σ需求, 跨仓
 *     可用+本令预占)（listing 侧算）；拒绝则 gap.check 整单 rejected 不落任何
 *     账（端口先行，体例同 #14）。equipment 类目不入（外购设备四数量不走
 *     预占账，PRD 17 RREQ-RQ-042 ④）。
 */
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { ExcelJsExcelPort } from './exceljs-excel-port.js';
import type { PayrollExportPort, PayrollSource, VerifiedLaborFact } from '@smes/payroll';
import { MaintenanceService, type FaultTaskSuggestion } from '@smes/maintenance';
import type { DrawingRefInput } from '@smes/drawing';
import type { MetricPackExportPort, MetricSourceSet } from '@smes/metric-pack';
import {
  ALL_OPERATIONS_VALID,
  BASELINE_EVENT_TYPES,
  BaselineNotFoundError,
  BaselineService,
  createAftercareReportPort,
  createDispatchProgressAdapter,
  createHoursCostSource,
  createInventoryAvailabilityAdapter,
  createInventoryReceiptAdapter,
  createListingRequirementAdapter,
  createPartsIssueAdapter,
  createStockReleaseRecorder,
  DISPATCH_NOOP_INSPECTION_INTAKE,
  DispatchService,
  HoursService,
  INVENTORY_EVENT_TYPES,
  InspectionService,
  InventoryService,
  IssueService,
  LISTING_UNWIRED_MATERIAL_VALIDATION,
  ListingService,
  minutesToHours,
  NEVER_FINAL_OPERATION,
  ReportingService,
  REPORTING_NOOP_INSPECTION_INTAKE,
  STOCK_MOVEMENT_AGGREGATE_TYPE,
  aftercareClaimTotalMinor,
  type AftercareApprovedReportPort,
  type FinalOperationJudgePort,
  type InventoryAvailabilityPort,
  type OperationValidityPort,
  type InventoryCommand,
  type InventoryDomainEventStore,
  type AftercareClaimStore,
  type IssueCommand,
  type IssueMaterialPort,
  type IssueRecordStore,
  type IssueStockAllocationReceipt,
  type IssueSyncTrigger,
  type InventoryUseReservationPort,
  type ListingLineStore,
  type ListingRequirementPort,
  type StockReservationStore,
  type ProcessMaterialLinkStore,
  type ProjectAftercareClaimSourcePort,
  type ProjectAftercareClaimLine,
  type ProjectEquipmentPurchaseSourcePort,
  type ProjectEquipmentPurchaseLine,
  type ProjectIssueCostSourcePort,
  type ProjectIssueSegmentLine,
  REPORT_EVENT_TYPES,
  WORKORDER_EVENT_TYPES,
  WORK_ORDER_AGGREGATE_TYPE,
  WORK_REPORT_AGGREGATE_TYPE,
  toDispatchFactForReport,
  toKitCheckFact,
  type BaselineCommandEnvelope,
  type BaselineEventStore,
  type CostingExcelPort,
  type DispatchDomainEventStore,
  type DispatchExcelPort,
  type DispatchOperationStore,
  type DispatchOrderStore,
  type DispatchPrintPort,
  type ExcelPort,
  type InspectionIntakePort,
  type IssueStockCommand,
  type IssueStockReceipt,
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
  type ProcessMaterialLink,
  type PurchaseOrder,
  type PurchaseOrderStore,
  type ReportDomainEventStore,
  type ReportEventFeedPort,
  type ReportEventMessage,
  type LaborEntryStore,
  type StockMovementStore,
  type StockMovement,
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
  type NotificationStore,
  type TodoItem,
  type TodoStore,
} from '@smes/application';
import {
  makeCommandEnvelope,
  OperationId,
  UserId,
  WorkOrderId,
  type BusinessEvent,
  type CommandEnvelope,
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
  /** dispatch 命令幂等记账（U6 #29/#30：aftercare-claim 与 DispatchModule 共享同源）。 */
  readonly dispatchOperations?: DispatchOperationStore | undefined;
  /** dispatch 域事件（U6：aftercare-claim 与 DispatchModule 共享同源）。 */
  readonly dispatchDomainEvents?: DispatchDomainEventStore | undefined;
  /** inventory 预占（U6 #28：issue.material 适配器读面，与 InventoryModule 同源）。 */
  readonly inventoryReservations?: StockReservationStore | undefined;
  /** inventory 域事件（U6 #28：issue.material 撤销恢复预占的事实源）。 */
  readonly inventoryDomainEvents?: InventoryDomainEventStore | undefined;
  /** issue 发料记录投影（U7 #31：projectIssueSource 段事实源）。 */
  readonly issueRecords?: IssueRecordStore | undefined;
  /** listing 清单行投影（U7 #31/#32：原材料关联锚 + 设备采购匹配面）。 */
  readonly listingLines?: ListingLineStore | undefined;
  /** listing 工序×原材料关联（U7 #31：②原材料段尺寸/单价快照源）。 */
  readonly processMaterialLinks?: ProcessMaterialLinkStore | undefined;
  /** dispatch 售后报销投影（U7 #33：projectAftercareSource 四费事实源）。 */
  readonly aftercareClaims?: AftercareClaimStore | undefined;
}

/** 各模块 register 的跨模块端口注入面（形状与 *ModuleOptions 对应字段同构）。 */
export interface CrossModuleRegisterPorts {
  readonly workorder?: {
    /** listing 需求行（齐套判定需求侧，#25）；缺省回落模块空实现（零行全齐套）。 */
    readonly listingPort?: ListingRequirementPort | undefined;
    /** inventory 可用量（齐套判定供给侧，#26）；缺省回落模块空实现。 */
    readonly inventoryPort?: InventoryAvailabilityPort | undefined;
    readonly progressPort?: Parameters<typeof createDispatchProgressAdapter>[0] | undefined;
    readonly issuePort?: PartsIssuePort | undefined;
  };
  readonly listing?: {
    readonly workOrderFeed?: WorkOrderCreatedFeedPort | undefined;
    readonly inventoryPort?: ReturnType<typeof createInventoryAvailabilityAdapter> | undefined;
    readonly receiptPort?: ReturnType<typeof createInventoryReceiptAdapter> | undefined;
    /** #38：inventory 利库预占（gap.check 确认→预占创建）；缺省回落模块 NOOP。 */
    readonly useReservationPort?: InventoryUseReservationPort | undefined;
    readonly materialValidation?: MaterialValidationExecutor | undefined;
    /** Excel 导入导出（xlsx-bytes ↔ 结构化表，ExcelJS 适配器——本 wiring 构造）。 */
    readonly excelPort?: ExcelPort | undefined;
    /** fix-wave-3 W3-1 #37：inspection 收货触发三类采购质检；缺省回落模块 noop。 */
    readonly inspectionIntake?: InspectionIntakePort | undefined;
  };
  readonly dispatch?: {
    readonly kitCheck?: KitCheckReadPort | undefined;
    readonly priceSource?: OutsourcingPriceSource | undefined;
    readonly inspectionIntake?: InspectionIntakePort | undefined;
    readonly print?: DispatchPrintPort | undefined;
    /** 派工单 Excel 导出（6a-1 RREQ-DP-026）：ExcelJS 单实例结构同形（#20 先例）。 */
    readonly excelPort?: DispatchExcelPort | undefined;
  };
  readonly reporting?: {
    readonly validDispatch?: ValidDispatchSource | undefined;
    /** fix-wave-3 W3-1 #34：baseline 工序合法性复检；缺省回落模块恒合法。 */
    readonly operationValidity?: OperationValidityPort | undefined;
    /** fix-wave-3 W3-1 #35：baseline 工艺路线末道判定；缺省回落模块恒非末道。 */
    readonly finalOperation?: FinalOperationJudgePort | undefined;
    /** fix-wave-3 W3-1 #36：inspection 末道报工触发；缺省回落模块 noop。 */
    readonly inspectionIntake?: InspectionIntakePort | undefined;
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
    /** U7 #31：issue 发料行段事实（②材料两段/原材料段 + ⑥设备利库段）。 */
    readonly projectIssueSource?: ProjectIssueCostSourcePort | undefined;
    /** U7 #32：listing 外购设备采购行（⑥采购段）。 */
    readonly projectEquipmentSource?: ProjectEquipmentPurchaseSourcePort | undefined;
    /** U7 #33：dispatch 售后报销（⑤报销段）。 */
    readonly projectAftercareSource?: ProjectAftercareClaimSourcePort | undefined;
  };
  readonly inspection?: {
    readonly stockReleasePort?: StockReleasePort | undefined;
    readonly notifyChannel?: NotifyChannel | undefined;
  };
  readonly baseline?: {
    readonly notifyChannel?: NotifyChannel | undefined;
    readonly workOrderDrawingSource?: WorkOrderDrawingSource | undefined;
  };
  /** U6 #28：issue 库存/预占联动（inventory 侧实现；缺省回落模块 NOOP）。 */
  readonly issue?: {
    readonly material?: IssueMaterialPort | undefined;
  } | undefined;
  /** U6 #30：aftercare-claim 审批通过报工读（reporting 侧实现；缺省 fail-closed）。 */
  readonly 'aftercare-claim'?: {
    readonly reportPort?: AftercareApprovedReportPort | undefined;
  } | undefined;
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

// ---- U7 #31~#33：costing 项目成本六块源适配器（组合根装配） ----

/**
 * 本工作令 PO 加权含税单价（分；U7 #31/#32 单价口径）：itemId 与 drawingNo 两键
 * 各建一张——Σ(订购量×单价)/Σ订购量 四舍五入，仅计已定价行（文档「多张 PO 按
 * 订单采购数量加权平均；单价为空该笔暂不计」的 Cadence 重述）。
 */
function weightedPoPrices(
  orders: readonly PurchaseOrder[],
): { readonly byItemId: ReadonlyMap<string, number>; readonly byDrawingNo: ReadonlyMap<string, number> } {
  const accItemId = new Map<string, { qty: number; amount: number }>();
  const accDrawingNo = new Map<string, { qty: number; amount: number }>();
  for (const order of orders) {
    for (const line of order.lines) {
      if (line.unitPriceMinor === null) continue; // 未定价行不计入加权
      const item = accItemId.get(line.itemId) ?? { qty: 0, amount: 0 };
      item.qty += line.quantity;
      item.amount += line.quantity * line.unitPriceMinor;
      accItemId.set(line.itemId, item);
      if (line.drawingNo !== null) {
        const drawing = accDrawingNo.get(line.drawingNo) ?? { qty: 0, amount: 0 };
        drawing.qty += line.quantity;
        drawing.amount += line.quantity * line.unitPriceMinor;
        accDrawingNo.set(line.drawingNo, drawing);
      }
    }
  }
  const byItemId = new Map<string, number>();
  for (const [key, acc] of accItemId) byItemId.set(key, Math.round(acc.amount / acc.qty));
  const byDrawingNo = new Map<string, number>();
  for (const [key, acc] of accDrawingNo) byDrawingNo.set(key, Math.round(acc.amount / acc.qty));
  return { byItemId, byDrawingNo };
}

/**
 * ②原材料段金额（分）：Σ 关联行（尺寸换算量 × 件数 × 录入单价 × 自制净发料）。
 * 尺寸换算量（U4 关联行快照）：length=长/1000(m)；长宽厚=(L/1000)(W/1000)(H/1000)(m³)；
 * area=面积值(m²)。无价行不计（文档「某一行无单价则该行不计入，其余行仍计」）。
 */
function rawMaterialAmountMinor(links: readonly ProcessMaterialLink[], netIssueQty: number): number | null {
  if (links.length === 0) return null; // 无关联行：该图号不可计原材料成本
  let total = 0;
  let computed = false;
  for (const link of links) {
    if (link.unitPriceMinor === null) continue; // 无价行不计
    const size =
      link.cutSizeForm === 'length'
        ? link.partLength / 1000
        : link.cutSizeForm === 'length-width-height'
          ? (link.partLength / 1000) * ((link.partWidth ?? 0) / 1000) * ((link.partHeight ?? 0) / 1000)
          : link.partLength; // area：m² 原值
    if (!(size > 0)) continue; // 尺寸无效不计
    total += Math.round(link.unitPriceMinor * size * link.quantity * netIssueQty);
    computed = true;
  }
  return computed ? total : null; // 全部行不可计 → null（该段不计）
}

/**
 * #31 issue 发料行段适配器（store 级）：IssueRecordStore 明细快照按行拆段——
 * 两段拆分以回执快照为据（合同 U7 裁定）：part 利库段=reservedConsumedQty
 * （金额归 costing 录入价格表，端口行金额 null）、采购段/原材料段基数=max(0,
 * thisQty−reservedConsumedQty)；std/elec 两段=Σ allocations reserved/available；
 * equipment 利库段=useInventoryConsumedQty。撤销记录（revoked）按**清零行**
 * 投影（该锚点当前净贡献 = 0——已发累计退出口径；costing 侧经 delta 冲销条目
 * 对齐净额到零，文档 §1.2.1「净数量 = 已发 − 撤销回冲」）。
 */
function createProjectIssueSource(stores: {
  readonly issueRecords: IssueRecordStore;
  readonly purchaseOrders: PurchaseOrderStore | undefined;
  readonly processMaterialLinks: ProcessMaterialLinkStore | undefined;
}): ProjectIssueCostSourcePort {
  return {
    issueSegments: async (tenant, workOrderId): Promise<readonly ProjectIssueSegmentLine[]> => {
      const records = await stores.issueRecords.list(tenant, { workOrderId }); // active + revoked（清零行）
      const orders = stores.purchaseOrders === undefined ? [] : await stores.purchaseOrders.list(tenant, { workOrderId });
      const prices = weightedPoPrices(orders);
      const priceOf = (itemId: string | null, drawingNo: string | null): number | null => {
        if (drawingNo !== null) {
          const byDrawing = prices.byDrawingNo.get(drawingNo);
          if (byDrawing !== undefined) return byDrawing;
        }
        if (itemId !== null) return prices.byItemId.get(itemId) ?? null;
        return null;
      };
      const lines: ProjectIssueSegmentLine[] = [];
      for (const record of [...records].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))) {
        const revoked = record.state === 'revoked'; // 撤销锚点：清零行（净贡献 0，delta 对齐用）
        for (const line of record.lines) {
          const base = {
            recordId: record.id,
            taskLineId: line.taskLineId,
            workOrderId,
            sourceLineId: line.sourceLineId,
            itemId: line.itemId,
            drawingNo: line.drawingNo,
            equipmentRef: record.equipmentRef,
            issuedAt: record.issuedAt,
          };
          const emit = (
            segment: 'reserved' | 'purchase' | 'raw',
            kind: ProjectIssueSegmentLine['kind'],
            quantity: number,
            amountMinor: number | null,
          ): void => {
            if (revoked) {
              lines.push({ ...base, kind, segment, quantity: 0, amountMinor: 0 });
              return;
            }
            if (quantity === 0) return;
            lines.push({ ...base, kind, segment, quantity, amountMinor });
          };
          if (line.kind === 'part') {
            const reservedQty = line.reservedConsumedQty;
            const netQty = Math.max(0, line.thisQty - reservedQty);
            if (reservedQty !== 0) emit('reserved', 'part', reservedQty, null);
            if (netQty > 0) {
              const price = priceOf(line.itemId, line.drawingNo);
              emit('purchase', 'part', netQty, price === null ? null : Math.round(netQty * price));
              if (stores.processMaterialLinks !== undefined && line.sourceLineId !== null) {
                const links = await stores.processMaterialLinks.listByLine(tenant, line.sourceLineId);
                const rawAmount = rawMaterialAmountMinor(links, netQty);
                if (rawAmount !== null) emit('raw', 'part', netQty, rawAmount);
              }
            }
            continue;
          }
          if (line.kind === 'standard' || line.kind === 'electrical') {
            const reservedQty = line.allocations.reduce((sum, alloc) => sum + alloc.reservedConsumedQty, 0);
            const availableQty = line.allocations.reduce((sum, alloc) => sum + alloc.availableConsumedQty, 0);
            if (reservedQty > 0) {
              const price = priceOf(line.itemId, line.drawingNo);
              emit('reserved', line.kind, reservedQty, price === null ? null : Math.round(reservedQty * price));
            }
            if (availableQty > 0) {
              const price = priceOf(line.itemId, line.drawingNo);
              emit('purchase', line.kind, availableQty, price === null ? null : Math.round(availableQty * price));
            }
            continue;
          }
          if (line.kind === 'equipment' && line.useInventoryConsumedQty > 0) {
            emit('reserved', 'equipment', line.useInventoryConsumedQty, null);
          }
        }
      }
      return lines;
    },
  };
}

/**
 * #32 外购设备采购行适配器（store 级）：PO 行 × equipment 清单行按 itemId/
 * drawingNo 匹配；金额 = receivedQty × unitPriceMinor（listing 既定金额汇总口径
 * ——文档「申请子行 Σ amount」的 Cadence 对应面；未收货/未价 = 0 不计）。
 */
function createProjectEquipmentSource(stores: {
  readonly purchaseOrders: PurchaseOrderStore | undefined;
  readonly listingLines: ListingLineStore | undefined;
}): ProjectEquipmentPurchaseSourcePort {
  return {
    equipmentPurchases: async (tenant, workOrderId): Promise<readonly ProjectEquipmentPurchaseLine[]> => {
      if (stores.purchaseOrders === undefined) return [];
      const orders = await stores.purchaseOrders.list(tenant, { workOrderId });
      const equipmentLines =
        stores.listingLines === undefined
          ? []
          : (await stores.listingLines.listByWorkOrder(tenant, workOrderId)).filter((line) => line.kind === 'equipment');
      const byItemId = new Map(equipmentLines.filter((line) => line.itemId !== null).map((line) => [line.itemId!, line]));
      const byDrawingNo = new Map(equipmentLines.filter((line) => line.drawingNo !== null).map((line) => [line.drawingNo!, line]));
      const lines: ProjectEquipmentPurchaseLine[] = [];
      for (const order of orders) {
        for (const line of order.lines) {
          const matched =
            (line.drawingNo !== null ? byDrawingNo.get(line.drawingNo) : undefined) ??
            (line.itemId !== null ? byItemId.get(line.itemId) : undefined);
          const amount =
            line.unitPriceMinor === null || line.receivedQty <= 0
              ? 0
              : Math.round(line.receivedQty * line.unitPriceMinor);
          lines.push({
            purchaseOrderId: order.id,
            lineNo: line.lineNo,
            workOrderId,
            itemId: line.itemId,
            drawingNo: line.drawingNo,
            quantity: line.quantity,
            receivedQty: line.receivedQty,
            unitPriceMinor: line.unitPriceMinor,
            amountMinor: amount,
            equipmentListingLineId: matched?.id ?? null,
            equipmentRef: null, // Cadence equipment 清单行无设备维面（口径差异登记）
          });
        }
      }
      return lines.sort((a, b) => a.purchaseOrderId.localeCompare(b.purchaseOrderId) || a.lineNo - b.lineNo);
    },
  };
}

/**
 * #33 售后报销适配器（store 级）：aftermarket 派工单 × 报销单联查——四费合计
 * （aftercareClaimTotalMinor）；工作令归属取派工单 workOrderId（无归属单不入
 * 项目成本，口径差异登记）。
 */
function createProjectAftercareSource(stores: {
  readonly dispatchOrders: DispatchOrderStore;
  readonly aftercareClaims: AftercareClaimStore;
}): ProjectAftercareClaimSourcePort {
  return {
    aftercareClaims: async (tenant, workOrderId): Promise<readonly ProjectAftercareClaimLine[]> => {
      const orders = await stores.dispatchOrders.list(tenant, { kind: 'aftermarket', workOrderId });
      const lines: ProjectAftercareClaimLine[] = [];
      for (const order of orders) {
        const claim = await stores.aftercareClaims.findByDispatch(tenant, order.id);
        if (claim === null) continue; // 未填报报销不计
        lines.push({
          claimId: claim.id,
          dispatchId: claim.dispatchId,
          workOrderId,
          reimburseMinor: aftercareClaimTotalMinor(claim),
          filedAt: claim.updatedAt,
        });
      }
      return lines.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
    },
  };
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

/**
 * 待办 → 站内通知桥（T1 #101 接线清单 #27）：装饰共享 TodoStore 的创建面——
 * 每次待办创建同发一条收件箱通知（recipient=assignee、source=todo.source、
 * refType/refId 透传）。通知式合同：发布失败不回滚待办创建（catch + warn），
 * 待办本体先行返回。
 */
export function createTodoNotifyingStore(
  todoStore: TodoStore,
  notifications: NotificationStore,
): TodoStore {
  return {
    create: async (input) => {
      const todo: TodoItem = await todoStore.create(input);
      try {
        await notifications.create({
          tenant: input.tenant,
          recipient: input.assignee,
          title: input.title,
          body: null,
          source: input.source,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
        });
      } catch (error) {
        console.warn(
          '[smes] 待办→通知投递失败（通知式合同，不阻塞待办创建）:',
          error instanceof Error ? error.message : String(error),
        );
      }
      return todo;
    },
    listOwn: (tenant, assignee) => todoStore.listOwn(tenant, assignee),
    findOwn: (tenant, assignee, id) => todoStore.findOwn(tenant, assignee, id),
    complete: (tenant, assignee, id) => todoStore.complete(tenant, assignee, id),
  };
}

// ---- U6 #28/#29：issue 库存/预占联动 + 派工触发生成（组合根适配器） ----

/**
 * issue 锚预占键约定（U6 #28）：`issue-rsv:v1:<enc(workOrderId)>:<enc(equipmentRef)>:<enc(itemId)>`
 * （enc=encodeURIComponent——产出必无 ':'，段界安全）。锚粒度取舍（U1 验收
 * "itemId vs 清单行"复核点）：按（工作令, 设备, 物料）三段锚定——与
 * IssueMaterialPort.reservedQtyOf 查询面同粒度；**清单行粒度不加维**（四数量
 * 消费面全部按 equipment+item 收口，无行粒度消费者；预占粒度待定项归对账
 * 阶段，m2 草案 07-inventory §"预占的粒度"）。equipmentRef 空串 = 订单级锚
 * （standard/electrical 确认发料的可核销集）；非空 = 设备级锚（equipment 行
 * 四数量只读面，本端口不核销）。撤销恢复键追加 `:rb:<enc(subKey)>` 段——
 * 解析归并为原锚（同 workOrder/equipment/item 维度）。
 *
 * 追加段约定（#38 利库预占创建面）：前 5 段之后允许成对追加 `tag:value` 段
 * （tag ∈ {rb, wh, g}，任意组合、任意顺序——解析一律归并前 5 段锚）：
 *  - `rb`：发料撤销恢复（#28 原有）；
 *  - `wh`：仓库拆分段——利库预占跨仓顺序分配，每仓一行（同锚多行）；
 *  - `g`：核查批次段（gapCheckId）——每批新建键不复用（reserveStock 合同
 *    consumed/released 键不得复用；跨批增量经锚点活跃预占折差收敛）。
 * #38 实际键形：`issue-rsv:v1:<wo>:<''>:<item>:g:<gapCheckId>:wh:<warehouseId>`。
 */
export function buildIssueReservationKey(
  workOrderId: string,
  equipmentRef: string | null,
  itemId: string,
): string {
  const enc = (value: string): string => encodeURIComponent(value);
  return `issue-rsv:v1:${enc(workOrderId)}:${enc(equipmentRef ?? '')}:${enc(itemId)}`;
}

/**
 * 解析 issue 锚预占键；非本约定形状（含 decode 失败）返回 null（防御）。
 * 前 5 段为锚（issue-rsv/v1/工作令/设备/物料）；其后允许成对 `tag:value`
 * 追加段（tag ∈ rb/wh/g——见 buildIssueReservationKey 头注），解析归并锚。
 */
export function parseIssueReservationKey(
  key: string,
): { readonly workOrderId: string; readonly equipmentRef: string; readonly itemId: string } | null {
  const parts = key.split(':');
  if (parts.length < 5 || (parts.length - 5) % 2 !== 0) return null;
  if (parts[0] !== 'issue-rsv' || parts[1] !== 'v1') return null;
  for (let index = 5; index < parts.length; index += 2) {
    const tag = parts[index];
    if (tag !== 'rb' && tag !== 'wh' && tag !== 'g') return null;
  }
  try {
    return {
      workOrderId: decodeURIComponent(parts[2] as string),
      equipmentRef: decodeURIComponent(parts[3] as string),
      itemId: decodeURIComponent(parts[4] as string),
    };
  } catch {
    return null; // 非法百分号序列——非本约定键
  }
}

/** 系统信封（U6 适配器命令面；操作者记系统账号，幂等由子键 sourceKey 承载）。 */
function wiringIssueEnvelope(
  tenant: TenantId,
  operationId: string,
  kind: 'stock.issue.v1' | 'stock.receive.v1',
  payload: Record<string, unknown>,
): CommandEnvelope<InventoryCommand> {
  return makeCommandEnvelope<InventoryCommand>({
    tenantId: tenant,
    issuedBy: UserId.create('u-system-wiring-issue'),
    operationId: OperationId.create(operationId),
    expectedRevision: 'initial',
    issuedAt: new Date().toISOString(),
    command: { kind, payload },
  });
}

/** 适配器依赖面（inventory service 迟到解析 + 三个 store 级共享实例）。 */
export interface InventoryIssueMaterialDeps {
  /** inventory service 解析面（bind 前后行为确定性：未绑定回落 NOOP 同构语义）。 */
  readonly inventory: () => InventoryService | undefined;
  readonly reservations: StockReservationStore;
  readonly movements: StockMovementStore;
  readonly domainEvents: InventoryDomainEventStore;
}

/**
 * IssueMaterialPort ← inventory 适配器（U6 #28）。
 *
 * 写面：每个库位分配折成 stock.issue.v1 子命令——预占核销份额（同仓、订单级
 * 锚、createdAt FIFO）与直扣份额各成子键 `<issueKey>@<i>r<n>` / `<issueKey>@<i>a`
 * （sourceKey 幂等——重试不重复扣减；重试时预占挑选可能与首次不同，锚语义
 * 同源不破账）。撤销：按子键枚举流水逐条 stock.receive.v1(kind=production)
 * 原路回补（receiptKey `issue-rb:<子键>` 幂等）+ 按 StockIssued 事件载荷恢复
 * 预占（restoreKey `<原键>:rb:<子键>` 确定性幂等——inventory 预占键 consumed
 * 后不得复用，恢复 = 新键同锚重立）。预占恢复失败（如可用量被并发占用）不
 * 阻塞撤销回执（stock 已回补，拒绝撤销反而制造更大漂移）——console.warn 留
 * 痕归对账。预占创建面不在本端口（IssueMaterialPort 无 reserve；外部经
 * InventoryService.reserveStock 按上述键约定立锚）。
 */
export function createInventoryIssueMaterialPort(deps: InventoryIssueMaterialDeps): IssueMaterialPort {
  const refusedReasonOf = (outcome: { status: string; reason?: string }): string =>
    outcome.reason ?? outcome.status;

  return {
    availableQtyOf: async (tenant, itemIds) => {
      const inventory = deps.inventory();
      if (inventory === undefined) return new Map(itemIds.map((itemId) => [itemId, 0])); // NOOP 同构
      return inventory.availableQtyOf(tenant, itemIds);
    },

    reservedQtyOf: async (tenant, query) => {
      const wanted = new Set(query.itemIds);
      const result = new Map<string, number>(query.itemIds.map((itemId) => [itemId, 0]));
      const rows = await deps.reservations.list(tenant, { status: 'active' });
      const equipment = query.equipmentRef ?? '';
      for (const row of rows) {
        if (row.refType !== 'issue' || row.refId !== query.workOrderId) continue;
        if (!wanted.has(row.itemId)) continue;
        const anchor = parseIssueReservationKey(row.reservationKey);
        if (anchor === null || anchor.equipmentRef !== equipment) continue;
        result.set(row.itemId, (result.get(row.itemId) ?? 0) + row.remaining);
      }
      return result;
    },

    issueStock: async (tenant, command: IssueStockCommand): Promise<IssueStockReceipt> => {
      const inventory = deps.inventory();
      if (inventory === undefined) {
        return { issued: true, allocations: command.allocations.map((a) => ({ locationId: a.locationId, quantity: a.quantity, reservedConsumedQty: 0, availableConsumedQty: a.quantity })) }; // NOOP 同构（bind 前窗口）
      }
      if (command.allocations.length === 0) return { issued: true, allocations: [] };

      // 库位 → 仓解析（逐调用扫描——仓库主数据规模小，不缓存避免陈旧）。
      const locationWarehouse = new Map<string, string>();
      for (const warehouse of await inventory.listWarehouses(tenant)) {
        for (const location of warehouse.locations) locationWarehouse.set(location.id, warehouse.id);
      }

      // 可核销预占：订单级锚（equipment 段空）+ 同 workOrder/item，createdAt FIFO。
      const consumable = (await deps.reservations.list(tenant, { status: 'active' }))
        .map((row) => ({ row, anchor: parseIssueReservationKey(row.reservationKey) }))
        .filter(
          (entry) =>
            entry.row.refType === 'issue' &&
            entry.row.refId === command.workOrderId &&
            entry.row.itemId === command.itemId &&
            entry.anchor !== null &&
            (entry.anchor as { equipmentRef: string }).equipmentRef === '',
        )
        .sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt) || a.row.id.localeCompare(b.row.id));
      const remainingOf = new Map<string, number>(consumable.map((entry) => [entry.row.reservationKey, entry.row.remaining]));

      const receipts: IssueStockAllocationReceipt[] = [];
      for (const [index, allocation] of command.allocations.entries()) {
        const warehouseId = locationWarehouse.get(allocation.locationId);
        if (warehouseId === undefined) {
          return { issued: false, refusedReason: `库位 '${allocation.locationId}' 不属于任何仓库（发料 ${command.issueKey}）` };
        }
        let reservedPart = 0;
        let reservedSeq = 0;
        for (const entry of consumable) {
          if (reservedPart >= allocation.quantity) break;
          if (entry.row.warehouseId !== warehouseId) continue;
          const remaining = remainingOf.get(entry.row.reservationKey) ?? 0;
          if (remaining <= 0) continue;
          const take = Math.min(remaining, allocation.quantity - reservedPart);
          const subKey = `${command.issueKey}@${index}r${reservedSeq}`;
          reservedSeq += 1;
          const outcome = await inventory.execute(
            wiringIssueEnvelope(tenant, `wiring-issue-${subKey}`, 'stock.issue.v1', {
              itemId: command.itemId,
              warehouseId,
              locationId: allocation.locationId,
              quantity: take,
              purpose: 'production',
              workOrderId: command.workOrderId,
              reservationKey: entry.row.reservationKey,
              issueKey: subKey,
              remark: `发料任务确认（预占核销）：${command.issueKey}`,
            }),
          );
          if (outcome.status !== 'committed') {
            return { issued: false, refusedReason: `库位 '${allocation.locationId}' 预占核销出库被拒：${refusedReasonOf(outcome)}` };
          }
          remainingOf.set(entry.row.reservationKey, remaining - take);
          reservedPart += take;
        }
        const availablePart = allocation.quantity - reservedPart;
        if (availablePart > 0) {
          const subKey = `${command.issueKey}@${index}a`;
          const outcome = await inventory.execute(
            wiringIssueEnvelope(tenant, `wiring-issue-${subKey}`, 'stock.issue.v1', {
              itemId: command.itemId,
              warehouseId,
              locationId: allocation.locationId,
              quantity: availablePart,
              purpose: 'production',
              workOrderId: command.workOrderId,
              reservationKey: null,
              issueKey: subKey,
              remark: `发料任务确认（直扣可用）：${command.issueKey}`,
            }),
          );
          if (outcome.status !== 'committed') {
            return { issued: false, refusedReason: `库位 '${allocation.locationId}' 出库被拒：${refusedReasonOf(outcome)}` };
          }
        }
        receipts.push({
          locationId: allocation.locationId,
          quantity: allocation.quantity,
          reservedConsumedQty: reservedPart,
          availableConsumedQty: availablePart,
        });
      }
      return { issued: true, allocations: receipts };
    },

    rollbackIssue: async (tenant, command) => {
      const inventory = deps.inventory();
      if (inventory === undefined) return { rolled: true }; // NOOP 同构（bind 前窗口）

      // 子键枚举（i 连续自 0；每 i 有至多一个 a 份额与一串 r<n> 份额；双缺即止）。
      const issued: StockMovement[] = [];
      for (let index = 0; index < 10_000; index += 1) {
        const direct = await deps.movements.findBySourceKey(tenant, `${command.issueKey}@${index}a`);
        const reservedRows: StockMovement[] = [];
        for (let seq = 0; seq < 10_000; seq += 1) {
          const row = await deps.movements.findBySourceKey(tenant, `${command.issueKey}@${index}r${seq}`);
          if (row === null) break;
          reservedRows.push(row);
        }
        if (direct === null && reservedRows.length === 0) break;
        if (direct !== null) issued.push(direct);
        issued.push(...reservedRows);
      }
      if (issued.length === 0) return { rolled: true }; // 无对应流水（未发过/已回滚）——幂等空回执

      for (const movement of issued) {
        const receiptKey = `issue-rb:${movement.sourceKey as string}`;
        const outcome = await inventory.execute(
          wiringIssueEnvelope(tenant, `wiring-issue-${receiptKey}`, 'stock.receive.v1', {
            kind: 'production',
            itemId: movement.itemId,
            warehouseId: movement.warehouseId,
            locationId: movement.locationId,
            quantity: movement.quantity,
            inspectionId: null,
            purchaseOrderId: null,
            workOrderId: movement.workOrderId,
            receiptKey,
            remark: `发料撤销原路回滚：${command.issueKey}`,
          }),
        );
        if (outcome.status !== 'committed') {
          return { rolled: false, refusedReason: `流水 '${movement.sourceKey}' 回补被拒：${refusedReasonOf(outcome)}` };
        }

        // 预占恢复：StockIssued 事件载荷（事实源）→ 同锚新键重立（确定性幂等）。
        const events = await deps.domainEvents.byAggregate({ id: movement.id, type: STOCK_MOVEMENT_AGGREGATE_TYPE });
        for (const event of events) {
          if (event.eventType !== INVENTORY_EVENT_TYPES.stockIssued) continue;
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const reservationKey = readString(payload['reservationKey']);
          const consumedQty = payload['consumedReservationQty'];
          if (reservationKey === null || typeof consumedQty !== 'number' || consumedQty <= 0) continue;
          const restoreKey = `${reservationKey}:rb:${movement.sourceKey}`;
          if ((await deps.reservations.findByKey(tenant, restoreKey)) !== null) continue; // 已恢复
          const restored = await inventory.reserveStock(tenant, {
            reservationKey: restoreKey,
            itemId: movement.itemId,
            warehouseId: movement.warehouseId,
            quantity: consumedQty,
            refType: 'issue',
            refId: movement.workOrderId ?? '',
          });
          if (!restored.reserved) {
            console.warn(
              `[smes] 发料撤销预占恢复失败（stock 已回补，漂移归对账）：${restored.refusedReason ?? '未知原因'}`,
            );
          }
        }
      }
      return { rolled: true };
    },
  };
}

// ---- #38：listing 利库预占 ← inventory 适配器（gap.check 确认→预占创建） ----

/** 适配器依赖面（inventory service 迟到解析 + 预占 store 共享实例——#28 同体例）。 */
export interface InventoryUseReservationDeps {
  /** inventory service 解析面（bind 前后行为确定性：未绑定回落 NOOP 同构语义）。 */
  readonly inventory: () => InventoryService | undefined;
  readonly reservations: StockReservationStore;
}

/**
 * InventoryUseReservationPort ← inventory 适配器（#38）。
 *
 * 读面 reservedForWorkOrder：issue 订单级锚（equipmentRef 空段）活跃预占按
 * 物料汇总——与 #28 IssueMaterialPort.reservedQtyOf(equipmentRef=null) 同锚
 * 同源（共享 StockReservationStore）；listing 侧用作利库供给基数的自有部分
 * （重复核查不自我挤占）。
 *
 * 写面 reserveForWorkOrder：目标量 = 调用方算好的 min(Σ需求, 供给基数)；
 * 写时重读锚点活跃预占折差（供给读与写之间的竞态在此收敛——不超目标量）。
 * 折差跨仓顺序分配（stockLevels per-仓 availableQty，仓库 id 升序确定性），
 * 每仓一行 reserveStock（refType 'issue' / refId 工作令——发料核销 #28 的
 * 可核销集），键 = issue-rsv 约定 + `:g:<gapCheckId>:wh:<仓>` 段（批次唯一
 * 不复用键；锚点归并消费）。分配不足（供给读后可用被并发占用）→ reserved
 * false——listing 侧整单 rejected 不落任何账（端口先行，体例同 #14）；拒绝
 * 前已立的仓段预占不回滚（挂在同锚上不丢账——下次核查折差收敛，取舍同
 * #28 子命令中途拒绝的锚语义同源口径）。
 */
export function createInventoryUseReservationPort(
  deps: InventoryUseReservationDeps,
): InventoryUseReservationPort {
  const orderAnchorActive = async (
    tenant: TenantId,
    workOrderId: string,
    itemId: string,
  ): Promise<number> => {
    let total = 0;
    for (const row of await deps.reservations.list(tenant, { status: 'active' })) {
      if (row.refType !== 'issue' || row.refId !== workOrderId) continue;
      if (row.itemId !== itemId) continue;
      const anchor = parseIssueReservationKey(row.reservationKey);
      if (anchor === null || anchor.equipmentRef !== '') continue; // 仅订单级锚
      total += row.remaining;
    }
    return total;
  };

  return {
    reservedForWorkOrder: async (tenant, workOrderId, itemIds) => {
      const result = new Map<string, number>(itemIds.map((itemId) => [itemId, 0]));
      const wanted = new Set(itemIds);
      for (const row of await deps.reservations.list(tenant, { status: 'active' })) {
        if (row.refType !== 'issue' || row.refId !== workOrderId) continue;
        if (!wanted.has(row.itemId)) continue;
        const anchor = parseIssueReservationKey(row.reservationKey);
        if (anchor === null || anchor.equipmentRef !== '') continue; // 仅订单级锚
        result.set(row.itemId, (result.get(row.itemId) ?? 0) + row.remaining);
      }
      return result;
    },

    reserveForWorkOrder: async (tenant, command) => {
      const inventory = deps.inventory();
      if (inventory === undefined) {
        return { reserved: true, created: [] }; // NOOP 同构（bind 前窗口）
      }
      const ownActive = await orderAnchorActive(tenant, command.workOrderId, command.itemId);
      const need = Math.max(0, command.quantity - ownActive);
      if (need <= 0) {
        return {
          reserved: true,
          created: [{ itemId: command.itemId, quantity: 0, reservationKeys: [] }], // 已覆盖（幂等收敛）
        };
      }

      // 跨仓顺序分配：per-仓 availableQty（可用量恒等式口径），仓库 id 升序。
      const levels = (await inventory.stockLevels(tenant, undefined, command.itemId))
        .filter((level) => level.availableQty > 0)
        .sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
      const enc = (value: string): string => encodeURIComponent(value);
      const base = buildIssueReservationKey(command.workOrderId, null, command.itemId);
      let remaining = need;
      const reservationKeys: string[] = [];
      for (const level of levels) {
        if (remaining <= 0) break;
        const take = Math.min(level.availableQty, remaining);
        const reservationKey = `${base}:g:${enc(command.gapCheckId)}:wh:${enc(level.warehouseId)}`;
        const outcome = await inventory.reserveStock(tenant, {
          reservationKey,
          itemId: command.itemId,
          warehouseId: level.warehouseId,
          quantity: take,
          refType: 'issue',
          refId: command.workOrderId,
        });
        if (!outcome.reserved) {
          return {
            reserved: false,
            refusedReason: `仓库 '${level.warehouseId}' 预占被拒：${outcome.refusedReason ?? '未知原因'}`,
          };
        }
        reservationKeys.push(reservationKey);
        remaining -= take;
      }
      if (remaining > 0) {
        return {
          reserved: false,
          refusedReason: `可用量不足：物料 '${command.itemId}' 跨仓可分配 ${need - remaining} < 利库预占 ${need}（供给读取后可用被并发占用）`,
        };
      }
      return {
        reserved: true,
        created: [{ itemId: command.itemId, quantity: need, reservationKeys }],
      };
    },
  };
}

/**
 * dispatch→issue 派工生成钩子（U6 #29）+ 撤销派工清理钩子（fix-wave-3 W3-2）：
 * 装饰 DispatchOrderStore.advance——
 *  - draft→assigned（派工成功）且 kind=assembly 且挂工作令时调 syncFromDispatch
 *    （rollup=true 整线归拢；取舍见文件头）。通知式合同：派工已提交，同步失败
 *    console.warn 不回滚（显式同步面 POST /issue/tasks/sync 兜底）。
 *  - →cancelled（撤销派工）且 kind=assembly 且挂工作令时触发 issue.cleanup.v1
 *    清理该工作令装配维度的发料任务（W3-2）。目标任务集按 issue 现存任务推导：
 *    非归拢任务的 equipmentRef 去重 + 存在归拢任务则 includeRollup；无任务直接
 *    跳过不调 execute（无可清理）。幂等 = 确定性 operationId
 *    `wiring-issue-cleanup:<dispatchId>`（重复撤销/重试由 issue 侧 operations.record
 *    拒重复）。通知式合同：清理被拒（目标任务已发料非未开始等）或异常仅
 *    console.warn 留痕，不回滚撤销（显式清理面 POST /issue/tasks/cleanup 兜底）。
 */
export function createIssueSyncDispatchStore(
  store: DispatchOrderStore,
  resolveIssue: () => IssueService | undefined,
): DispatchOrderStore {
  return {
    create: (input) => store.create(input),
    find: (tenant, id) => store.find(tenant, id),
    list: (tenant, filter) => store.list(tenant, filter),
    advance: async (tenant, id, expectedObjectVersion, nextState, nextObjectVersion, extra) => {
      const before =
        nextState === 'assigned' || nextState === 'cancelled' ? await store.find(tenant, id) : null;
      const advanced = await store.advance(tenant, id, expectedObjectVersion, nextState, nextObjectVersion, extra);
      if (
        before !== null &&
        before.state !== 'assigned' &&
        advanced.state === 'assigned' &&
        before.workOrderId !== null &&
        before.kind === 'assembly'
      ) {
        try {
          const issue = resolveIssue();
          if (issue !== undefined) {
            await issue.syncFromDispatch(tenant, {
              workOrderId: before.workOrderId,
              dispatchKind: 'assembly',
              rollup: true,
              workOrderLabel: advanced.title,
              plannedStartAt: null,
              plannedEndAt: advanced.dueAt,
              ...(advanced.assignee === null ? {} : { operators: [String(advanced.assignee)] }),
              triggerRef: { type: 'dispatch-order', id },
            });
          }
        } catch (error) {
          console.warn(
            '[smes] 派工→发料任务同步失败（通知式合同，不回滚派工；POST /issue/tasks/sync 可补触发）:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      // W3-2：撤销派工→issue.cleanup（通知式合同，不回滚撤销）。
      if (
        before !== null &&
        before.state !== 'cancelled' &&
        advanced.state === 'cancelled' &&
        before.kind === 'assembly' &&
        before.workOrderId !== null
      ) {
        try {
          const issue = resolveIssue();
          if (issue !== undefined) {
            // 目标任务集推导：按该工作令装配维度现存任务——非归拢设备维去重 +
            // 归拢任务存在则整线清理；无任务跳过（无可清理，不占 operationId）。
            const tasks = await issue.listTasks(tenant, {
              workOrderId: before.workOrderId,
              dispatchKind: 'assembly',
            });
            const equipmentRefs = [
              ...new Set(
                tasks
                  .filter((task) => !task.rollup && task.equipmentRef !== null)
                  .map((task) => task.equipmentRef as string),
              ),
            ];
            const includeRollup = tasks.some((task) => task.rollup);
            if (equipmentRefs.length > 0 || includeRollup) {
              const outcome = await issue.execute(
                makeCommandEnvelope<IssueCommand>({
                  tenantId: tenant,
                  issuedBy: UserId.create('u-system-wiring-issue'),
                  operationId: OperationId.create(`wiring-issue-cleanup:${id}`),
                  expectedRevision: 'initial',
                  issuedAt: new Date().toISOString(),
                  command: {
                    kind: 'issue.cleanup.v1',
                    payload: {
                      workOrderId: before.workOrderId,
                      dispatchKind: 'assembly',
                      ...(equipmentRefs.length > 0 ? { equipmentRefs } : {}),
                      ...(includeRollup ? { includeRollup: true } : {}),
                      remark: '撤销派工自动清理',
                    },
                  },
                }),
              );
              if (outcome.status !== 'committed') {
                console.warn(
                  '[smes] 撤销派工→发料任务清理被拒（通知式合同，不回滚撤销；POST /issue/tasks/cleanup 可补清理）:',
                  outcome.reason,
                );
              }
            }
          }
        } catch (error) {
          console.warn(
            '[smes] 撤销派工→发料任务清理失败（通知式合同，不回滚撤销；POST /issue/tasks/cleanup 可补清理）:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return advanced;
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
  /**
   * store 级装饰实例（U6 #29）：dispatch 派工单存储经装饰后的 advance 在
   * 派工成功时触发发料任务同步——app-registry 的 dispatch/aftercare-claim
   * 工厂读本字段拿实例（未接线形态 = undefined，回落原 store）。
   */
  readonly storeOverrides: { readonly dispatchOrders?: DispatchOrderStore | undefined };
}

/** 组装全部跨模块接线（清单见文件头；两侧装配才接，机制各见条目注释）。 */
export function createCrossModuleWiring(input: CrossModuleWiringInput): CrossModuleWiring {
  const { enabled, stores } = input;
  const has = (module: string): boolean => enabled.includes(module);

  // 迟到引用（#3/#8/#9/#12~#17 的 service 级端口；#22 的 maintenance；
  // #25 的 listing；U6 #29/#30 的 issue/reporting）
  const lateInventory = new LateBound<InventoryService>();
  const lateListing = new LateBound<ListingService>();
  const lateDispatch = new LateBound<DispatchService>();
  const lateBaseline = new LateBound<BaselineService>();
  const lateInspection = new LateBound<InspectionService>();
  const lateHours = new LateBound<HoursService>();
  const lateMaintenance = new LateBound<MaintenanceService>();
  const lateIssue = new LateBound<IssueService>();
  const lateReporting = new LateBound<ReportingService>();

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

  // U7 #31 costing.projectIssueSource（store 级：issue 发料记录段事实 + PO 加权价 + 原材料关联）
  const projectIssueSource: ProjectIssueCostSourcePort | undefined =
    has('costing') && has('issue') && stores.issueRecords !== undefined
      ? createProjectIssueSource({
          issueRecords: stores.issueRecords,
          purchaseOrders: stores.purchaseOrders,
          processMaterialLinks: stores.processMaterialLinks,
        })
      : undefined;

  // U7 #32 costing.projectEquipmentSource（store 级：PO 行 × equipment 清单行匹配）
  const projectEquipmentSource: ProjectEquipmentPurchaseSourcePort | undefined =
    has('costing') && has('listing') && stores.purchaseOrders !== undefined
      ? createProjectEquipmentSource({ purchaseOrders: stores.purchaseOrders, listingLines: stores.listingLines })
      : undefined;

  // U7 #33 costing.projectAftercareSource（store 级：aftermarket 派工 × 报销单联查）
  const projectAftercareSource: ProjectAftercareClaimSourcePort | undefined =
    has('costing') && has('dispatch') && stores.dispatchOrders !== undefined && stores.aftercareClaims !== undefined
      ? createProjectAftercareSource({ dispatchOrders: stores.dispatchOrders, aftercareClaims: stores.aftercareClaims })
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

  // fix-wave-3 W3-1 #34 reporting.operationValidity（service 级迟到绑定；未绑定
  // 回落 ALL_OPERATIONS_VALID 同构恒合法——bind 前窗口语义与模块缺省一致）
  const operationValidity: OperationValidityPort | undefined =
    has('reporting') && has('baseline')
      ? {
          isKnownOperation: async (tenant, operationCode) => {
            const baseline = lateBaseline.resolve();
            if (baseline === undefined) return true; // 未绑定 = ALL_OPERATIONS_VALID 同语义
            try {
              return (await baseline.getProcess(tenant, operationCode)).current.status === 'active';
            } catch (error) {
              if (error instanceof BaselineNotFoundError) return false; // NotFound→false（fail-closed 复检）
              throw error;
            }
          },
        }
      : undefined;

  // fix-wave-3 W3-1 #35 reporting.finalOperation（service 级迟到绑定；未绑定回落
  // NEVER_FINAL_OPERATION 同构恒非末道；NotFound/无路线→false 恒非末道不抛）
  const finalOperationJudge: FinalOperationJudgePort | undefined =
    has('reporting') && has('baseline')
      ? {
          isFinalOperation: async (tenant, drawingNo, operationCode) => {
            const baseline = lateBaseline.resolve();
            if (baseline === undefined) return false; // 未绑定 = NEVER_FINAL_OPERATION 同语义
            try {
              const steps = (await baseline.getRouting(tenant, drawingNo)).current.steps;
              if (steps.length === 0) return false; // 空工序序列（防御）→ 恒非末道
              const last = steps.reduce((max, step) => (step.seq > max.seq ? step : max)); // 末道 = max seq
              return last.processCode === operationCode;
            } catch (error) {
              if (error instanceof BaselineNotFoundError) return false; // 无工艺路线 → 恒非末道
              throw error;
            }
          },
        }
      : undefined;

  // fix-wave-3 W3-1 #36 reporting.inspectionIntake（service 级迟到绑定；#9 同体例）
  const reportingInspectionIntake: InspectionIntakePort | undefined =
    has('reporting') && has('inspection')
      ? {
          receiveSourceFact: (tenant, fact) => {
            const inspection = lateInspection.resolve();
            return inspection === undefined
              ? REPORTING_NOOP_INSPECTION_INTAKE.receiveSourceFact(tenant, fact)
              : inspection.receiveSourceFact(tenant, fact);
          },
        }
      : undefined;

  // fix-wave-3 W3-1 #37 listing.inspectionIntake（service 级迟到绑定；#9 同体例，
  // 未绑定回落 LISTING_NOOP_INSPECTION_INTAKE 同构——同形回执，bind 前窗口不投递）
  const listingInspectionIntake: InspectionIntakePort | undefined =
    has('listing') && has('inspection')
      ? {
          receiveSourceFact: (tenant, fact) => {
            const inspection = lateInspection.resolve();
            return inspection === undefined
              ? Promise.resolve({
                  inspectionId: null,
                  created: false,
                  reason: 'inspection intake 端口未接线（组合根 bind 前窗口）：listing 收货触发',
                })
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

  // #25 workorder.listingPort（service 级迟到绑定；未绑定回落空实现语义——
  // 组合根构造到 bind 之间的窗口与模块缺省 EMPTY_LISTING_PORT 同口径零行）
  const workorderListingPort: ListingRequirementPort | undefined =
    has('workorder') && has('listing')
      ? createListingRequirementAdapter({
          requirementLines: (tenant, workOrderId) => {
            const listing = lateListing.resolve();
            return listing === undefined
              ? Promise.resolve([])
              : listing.requirementLines(tenant, workOrderId);
          },
        })
      : undefined;

  // #26 workorder.inventoryPort（service 级迟到绑定；与 #13/#16 共用同一
  // InventoryService——可用量恒等式口径单点定义）
  const workorderInventoryPort: InventoryAvailabilityPort | undefined =
    has('workorder') && has('inventory')
      ? createInventoryAvailabilityAdapter({
          availableQtyOf: async (tenant, itemIds) => {
            const inventory = lateInventory.resolve();
            return inventory === undefined
              ? new Map<string, number>()
              : inventory.availableQtyOf(tenant, itemIds);
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

  // Excel 端口（listing 导入导出 + costing/metric-pack/payroll/dispatch 导出，
  // ExcelJS xlsx-bytes 适配——单实例注入各模块，语义层委托 application 纯函数，见
  // exceljs-excel-port.ts；dispatch 侧为 exportWorkbook 结构子集，fix-wave-6 6a-1）
  const excel =
    has('listing') || has('costing') || has('payroll') || has('metric-pack') || has('dispatch')
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

  // U6 #28 issue.material（service+store 混级：读面迟到绑定 + 预占/流水/域事件
  // 三共享实例；机制与预占键约定见适配器头注）。
  const issueMaterial: IssueMaterialPort | undefined =
    has('issue') &&
    has('inventory') &&
    stores.inventoryReservations !== undefined &&
    stores.inventoryMovements !== undefined &&
    stores.inventoryDomainEvents !== undefined
      ? createInventoryIssueMaterialPort({
          inventory: () => lateInventory.resolve(),
          reservations: stores.inventoryReservations,
          movements: stores.inventoryMovements,
          domainEvents: stores.inventoryDomainEvents,
        })
      : undefined;

  // #38 listing.useReservationPort（service+store 混级：写面迟到绑定 reserveStock/
  // stockLevels + 预占共享实例读面；机制与键约定见适配器头注）。
  const useReservationPort: InventoryUseReservationPort | undefined =
    has('listing') && has('inventory') && stores.inventoryReservations !== undefined
      ? createInventoryUseReservationPort({
          inventory: () => lateInventory.resolve(),
          reservations: stores.inventoryReservations,
        })
      : undefined;

  // U6 #29 dispatch→issue 派工生成钩子（store 装饰——advance→assigned 触发；
  // DispatchModule 经 app-registry 读 storeOverrides.dispatchOrders 拿装饰态实例）。
  const issueSyncDispatchOrders: DispatchOrderStore | undefined =
    has('dispatch') && has('issue') && stores.dispatchOrders !== undefined
      ? createIssueSyncDispatchStore(stores.dispatchOrders, () => lateIssue.resolve())
      : undefined;  // U6 #30 aftercare-claim.reportPort（service 级迟到绑定：application 备好的
  // 投影 + 此处粘 reporting 查询面）。
  const aftercareReportPort: AftercareApprovedReportPort | undefined =
    has('aftercare-claim') && has('reporting')
      ? createAftercareReportPort({
          listReports: (tenant, filter) => {
            const reporting = lateReporting.resolve();
            return reporting === undefined
              ? Promise.resolve([])
              : reporting.listReports(tenant, filter);
          },
        })
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
      ...(progressPort !== undefined ||
      issuePort !== undefined ||
      workorderListingPort !== undefined ||
      workorderInventoryPort !== undefined
        ? {
            workorder: {
              ...(workorderListingPort !== undefined ? { listingPort: workorderListingPort } : {}),
              ...(workorderInventoryPort !== undefined ? { inventoryPort: workorderInventoryPort } : {}),
              ...(progressPort !== undefined ? { progressPort } : {}),
              ...(issuePort !== undefined ? { issuePort } : {}),
            },
          }
        : {}),
      ...(workOrderFeed !== undefined ||
      listingInventoryPort !== undefined ||
      receiptPort !== undefined ||
      useReservationPort !== undefined ||
      materialValidation !== undefined ||
      listingInspectionIntake !== undefined ||
      (has('listing') && excel !== undefined)
        ? {
            listing: {
              ...(workOrderFeed !== undefined ? { workOrderFeed } : {}),
              ...(listingInventoryPort !== undefined ? { inventoryPort: listingInventoryPort } : {}),
              ...(receiptPort !== undefined ? { receiptPort } : {}),
              ...(useReservationPort !== undefined ? { useReservationPort } : {}),
              ...(materialValidation !== undefined ? { materialValidation } : {}),
              ...(has('listing') && excel !== undefined ? { excelPort: excel } : {}),
              ...(listingInspectionIntake !== undefined ? { inspectionIntake: listingInspectionIntake } : {}),
            },
          }
        : {}),
      ...(kitCheck !== undefined ||
      priceSource !== undefined ||
      inspectionIntake !== undefined ||
      print !== undefined ||
      (has('dispatch') && excel !== undefined)
        ? {
            dispatch: {
              ...(kitCheck !== undefined ? { kitCheck } : {}),
              ...(priceSource !== undefined ? { priceSource } : {}),
              ...(inspectionIntake !== undefined ? { inspectionIntake } : {}),
              ...(print !== undefined ? { print } : {}),
              ...(has('dispatch') && excel !== undefined ? { excelPort: excel } : {}),
            },
          }
        : {}),
      ...(validDispatch !== undefined ||
      operationValidity !== undefined ||
      finalOperationJudge !== undefined ||
      reportingInspectionIntake !== undefined
        ? {
            reporting: {
              ...(validDispatch !== undefined ? { validDispatch } : {}),
              ...(operationValidity !== undefined ? { operationValidity } : {}),
              ...(finalOperationJudge !== undefined ? { finalOperation: finalOperationJudge } : {}),
              ...(reportingInspectionIntake !== undefined ? { inspectionIntake: reportingInspectionIntake } : {}),
            },
          }
        : {}),
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
      projectIssueSource !== undefined ||
      projectEquipmentSource !== undefined ||
      projectAftercareSource !== undefined ||
      (has('costing') && excel !== undefined)
        ? {
            costing: {
              ...(materialSource !== undefined ? { materialSource } : {}),
              ...(laborSource !== undefined ? { laborSource } : {}),
              ...(outsourcingSource !== undefined ? { outsourcingSource } : {}),
              ...(workOrderSubject !== undefined ? { workOrderSubject } : {}),
              ...(has('costing') && excel !== undefined ? { excelPort: excel } : {}),
              ...(projectIssueSource !== undefined ? { projectIssueSource } : {}),
              ...(projectEquipmentSource !== undefined ? { projectEquipmentSource } : {}),
              ...(projectAftercareSource !== undefined ? { projectAftercareSource } : {}),
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
      ...(issueMaterial !== undefined ? { issue: { material: issueMaterial } } : {}),
      ...(aftercareReportPort !== undefined ? { 'aftercare-claim': { reportPort: aftercareReportPort } } : {}),
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
      if (has('listing')) {
        const listing = resolveOptional(ListingService);
        if (listing !== undefined) lateListing.bind(listing);
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
      if (has('issue')) {
        const issue = resolveOptional(IssueService);
        if (issue !== undefined) lateIssue.bind(issue);
      }
      if (has('reporting')) {
        const reporting = resolveOptional(ReportingService);
        if (reporting !== undefined) lateReporting.bind(reporting);
      }
    },
    hoursIngestTrigger,
    storeOverrides: { dispatchOrders: issueSyncDispatchOrders },
  };
}

/** 组合根构造后接线入口：main/tests 在 NestFactory.create 后调用（幂等）。 */
export function bindCrossModuleWiring(app: INestApplicationContext): void {
  const wiring = app.get<CrossModuleWiring>(CROSS_MODULE_WIRING, { strict: false });
  wiring.bind(app);
}
