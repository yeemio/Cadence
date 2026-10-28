import type { WorkOrderEquipmentStore } from '../workorder/workorder-equipment.js';
/**
 * ListingService —— 清单与采购用例编排（M2-W3，03-listing.md v1.0）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分（committed/rejected 为值；indeterminate 仅在上游
 * baseline 校验端口返回 indeterminate 时透传——内存路径不产生）。
 *
 * 五件事：
 *
 * 1. 清单：WorkOrderCreated 订阅端口 → 四类清单骨架；Excel 导入（ExcelPort
 *    表头别名/错误行提示语义）→ 物料校验端口（baseline
 *    MaterialValidationExecutor，子信封 operationId 确定性派生——重试不重复
 *    落 baseline 账）→ 行落库（校验状态字段）；
 * 2. 缺口核查：清单需求（itemId 已解析行）× inventory 可用量端口 → 不可变
 *    快照 + 缺口行（一键采购锚点）；确认即利库预占（useReservation 端口先行
 *    ——供给基数 = 跨仓可用 + 本令锚点活跃预占，目标量 = min(Σ需求, 供给)，
 *    拒绝则整单 rejected 不落账，体例同收货入库端口先行）；
 * 3. 采购申请：create 落 draft；随订单推进（approve→approved、issue→converted，
 *    初版口径见 listing-config 头注）；
 * 4. 采购订单：五态机经 engine-flow runtime 驱动（配置整体可替换，ADR-0010）；
 *    submit=建单+SUBMIT+审批待办；approve=决策迁移（体例照抄配件机）；receive
 *    先行 inventory 入库指令端口（拒绝则整单 rejected 不落账，receiptKey 幂等）；
 *    return.create=建退货单 + 订单 RETURN 回退（received→issued 可重收）；
 * 5. 逾期事实：交期对比扫描（promisedAt < now ∧ 未收货）→ PurchaseOverdue
 *    事件 + 采购负责人催货待办（去重：同订单已有 open 催货待办不重复派）。
 *
 * 落账顺序（与 workorder 同取舍）：幂等记账 → 机器事件账本 → 投影乐观推进 →
 * 域事件发布（BusinessEvent + Outbox）。建单类命令（申请/退货单、订单提交）
 * 先落初始态投影行（draft/open@v1 无机器事件）再驱动首次迁移——投影行先在
 * 是机器事件 append 的前置（PG 账本按投影行解析租户，孤儿聚合拒写）。
 */
import {
  EventId,
  OperationId,
  UserId,
  makeCommandEnvelope,
  type BusinessEvent,
  type CommandEnvelope,
  type CommittedOutcome,
  type IndeterminateOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import {
  startApprovalFlow,
  type ApprovalEvent,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalFlowRuntime,
} from '@smes/engine-flow';
import type { TodoItem, TodoStore } from '../workbench/workbench-stores.js';
import {
  DEFAULT_GAP_SCOPE_KINDS,
  DEFAULT_PURCHASE_ORDER_FLOW_CONFIG,
  DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG,
  DEFAULT_PURCHASE_RETURN_FLOW_CONFIG,
  GAP_RESERVE_SCOPE_KINDS,
  LISTING_KINDS,
  listingKindLabel,
  purchaseOrderStateLabel,
  type ListingKind,
} from './listing-config.js';
import {
  GAP_CHECK_AGGREGATE_TYPE,
  LISTING_LINE_AGGREGATE_TYPE,
  LISTING_SHEET_AGGREGATE_TYPE,
  PURCHASE_ORDER_AGGREGATE_TYPE,
  PURCHASE_REQUEST_AGGREGATE_TYPE,
  PURCHASE_RETURN_AGGREGATE_TYPE,
  makeGapCheckedEvent,
  makeListingImportedEvent,
  makeListingLineUpdatedEvent,
  makeListingLineValidatedEvent,
  makePurchaseOrderTransitionedEvent,
  makePurchaseOverdueEvent,
  makePurchaseRequestedEvent,
  makePurchaseReturnedEvent,
  provenanceOf,
  type GapCheckedPayload,
  type ListingImportedPayload,
  type ListingLineUpdatedPayload,
  type ListingLineValidatedLinePayload,
  type ListingLineValidatedPayload,
  type ListingMachineMilestone,
  type PurchaseOrderApprovedPayload,
  type PurchaseOrderIssuedPayload,
  type PurchaseOrderReceivedPayload,
  type PurchaseOrderSubmittedPayload,
  type PurchaseOverduePayload,
  type PurchaseRequestedPayload,
  type PurchaseReturnedPayload,
} from './listing-events.js';
import { ListingInputError, ListingNotFoundError, ListingStateError } from './listing-errors.js';
import {
  parseGapCheckPayload,
  parseListingImportPayload,
  parseOverdueScanPayload,
  parsePurchaseOrderDecisionPayload,
  parsePurchaseOrderIssuePayload,
  parsePurchaseOrderReceivePayload,
  parsePurchaseOrderSubmitPayload,
  parsePurchaseRequestCreatePayload,
  parsePurchaseReturnCreatePayload,
  parsePurchaseReturnRevokePayload,
  parseUpdateListingLinePayload,
  type ListingCommand,
  type ListingCommandKind,
} from './listing-input.js';
import {
  EMPTY_WORK_ORDER_CREATED_FEED,
  LISTING_EMPTY_INVENTORY_PORT,
  LISTING_NOOP_INSPECTION_INTAKE,
  LISTING_NOOP_RECEIPT_PORT,
  LISTING_NOOP_USE_RESERVATION_PORT,
  LISTING_TODO_SOURCE,
  LISTING_UNWIRED_MATERIAL_VALIDATION,
  materialValidationOperationId,
  REQUEST_KIND_TO_INSPECTION_KIND,
  type InventoryAvailabilityPort,
  type InventoryReceiptPort,
  type InventoryUseReserveLineReceipt,
  type InventoryUseReservationPort,
  type MaterialValidationExecutor,
  type WorkOrderCreatedFeedPort,
} from './listing-ports.js';
import type { InspectionIntakePort } from '../inspection/inspection-ports.js';
import type { InspectionKind } from '../inspection/inspection-config.js';
import type { BaselineCommand } from '../baseline/baseline-input.js';
import {
  JsonTablesExcelPort,
  fileLevelIssues,
  type ExcelExport,
  type ExcelPort,
  type ExcelSheet,
  type ExcelSource,
} from './excel-port.js';
import type {
  GapCheck,
  GapCheckStore,
  GapKindSummary,
  GapLine,
  ListingDomainEventStore,
  ListingLine,
  ListingLineStore,
  ListingOperationStore,
  ListingRowIssue,
  ListingSheet,
  ListingSheetStore,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStore,
  PurchaseRequest,
  PurchaseRequestStore,
  PurchaseReturn,
  PurchaseReturnLine,
  PurchaseReturnStore,
  UpdateListingLineFields,
} from './listing-stores.js';
import {
  newDomainEventId,
  newGapCheckId,
  newListingLineId,
  newListingSheetId,
  newPurchaseOrderId,
  newPurchaseRequestId,
  newPurchaseReturnId,
} from './listing-ids.js';

// ---- 结果形状 ----

export interface ListingCommitted extends CommittedOutcome {
  readonly todosCreated: readonly TodoItem[];
  readonly todosCompleted: readonly TodoItem[];
  readonly sheets?: readonly ListingSheet[];
  readonly lines?: readonly ListingLine[];
  /** Excel 导入被跳过行的错误行提示（复刻行为锚点）。 */
  readonly rowIssues?: readonly ListingRowIssue[];
  readonly gapCheck?: GapCheck;
  /** 本次核查新建的利库预占行（接线后非空时携带；事实账在 inventory 预占账）。 */
  readonly reservations?: readonly InventoryUseReserveLineReceipt[];
  readonly purchaseRequest?: PurchaseRequest;
  readonly purchaseOrder?: PurchaseOrder;
  readonly purchaseReturn?: PurchaseReturn;
  /** 逾期扫描产出的逾期事实行。 */
  readonly overdue?: readonly PurchaseOverdueRow[];
}

export type ListingCommandResult = ListingCommitted | RejectedOutcome | IndeterminateOutcome;

export interface ListingServiceOptions {
  readonly equipmentSource?: WorkOrderEquipmentStore | undefined;
  readonly canRelinkEquipment?: (tenant: TenantId, workOrderId: string, itemId: string | null) => Promise<boolean>;
  readonly receivingWarehouses?: (tenant: TenantId) => Promise<readonly { readonly id: string; readonly code: string; readonly name: string }[]>;
  /** 订单五态配置（缺省 DEFAULT_PURCHASE_ORDER_FLOW_CONFIG；整体替换 = 换合法集/审核链层级）。 */
  readonly orderConfig: ApprovalFlowConfig;
  /** 申请三态配置（缺省 DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG）。 */
  readonly requestConfig: ApprovalFlowConfig;
  /** 退货单两态配置（缺省 DEFAULT_PURCHASE_RETURN_FLOW_CONFIG）。 */
  readonly returnConfig: ApprovalFlowConfig;
  /** 缺口核查覆盖类目（缺省四类全量）。 */
  readonly gapScopeKinds: readonly ListingKind[];
  /** 订单审批待办指派人（审核链层级配置化的初版单级锚点；null = 不派待办）。 */
  readonly orderApprover: UserId | null;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface ListingCrossModulePorts {
  readonly workOrderFeed: WorkOrderCreatedFeedPort;
  readonly inventory: InventoryAvailabilityPort;
  readonly receipt: InventoryReceiptPort;
  /** inventory 利库预占端口（gap.check 确认→预占创建）；缺省 = NOOP（不预占）。 */
  readonly useReservation: InventoryUseReservationPort;
  readonly inspectionIntake: InspectionIntakePort;
  readonly excel: ExcelPort;
  readonly materialValidation: MaterialValidationExecutor;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

/** 逾期未收货的开放态集合（draft 为瞬时初始态不计逾期）。 */
const OVERDUE_OPEN_STATES: ReadonlySet<string> = new Set(['submitted', 'approved', 'issued']);

/** baseline 物料校验判定行的载荷镜像（结构化提取；词汇以 baseline 侧为准）。 */
interface MaterialJudgmentShape {
  readonly judgment: 'matched' | 'suspected' | 'unmatched';
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  readonly similarity: number;
  readonly basis: 'code-exact' | 'name-and-spec' | 'none';
}

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class ListingService {
  private readonly options: ListingServiceOptions;
  private readonly ports: ListingCrossModulePorts;

  constructor(
    private readonly sheets: ListingSheetStore,
    private readonly lines: ListingLineStore,
    private readonly gapChecks: GapCheckStore,
    private readonly requests: PurchaseRequestStore,
    private readonly orders: PurchaseOrderStore,
    private readonly returns: PurchaseReturnStore,
    private readonly operations: ListingOperationStore,
    private readonly domainEvents: ListingDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    private readonly todos: TodoStore,
    ports: Partial<ListingCrossModulePorts> = {},
    options: Partial<ListingServiceOptions> = {},
  ) {
    this.ports = {
      workOrderFeed: ports.workOrderFeed ?? EMPTY_WORK_ORDER_CREATED_FEED,
      inventory: ports.inventory ?? LISTING_EMPTY_INVENTORY_PORT,
      receipt: ports.receipt ?? LISTING_NOOP_RECEIPT_PORT,
      useReservation: ports.useReservation ?? LISTING_NOOP_USE_RESERVATION_PORT,
      inspectionIntake: ports.inspectionIntake ?? LISTING_NOOP_INSPECTION_INTAKE,
      excel: ports.excel ?? new JsonTablesExcelPort(),
      materialValidation: ports.materialValidation ?? LISTING_UNWIRED_MATERIAL_VALIDATION,
    };
    this.options = {
      ...(options.equipmentSource === undefined ? {} : { equipmentSource: options.equipmentSource }),
      ...(options.canRelinkEquipment === undefined ? {} : { canRelinkEquipment: options.canRelinkEquipment }),
      ...(options.receivingWarehouses === undefined ? {} : { receivingWarehouses: options.receivingWarehouses }),
      orderConfig: options.orderConfig ?? DEFAULT_PURCHASE_ORDER_FLOW_CONFIG,
      requestConfig: options.requestConfig ?? DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG,
      returnConfig: options.returnConfig ?? DEFAULT_PURCHASE_RETURN_FLOW_CONFIG,
      gapScopeKinds: options.gapScopeKinds ?? DEFAULT_GAP_SCOPE_KINDS,
      orderApprover: options.orderApprover ?? null,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private async validateEquipment(tenant: TenantId, workOrderId: string, kind: string, ref: string | null, origin: string): Promise<string | null> {
    if (!this.options.equipmentSource) return null;
    if (!ref) return kind !== 'equipment' && origin === 'production' ? '生产清单须先选择本工作令的自制设备；旧空设备行不会自动归属设备。' : null;
    const equipment = await this.options.equipmentSource.find(tenant, ref);
    if (!equipment || equipment.workOrderId !== workOrderId) return '设备不存在或不属于当前工作令/租户';
    if (kind !== 'equipment' && equipment.kind !== 'self-made') return '零件、标准件和电气件只能关联本工作令的自制设备';
    if (kind === 'equipment' && equipment.kind !== 'purchased') return '外购设备清单只能关联本工作令的外购设备';
    return null;
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(
    envelope: CommandEnvelope<ListingCommand>,
    pathId?: string,
  ): Promise<ListingCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly ListingCommandKind[] = [
      'listing.import.v1',
      'gap.check.v1',
      'purchase.request.create.v1',
      'purchase.order.submit.v1',
      'purchase.return.create.v1',
      'purchase.overdue.scan.v1',
    ];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'listing.import.v1':
        return this.runImport(envelope);
      case 'listing.line.update.v1':
        return this.updateLine(envelope, this.requirePathId(pathId, kind));
      case 'gap.check.v1':
        return this.checkGap(envelope, this.requirePathId(pathId, kind));
      case 'purchase.request.create.v1':
        return this.createPurchaseRequest(envelope);
      case 'purchase.order.submit.v1':
        return this.submitOrder(envelope);
      case 'purchase.order.approve.v1':
        return this.approveOrder(envelope, this.requirePathId(pathId, kind));
      case 'purchase.order.issue.v1':
        return this.issueOrder(envelope, this.requirePathId(pathId, kind));
      case 'purchase.order.receive.v1':
        return this.receiveOrder(envelope, this.requirePathId(pathId, kind));
      case 'purchase.return.create.v1':
        return this.createReturn(envelope);
      case 'purchase.return.revoke.v1':
        return this.revokeReturn(envelope, this.requirePathId(pathId, kind));
      case 'purchase.overdue.scan.v1':
        return this.scanOverdue(envelope);
    }
  }

  private requirePathId(pathId: string | undefined, kind: ListingCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new ListingInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- listing.import（workorder 骨架 / excel 行导入） ----

  private async runImport(
    envelope: CommandEnvelope<ListingCommand>,
  ): Promise<ListingCommandResult> {
    const payload = parseListingImportPayload(envelope.command.payload);
    return payload.source === 'workorder'
      ? this.importFromWorkOrder(envelope, payload.workOrderId)
      : this.importFromExcel(envelope, payload.workOrderId, payload.kind, payload.excel, payload.equipmentRef ?? null, payload.origin ?? 'production');
  }

  private async importFromWorkOrder(
    envelope: CommandEnvelope<ListingCommand>,
    workOrderId: string,
  ): Promise<ListingCommandResult> {
    const tenant = envelope.tenantId;
    const pending = await this.ports.workOrderFeed.pendingCreatedEvents(tenant);
    const matched = pending.find((message) => message.payload.workOrderId === workOrderId);
    // 零接线兜底：订阅端口无该工作令事件时按四类缺省骨架生成（EMPTY feed 语义完整）。
    const kinds =
      matched === undefined
        ? LISTING_KINDS
        : matched.payload.listingKinds.filter((kind): kind is ListingKind =>
            (LISTING_KINDS as readonly string[]).includes(kind),
          );
    const existing = await this.sheets.listByWorkOrder(tenant, workOrderId);
    const existingKinds = new Set(existing.map((sheet) => sheet.kind));
    const toCreate = kinds.filter((kind) => !existingKinds.has(kind));
    if (toCreate.length === 0) {
      return rejected(
        `工作令 '${workOrderId}' 的清单已齐（${kinds.map(listingKindLabel).join('/')}），无新骨架可生成`,
      );
    }

    const firstId = newListingSheetId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: LISTING_SHEET_AGGREGATE_TYPE,
      aggregateId: firstId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const created: ListingSheet[] = [];
    const events: BusinessEvent[] = [];
    const sheetIds = [firstId, ...toCreate.slice(1).map(() => newListingSheetId())];
    for (const [index, kind] of toCreate.entries()) {
      const sheet = await this.sheets.create({
        tenant,
        id: sheetIds[index] as string,
        workOrderId,
        kind,
        name: `${listingKindLabel(kind)}（${workOrderId}）`,
      });
      created.push(sheet);
      const payload: ListingImportedPayload = {
        workOrderId,
        kind,
        sheetId: sheet.id,
        source: 'workorder',
        sourceEventId: matched === undefined ? null : matched.eventId,
        previousLineCount: 0,
        importedLineCount: 0,
        rowIssues: [],
        actor: envelope.issuedBy,
      };
      events.push(makeListingImportedEvent(this.domainEventBase(envelope), payload));
    }
    for (const event of events) {
      await this.domainEvents.append(event);
    }
    if (matched !== undefined) {
      await this.ports.workOrderFeed.acknowledge(matched.eventId);
    }

    return {
      status: 'committed',
      newRevision: 1,
      events,
      todosCreated: [],
      todosCompleted: [],
      sheets: created,
    };
  }

  private async importFromExcel(
    envelope: CommandEnvelope<ListingCommand>,
    workOrderId: string,
    kind: ListingKind,
    excelSource: ExcelSource,
    equipmentRef: string | null = null,
    origin: 'production' | 'aftermarket' = 'production',
  ): Promise<ListingCommandResult> {
    const tenant = envelope.tenantId;
    const equipmentFault = await this.validateEquipment(tenant, workOrderId, kind, equipmentRef, origin);
    if (equipmentFault) return rejected(equipmentFault);
    const parsed = await this.ports.excel.parseListingImport(excelSource);
    const fileIssues = fileLevelIssues(parsed.issues);
    if (fileIssues.length > 0) {
      return rejected(`Excel 导入被拒绝：${fileIssues.map((issue) => issue.message).join('；')}`);
    }
    if (parsed.rows.length === 0) {
      return rejected('Excel 导入被拒绝：无有效数据行');
    }

    const existing = await this.sheets.listByWorkOrder(tenant, workOrderId);
    const sheet =
      existing.find((entry) => entry.kind === kind) ??
      (await this.sheets.create({
        tenant,
        id: newListingSheetId(),
        workOrderId,
        kind,
        name: `${listingKindLabel(kind)}（${workOrderId}）`,
      }));

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: LISTING_SHEET_AGGREGATE_TYPE,
      aggregateId: sheet.id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 物料校验端口（baseline MaterialValidationExecutor）：子信封 operationId
    // 确定性派生（#material 后缀）——同 listing 命令重试不重复落 baseline 账。
    const subEnvelope = makeCommandEnvelope<BaselineCommand>({
      tenantId: tenant,
      issuedBy: envelope.issuedBy,
      operationId: OperationId.create(materialValidationOperationId(envelope.operationId)),
      expectedRevision: 'initial',
      issuedAt: envelope.issuedAt,
      command: {
        kind: 'baseline.material.validate.v1', // BASELINE_COMMAND_KINDS.materialValidate
        payload: {
          lines: parsed.rows.map((row) => ({ code: row.code, name: row.name, spec: row.spec })),
        },
      },
    });
    const outcome = await this.ports.materialValidation.execute(tenant, subEnvelope);
    if (outcome.status === 'rejected') {
      return rejected(`物料校验拒绝：${outcome.reason}`);
    }
    if (outcome.status === 'indeterminate') {
      return {
        status: 'indeterminate',
        reason: `物料校验端口返回 indeterminate：${outcome.reason}——retrySafe=false，须人工对账`,
        retrySafe: false,
      };
    }
    const judgments = extractJudgments(outcome.events);
    if (judgments === null || judgments.length !== parsed.rows.length) {
      return rejected('物料校验端口回执载荷异常（判定行数与导入行数不符），命令不落账');
    }

    const startLineNo = await this.lines.nextLineNo(tenant, sheet.id);
    const appended = await this.lines.appendLines(
      parsed.rows.map((row, index) => {
        const judgment = judgments[index] as MaterialJudgmentShape;
        return {
          tenant,
          id: newListingLineId(),
          sheetId: sheet.id,
          workOrderId,
          kind,
          equipmentRef,
          origin,
          lineNo: startLineNo + index,
          drawingNo: row.drawingNo,
          code: row.code,
          name: row.name,
          spec: row.spec,
          itemId: judgment.judgment === 'matched' ? judgment.candidateItemId : null,
          requiredQty: row.quantity,
          neededBy: row.neededBy,
          validationStatus: judgment.judgment,
          candidateItemId: judgment.candidateItemId,
          candidateItemCode: judgment.candidateItemCode,
          similarity: judgment.similarity,
          basis: judgment.basis,
          source: 'excel' as const,
        };
      }),
    );

    const rowIssues: ListingRowIssue[] = parsed.issues.filter((issue) => issue.lineNo !== null);
    const summary = {
      total: judgments.length,
      matched: judgments.filter((row) => row.judgment === 'matched').length,
      suspected: judgments.filter((row) => row.judgment === 'suspected').length,
      unmatched: judgments.filter((row) => row.judgment === 'unmatched').length,
    };
    const importPayload: ListingImportedPayload = {
      workOrderId,
      kind,
      sheetId: sheet.id,
      source: 'excel',
      sourceEventId: null,
      previousLineCount: startLineNo - 1,
      importedLineCount: appended.length,
      rowIssues,
      actor: envelope.issuedBy,
    };
    const validatedPayload: ListingLineValidatedPayload = {
      workOrderId,
      kind,
      sheetId: sheet.id,
      summary,
      lines: appended.map((line, index): ListingLineValidatedLinePayload => {
        const judgment = judgments[index] as MaterialJudgmentShape;
        return {
          lineId: line.id,
          lineNo: line.lineNo,
          code: line.code,
          name: line.name,
          spec: line.spec,
          judgment: judgment.judgment,
          candidateItemId: judgment.candidateItemId,
          candidateItemCode: judgment.candidateItemCode,
          similarity: judgment.similarity,
          basis: judgment.basis,
        };
      }),
      actor: envelope.issuedBy,
    };
    const events: BusinessEvent[] = [
      makeListingImportedEvent(this.domainEventBase(envelope), importPayload),
      makeListingLineValidatedEvent(this.domainEventBase(envelope), validatedPayload),
    ];
    for (const event of events) {
      await this.domainEvents.append(event);
    }

    return {
      status: 'committed',
      newRevision: 1, // 导入是清单聚合的新事实组，不推进单据头状态机版本（无状态机）
      events,
      todosCreated: [],
      todosCompleted: [],
      sheets: [sheet],
      lines: appended,
      rowIssues,
    };
  }

  // ---- listing.line.update ----

  private async updateLine(
    envelope: CommandEnvelope<ListingCommand>,
    lineId: string,
  ): Promise<ListingCommandResult> {
    const payload = parseUpdateListingLinePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const line = await this.lines.find(tenant, lineId);
    if (line === null) {
      return rejected(`租户 '${tenant}' 内不存在清单行 '${lineId}'`);
    }
    if (envelope.expectedRevision !== line.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，清单行当前 objectVersion=${line.objectVersion}`,
      );
    }

    if (payload.equipmentRef !== undefined || payload.origin !== undefined) {
      const fault = await this.validateEquipment(tenant, line.workOrderId, line.kind, payload.equipmentRef ?? line.equipmentRef ?? null, payload.origin ?? line.origin ?? 'production');
      if (fault) return rejected(fault);
      if (this.options.canRelinkEquipment && !(await this.options.canRelinkEquipment(tenant, line.workOrderId, line.itemId))) return rejected('此物料已有预占或发料关联，不能改绑设备或来源；请先按原流程撤销关联。');
    }
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: LISTING_LINE_AGGREGATE_TYPE,
      aggregateId: lineId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 校验重置口径：物料三要素任一变更 → pending + 清候选/确认；只改数量/日期/
    // 人工确认 itemId → 保留校验态（人工确认 = suspected 候选的最终裁定）。
    const materialChanged =
      payload.code !== undefined || payload.name !== undefined || payload.spec !== undefined;
    const validationReset = materialChanged;
    const fields: UpdateListingLineFields = materialChanged
      ? {
          ...payload,
          validationStatus: 'pending',
          candidateItemId: null,
          candidateItemCode: null,
          similarity: 0,
          basis: null,
          ...(payload.itemId === undefined ? { itemId: null } : {}),
        }
      : { ...payload };

    const updated = await this.lines.update(tenant, lineId, line.objectVersion, fields);
    if (updated === null) {
      return rejected(
        `清单行 '${lineId}' 版本推进冲突：期望 ${line.objectVersion}（可能存在并发写入，拒绝继续）`,
      );
    }

    const changes: Record<string, unknown> = {};
    const updatedRecord = updated as unknown as Record<string, unknown>;
    const fieldsRecord = fields as unknown as Record<string, unknown>;
    for (const key of [
      'equipmentRef', 'origin', 'drawingNo', 'code', 'name', 'spec', 'itemId', 'requiredQty', 'neededBy',
      'validationStatus', 'candidateItemId', 'candidateItemCode', 'similarity', 'basis',
    ] as const) {
      if (fieldsRecord[key] !== undefined) {
        changes[key] = updatedRecord[key];
      }
    }
    const eventPayload: ListingLineUpdatedPayload = {
      changes,
      validationReset,
      objectVersion: updated.objectVersion,
      actor: envelope.issuedBy,
    };
    const event = makeListingLineUpdatedEvent(this.domainEventBase(envelope), eventPayload, lineId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: updated.objectVersion,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      lines: [updated],
    };
  }

  // ---- gap.check ----

  private async checkGap(
    envelope: CommandEnvelope<ListingCommand>,
    workOrderId: string,
  ): Promise<ListingCommandResult> {
    parseGapCheckPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const scope = this.options.gapScopeKinds;
    const allLines = (await this.lines.listByWorkOrder(tenant, workOrderId)).filter((line) =>
      (scope as readonly string[]).includes(line.kind) && line.origin !== 'aftermarket',
    );
    if (this.options.equipmentSource && allLines.some((line) => line.kind !== 'equipment' && !line.equipmentRef)) return rejected('生产清单存在未关联设备的旧行，请先补齐真实关联后核查；不会自动补设备。');
    const resolved = allLines.filter((line) => line.itemId !== null);
    const itemIds = [...new Set(resolved.map((line) => line.itemId as string))];
    // 利库供给基数 = 跨仓可用 + 本令 issue 订单级锚活跃预占（本令已预占部分仍属
    // 本令可供给——重复核查不自我挤占，口径镜像 issue 四数量"预占+料品可用"；
    // 未接线 own=0，行为同旧"纯可用量"口径）。
    const [available, ownReserved] = await Promise.all([
      this.ports.inventory.availableQty(tenant, itemIds),
      this.ports.useReservation.reservedForWorkOrder(tenant, workOrderId, itemIds),
    ]);
    const supply = new Map(
      itemIds.map((itemId) => [itemId, (available.get(itemId) ?? 0) + (ownReserved.get(itemId) ?? 0)]),
    );

    const gapLines: GapLine[] = [];
    const kinds: GapKindSummary[] = scope.map((kind) => {
      const kindLines = allLines.filter((line) => line.kind === kind);
      const kindResolved = kindLines.filter((line) => line.itemId !== null);
      let gapLineCount = 0;
      for (const line of kindResolved) {
        const availableQty = supply.get(line.itemId as string) ?? 0;
        const gapQty = Math.max(0, line.requiredQty - availableQty);
        if (gapQty > 0) {
          gapLineCount += 1;
          gapLines.push({
            kind: line.kind,
            listingLineId: line.id,
            itemId: line.itemId as string,
            drawingNo: line.drawingNo,
            requiredQty: line.requiredQty,
            availableQty,
            gapQty,
            neededBy: line.neededBy,
          });
        }
      }
      return {
        kind,
        lineCount: kindLines.length,
        checkedLineCount: kindResolved.length,
        gapLineCount,
        complete: kindLines.length > 0 && gapLineCount === 0,
      };
    });
    gapLines.sort((a, b) => a.kind.localeCompare(b.kind) || a.itemId.localeCompare(b.itemId));
    // 整单与类目级 complete 同口径：须以"确有清单行被核查"为前提——0 行时差集
    // 恒空，直接判 complete=true 属 vacuous truth（UX-PLAN-03 Round-2 复测裁决：
    // 0 行类目不得标「齐套」，读面显示「无清单行/未参与核查」）。含 pending 行
    // 的类目维持"可解析口径下无缺口"判 true（测试钉住语义）。
    const complete = allLines.length > 0 && gapLines.length === 0;

    const gapCheckId = newGapCheckId();

    // 利库预占创建（端口先行：拒绝则整单 rejected 不落任何账——体例同
    // purchase.order.receive 入库指令先行）。目标量 = min(Σ需求, 供给基数)：
    // 适配方按锚点既有活跃预占折差新建（幂等收敛，重复核查不重复预占）；
    // 作用类目 = 发料可核销三类（equipment 不走预占账，见 GAP_RESERVE_SCOPE_KINDS）。
    const demandTotals = new Map<string, { itemId: string; equipmentRef: string | null; quantity: number }>();
    const reserveScope = GAP_RESERVE_SCOPE_KINDS;
    for (const line of resolved) {
      if (!(reserveScope as readonly string[]).includes(line.kind)) continue;
      const itemId = line.itemId as string;
      const equipmentRef = line.equipmentRef ?? null;
      const key = JSON.stringify([equipmentRef, itemId]);
      demandTotals.set(key, { itemId, equipmentRef, quantity: (demandTotals.get(key)?.quantity ?? 0) + line.requiredQty });
    }
    const reserveLines: InventoryUseReserveLineReceipt[] = [];
    const reservable = new Map(supply);
    for (const key of [...demandTotals.keys()].sort()) {
      const { itemId, equipmentRef, quantity } = demandTotals.get(key)!;
      const useTotal = Math.min(quantity, reservable.get(itemId) ?? 0);
      reservable.set(itemId, (reservable.get(itemId) ?? 0) - useTotal);
      if (useTotal <= 0) continue;
      const receipt = await this.ports.useReservation.reserveForWorkOrder(tenant, {
        workOrderId,
        ...(equipmentRef === null ? {} : { equipmentRef }),
        itemId,
        quantity: useTotal,
        gapCheckId,
      });
      if (!receipt.reserved) {
        return rejected(
          `利库预占被拒绝（物料 '${itemId}'）：${receipt.refusedReason ?? 'inventory 端口未说明原因'}`,
        );
      }
      reserveLines.push(...(receipt.created ?? []));
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: GAP_CHECK_AGGREGATE_TYPE,
      aggregateId: gapCheckId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const snapshot = await this.gapChecks.append({
      tenant,
      id: gapCheckId,
      workOrderId,
      kinds,
      gapLines,
      complete,
      checkedBy: envelope.issuedBy,
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    });

    const payload: GapCheckedPayload = { workOrderId, kinds, gapLines, complete, actor: envelope.issuedBy };
    const event = makeGapCheckedEvent(this.domainEventBase(envelope), payload, gapCheckId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1, // 快照是独立事实（v1 一条），不挂任何状态机版本
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      gapCheck: snapshot,
      ...(reserveLines.length > 0 ? { reservations: reserveLines } : {}),
    };
  }

  // ---- purchase.request.create ----

  private async createPurchaseRequest(
    envelope: CommandEnvelope<ListingCommand>,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseRequestCreatePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    let workOrderId = payload.workOrderId;
    const gapSource = payload.source.type === 'gap' ? payload.source : null;
    if (gapSource !== null) {
      const snapshot = await this.gapChecks.find(tenant, gapSource.gapCheckId);
      if (snapshot === null) {
        return rejected(`缺口核查快照 '${gapSource.gapCheckId}' 不存在（一键发起锚点失效）`);
      }
      const gapLine = snapshot.gapLines.find((line) => line.listingLineId === gapSource.listingLineId);
      if (gapLine === undefined) {
        return rejected(`缺口快照 '${gapSource.gapCheckId}' 不含清单行 '${gapSource.listingLineId}'`);
      }
      if (workOrderId === null) workOrderId = snapshot.workOrderId;
    }

    const requestId = newPurchaseRequestId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: PURCHASE_REQUEST_AGGREGATE_TYPE,
      aggregateId: requestId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const created = await this.requests.create({
      tenant,
      id: requestId,
      workOrderId,
      kind: payload.kind,
      flowConfigId: this.options.requestConfig.flowId,
      state: this.options.requestConfig.initial, // draft：初始态落库，无机器事件
      objectVersion: 1,
      itemId: payload.itemId,
      quantity: payload.quantity,
      requester: envelope.issuedBy,
      remark: payload.remark,
      source: payload.source,
    });

    const payloadOut: PurchaseRequestedPayload = {
      workOrderId,
      kind: payload.kind,
      itemId: payload.itemId,
      quantity: payload.quantity,
      source: payload.source,
      remark: payload.remark,
      objectVersion: 1,
      actor: envelope.issuedBy,
    };
    const event = makePurchaseRequestedEvent(this.domainEventBase(envelope), payloadOut, requestId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      purchaseRequest: created,
    };
  }

  // ---- purchase.order.submit（建单 + 提交 + 审批待办） ----

  private async submitOrder(
    envelope: CommandEnvelope<ListingCommand>,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseOrderSubmitPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    for (const requestId of payload.requestIds) {
      const request = await this.requests.find(tenant, requestId);
      if (request === null) {
        return rejected(`采购申请 '${requestId}' 不存在（订单承接申请必须真实存在）`);
      }
      if (request.flowConfigId !== this.options.requestConfig.flowId) {
        return rejected(
          `采购申请 '${requestId}' 由配置 '${request.flowConfigId}' 驱动，与当前装配配置 '${this.options.requestConfig.flowId}' 不符`,
        );
      }
      if (request.state !== this.options.requestConfig.initial) {
        return rejected(`采购申请 '${requestId}' 当前状态 '${request.state}' 不可承接（须为 draft）`);
      }
      if (request.purchaseOrderId !== null) {
        return rejected(`采购申请 '${requestId}' 已被订单 '${request.purchaseOrderId}' 承接`);
      }
    }

    const orderId = newPurchaseOrderId();
    // 落账顺序（体例同申请/退货单创建 + PG 机器账本租户解析合同）：先落
    // draft@v1 投影行（初始态无机器事件），再驱动 SUBMIT 迁移、append 机器
    // 事件账本（投影行已在，租户可解析）、乐观推进投影至 submitted@v2——
    // 投影行先在是机器事件 append 的前置（pg-listing-stores 孤儿账目拒写）。
    const submitRule = this.options.orderConfig.transitions.find(
      (candidate) => candidate.from === this.options.orderConfig.initial && candidate.event === 'SUBMIT',
    );
    if (submitRule === undefined) {
      return rejected(
        `初始态 '${this.options.orderConfig.initial}' 不支持提交（配置无 SUBMIT 规则）`,
      );
    }
    const runtime = startApprovalFlow({
      config: this.options.orderConfig,
      subject: { aggregate: { id: orderId, type: PURCHASE_ORDER_AGGREGATE_TYPE }, initialObjectVersion: 1 },
      now: () => this.now(),
      newEventId: () => EventId.create(newDomainEventId()),
    });
    try {
      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PURCHASE_ORDER_AGGREGATE_TYPE,
        aggregateId: orderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      const lines: PurchaseOrderLine[] = payload.lines.map((line, index) => ({
        lineNo: index + 1,
        itemId: line.itemId,
        drawingNo: line.drawingNo,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        receivedQty: 0,
      }));
      await this.orders.create({
        tenant,
        id: orderId,
        workOrderId: payload.workOrderId,
        flowConfigId: this.options.orderConfig.flowId,
        state: this.options.orderConfig.initial, // draft：初始态落库，无机器事件
        objectVersion: 1,
        supplierRef: payload.supplierRef,
        supplierName: payload.supplierName,
        promisedAt: payload.promisedAt,
        lines,
        requestIds: [...payload.requestIds],
        buyer: payload.buyer,
        remark: payload.remark,
      });
      if (payload.requestIds.length > 0) {
        await this.requests.linkOrder(tenant, payload.requestIds, orderId);
      }

      const outcome = runtime.send('SUBMIT', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '采购订单提交',
        objectVersion: 1,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`采购订单提交失败：draft 对 SUBMIT 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        tenant,
        orderId,
        1,
        runtime.state(),
        runtime.objectVersion(),
      );

      const payloadOut: PurchaseOrderSubmittedPayload = {
        workOrderId: payload.workOrderId,
        supplierRef: payload.supplierRef,
        supplierName: payload.supplierName,
        promisedAt: payload.promisedAt,
        lines: advanced.lines,
        requestIds: [...payload.requestIds],
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePurchaseOrderTransitionedEvent(this.domainEventBase(envelope), payloadOut, orderId);
      await this.domainEvents.append(event);

      // 待办联动：订单提交进审批待办（Done-when；指派对象 = 配置化审批人）。
      const todosCreated: TodoItem[] = [];
      if (this.options.orderApprover !== null) {
        todosCreated.push(
          await this.todos.create({
            tenant,
            assignee: this.options.orderApprover,
            title: `采购订单待审批：${payload.supplierName ?? payload.supplierRef ?? orderId}（交期 ${payload.promisedAt.slice(0, 10)}）`,
            source: LISTING_TODO_SOURCE,
            refType: PURCHASE_ORDER_AGGREGATE_TYPE,
            refId: orderId,
          }),
        );
      }

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated,
        todosCompleted: [],
        purchaseOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- purchase.order.approve（决策迁移 + 申请 draft→approved） ----

  private async approveOrder(
    envelope: CommandEnvelope<ListingCommand>,
    orderId: string,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseOrderDecisionPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const order = await this.orders.find(tenant, orderId);
    if (order === null) {
      return rejected(`租户 '${tenant}' 内不存在采购订单 '${orderId}'`);
    }
    if (order.flowConfigId !== this.options.orderConfig.flowId) {
      return rejected(
        `订单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.orderConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，订单当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const rule = this.options.orderConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'APPROVE',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持审批决策（配置无 APPROVE 规则——审核链层级见 listing-config）`);
      }
      const outcome = runtime.send('APPROVE', {
        by: envelope.issuedBy,
        reason: payload.remark,
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 的审批决策未迁移（${outcome.status}）`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PURCHASE_ORDER_AGGREGATE_TYPE,
        aggregateId: orderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        tenant,
        orderId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      // 申请联动：draft → approved（初版口径，随订单批准推进）。
      const requestsApproved = await this.advanceRequests(
        tenant,
        order.requestIds,
        'APPROVE',
        envelope.issuedBy,
        payload.remark,
      );

      const payloadOut: PurchaseOrderApprovedPayload = {
        remark: payload.remark,
        requestsApproved,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePurchaseOrderTransitionedEvent(this.domainEventBase(envelope), payloadOut, orderId);
      await this.domainEvents.append(event);

      // 审批人名下该订单的提交待办自动完成。
      const todosCompleted =
        this.options.orderApprover !== null
          ? await this.completeTodosFor(tenant, this.options.orderApprover, PURCHASE_ORDER_AGGREGATE_TYPE, orderId)
          : [];

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        purchaseOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- purchase.order.issue（下发 + 申请 approved→converted） ----

  private async issueOrder(
    envelope: CommandEnvelope<ListingCommand>,
    orderId: string,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseOrderIssuePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const order = await this.orders.find(tenant, orderId);
    if (order === null) {
      return rejected(`租户 '${tenant}' 内不存在采购订单 '${orderId}'`);
    }
    if (order.flowConfigId !== this.options.orderConfig.flowId) {
      return rejected(
        `订单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.orderConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，订单当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const rule = this.options.orderConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'ISSUE',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持下发（仅已审核态可下发，配置无 ISSUE 规则）`);
      }
      const outcome = runtime.send('ISSUE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '采购订单下发',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 ISSUE 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PURCHASE_ORDER_AGGREGATE_TYPE,
        aggregateId: orderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        tenant,
        orderId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      // 申请联动：approved → converted（转单完成）。
      const requestsConverted = await this.advanceRequests(
        tenant,
        order.requestIds,
        'CONVERT',
        envelope.issuedBy,
        payload.remark ?? '订单下发转单',
      );

      const payloadOut: PurchaseOrderIssuedPayload = {
        remark: payload.remark,
        requestsConverted,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePurchaseOrderTransitionedEvent(this.domainEventBase(envelope), payloadOut, orderId);
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted: [],
        purchaseOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- purchase.order.receive（入库指令端口先行 + received） ----

  private async receiveOrder(
    envelope: CommandEnvelope<ListingCommand>,
    orderId: string,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseOrderReceivePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const order = await this.orders.find(tenant, orderId);
    if (order === null) {
      return rejected(`租户 '${tenant}' 内不存在采购订单 '${orderId}'`);
    }
    if (order.flowConfigId !== this.options.orderConfig.flowId) {
      return rejected(
        `订单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.orderConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，订单当前 objectVersion=${order.objectVersion}`,
      );
    }

    // 收货明细校验：行号存在、不超订（初版口径：一次收货定稿各行已收数量）。
    const receivedByLineNo = new Map(payload.lines.map((line) => [line.lineNo, line.receivedQty]));
    for (const [lineNo, receivedQty] of receivedByLineNo) {
      const orderLine = order.lines.find((line) => line.lineNo === lineNo);
      if (orderLine === undefined) {
        return rejected(`订单 '${orderId}' 不存在明细行 ${lineNo}`);
      }
      if (receivedQty > orderLine.quantity) {
        return rejected(`收货数量超订：行 ${lineNo} 收 ${receivedQty} > 订 ${orderLine.quantity}`);
      }
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const rule = this.options.orderConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'RECEIVE',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持收货（仅已下发态可收货，配置无 RECEIVE 规则）`);
      }

      // 入库指令端口先行：拒绝则命令整体 rejected，不落任何账。端口按 receiptKey
      // 幂等（重试不重复入库）——合同见 listing-ports.ts。
      const receipts: { readonly receiptKey: string; readonly received: boolean }[] = [];
      for (const [lineNo, receivedQty] of receivedByLineNo) {
        if (receivedQty <= 0) continue; // 0 数量行不下入库指令
        const orderLine = order.lines.find((line) => line.lineNo === lineNo) as PurchaseOrderLine;
        const receipt = await this.ports.receipt.receivePurchase(tenant, {
          receiptKey: `${orderId}#${lineNo}`,
          purchaseOrderId: orderId,
          itemId: orderLine.itemId,
          quantity: receivedQty,
          // D-15：载荷显式收货仓透传（null = 省略字段 → inventory 服务选项回落；
          // exactOptionalPropertyTypes 下不显式传 undefined）。
          ...(payload.warehouseId !== null ? { warehouseId: payload.warehouseId } : {}),
        });
        if (!receipt.received) {
          return rejected(`入库指令被拒绝（行 ${lineNo}）：${receipt.refusedReason ?? 'inventory 端口未说明原因'}`);
        }
        receipts.push({ receiptKey: `${orderId}#${lineNo}`, received: true });
      }

      const outcome = runtime.send('RECEIVE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '采购收货',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 RECEIVE 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PURCHASE_ORDER_AGGREGATE_TYPE,
        aggregateId: orderId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const newLines = order.lines.map((line) => {
        const receivedQty = receivedByLineNo.get(line.lineNo);
        return receivedQty === undefined ? line : { ...line, receivedQty };
      });
      const advanced = await this.orders.advance(
        tenant,
        orderId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { lines: newLines, receiptRef: payload.receiptRef },
      );

      const payloadOut: PurchaseOrderReceivedPayload = {
        lines: newLines
          .filter((line) => receivedByLineNo.has(line.lineNo))
          .map((line) => ({ lineNo: line.lineNo, itemId: line.itemId, receivedQty: line.receivedQty })),
        receiptRef: payload.receiptRef,
        receipts,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePurchaseOrderTransitionedEvent(this.domainEventBase(envelope), payloadOut, orderId);
      await this.domainEvents.append(event);

      // 收货→三类采购质检来源投递（RQ-019；通知式——失败不阻塞不回滚收货）。
      await this.deliverReceiptInspection(tenant, order, receivedByLineNo, envelope.issuedBy);

      // 待办联动：收货消催货（buyer 名下该订单的逾期催货待办自动完成）。
      const todosCompleted =
        advanced.buyer !== null
          ? await this.completeTodosFor(tenant, advanced.buyer, PURCHASE_ORDER_AGGREGATE_TYPE, orderId)
          : [];

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        purchaseOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- 收货→采购质检来源投递（RQ-019；通知式合同沿 U6 #29 体例） ----

  /**
   * 逐收货行投递采购质检来源事实（advance + 域事件落账后调用）：触发行 = 本次
   * 收货数量 > 0 的行；投递失败仅 console.warn 不回滚收货（回执 created:false
   * 是幂等命中/非覆盖面正常路径，不告警）。
   */
  private async deliverReceiptInspection(
    tenant: TenantId,
    order: PurchaseOrder,
    receivedByLineNo: ReadonlyMap<number, number>,
    triggeredBy: UserId,
  ): Promise<void> {
    for (const [lineNo, receivedQty] of receivedByLineNo) {
      if (receivedQty <= 0) continue; // 触发行：本次收货数量 > 0
      const line = order.lines.find((entry) => entry.lineNo === lineNo);
      if (line === undefined) continue; // 防御（receive 明细校验已保证行存在）
      const kind = await this.resolvePurchaseInspectionKind(tenant, order.requestIds, line.itemId);
      if (kind === null) {
        console.warn(
          `[smes] 收货行质检投递跳过（订单 '${order.id}' 行 ${lineNo}：无申请承接/kind 歧义，无法推导采购质检类——RQ-019 只收显式三类采购事实）`,
        );
        continue;
      }
      try {
        await this.ports.inspectionIntake.receiveSourceFact(tenant, {
          sourceType: 'receipt',
          sourceRefId: `${order.id}#${lineNo}`, // 复用 receiptKey 幂等键约定
          kind,
          itemId: line.itemId,
          drawingNo: line.drawingNo,
          quantity: receivedQty,
          workOrderId: order.workOrderId,
          occurredAt: this.now(),
          triggeredBy,
        });
      } catch (error) {
        console.warn(
          `[smes] 收货行质检投递失败（通知式合同，不回滚收货；订单 '${order.id}' 行 ${lineNo}）:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * 申请链 kind 推导：订单承接申请按 itemId 匹配（申请单物料）去重后恰一个
   * kind → 映射采购质检 kind；无申请/无匹配/多 kind 歧义 → null（该行不投递）。
   */
  private async resolvePurchaseInspectionKind(
    tenant: TenantId,
    requestIds: readonly string[],
    itemId: string,
  ): Promise<InspectionKind | null> {
    const kinds = new Set<string>();
    for (const requestId of requestIds) {
      const request = await this.requests.find(tenant, requestId);
      if (request === null || request.itemId !== itemId) continue;
      kinds.add(request.kind);
    }
    const [only] = kinds;
    if (kinds.size !== 1 || only === undefined) return null;
    return REQUEST_KIND_TO_INSPECTION_KIND[only] ?? null;
  }

  // ---- purchase.return.create（建退货单 + 订单退货回退） ----

  private async createReturn(
    envelope: CommandEnvelope<ListingCommand>,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseReturnCreatePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const order = await this.orders.find(tenant, payload.purchaseOrderId);
    if (order === null) {
      return rejected(`租户 '${tenant}' 内不存在采购订单 '${payload.purchaseOrderId}'`);
    }
    if (order.flowConfigId !== this.options.orderConfig.flowId) {
      return rejected(
        `订单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.orderConfig.flowId}' 不符`,
      );
    }
    if (order.state !== 'received') {
      return rejected(`订单 '${payload.purchaseOrderId}' 当前状态 '${order.state}' 不可退货（仅已收货态）`);
    }
    for (const line of payload.lines) {
      const orderLine = order.lines.find((entry) => entry.lineNo === line.lineNo);
      if (orderLine === undefined) {
        return rejected(`订单 '${payload.purchaseOrderId}' 不存在明细行 ${line.lineNo}`);
      }
      if (line.returnedQty > orderLine.receivedQty) {
        return rejected(`退货数量超收货：行 ${line.lineNo} 退 ${line.returnedQty} > 收 ${orderLine.receivedQty}`);
      }
    }
    const returnLines: PurchaseReturnLine[] = payload.lines.map((line) => ({
      lineNo: line.lineNo,
      itemId: order.lines.find((orderLine) => orderLine.lineNo === line.lineNo)?.itemId ?? '',
      returnedQty: line.returnedQty,
      reason: line.reason,
    }));

    const returnId = newPurchaseReturnId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: PURCHASE_RETURN_AGGREGATE_TYPE,
      aggregateId: returnId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 订单退货回退：received --RETURN--> issued（重收口径见 listing-config 头注）。
    const runtime = await this.replayOrder(order);
    try {
      const outcome = runtime.send('RETURN', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '收货异常退货',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`订单退货回退失败：received 对 RETURN 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);
      const rolledBack = await this.orders.advance(
        tenant,
        order.id,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const created = await this.returns.create({
        tenant,
        id: returnId,
        purchaseOrderId: order.id,
        flowConfigId: this.options.returnConfig.flowId,
        state: this.options.returnConfig.initial, // open：初始态落库，无机器事件
        objectVersion: 1,
        lines: returnLines,
        returnedBy: envelope.issuedBy,
        remark: payload.remark,
      });

      const payloadOut: PurchaseReturnedPayload = {
        purchaseOrderId: order.id,
        lines: returnLines,
        orderRolledBackTo: runtime.state(),
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePurchaseReturnedEvent(this.domainEventBase(envelope), payloadOut, returnId);
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: 1,
        events: [event],
        todosCreated: [],
        todosCompleted: [],
        purchaseOrder: rolledBack,
        purchaseReturn: created,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- purchase.return.revoke（撤销退货单） ----

  private async revokeReturn(
    envelope: CommandEnvelope<ListingCommand>,
    returnId: string,
  ): Promise<ListingCommandResult> {
    const payload = parsePurchaseReturnRevokePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const purchaseReturn = await this.returns.find(tenant, returnId);
    if (purchaseReturn === null) {
      return rejected(`租户 '${tenant}' 内不存在退货单 '${returnId}'`);
    }
    if (purchaseReturn.flowConfigId !== this.options.returnConfig.flowId) {
      return rejected(
        `退货单由配置 '${purchaseReturn.flowConfigId}' 驱动，与当前装配配置 '${this.options.returnConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== purchaseReturn.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，退货单当前 objectVersion=${purchaseReturn.objectVersion}`,
      );
    }

    const runtime = await this.replayReturn(purchaseReturn);
    try {
      const from = runtime.state();
      const rule = this.options.returnConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'REVOKE',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持撤销（配置无 REVOKE 规则）`);
      }
      const outcome = runtime.send('REVOKE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '退货单撤销',
        objectVersion: purchaseReturn.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 REVOKE 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PURCHASE_RETURN_AGGREGATE_TYPE,
        aggregateId: returnId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.returns.advance(
        tenant,
        returnId,
        purchaseReturn.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );
      // 撤销不另发域事件：合同事件词汇面只登记 PurchaseReturned；撤销事实由
      // 机器账本（REVOKE 迁移事件）承载，订单侧重收路径不受影响。

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [],
        todosCreated: [],
        todosCompleted: [],
        purchaseReturn: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- purchase.overdue.scan（逾期事实：交期对比） ----

  private async scanOverdue(
    envelope: CommandEnvelope<ListingCommand>,
  ): Promise<ListingCommandResult> {
    parseOverdueScanPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const now = this.now();
    const candidates = (await this.orders.list(tenant)).filter(
      (order) => OVERDUE_OPEN_STATES.has(order.state) && Date.parse(order.promisedAt) < Date.parse(now),
    );

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: PURCHASE_ORDER_AGGREGATE_TYPE,
      aggregateId: 'overdue-scan',
      occurredAt: now,
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const events: BusinessEvent[] = [];
    const todosCreated: TodoItem[] = [];
    const overdueRows: PurchaseOverdueRow[] = [];
    for (const order of candidates) {
      const daysOverdue = Math.trunc((Date.parse(now) - Date.parse(order.promisedAt)) / 86_400_000);
      const payloadOut: PurchaseOverduePayload = {
        workOrderId: order.workOrderId,
        supplierName: order.supplierName,
        promisedAt: order.promisedAt,
        daysOverdue,
        state: order.state,
        objectVersion: order.objectVersion,
        actor: envelope.issuedBy,
      };
      events.push(makePurchaseOverdueEvent(this.domainEventBase(envelope), payloadOut, order.id));
      overdueRows.push({
        purchaseOrderId: order.id,
        workOrderId: order.workOrderId,
        supplierName: order.supplierName,
        promisedAt: order.promisedAt,
        state: order.state,
        daysOverdue,
      });
      // 催货待办（去重：同订单已有 open 催货待办不重复派——重复扫描不刷屏）。
      if (order.buyer !== null && !(await this.hasOpenOrderTodo(tenant, order.buyer, order.id))) {
        todosCreated.push(
          await this.todos.create({
            tenant,
            assignee: order.buyer,
            title: `采购催货：${order.supplierName ?? order.supplierRef ?? order.id} 逾期 ${daysOverdue} 天（交期 ${order.promisedAt.slice(0, 10)}）`,
            source: LISTING_TODO_SOURCE,
            refType: PURCHASE_ORDER_AGGREGATE_TYPE,
            refId: order.id,
          }),
        );
      }
    }
    for (const event of events) {
      await this.domainEvents.append(event);
    }

    return {
      status: 'committed',
      newRevision: 1, // 扫描是事实产出组，不推进订单状态机版本
      events,
      todosCreated,
      todosCompleted: [],
      overdue: [...overdueRows].sort((a, b) => b.daysOverdue - a.daysOverdue), // 与 overdueList 同序
    };
  }

  // ---- 查询 ----

  /** 四类清单（按工作令；kind 声明序）。 */
  async sheetsByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingSheet[]> {
    return this.sheets.listByWorkOrder(tenant, workOrderId);
  }

  /** 清单详情：单据头 + 行（lineNo 升序）。 */
  async sheetDetail(
    tenant: TenantId,
    sheetId: string,
  ): Promise<{ readonly sheet: ListingSheet; readonly lines: readonly ListingLine[] }> {
    const sheet = await this.sheets.find(tenant, sheetId);
    if (sheet === null) {
      throw new ListingNotFoundError(`租户 '${tenant}' 内不存在清单 '${sheetId}'`);
    }
    return { sheet, lines: await this.lines.listBySheet(tenant, sheetId) };
  }

  /** 缺口核查结果：该工作令最新快照（无核查记录返回 null）。 */
  async latestGapCheck(tenant: TenantId, workOrderId: string): Promise<GapCheck | null> {
    return this.gapChecks.latestByWorkOrder(tenant, workOrderId);
  }

  /** 采购申请列表（可选状态/工作令/承接订单过滤）。 */
  async listRequests(
    tenant: TenantId,
    stateFilter?: string,
    workOrderId?: string,
    purchaseOrderId?: string,
  ): Promise<readonly PurchaseRequest[]> {
    return this.requests.list(tenant, {
      ...(stateFilter === undefined ? {} : { state: stateFilter }),
      ...(workOrderId === undefined ? {} : { workOrderId }),
      ...(purchaseOrderId === undefined ? {} : { purchaseOrderId }),
    });
  }

  /** 采购申请详情。 */
  async requestDetail(tenant: TenantId, requestId: string): Promise<PurchaseRequest> {
    const request = await this.requests.find(tenant, requestId);
    if (request === null) {
      throw new ListingNotFoundError(`租户 '${tenant}' 内不存在采购申请 '${requestId}'`);
    }
    return request;
  }

  /** 采购订单列表（可选状态/工作令过滤）。 */
  async listOrders(
    tenant: TenantId,
    stateFilter?: string,
    workOrderId?: string,
  ): Promise<readonly PurchaseOrder[]> {
    return this.orders.list(tenant, {
      ...(stateFilter === undefined ? {} : { state: stateFilter }),
      ...(workOrderId === undefined ? {} : { workOrderId }),
    });
  }

  /** 订单全流程视图：订单行 + 机器迁移里程碑 + 承接申请。 */
  async orderDetail(tenant: TenantId, orderId: string): Promise<PurchaseOrderDetail> {
    const order = await this.orders.find(tenant, orderId);
    if (order === null) {
      throw new ListingNotFoundError(`租户 '${tenant}' 内不存在采购订单 '${orderId}'`);
    }
    const page = await this.machineEvents.readByAggregate({
      id: orderId,
      type: PURCHASE_ORDER_AGGREGATE_TYPE,
    });
    const requests = await Promise.all(
      order.requestIds.map((requestId) => this.requests.find(tenant, requestId)),
    );
    return {
      order,
      milestones: machineMilestones(page.events),
      requests: requests.filter((request): request is PurchaseRequest => request !== null),
    };
  }

  /** 退货单列表（按订单）。 */
  async listReturns(tenant: TenantId, purchaseOrderId: string): Promise<readonly PurchaseReturn[]> {
    return this.returns.listByOrder(tenant, purchaseOrderId);
  }

  /** 逾期未交明细（事实查询；呈现归 engine-reporting，此处只出事实行）。 */
  async overdueList(tenant: TenantId): Promise<readonly PurchaseOverdueRow[]> {
    const now = this.now();
    return (await this.orders.list(tenant))
      .filter((order) => OVERDUE_OPEN_STATES.has(order.state) && Date.parse(order.promisedAt) < Date.parse(now))
      .map((order) => ({
        purchaseOrderId: order.id,
        workOrderId: order.workOrderId,
        supplierName: order.supplierName,
        promisedAt: order.promisedAt,
        state: order.state,
        daysOverdue: Math.trunc((Date.parse(now) - Date.parse(order.promisedAt)) / 86_400_000),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  /**
   * 逾期未交**明细行**（U8 事实查询，逾期交货采购件报表-开发文档：订单明细行级）：
   * 一行一采购订单明细行（orderLineId=订单#行号，与订单头粒度 overdueList 并存）。
   * 纳入：订单已进入采购链路（draft 不纳入——未下单不进逾期口径）且交期已过
   * （promisedAt < now，计划到货日当天即逾期），行未收齐（unInboundQty>0）——
   * receivedQty 为收货回填净完成量（纯外购净入库/外购加工净收货两分支统一到
   * 本域单口径）。无工作令订单行（手工采购，源 apply_source=4）同等纳入，
   * workOrderId/drawingNo 为 null（呈现层显示「—」）。固化留存（已收齐但曾
   * 晚于计划日完成、历史固化逾期数）依赖跑批历史，实时事实面不出，归快照
   * 波。默认序：交期升序（计划到货日 ASC）、orderLineId 稳定序。
   */
  async overdueLines(tenant: TenantId, workOrderId?: string): Promise<readonly PurchaseOverdueLineRow[]> {
    const now = this.now();
    // 状态纳入集口径登记（U8 验收发现 1）：文档字面"已下发及之后"映射为
    // state!=='draft'——与既有订单头粒度面 OVERDUE_OPEN_STATES 自洽（审批中单
    // 已进入采购链路、其行同样构成逾期敞口）；差异属映射取舍非隐藏行为，测试
    // 显式断言。快照面（跑批）落地时如需收窄到字面集，在此处与文档对账改判。
    const orders = (await this.orders.list(tenant, workOrderId === undefined ? undefined : { workOrderId })).filter(
      (order) => order.state !== 'draft' && Date.parse(order.promisedAt) < Date.parse(now),
    );
    const rows: PurchaseOverdueLineRow[] = [];
    for (const order of orders) {
      for (const line of order.lines) {
        const unInboundQty = Math.max(0, line.quantity - line.receivedQty);
        if (unInboundQty <= 0) continue; // 已收齐行退出（留存条件归快照波）
        rows.push({
          orderLineId: `${order.id}#${String(line.lineNo)}`,
          purchaseOrderId: order.id,
          lineNo: line.lineNo,
          workOrderId: order.workOrderId,
          itemId: line.itemId,
          drawingNo: line.drawingNo,
          quantity: line.quantity,
          receivedQty: line.receivedQty,
          unInboundQty,
          supplierName: order.supplierName,
          promisedAt: order.promisedAt,
          state: order.state,
          stateLabel: purchaseOrderStateLabel(order.state),
          daysOverdue: Math.trunc((Date.parse(now) - Date.parse(order.promisedAt)) / 86_400_000),
        });
      }
    }
    return rows.sort(
      (a, b) => a.promisedAt.localeCompare(b.promisedAt) || a.orderLineId.localeCompare(b.orderLineId),
    );
  }

  /** 采购明细行集 + 金额汇总（对账要点：Σ 已收数量 × 单价，未定价行计 0）。 */
  async receivingWarehouseOptions(tenant: TenantId) { return this.options.receivingWarehouses?.(tenant) ?? []; }

  async purchaseDetails(tenant: TenantId, workOrderId?: string): Promise<PurchaseDetailRows> {
    const orders = await this.orders.list(
      tenant,
      workOrderId === undefined ? undefined : { workOrderId },
    );
    const rows: PurchaseDetailRow[] = [];
    for (const order of orders) {
      for (const line of order.lines) {
        rows.push({
          purchaseOrderId: order.id,
          state: order.state,
          stateLabel: purchaseOrderStateLabel(order.state),
          workOrderId: order.workOrderId,
          supplierName: order.supplierName,
          lineNo: line.lineNo,
          itemId: line.itemId,
          drawingNo: line.drawingNo,
          quantity: line.quantity,
          receivedQty: line.receivedQty,
          unitPriceMinor: line.unitPriceMinor,
          amountMinor: line.receivedQty * (line.unitPriceMinor ?? 0),
          promisedAt: order.promisedAt,
        });
      }
    }
    return { rows, totalAmountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0) };
  }

  /** 采购明细导出（ExcelPort 序列化——json-tables 回声 / ExcelJS 字节）。 */
  async exportPurchaseDetails(tenant: TenantId, workOrderId?: string): Promise<ExcelExport> {
    const details = await this.purchaseDetails(tenant, workOrderId);
    const sheet: ExcelSheet = {
      name: '采购明细',
      header: [
        '采购订单', '状态', '工作令', '供应商', '行号', '物料', '图号',
        '订购数量', '已收数量', '单价(分)', '金额(分)', '交期',
      ],
      rows: details.rows.map((row) => [
        row.purchaseOrderId,
        row.stateLabel,
        row.workOrderId ?? '',
        row.supplierName ?? '',
        String(row.lineNo),
        row.itemId,
        row.drawingNo ?? '',
        String(row.quantity),
        String(row.receivedQty),
        row.unitPriceMinor === null ? '' : String(row.unitPriceMinor),
        String(row.amountMinor),
        row.promisedAt.slice(0, 10),
      ]),
    };
    return this.ports.excel.exportWorkbook([sheet]);
  }

  /** 清单需求行投影（workorder 齐套消费面；仅 itemId 已解析行）。 */
  async requirementLines(
    tenant: TenantId,
    workOrderId: string,
  ): Promise<
    readonly {
      readonly kind: ListingKind;
      readonly itemId: string;
      readonly drawingNo: string | null;
      readonly requiredQty: number;
      readonly neededBy: string | null;
    }[]
  > {
    const lines = (await this.lines.listByWorkOrder(tenant, workOrderId)).filter((line) => line.origin !== 'aftermarket');
    return lines
      .filter((line) => line.itemId !== null)
      .map((line) => ({
        kind: line.kind,
        itemId: line.itemId as string,
        drawingNo: line.drawingNo,
        requiredQty: line.requiredQty,
        neededBy: line.neededBy,
      }));
  }

  /**
   * A9 下图统计（只读实时汇总，工作令-下图统计-开发文档）：零件清单明细行在
   * 创建日闭区间内的行数 COUNT——同一图号多次上传按行计（不去重）、不按
   * 工作令/设备拆分、无分页、**恒一行结果**（无匹配行 drawingCount=0）。
   * timeRange：起止均有 `${起} ~ ${止}`；均无「全部」；仅一侧（极少——产品
   * 默认始终传闭区间）只显示已传侧。行存储端口未实现计数（可选成员缺省，
   * PG 适配器未合流）时显式拒绝，不静默回 0。
   */
  async partUploadStats(
    tenant: TenantId,
    createTimeStart?: string,
    createTimeEnd?: string,
  ): Promise<{ readonly timeRange: string; readonly drawingCount: number }> {
    const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
    const bounds = [
      ['createTimeStart', createTimeStart],
      ['createTimeEnd', createTimeEnd],
    ] as const;
    for (const [name, day] of bounds) {
      if (day !== undefined && !dayPattern.test(day)) {
        throw new ListingInputError(`${name} 须为 yyyy-MM-dd（收到 '${day}'）`);
      }
    }
    if (createTimeStart !== undefined && createTimeEnd !== undefined && createTimeStart > createTimeEnd) {
      throw new ListingInputError(`上传日期范围不正确：起 ${createTimeStart} 大于止 ${createTimeEnd}`);
    }
    const drawingCount = await this.lines.countPartLinesCreatedBetween?.(tenant, {
      ...(createTimeStart !== undefined ? { fromDay: createTimeStart } : {}),
      ...(createTimeEnd !== undefined ? { toDay: createTimeEnd } : {}),
    });
    if (drawingCount === undefined) {
      throw new ListingStateError(
        '下图统计端口未接线：lineStore 未实现 countPartLinesCreatedBetween（内存实现已备；PG 适配器合流时补齐）',
      );
    }
    const timeRange =
      createTimeStart !== undefined && createTimeEnd !== undefined
        ? `${createTimeStart} ~ ${createTimeEnd}`
        : createTimeStart === undefined && createTimeEnd === undefined
          ? '全部'
          : `${createTimeStart ?? ''}~${createTimeEnd ?? ''}`;
    return { timeRange, drawingCount };
  }

  // ---- 私有辅助 ----

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<ListingCommand>): {
    eventId: EventId;
    tenant: TenantId;
    occurredAt: string;
    provenance: { operationId: string; command: string; actor: string };
  } {
    return {
      eventId: EventId.create(newDomainEventId()),
      tenant: envelope.tenantId,
      occurredAt: this.now(),
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    };
  }

  /** 重放订单机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayOrder(order: PurchaseOrder): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: order.id, type: PURCHASE_ORDER_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.orderConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    return this.finishReplay(runtime, page.events, order, '订单');
  }

  /** 重放采购申请机器事件账本（零事件 = 初始态 draft@1，口径同上）。 */
  private async replayRequest(request: PurchaseRequest): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: request.id, type: PURCHASE_REQUEST_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.requestConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    return this.finishReplay(runtime, page.events, request, '采购申请');
  }

  /** 重放退货单机器事件账本（零事件 = 初始态 open@1）。 */
  private async replayReturn(purchaseReturn: PurchaseReturn): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: purchaseReturn.id, type: PURCHASE_RETURN_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.returnConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    return this.finishReplay(runtime, page.events, purchaseReturn, '退货单');
  }

  private finishReplay(
    runtime: ApprovalFlowRuntime,
    events: readonly ApprovalEvent[],
    row: { readonly id: string; readonly state: string; readonly objectVersion: number },
    label: string,
  ): ApprovalFlowRuntime {
    for (const event of events) {
      const outcome = runtime.send(event.payload.event, {
        by: UserId.create(event.payload.actor),
        reason: event.payload.reason,
        objectVersion: event.payload.objectVersion - 1,
      });
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new ListingStateError(
          `${label}事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== row.state || runtime.objectVersion() !== row.objectVersion) {
      runtime.stop();
      throw new ListingStateError(
        `${label}事件账本与投影行不一致：投影 ${row.state}@v${row.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 申请批量推进（订单 approve/issue 联动）：非预期态的申请跳过不推进。 */
  private async advanceRequests(
    tenant: TenantId,
    requestIds: readonly string[],
    verb: 'APPROVE' | 'CONVERT',
    actor: UserId,
    reason: string,
  ): Promise<readonly string[]> {
    const advancedIds: string[] = [];
    for (const requestId of requestIds) {
      const request = await this.requests.find(tenant, requestId);
      if (request === null) continue;
      const runtime = await this.replayRequest(request);
      try {
        const outcome = runtime.send(verb, {
          by: actor,
          reason,
          objectVersion: request.objectVersion,
        });
        if (outcome.status !== 'transitioned') continue; // 状态不匹配（如已转单）：跳过
        await this.machineEvents.append(outcome.event);
        await this.requests.advance(
          tenant,
          requestId,
          request.objectVersion,
          runtime.state(),
          runtime.objectVersion(),
        );
        advancedIds.push(requestId);
      } finally {
        runtime.stop();
      }
    }
    return advancedIds;
  }

  private async hasOpenOrderTodo(tenant: TenantId, assignee: UserId, orderId: string): Promise<boolean> {
    const own = await this.todos.listOwn(tenant, assignee);
    return own.some(
      (todo) =>
        todo.source === LISTING_TODO_SOURCE &&
        todo.refType === PURCHASE_ORDER_AGGREGATE_TYPE &&
        todo.refId === orderId &&
        todo.status === 'open',
    );
  }

  /** 完成指定经办人名下（source=listing + refType + refId）的 open 待办。 */
  private async completeTodosFor(
    tenant: TenantId,
    assignee: UserId,
    refType: string,
    refId: string,
  ): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, assignee);
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (todo.source === LISTING_TODO_SOURCE && todo.refType === refType && todo.refId === refId && todo.status === 'open') {
        const done = await this.todos.complete(tenant, assignee, todo.id);
        if (done !== null) completed.push(done);
      }
    }
    return completed;
  }
}

// ---- 查询视图形状 ----

export interface PurchaseOrderDetail {
  readonly order: PurchaseOrder;
  readonly milestones: readonly ListingMachineMilestone[];
  readonly requests: readonly PurchaseRequest[];
}

export interface PurchaseOverdueRow {
  readonly purchaseOrderId: string;
  readonly workOrderId: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  readonly state: string;
  readonly daysOverdue: number;
}

/** 逾期未交明细行（U8 明细行事实面；orderLineId=订单#行号，订单头粒度面并存）。 */
export interface PurchaseOverdueLineRow {
  readonly orderLineId: string;
  readonly purchaseOrderId: string;
  readonly lineNo: number;
  /** null = 无工作令订单（手工采购行，源 apply_source=4）。 */
  readonly workOrderId: string | null;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly quantity: number;
  /** 已完成数量（净完成量：收货回填，退货回退后重收覆盖）。 */
  readonly receivedQty: number;
  /** 未入库数量 = max(0, quantity − receivedQty)。 */
  readonly unInboundQty: number;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly daysOverdue: number;
}

export interface PurchaseDetailRow {
  readonly purchaseOrderId: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly workOrderId: string | null;
  readonly supplierName: string | null;
  readonly lineNo: number;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly receivedQty: number;
  readonly unitPriceMinor: number | null;
  readonly amountMinor: number;
  readonly promisedAt: string;
}

export interface PurchaseDetailRows {
  readonly rows: readonly PurchaseDetailRow[];
  readonly totalAmountMinor: number;
}

/** 机器账本迁移史（本地读法，与 workorder milestoneHistory 同构）。 */
function machineMilestones(events: readonly ApprovalEvent[]): readonly ListingMachineMilestone[] {
  return events.map((event) => ({
    from: event.payload.from,
    to: event.payload.to,
    event: event.payload.event,
    at: event.occurredAt,
    actor: event.payload.actor,
    objectVersion: event.payload.objectVersion,
  }));
}

/** 从 baseline 物料校验回执事件提取判定行（载荷镜像结构化提取；行序=输入行序）。 */
function extractJudgments(events: readonly BusinessEvent[]): readonly MaterialJudgmentShape[] | null {
  for (const event of events) {
    const payload = event.payload as { lines?: unknown } | null;
    if (payload !== null && typeof payload === 'object' && Array.isArray(payload.lines)) {
      const judgments: MaterialJudgmentShape[] = [];
      for (const raw of payload.lines) {
        const row = raw as Record<string, unknown>;
        if (
          (row['judgment'] !== 'matched' && row['judgment'] !== 'suspected' && row['judgment'] !== 'unmatched') ||
          typeof row['similarity'] !== 'number'
        ) {
          return null;
        }
        judgments.push({
          judgment: row['judgment'],
          candidateItemId: typeof row['candidateItemId'] === 'string' ? row['candidateItemId'] : null,
          candidateItemCode: typeof row['candidateItemCode'] === 'string' ? row['candidateItemCode'] : null,
          similarity: row['similarity'],
          basis:
            row['basis'] === 'code-exact' || row['basis'] === 'name-and-spec' || row['basis'] === 'none'
              ? row['basis']
              : 'none',
        });
      }
      return judgments;
    }
  }
  return null;
}
