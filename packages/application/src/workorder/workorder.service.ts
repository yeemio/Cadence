/**
 * WorkOrderService —— 工作令用例编排（M2-W1）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分返回（committed/rejected 为值；indeterminate 由 PG 适配
 * 层在写入失联窗口产出，内存路径不产生）——与 approval（M1，命令前信封形态）
 * 的分工差异见 workorder-errors.ts 头注。
 *
 * 三件事：
 *
 * 1. 状态机：九态（工作令）与六态（配件申请）均经 engine-flow runtime 驱动
 *    （配置注入可整体替换，ADR-0010 条 2）。transition/close 以**目标态**寻径
 *    （from=当前态 ∧ to=目标态 的配置规则）；配件决策按决策类反查动词。
 *
 * 2. 事实源与投影：机器事件账本（engine-flow ApprovalEventStore 形状）是状态
 *    机的重放事实源——每次迁移命令先重放该聚合全部机器事件重建运行时（重放
 *    结果必须与投影行一致，否则数据级冲突抛 WorkOrderStateError）；落账顺序：
 *    幂等记账 → 机器事件 → 投影乐观推进 → 域事件发布（BusinessEvent + Outbox）。
 *    建单类命令（建令、配件申请提交）先落初始态投影行（无机器事件）再驱动首次
 *    迁移——投影行先在是机器事件 append 的前置（PG 账本按投影行解析租户）。
 *    域事件是对外发布事实（listing/待办/IM/报表消费），与机器账本各自 append-only。
 *
 * 3. 联动：迁移 → 项目经理待办（source='workorder'）；关闭 → 清该工作令待办；
 *    齐套缺口 → 项目经理催办待办；配件提交 → 当前待审级审批待办、决策后完成
 *    （S6 / RREQ-IS-037 多级链：一级=工作令负责人、二/三级=参数角色或签，
 *    待审批人实时解析不落库，缺省单级=基线零回归）；parts.ship → inventory
 *    出库端口（拒绝则命令 rejected 不落账，端口按 requestId 幂等——重试不
 *    重复扣减）。
 */
import {
  EventId,
  UserId,
  WorkOrderId,
  type CommandEnvelope,
  type CommittedOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import {
  startApprovalFlow,
  type ApprovalEventStore,
  type ApprovalFlowConfig,
  type ApprovalFlowRuntime,
  type EvidenceRef,
} from '@smes/engine-flow';
import type { TodoItem, TodoStore } from '../workbench/workbench-stores.js';
import {
  DEFAULT_KIT_SCOPE_KINDS,
  DEFAULT_PARTS_APPROVAL_CHAIN,
  DEFAULT_PARTS_REQUEST_FLOW_CONFIG,
  DEFAULT_WORK_ORDER_FLOW_CONFIG,
  LISTING_KINDS,
  PARTS_PENDING_STATE_IDS,
  buildPartsRequestFlowConfig,
  partsApprovalLevelOfState,
  workOrderStateLabel,
  type ListingKind,
  type PartsApprovalChain,
} from './workorder-config.js';
import {
  KIT_CHECK_AGGREGATE_TYPE,
  PARTS_REQUEST_AGGREGATE_TYPE,
  WORKORDER_EVENT_TYPES,
  WORK_ORDER_AGGREGATE_TYPE,
  makeAttachmentAddedEvent,
  makeKitCheckRefreshedEvent,
  makePartsDecidedEvent,
  makePartsRequestedEvent,
  makePartsShippedEvent,
  makeWorkOrderCreatedEvent,
  makeWorkOrderTransitionedEvent,
  makeWorkOrderUpdatedEvent,
  provenanceOf,
  type AttachmentAddedPayload,
  type KitCheckKindSummaryPayload,
  type KitCheckLineGapPayload,
  type KitCheckRefreshedPayload,
  type PartsDecidedPayload,
  type PartsRequestedPayload,
  type PartsShippedPayload,
  type WorkOrderCreatedPayload,
  type WorkOrderTransitionedPayload,
  type WorkOrderUpdatedPayload,
} from './workorder-events.js';
import { WorkOrderInputError, WorkOrderNotFoundError, WorkOrderStateError } from './workorder-errors.js';
import {
  parseAttachPayload,
  parseCloseWorkOrderPayload,
  parseCreateWorkOrderPayload,
  parseKitRefreshPayload,
  parsePartsDecisionPayload,
  parsePartsRequestPayload,
  parsePartsShipPayload,
  parseTransitionWorkOrderPayload,
  parseUpdateWorkOrderPayload,
  type WorkOrderCommand,
  type WorkOrderCommandKind,
} from './workorder-input.js';
import {
  EMPTY_CUSTOMER_PORT,
  EMPTY_INVENTORY_PORT,
  EMPTY_LISTING_PORT,
  EMPTY_PARTS_APPROVER_DIRECTORY,
  EMPTY_PROGRESS_PORT,
  NOOP_PARTS_ISSUE_PORT,
  WORKORDER_TODO_SOURCE,
  type CustomerDirectoryPort,
  type InventoryAvailabilityPort,
  type ListingRequirementPort,
  type PartsApproverDirectoryPort,
  type PartsIssuePort,
  type ProgressFactPort,
} from './workorder-ports.js';
import {
  daysToDelivery,
  deliveryRiskLevel,
  milestoneHistory,
  rollupAssemblyProgress,
  rollupMachiningProgress,
  stateDistribution,
  type AssemblyProgressRow,
  type DeliverySituationRow,
  type MachiningProgressRow,
  type WorkOrderMilestone,
} from './workorder-progress.js';
import type {
  KitCheck,
  PartsRequest,
  WorkOrder,
  WorkOrderAttachment,
  WorkOrderDomainEventStore,
  WorkOrderOperationStore,
  WorkOrderStore,
  PartsRequestStore,
  KitCheckStore,
  WorkOrderAttachmentStore,
} from './workorder-stores.js';
import {
  newAttachmentId,
  newDomainEventId,
  newKitCheckId,
  newPartsRequestId,
  newWorkOrderId,
} from './workorder-ids.js';

// ---- 结果形状（CommandOutcome 扩展：命令侧待办联动与聚合视图回执） ----

export interface WorkOrderCommitted extends CommittedOutcome {
  /** 本次命令派生的待办（迁移/齐套缺口/配件审批联动）。 */
  readonly todosCreated: readonly TodoItem[];
  /** 本次命令完成的待办（关闭/配件决策联动）。 */
  readonly todosCompleted: readonly TodoItem[];
  /** 命令目标聚合的提交后视图（create/transition/close/attach/kit/parts 各取所需）。 */
  readonly workOrder?: WorkOrder;
  readonly partsRequest?: PartsRequest;
  readonly attachment?: WorkOrderAttachment;
  readonly kitCheck?: KitCheck;
}

export type WorkOrderCommandResult = WorkOrderCommitted | RejectedOutcome;

export interface WorkOrderServiceOptions {
  /** 九态配置（缺省 DEFAULT_WORK_ORDER_FLOW_CONFIG；可整体替换 = 换合法集）。 */
  readonly workOrderConfig: ApprovalFlowConfig;
  /** 配件申请配置（缺省 DEFAULT_PARTS_REQUEST_FLOW_CONFIG；多级链时由链派生，见 partsApprovalChain）。 */
  readonly partsConfig: ApprovalFlowConfig;
  /**
   * 配件审批链（S6 / RREQ-IS-037）：levels=1（缺省）＝单级基线，配件流配置
   * 恒用 options.partsConfig（零回归锚点）；levels≥2 由链派生多级流配置
   * （待审中间态 level2_review/level3_review，统一「审批中」文案）。
   */
  readonly partsApprovalChain?: PartsApprovalChain | undefined;
  /**
   * 配件审批链租户级解析器（沿 approval 域 flowConfigResolver 先例）：返回
   * 该租户当前生效链配置，null/undefined 回落静态 partsApprovalChain。每次
   * 建单/决策/重放按租户现解析；在途单由引擎重放守卫兜底（链级数切换导致
   * 重放不一致即状态冲突，不静默漂移）。
   */
  readonly partsChainResolver?:
    | ((tenant: TenantId) => Promise<PartsApprovalChain | null>)
    | undefined;
  /** 齐套覆盖的清单类目（缺省 DEFAULT_KIT_SCOPE_KINDS：零件/标准件/电气件）。 */
  readonly kitScopeKinds: readonly ListingKind[];
  /** 建令时清单骨架提示类目（缺省四类全量——listing 消费方各建一张空清单）。 */
  readonly skeletonListingKinds: readonly ListingKind[];
  /** 交付态势临期窗口（天；缺省 7——初版口径，对账阶段校正）。 */
  readonly riskWindowDays: number;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface WorkOrderCrossModulePorts {
  readonly listing: ListingRequirementPort;
  readonly inventory: InventoryAvailabilityPort;
  readonly issue: PartsIssuePort;
  readonly progress: ProgressFactPort;
  readonly customer: CustomerDirectoryPort;
  /** 配件审批链二/三级角色解析（S6；缺省空目录——多级链该级审批明确拒绝）。 */
  readonly approvers: PartsApproverDirectoryPort;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class WorkOrderService {
  private readonly options: WorkOrderServiceOptions;
  private readonly ports: WorkOrderCrossModulePorts;

  constructor(
    private readonly orders: WorkOrderStore,
    private readonly attachments: WorkOrderAttachmentStore,
    private readonly parts: PartsRequestStore,
    private readonly kitChecks: KitCheckStore,
    private readonly operations: WorkOrderOperationStore,
    private readonly domainEvents: WorkOrderDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    private readonly todos: TodoStore,
    ports: Partial<WorkOrderCrossModulePorts> = {},
    options: Partial<WorkOrderServiceOptions> = {},
  ) {
    this.ports = {
      listing: ports.listing ?? EMPTY_LISTING_PORT,
      inventory: ports.inventory ?? EMPTY_INVENTORY_PORT,
      issue: ports.issue ?? NOOP_PARTS_ISSUE_PORT,
      progress: ports.progress ?? EMPTY_PROGRESS_PORT,
      customer: ports.customer ?? EMPTY_CUSTOMER_PORT,
      approvers: ports.approvers ?? EMPTY_PARTS_APPROVER_DIRECTORY,
    };
    this.options = {
      workOrderConfig: options.workOrderConfig ?? DEFAULT_WORK_ORDER_FLOW_CONFIG,
      partsConfig: options.partsConfig ?? DEFAULT_PARTS_REQUEST_FLOW_CONFIG,
      partsApprovalChain: options.partsApprovalChain ?? DEFAULT_PARTS_APPROVAL_CHAIN,
      partsChainResolver: options.partsChainResolver,
      kitScopeKinds: options.kitScopeKinds ?? DEFAULT_KIT_SCOPE_KINDS,
      skeletonListingKinds: options.skeletonListingKinds ?? LISTING_KINDS,
      riskWindowDays: options.riskWindowDays ?? 7,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  /**
   * 执行一条命令信封。pathId = 资源路径参数（update/transition/close/attach/
   * kit.refresh 的目标工作令、配件命令的目标申请）——提供时即为目标聚合。
   */
  async execute(
    envelope: CommandEnvelope<WorkOrderCommand>,
    pathId?: string,
  ): Promise<WorkOrderCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly WorkOrderCommandKind[] = ['workorder.create.v1', 'workorder.parts.request.v1'];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'workorder.create.v1':
        return this.createWorkOrder(envelope);
      case 'workorder.update.v1':
        return this.updateWorkOrder(envelope, this.requirePathId(pathId, kind));
      case 'workorder.transition.v1':
        return this.transitionWorkOrder(envelope, this.requirePathId(pathId, kind));
      case 'workorder.close.v1':
        return this.closeWorkOrder(envelope, this.requirePathId(pathId, kind));
      case 'workorder.attach.v1':
        return this.attach(envelope, this.requirePathId(pathId, kind));
      case 'workorder.parts.request.v1':
        return this.requestParts(envelope);
      case 'workorder.parts.approve.v1':
        return this.decideParts(envelope, this.requirePathId(pathId, kind));
      case 'workorder.parts.ship.v1':
        return this.shipParts(envelope, this.requirePathId(pathId, kind));
      case 'workorder.kit.refresh.v1':
        return this.refreshKit(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: WorkOrderCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new WorkOrderInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- workorder.create ----

  private async createWorkOrder(
    envelope: CommandEnvelope<WorkOrderCommand>,
  ): Promise<WorkOrderCommandResult> {
    const payload = parseCreateWorkOrderPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const id = newWorkOrderId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: WORK_ORDER_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const created = await this.orders.create({
      tenant,
      id: WorkOrderId.create(id),
      flowConfigId: this.options.workOrderConfig.flowId,
      state: this.options.workOrderConfig.initial,
      objectVersion: 1,
      customerRef: payload.customerRef,
      projectName: payload.projectName,
      salesRep: payload.salesRep,
      manager: payload.manager,
      plannedDeliveryAt: payload.plannedDeliveryAt,
      packagingArrivalAt: payload.packagingArrivalAt,
    });

    const eventPayload: WorkOrderCreatedPayload = {
      workOrderId: id,
      projectName: created.projectName,
      customerRef: created.customerRef,
      salesRep: created.salesRep,
      manager: created.manager,
      plannedDeliveryAt: created.plannedDeliveryAt,
      packagingArrivalAt: created.packagingArrivalAt,
      listingKinds: this.options.skeletonListingKinds,
      actor: envelope.issuedBy,
    };
    const event = makeWorkOrderCreatedEvent(this.domainEventBase(envelope), eventPayload);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      workOrder: created,
    };
  }

  // ---- workorder.update ----

  private async updateWorkOrder(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
  ): Promise<WorkOrderCommandResult> {
    const fields = parseUpdateWorkOrderPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, WorkOrderId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${id}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，工作令当前 objectVersion=${order.objectVersion}`,
      );
    }

    const recorded = await this.operations.record({
      tenant: envelope.tenantId,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: WORK_ORDER_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const updated = await this.orders.update(envelope.tenantId, WorkOrderId.create(id), fields);
    if (updated === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${id}'`);
    }

    const changes: Record<string, unknown> = {};
    if (fields.customerRef !== undefined) changes['customerRef'] = updated.customerRef;
    if (fields.projectName !== undefined) changes['projectName'] = updated.projectName;
    if (fields.salesRep !== undefined) changes['salesRep'] = updated.salesRep;
    if (fields.manager !== undefined) changes['manager'] = updated.manager;
    if (fields.plannedDeliveryAt !== undefined) changes['plannedDeliveryAt'] = updated.plannedDeliveryAt;
    if (fields.packagingArrivalAt !== undefined) changes['packagingArrivalAt'] = updated.packagingArrivalAt;

    const event = makeWorkOrderUpdatedEvent(
      this.domainEventBase(envelope),
      { changes, actor: envelope.issuedBy },
      id,
      order.objectVersion, // update 不推进状态机版本（修订见 stores 头注取舍）
    );
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: updated.objectVersion,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      workOrder: updated,
    };
  }

  // ---- workorder.transition / workorder.close ----

  private async transitionWorkOrder(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
  ): Promise<WorkOrderCommandResult> {
    const payload = parseTransitionWorkOrderPayload(envelope.command.payload);
    // 终态 closed 保留给 close 命令：close 独立权限码（workorder:close）的语义
    // 不被 transition（workorder:transition）旁路（Wave-1 验收低危①）。
    if (payload.targetState === 'closed') {
      return rejected(
        "目标终态 'closed' 保留给 close 命令（workorder.close.v1 / workorder:close）；transition.v1 不直达 closed",
      );
    }
    return this.runTransition(envelope, id, payload.targetState, payload.remark, payload.evidence);
  }

  private async closeWorkOrder(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
  ): Promise<WorkOrderCommandResult> {
    const payload = parseCloseWorkOrderPayload(envelope.command.payload);
    return this.runTransition(envelope, id, 'closed', payload.remark, []);
  }

  private async runTransition(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
    targetState: string,
    remark: string | null,
    evidence: readonly { readonly kind: string; readonly ref: string }[],
  ): Promise<WorkOrderCommandResult> {
    const order = await this.orders.find(envelope.tenantId, WorkOrderId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${id}'`);
    }
    if (order.flowConfigId !== this.options.workOrderConfig.flowId) {
      return rejected(
        `工作令由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.workOrderConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，工作令当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayWorkOrder(order);
    try {
      const from = runtime.state();
      const rule = this.options.workOrderConfig.transitions.find(
        (candidate) => candidate.from === from && candidate.to === targetState,
      );
      if (rule === undefined) {
        return rejected(
          `状态 '${from}' 不支持流转到 '${targetState}'（配置 '${this.options.workOrderConfig.flowId}' 无对应迁移规则）`,
        );
      }
      const reason = remark ?? `流转至 ${workOrderStateLabel(targetState)}`;
      const sendInput = {
        by: envelope.issuedBy,
        reason,
        ...(evidence.length === 0
          ? {}
          : { evidence: evidence.map((entry) => ({ kind: entry.kind, ref: entry.ref }) as EvidenceRef) }),
        objectVersion: order.objectVersion,
      };
      const outcome = runtime.send(rule.event, sendInput);
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对命令 '${rule.event}' 返回 ${outcome.status}（配置守卫或规则不一致）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: WORK_ORDER_AGGREGATE_TYPE,
        aggregateId: id,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        envelope.tenantId,
        WorkOrderId.create(id),
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const eventPayload: WorkOrderTransitionedPayload = {
        from,
        to: targetState,
        event: rule.event,
        objectVersion: runtime.objectVersion(),
        remark: reason,
        evidence: evidence.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
        actor: envelope.issuedBy,
      };
      const event = makeWorkOrderTransitionedEvent(this.domainEventBase(envelope), eventPayload, id);
      await this.domainEvents.append(event);

      // 待办联动：关闭 → 清项目经理该工作令待办；其余迁移 → 项目经理一条进展待办。
      const todosCompleted =
        targetState === 'closed' && advanced.manager !== null
          ? await this.completeTodosFor(envelope.tenantId, advanced.manager, WORK_ORDER_AGGREGATE_TYPE, id)
          : [];
      const todosCreated: TodoItem[] = [];
      if (targetState !== 'closed' && advanced.manager !== null) {
        todosCreated.push(
          await this.todos.create({
            tenant: envelope.tenantId,
            assignee: advanced.manager,
            title: `工作令流转：${advanced.projectName} → ${workOrderStateLabel(targetState)}`,
            source: WORKORDER_TODO_SOURCE,
            refType: WORK_ORDER_AGGREGATE_TYPE,
            refId: id,
          }),
        );
      }

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated,
        todosCompleted,
        workOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- workorder.attach ----

  private async attach(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
  ): Promise<WorkOrderCommandResult> {
    const payload = parseAttachPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, WorkOrderId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${id}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，工作令当前 objectVersion=${order.objectVersion}`,
      );
    }
    if (this.isFinalWorkOrderState(order.state)) {
      return rejected(`工作令 '${id}' 已处终态 '${order.state}'，不再接受附件挂接`);
    }

    const attachmentId = newAttachmentId();
    const recorded = await this.operations.record({
      tenant: envelope.tenantId,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: WORK_ORDER_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const attachment = await this.attachments.append({
      tenant: envelope.tenantId,
      id: attachmentId,
      workOrderId: WorkOrderId.create(id),
      name: payload.name,
      kind: payload.kind,
      ref: payload.ref,
      attachedBy: envelope.issuedBy,
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    });

    const eventPayload: AttachmentAddedPayload = {
      workOrderId: id,
      name: payload.name,
      kind: payload.kind,
      ref: payload.ref,
      actor: envelope.issuedBy,
    };
    const event = makeAttachmentAddedEvent(this.domainEventBase(envelope), eventPayload, attachmentId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: order.objectVersion, // 附件是独立事实，不推进工作令状态机版本
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      attachment,
    };
  }

  // ---- workorder.kit.refresh ----

  private async refreshKit(
    envelope: CommandEnvelope<WorkOrderCommand>,
    id: string,
  ): Promise<WorkOrderCommandResult> {
    parseKitRefreshPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, WorkOrderId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${id}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，工作令当前 objectVersion=${order.objectVersion}`,
      );
    }
    if (this.isFinalWorkOrderState(order.state)) {
      return rejected(`工作令 '${id}' 已处终态 '${order.state}'，不再接受齐套刷新`);
    }

    const tenant = envelope.tenantId;
    const scope = this.options.kitScopeKinds;
    const lines = (await this.ports.listing.requirementLines(tenant, id)).filter((line) =>
      (scope as readonly string[]).includes(line.kind),
    );
    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const available = await this.ports.inventory.availableQty(tenant, itemIds);

    const gapLines: KitCheckLineGapPayload[] = [];
    const kindSummaries: KitCheckKindSummaryPayload[] = scope.map((kind) => {
      const kindLines = lines.filter((line) => line.kind === kind);
      let gapLineCount = 0;
      for (const line of kindLines) {
        const availableQty = available.get(line.itemId) ?? 0;
        const gapQty = Math.max(0, line.requiredQty - availableQty);
        if (gapQty > 0) {
          gapLineCount += 1;
          gapLines.push({
            kind: line.kind,
            itemId: line.itemId,
            drawingNo: line.drawingNo,
            requiredQty: line.requiredQty,
            availableQty,
            gapQty,
          });
        }
      }
      return {
        kind,
        lineCount: kindLines.length,
        gapLineCount,
        // Round-2 裁决（UX-PLAN-03）：空类目不判齐套（与 listing.service 缺口核查同构，防 vacuous true）。
        complete: kindLines.length > 0 && gapLineCount === 0,
      };
    });
    gapLines.sort((a, b) => a.kind.localeCompare(b.kind) || a.itemId.localeCompare(b.itemId));
    // 同上：空清单整单不判齐套。
    const complete = lines.length > 0 && gapLines.length === 0;

    const kitCheckId = newKitCheckId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: KIT_CHECK_AGGREGATE_TYPE,
      aggregateId: kitCheckId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const snapshot = await this.kitChecks.append({
      tenant,
      id: kitCheckId,
      workOrderId: WorkOrderId.create(id),
      kinds: kindSummaries,
      gapLines,
      complete,
      refreshedBy: envelope.issuedBy,
      provenance: provenanceOf(envelope.operationId, envelope.command.kind, envelope.issuedBy),
    });

    const eventPayload: KitCheckRefreshedPayload = {
      workOrderId: id,
      kinds: kindSummaries,
      gapLines,
      complete,
      actor: envelope.issuedBy,
    };
    const event = makeKitCheckRefreshedEvent(this.domainEventBase(envelope), eventPayload, kitCheckId);
    await this.domainEvents.append(event);

    // 缺口 → 待办（催办，Done-when：齐套缺口可见并可催办）。
    // 空清单不催办：催办语义是「有缺口需补料」，空清单是数据未录入，不是缺口。
    const todosCreated: TodoItem[] = [];
    if (!complete && lines.length > 0 && order.manager !== null) {
      todosCreated.push(
        await this.todos.create({
          tenant,
          assignee: order.manager,
          title: `齐套缺口催办：${order.projectName}（缺 ${gapLines.length} 行）`,
          source: WORKORDER_TODO_SOURCE,
          refType: WORK_ORDER_AGGREGATE_TYPE,
          refId: id,
        }),
      );
    }

    return {
      status: 'committed',
      newRevision: order.objectVersion, // 快照是独立事实，不推进工作令状态机版本
      events: [event],
      todosCreated,
      todosCompleted: [],
      kitCheck: snapshot,
    };
  }

  // ---- workorder.parts.request / approve / ship ----

  private async requestParts(
    envelope: CommandEnvelope<WorkOrderCommand>,
  ): Promise<WorkOrderCommandResult> {
    const payload = parsePartsRequestPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, WorkOrderId.create(payload.workOrderId));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在工作令 '${payload.workOrderId}'`);
    }
    if (this.isFinalWorkOrderState(order.state)) {
      return rejected(`工作令 '${payload.workOrderId}' 已处终态 '${order.state}'，不再接受配件申请`);
    }

    const requestId = newPartsRequestId();
    // 生效链/配置（租户级解析优先，缺省单级零回归）。
    const { config: partsFlow, chain } = await this.partsFlowFor(envelope.tenantId);
    // 落账顺序（体例同 listing 订单提交）：先落 draft@v1 投影行（初始态无机器
    // 事件），再驱动 SUBMIT 迁移、append 机器事件账本（投影行已在，租户可解析）、
    // 乐观推进投影至 submitted@v2——pg-workorder-stores 按投影行解析租户，
    // 投影行先在是机器事件 append 的前置（孤儿聚合拒写）。
    const submitRule = partsFlow.transitions.find(
      (candidate) => candidate.from === partsFlow.initial && candidate.event === 'SUBMIT',
    );
    if (submitRule === undefined) {
      return rejected(`初始态 '${partsFlow.initial}' 不支持提交（配置无 SUBMIT 规则）`);
    }
    const runtime = startApprovalFlow({
      config: partsFlow,
      subject: { aggregate: { id: requestId, type: PARTS_REQUEST_AGGREGATE_TYPE }, initialObjectVersion: 1 },
      now: () => this.now(),
      newEventId: () => EventId.create(newDomainEventId()),
    });
    try {
      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PARTS_REQUEST_AGGREGATE_TYPE,
        aggregateId: requestId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.parts.create({
        tenant: envelope.tenantId,
        id: requestId,
        workOrderId: WorkOrderId.create(payload.workOrderId),
        flowConfigId: partsFlow.flowId,
        state: partsFlow.initial, // draft：初始态落库，无机器事件
        objectVersion: 1,
        itemId: payload.itemId,
        quantity: payload.quantity,
        requester: envelope.issuedBy,
        remark: payload.remark,
      });

      const outcome = runtime.send('SUBMIT', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '配件申请',
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`配件申请提交失败：draft 对 SUBMIT 返回 ${outcome.status}`);
      }
      await this.machineEvents.append(outcome.event);
      const created = await this.parts.advance(
        envelope.tenantId,
        requestId,
        1,
        runtime.state(),
        runtime.objectVersion(),
      );

      const eventPayload: PartsRequestedPayload = {
        workOrderId: payload.workOrderId,
        itemId: payload.itemId,
        quantity: payload.quantity,
        remark: payload.remark,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePartsRequestedEvent(this.domainEventBase(envelope), eventPayload, requestId);
      await this.domainEvents.append(event);

      // 待办联动：配件申请 → 当前待审级审批人（或签逐人一条）。
      // 单级链（缺省零回归）：项目经理审批待办（基线行为原样）；多级链：
      // 一级 = 工作令负责人（项目经理，空回落销售），名单空则不派待办
      // （该级决策时明确拒绝——「未配置或无审批人」口径同源文档）。
      const todosCreated: TodoItem[] = [];
      if (chain.levels === 1) {
        if (order.manager !== null) {
          todosCreated.push(
            await this.todos.create({
              tenant: envelope.tenantId,
              assignee: order.manager,
              title: `配件申请待审批：${payload.itemId} × ${payload.quantity}（${order.projectName}）`,
              source: WORKORDER_TODO_SOURCE,
              refType: PARTS_REQUEST_AGGREGATE_TYPE,
              refId: requestId,
            }),
          );
        }
      } else {
        const levelOne = await this.levelApproversFor(envelope.tenantId, 1, chain, order);
        for (const approver of levelOne.approvers) {
          todosCreated.push(
            await this.todos.create({
              tenant: envelope.tenantId,
              assignee: approver,
              title: `配件申请待审批：${payload.itemId} × ${payload.quantity}（${order.projectName}）`,
              source: WORKORDER_TODO_SOURCE,
              refType: PARTS_REQUEST_AGGREGATE_TYPE,
              refId: requestId,
            }),
          );
        }
      }

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated,
        todosCompleted: [],
        partsRequest: created,
      };
    } finally {
      runtime.stop();
    }
  }

  private async decideParts(
    envelope: CommandEnvelope<WorkOrderCommand>,
    requestId: string,
  ): Promise<WorkOrderCommandResult> {
    const payload = parsePartsDecisionPayload(envelope.command.payload);
    const request = await this.parts.find(envelope.tenantId, requestId);
    if (request === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在配件申请 '${requestId}'`);
    }
    const { config: partsFlow, chain } = await this.partsFlowFor(envelope.tenantId);
    if (request.flowConfigId !== partsFlow.flowId) {
      return rejected(
        `配件申请由配置 '${request.flowConfigId}' 驱动，与当前装配配置 '${partsFlow.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== request.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，配件申请当前 objectVersion=${request.objectVersion}`,
      );
    }

    const runtime = await this.replayPartsRequest(request, partsFlow);
    try {
      const from = runtime.state();
      const verb = payload.decision === 'approve' ? 'APPROVE' : 'REJECT';
      const rule = partsFlow.transitions.find(
        (candidate) => candidate.from === from && candidate.event === verb,
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持决策 '${payload.decision}'（配置无对应迁移规则）`);
      }

      // 多级链或签门（S6 / RREQ-IS-037）：本级审批人实时解析（不落库），
      // 决策人须在名单内（一级 = 工作令负责人；二/三级 = 角色或签）；名单
      // 空 = 未配置或无审批人，明确拒绝。单级链（缺省）不做服务端人校验
      // （基线口径：parts:approve 权限码守门——零回归）。
      let orSignApprovers: readonly UserId[] | null = null;
      const currentLevel = partsApprovalLevelOfState(from);
      if (chain.levels >= 2 && currentLevel !== null) {
        const order = await this.orders.find(envelope.tenantId, request.workOrderId);
        const resolution = await this.levelApproversFor(envelope.tenantId, currentLevel, chain, order);
        if (resolution.approvers.length === 0) {
          return rejected(`第 ${currentLevel} 级审批未配置审批人（${resolution.note ?? '未配置或无审批人'}），无法决策`);
        }
        if (!resolution.approvers.some((approver) => approver === envelope.issuedBy)) {
          return rejected(
            `第 ${currentLevel} 级审批或签校验未通过：用户 '${envelope.issuedBy}' 不在本级审批人名单`,
          );
        }
        orSignApprovers = resolution.approvers;
      }

      const outcome = runtime.send(verb, {
        by: envelope.issuedBy,
        reason: payload.remark,
        objectVersion: request.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 的决策 '${payload.decision}' 未迁移（${outcome.status}）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PARTS_REQUEST_AGGREGATE_TYPE,
        aggregateId: requestId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.parts.advance(
        envelope.tenantId,
        requestId,
        request.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const eventPayload: PartsDecidedPayload = {
        decision: payload.decision,
        remark: payload.remark,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
        ...(chain.levels >= 2 && currentLevel !== null ? { level: currentLevel } : {}),
      };
      const event = makePartsDecidedEvent(this.domainEventBase(envelope), eventPayload, requestId);
      await this.domainEvents.append(event);

      // 待办联动：决策级或签名单全员的该申请待办自动完成（或签一人过即本级
      // 完结）；单级链保持基线——仅决策人本人待办完成。
      const todosCompleted: TodoItem[] = [];
      if (orSignApprovers === null) {
        for (const done of await this.completeTodosFor(
          envelope.tenantId,
          envelope.issuedBy,
          PARTS_REQUEST_AGGREGATE_TYPE,
          requestId,
        )) {
          todosCompleted.push(done);
        }
      } else {
        for (const approver of orSignApprovers) {
          for (const done of await this.completeTodosFor(
            envelope.tenantId,
            approver,
            PARTS_REQUEST_AGGREGATE_TYPE,
            requestId,
          )) {
            todosCompleted.push(done);
          }
        }
      }

      // 多级链推进：本级通过且目标态仍是待审态 → 下一级审批人或签逐人派待办
      // （名单空不派——下一级决策时明确拒绝；口径同提交侧）。
      const todosCreated: TodoItem[] = [];
      if (chain.levels >= 2 && payload.decision === 'approve') {
        const nextLevel = partsApprovalLevelOfState(runtime.state());
        if (nextLevel !== null) {
          const order = await this.orders.find(envelope.tenantId, request.workOrderId);
          const projectName = order === null ? (request.workOrderId as string) : order.projectName;
          const next = await this.levelApproversFor(envelope.tenantId, nextLevel, chain, order);
          for (const approver of next.approvers) {
            todosCreated.push(
              await this.todos.create({
                tenant: envelope.tenantId,
                assignee: approver,
                title: `配件申请待审批：${request.itemId} × ${request.quantity}（${projectName}）`,
                source: WORKORDER_TODO_SOURCE,
                refType: PARTS_REQUEST_AGGREGATE_TYPE,
                refId: requestId,
              }),
            );
          }
        }
      }

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated,
        todosCompleted,
        partsRequest: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  private async shipParts(
    envelope: CommandEnvelope<WorkOrderCommand>,
    requestId: string,
  ): Promise<WorkOrderCommandResult> {
    const payload = parsePartsShipPayload(envelope.command.payload);
    const request = await this.parts.find(envelope.tenantId, requestId);
    if (request === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在配件申请 '${requestId}'`);
    }
    if (envelope.expectedRevision !== request.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，配件申请当前 objectVersion=${request.objectVersion}`,
      );
    }

    const { config: partsFlow } = await this.partsFlowFor(envelope.tenantId);
    const runtime = await this.replayPartsRequest(request, partsFlow);
    try {
      const from = runtime.state();
      const rule = partsFlow.transitions.find(
        (candidate) => candidate.from === from && candidate.event === 'SHIP',
      );
      if (rule === undefined) {
        return rejected(`状态 '${from}' 不支持发货（仅 approved 态可发货，配置无 SHIP 规则）`);
      }

      // 出库端口先行：拒绝（如可用量不足）则命令整体 rejected，不落任何账。
      // 端口按 requestId 幂等（重试不重复扣减）——合同见 workorder-ports.ts。
      const receipt = await this.ports.issue.issueParts(envelope.tenantId, {
        requestId,
        workOrderId: request.workOrderId,
        itemId: request.itemId,
        quantity: request.quantity,
      });
      if (!receipt.issued) {
        return rejected(`配件出库被拒绝：${receipt.refusedReason ?? 'inventory 端口未说明原因'}`);
      }

      const outcome = runtime.send('SHIP', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '配件发货',
        objectVersion: request.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 SHIP 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: PARTS_REQUEST_AGGREGATE_TYPE,
        aggregateId: requestId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.parts.advance(
        envelope.tenantId,
        requestId,
        request.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { shipmentRef: payload.shipmentRef },
      );

      const eventPayload: PartsShippedPayload = {
        shipmentRef: payload.shipmentRef,
        issue: { issued: true },
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makePartsShippedEvent(this.domainEventBase(envelope), eventPayload, requestId);
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted: [],
        partsRequest: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- 查询 ----

  /** 工作令列表（可选状态精确过滤；新的在前）。 */
  async list(tenant: TenantId, stateFilter?: string): Promise<readonly WorkOrder[]> {
    return this.orders.list(tenant, stateFilter === undefined ? undefined : { state: stateFilter });
  }

  /** 工作令详情：主单据 + 附件 + 最新齐套 + 迁移史 + 客户名解析。 */
  async detail(
    tenant: TenantId,
    id: string,
  ): Promise<WorkOrderDetail> {
    const order = await this.orders.find(tenant, WorkOrderId.create(id));
    if (order === null) {
      throw new WorkOrderNotFoundError(`租户 '${tenant}' 内不存在工作令 '${id}'`);
    }
    const [attachments, latestKitCheck, milestones, customer] = await Promise.all([
      this.attachments.listByWorkOrder(tenant, WorkOrderId.create(id)),
      this.kitChecks.latestByWorkOrder(tenant, WorkOrderId.create(id)),
      this.machineEvents.readByAggregate({ id, type: WORK_ORDER_AGGREGATE_TYPE }).then((page) =>
        milestoneHistory(page.events),
      ),
      order.customerRef === null
        ? Promise.resolve(null)
        : this.ports.customer.findCustomer(tenant, order.customerRef),
    ]);
    return {
      order,
      attachments,
      latestKitCheck,
      milestones,
      customerName: customer === null ? null : customer.name,
    };
  }

  /** 项目进度（计划 vs 实际）：计划日期 + 当前态 + 迁移里程碑 + 交付倒计时。 */
  async projectProgress(tenant: TenantId, id: string): Promise<WorkOrderProgressView> {
    const detail = await this.detail(tenant, id);
    const now = this.now();
    return {
      workOrderId: detail.order.id,
      projectName: detail.order.projectName,
      state: detail.order.state,
      plannedDeliveryAt: detail.order.plannedDeliveryAt,
      packagingArrivalAt: detail.order.packagingArrivalAt,
      daysToDelivery: daysToDelivery(detail.order.plannedDeliveryAt, now),
      milestones: detail.milestones,
    };
  }

  /** 机加工进度（图号 × 工序上卷；数据源 = reporting/dispatch 进度事实只读订阅）。 */
  async machiningProgress(
    tenant: TenantId,
    id: string,
  ): Promise<{ readonly workOrderId: string; readonly rows: readonly MachiningProgressRow[] }> {
    await this.mustFindOrder(tenant, id);
    const facts = await this.ports.progress.progressFacts(tenant, id);
    return { workOrderId: id, rows: rollupMachiningProgress(facts) };
  }

  /** 装配调试进度（工序上卷）。 */
  async assemblyProgress(
    tenant: TenantId,
    id: string,
  ): Promise<{ readonly workOrderId: string; readonly rows: readonly AssemblyProgressRow[] }> {
    await this.mustFindOrder(tenant, id);
    const facts = await this.ports.progress.progressFacts(tenant, id);
    return { workOrderId: id, rows: rollupAssemblyProgress(facts) };
  }

  /** 齐套看板：每工作令最新快照（缺口下钻 = 载荷 gapLines）+ 项目名关联。 */
  async kitBoard(tenant: TenantId): Promise<readonly KitBoardRow[]> {
    const [snapshots, orders] = await Promise.all([
      this.kitChecks.latestPerTenant(tenant),
      this.orders.list(tenant),
    ]);
    const namesById = new Map(orders.map((order) => [order.id as string, order.projectName]));
    return snapshots.map((snapshot) => ({
      workOrderId: snapshot.workOrderId,
      projectName: namesById.get(snapshot.workOrderId) ?? snapshot.workOrderId,
      complete: snapshot.complete,
      kinds: snapshot.kinds,
      gapLines: snapshot.gapLines,
      refreshedAt: snapshot.refreshedAt,
    }));
  }

  /** 交付态势（工作台）：非终态工作令的风险等级 + 倒计时 + 九态分布计数。 */
  async deliverySituation(
    tenant: TenantId,
  ): Promise<WorkOrderDeliverySituation> {
    const orders = await this.orders.list(tenant);
    const now = this.now();
    const rows: DeliverySituationRow[] = orders
      .filter((order) => !this.isFinalWorkOrderState(order.state))
      .map((order) => ({
        workOrderId: order.id,
        projectName: order.projectName,
        state: order.state,
        plannedDeliveryAt: order.plannedDeliveryAt,
        daysToDelivery: daysToDelivery(order.plannedDeliveryAt, now),
        riskLevel: deliveryRiskLevel(order.plannedDeliveryAt, now, this.options.riskWindowDays),
      }))
      .sort((a, b) => (a.daysToDelivery ?? Infinity) - (b.daysToDelivery ?? Infinity));
    return {
      orders: rows,
      distribution: stateDistribution(orders),
      generatedAt: now,
    };
  }

  /** 配件申请列表（可选状态/工作令过滤）。 */
  async listParts(
    tenant: TenantId,
    stateFilter?: string,
    workOrderId?: string,
  ): Promise<readonly PartsRequest[]> {
    const workOrderFilter =
      workOrderId === undefined ? undefined : { workOrderId: WorkOrderId.create(workOrderId) };
    // 「审批中」统一文案族（RREQ-IS-037）：待审三态互为同义词——族内任一
    // 过滤值命中全族（submitted/level2_review/level3_review 同为「审批中」，
    // 不因多级链把在途单从基线过滤口径里漏掉）。族外状态走存储端精确过滤。
    if (stateFilter !== undefined && (PARTS_PENDING_STATE_IDS as readonly string[]).includes(stateFilter)) {
      const rows = await this.parts.list(tenant, workOrderFilter);
      return rows.filter((row) => (PARTS_PENDING_STATE_IDS as readonly string[]).includes(row.state));
    }
    return this.parts.list(tenant, {
      ...(stateFilter === undefined ? {} : { state: stateFilter }),
      ...(workOrderFilter === undefined ? {} : workOrderFilter),
    });
  }

  /** 配件申请详情（含机器迁移史 + 当前待审级实时解析的或签名单）。 */
  async partsDetail(tenant: TenantId, requestId: string): Promise<PartsRequestDetail> {
    const request = await this.parts.find(tenant, requestId);
    if (request === null) {
      throw new WorkOrderNotFoundError(`租户 '${tenant}' 内不存在配件申请 '${requestId}'`);
    }
    const page = await this.machineEvents.readByAggregate({
      id: requestId,
      type: PARTS_REQUEST_AGGREGATE_TYPE,
    });
    const { chain } = await this.partsFlowFor(tenant);
    const pendingApproval = await this.pendingApprovalOf(tenant, request, chain);
    return { partsRequest: request, milestones: milestoneHistory(page.events), pendingApproval };
  }

  // ---- 私有辅助 ----

  private async mustFindOrder(tenant: TenantId, id: string): Promise<WorkOrder> {
    const order = await this.orders.find(tenant, WorkOrderId.create(id));
    if (order === null) {
      throw new WorkOrderNotFoundError(`租户 '${tenant}' 内不存在工作令 '${id}'`);
    }
    return order;
  }

  private isFinalWorkOrderState(state: string): boolean {
    return this.options.workOrderConfig.states.some((def) => def.id === state && def.final === true);
  }

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<WorkOrderCommand>): {
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

  /** 重放工作令机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayWorkOrder(order: WorkOrder): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: order.id as string, type: WORK_ORDER_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.workOrderConfig,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    for (const event of page.events) {
      const outcome = runtime.send(event.payload.event, {
        by: UserId.create(event.payload.actor),
        reason: event.payload.reason,
        objectVersion: event.payload.objectVersion - 1,
      });
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new WorkOrderStateError(
          `事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== order.state || runtime.objectVersion() !== order.objectVersion) {
      runtime.stop();
      throw new WorkOrderStateError(
        `事件账本与工作令行不一致：工作令 ${order.state}@v${order.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 重放配件申请机器事件账本（口径同 replayWorkOrder；配置 = 本次生效配件流配置）。 */
  private async replayPartsRequest(
    request: PartsRequest,
    config: ApprovalFlowConfig,
  ): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: request.id, type: PARTS_REQUEST_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config,
      subject: { aggregate, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    for (const event of page.events) {
      const outcome = runtime.send(event.payload.event, {
        by: UserId.create(event.payload.actor),
        reason: event.payload.reason,
        objectVersion: event.payload.objectVersion - 1,
      });
      if (outcome.status !== 'transitioned') {
        runtime.stop();
        throw new WorkOrderStateError(
          `配件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== request.state || runtime.objectVersion() !== request.objectVersion) {
      runtime.stop();
      throw new WorkOrderStateError(
        `配件账本与申请行不一致：申请 ${request.state}@v${request.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  // ---- 配件审批链辅助（S6 / RREQ-IS-037） ----

  /**
   * 配件流生效配置 + 审批链：租户级解析器优先（沿 approval 域
   * flowConfigResolver 先例），null 回落静态链；levels=1 恒用
   * options.partsConfig（零回归锚点——单级链与基线逐字节同路径），
   * levels≥2 由链派生（buildPartsRequestFlowConfig）。
   */
  private async partsFlowFor(
    tenant: TenantId,
  ): Promise<{ readonly config: ApprovalFlowConfig; readonly chain: PartsApprovalChain }> {
    const chain =
      this.options.partsChainResolver === undefined
        ? (this.options.partsApprovalChain ?? DEFAULT_PARTS_APPROVAL_CHAIN)
        : ((await this.options.partsChainResolver(tenant)) ??
          this.options.partsApprovalChain ??
          DEFAULT_PARTS_APPROVAL_CHAIN);
    if (chain.levels === 1) {
      return { config: this.options.partsConfig, chain };
    }
    return { config: buildPartsRequestFlowConfig(chain), chain };
  }

  /**
   * 第 level 级或签名单实时解析（不落库）：一级 = 工作令负责人（我方实态
   * 项目经理，空回落销售——18 册 §2 口径）；二/三级 = 角色经目录端口解析。
   * 名单空时 note 给出原因（角色未配置/角色无人/工作令无负责人），调用方
   * 据此拒绝决策或读面展示「—」。
   */
  private async levelApproversFor(
    tenant: TenantId,
    level: number,
    chain: PartsApprovalChain,
    order: WorkOrder | null,
  ): Promise<{ readonly approvers: readonly UserId[]; readonly note: string | null }> {
    if (level === 1) {
      const owner = order === null ? null : (order.manager ?? order.salesRep);
      return owner === null
        ? { approvers: [], note: '工作令未配置项目经理与销售，一级审批暂无审批人' }
        : { approvers: [owner], note: null };
    }
    const role = level === 2 ? chain.level2Role : chain.level3Role;
    if (role === undefined) {
      return { approvers: [], note: `第 ${level} 级审批角色未配置（审批链 levels=${chain.levels}）` };
    }
    const approvers = await this.ports.approvers.roleApprovers(tenant, role);
    return {
      approvers,
      note: approvers.length === 0 ? `角色 '${role}' 未配置或角色下暂无审批人` : null,
    };
  }

  /** 详情读面：待审级实时解析（非待审态返回 null——approved 后无待审批人）。 */
  private async pendingApprovalOf(
    tenant: TenantId,
    request: PartsRequest,
    chain: PartsApprovalChain,
  ): Promise<PartsPendingApprovalView | null> {
    const level = partsApprovalLevelOfState(request.state);
    if (level === null) {
      return null;
    }
    const order = await this.orders.find(tenant, request.workOrderId);
    const resolution = await this.levelApproversFor(tenant, level, chain, order);
    return {
      level,
      state: request.state,
      approvers: resolution.approvers,
      note: resolution.note,
    };
  }

  /** 完成指定经办人名下（source=workorder + refType + refId）的 open 待办。 */
  private async completeTodosFor(
    tenant: TenantId,
    assignee: UserId,
    refType: string,
    refId: string,
  ): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, assignee);
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (todo.source === WORKORDER_TODO_SOURCE && todo.refType === refType && todo.refId === refId && todo.status === 'open') {
        const done = await this.todos.complete(tenant, assignee, todo.id);
        if (done !== null) completed.push(done);
      }
    }
    return completed;
  }
}

// ---- 查询视图形状 ----

export interface WorkOrderDetail {
  readonly order: WorkOrder;
  readonly attachments: readonly WorkOrderAttachment[];
  readonly latestKitCheck: KitCheck | null;
  readonly milestones: readonly WorkOrderMilestone[];
  readonly customerName: string | null;
}

export interface WorkOrderProgressView {
  readonly workOrderId: WorkOrderId;
  readonly projectName: string;
  readonly state: string;
  readonly plannedDeliveryAt: string | null;
  readonly packagingArrivalAt: string | null;
  readonly daysToDelivery: number | null;
  readonly milestones: readonly WorkOrderMilestone[];
}

export interface KitBoardRow {
  readonly workOrderId: WorkOrderId;
  readonly projectName: string;
  readonly complete: boolean;
  readonly kinds: readonly KitCheckKindSummaryPayload[];
  readonly gapLines: readonly KitCheckLineGapPayload[];
  readonly refreshedAt: string;
}

export interface WorkOrderDeliverySituation {
  readonly orders: readonly DeliverySituationRow[];
  readonly distribution: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

/**
 * 待审级实时解析视图（S6 / RREQ-IS-037：待审批人实时按角色解析不落库）。
 * 待审三态（submitted/level2_review/level3_review）统一「审批中」文案——
 * 区分节点看 level，不看状态文案。
 */
export interface PartsPendingApprovalView {
  /** 当前审批层级（1/2/3）。 */
  readonly level: number;
  /** 当前待审态 id（「审批中」族成员）。 */
  readonly state: string;
  /** 本级或签审批人（实时解析；空 = 未配置或无审批人，读面展示「—」）。 */
  readonly approvers: readonly UserId[];
  /** 名单为空时的原因说明（正常 null）。 */
  readonly note: string | null;
}

/** 配件申请详情（申请行 + 机器迁移史 + 待审级实时解析）。 */
export interface PartsRequestDetail {
  readonly partsRequest: PartsRequest;
  readonly milestones: readonly WorkOrderMilestone[];
  readonly pendingApproval: PartsPendingApprovalView | null;
}
