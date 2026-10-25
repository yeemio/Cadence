/**
 * DispatchService —— 六类派工用例编排（M2-W6，04-dispatch.md v1.0）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分（committed/rejected 为值；indeterminate 内存路径不产生）。
 *
 * 六件事：
 *
 * 1. 六类创建（dispatch.create）：kind 判别载荷校验（零件单带图号×工序×工艺
 *    属性快照——尺寸/材料随单）；装配/电气创建前经 workorder KitCheck 读端口
 *    齐套放行拦截（未齐套/无核查记录拒绝创建——硬拦截，fail-closed）；
 * 2. 外协链路（kind=outsourcing）：明细行批量派发到供应商（每行供应商×工序×
 *    数量）；创建时未给定单价的行经 baseline 取价端口实时取价（无规则落
 *    "未定价"）；outsourcing.price.backfill 补录单价 → OutsourcingPriced 事件
 *    （costing 重算信号）；完工（complete）联动 InspectionIntakePort 外协回厂
 *    触发（未接线 = 回执 created:false，完工照常落账）；
 * 3. 四态状态机：draft→assigned→executing→done 经 engine-flow runtime 驱动
 *    （配置整体可替换，ADR-0010）；draft/assigned 可撤（CANCEL→cancelled，
 *    发 DispatchCancelled——reporting 侧据此禁止再报）；
 * 4. 待办联动：assign 派工到人 → 执行人待办；start/cancel/complete 消待办；
 * 5. 打印数据：外协加工单结构化数据（DispatchPrintDocument）+ 打印端口提交
 *    （integration-print 组合根接线——业务侧只持最小镜像端口）；
 * 6. 进度上卷：progressFacts 查询按 workorder ProgressFact 同形产出
 *    （零件→machining、装配/电气→assembly；外协/售后/零工不进上卷）——
 *    workorder 订阅消费，dispatch 不直接写他域。
 *
 * 落账顺序（与 workorder/listing 同取舍）：幂等记账 → 投影乐观推进（建单先落
 * draft 初始投影，无机器事件）→ 机器事件账本 → 域事件发布（BusinessEvent +
 * Outbox）。投影行先在是机器事件 append 的前置（PG 账本按投影行解析租户，
 * 孤儿聚合拒写）。
 */
import {
  EventId,
  UserId,
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
  DEFAULT_DISPATCH_FLOW_CONFIG,
  DEFAULT_KIT_GATED_KINDS,
  dispatchKindLabel,
  dispatchStateLabel,
  progressStageOfDispatchKind,
  type DispatchKind,
} from './dispatch-config.js';
import {
  DISPATCH_ORDER_AGGREGATE_TYPE,
  OUTSOURCING_LINE_AGGREGATE_TYPE,
  makeDispatchAssignedEvent,
  makeDispatchCancelledEvent,
  makeDispatchCompletedEvent,
  makeDispatchCreatedEvent,
  makeDispatchStartedEvent,
  makeOutsourcingPricedEvent,
  provenanceOf,
  type DispatchMachineMilestone,
  type DispatchProgressFactPayload,
  type InspectionIntakeReceiptPayload,
} from './dispatch-events.js';
import {
  DispatchInputError,
  DispatchNotFoundError,
  DispatchStateError,
} from './dispatch-errors.js';
import {
  parseDispatchAssignPayload,
  parseDispatchCancelPayload,
  parseDispatchCompletePayload,
  parseDispatchCreatePayload,
  parseDispatchStartPayload,
  parseOutsourcingPriceBackfillPayload,
  type DispatchCommand,
  type DispatchCommandKind,
  type OutsourcingLinePayload,
} from './dispatch-input.js';
import {
  DISPATCH_EMPTY_PRICE_SOURCE,
  DISPATCH_NOOP_INSPECTION_INTAKE,
  DISPATCH_NOOP_PRINT_PORT,
  DISPATCH_TODO_REF_TYPE,
  DISPATCH_TODO_SOURCE,
  EMPTY_KIT_CHECK_PORT,
  type DispatchPrintDocument,
  type DispatchPrintPort,
  type DispatchPrintReceipt,
  type DispatchProgressFact,
  type InspectionIntakePort,
  type KitCheckReadPort,
  type OutsourcingPriceSource,
} from './dispatch-ports.js';
import type {
  AppendOutsourcingLineInput,
  DispatchDomainEventStore,
  DispatchOperationStore,
  DispatchOrder,
  DispatchOrderStore,
  ListDispatchOrdersFilter,
  OutsourcingLine,
  OutsourcingLineStore,
} from './dispatch-stores.js';
import { newDispatchOrderId, newDomainEventId, newOutsourcingLineId } from './dispatch-ids.js';

// ---- 结果形状 ----

export interface DispatchCommitted extends CommittedOutcome {
  readonly todosCreated: readonly TodoItem[];
  readonly todosCompleted: readonly TodoItem[];
  readonly dispatchOrder?: DispatchOrder;
  /** 外协明细行集（create/补录时携带）。 */
  readonly outsourcingLines?: readonly OutsourcingLine[];
  /** 外协回厂触发回执（complete 外协单时携带）。 */
  readonly inspectionIntake?: InspectionIntakeReceiptPayload | null;
}

export type DispatchCommandResult = DispatchCommitted | RejectedOutcome | IndeterminateOutcome;

export interface DispatchServiceOptions {
  /** 派工单状态机配置（缺省 DEFAULT_DISPATCH_FLOW_CONFIG；整体替换 = 换合法集）。 */
  readonly flowConfig: ApprovalFlowConfig;
  /** 齐套放行拦截覆盖的 kind（缺省 DEFAULT_KIT_GATED_KINDS：装配/电气）。 */
  readonly kitGatedKinds: readonly string[];
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface DispatchCrossModulePorts {
  /** workorder KitCheck 齐套读（装配/电气派工创建放行判断）。 */
  readonly kitCheck: KitCheckReadPort;
  /** baseline 外协计价实时取价（未给定单价的行）。 */
  readonly priceSource: OutsourcingPriceSource;
  /** inspection 外协回厂触发（外协单 done 联动）。 */
  readonly inspectionIntake: InspectionIntakePort;
  /** 打印端口（外协加工单——integration-print 组合根接线）。 */
  readonly print: DispatchPrintPort;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

/** 金额（分）→ 十进制展示串（打印数据用；纯整数换算，无浮点参与）。 */
function formatMinor(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export class DispatchService {
  private readonly options: DispatchServiceOptions;
  private readonly ports: DispatchCrossModulePorts;

  constructor(
    private readonly orders: DispatchOrderStore,
    private readonly outsourcingLines: OutsourcingLineStore,
    private readonly operations: DispatchOperationStore,
    private readonly domainEvents: DispatchDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    private readonly todos: TodoStore,
    ports: Partial<DispatchCrossModulePorts> = {},
    options: Partial<DispatchServiceOptions> = {},
  ) {
    this.ports = {
      kitCheck: ports.kitCheck ?? EMPTY_KIT_CHECK_PORT,
      priceSource: ports.priceSource ?? DISPATCH_EMPTY_PRICE_SOURCE,
      inspectionIntake: ports.inspectionIntake ?? DISPATCH_NOOP_INSPECTION_INTAKE,
      print: ports.print ?? DISPATCH_NOOP_PRINT_PORT,
    };
    this.options = {
      flowConfig: options.flowConfig ?? DEFAULT_DISPATCH_FLOW_CONFIG,
      kitGatedKinds: options.kitGatedKinds ?? DEFAULT_KIT_GATED_KINDS,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(
    envelope: CommandEnvelope<DispatchCommand>,
    pathId?: string,
  ): Promise<DispatchCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly DispatchCommandKind[] = ['dispatch.create.v1'];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'dispatch.create.v1':
        return this.createOrder(envelope);
      case 'dispatch.assign.v1':
        return this.assignOrder(envelope, this.requirePathId(pathId, kind));
      case 'dispatch.start.v1':
        return this.startOrder(envelope, this.requirePathId(pathId, kind));
      case 'dispatch.complete.v1':
        return this.completeOrder(envelope, this.requirePathId(pathId, kind));
      case 'dispatch.cancel.v1':
        return this.cancelOrder(envelope, this.requirePathId(pathId, kind));
      case 'outsourcing.price.backfill.v1':
        return this.backfillPrice(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: DispatchCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new DispatchInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- dispatch.create（六类创建 + 齐套拦截 + 外协取价） ----

  private async createOrder(
    envelope: CommandEnvelope<DispatchCommand>,
  ): Promise<DispatchCommandResult> {
    const payload = parseDispatchCreatePayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    // 齐套放行拦截（装配/电气——默认配置可整体替换，ADR-0010 三层之默认配置层）：
    // 未齐套/无核查记录拒绝创建（fail-closed：齐套事实不可伪证）。
    let kitEvidence: { readonly kitCheckId: string; readonly refreshedAt: string } | null = null;
    if (this.options.kitGatedKinds.includes(payload.kind)) {
      if (payload.workOrderId === null) {
        return rejected(
          `${dispatchKindLabel(payload.kind)}必须挂工作令（workOrderId）——齐套放行判断按工作令读 KitCheck`,
        );
      }
      const fact = await this.ports.kitCheck.latestKitCheck(tenant, payload.workOrderId);
      if (fact === null) {
        return rejected(
          `工作令 '${payload.workOrderId}' 无齐套核查记录（KitCheck 端口未接线或未刷新）——${dispatchKindLabel(payload.kind)}被齐套拦截，须先齐套通过`,
        );
      }
      if (!fact.complete) {
        return rejected(
          `工作令 '${payload.workOrderId}' 齐套未通过（缺 ${fact.gapLineCount} 行，核查于 ${fact.refreshedAt.slice(0, 10)}）——${dispatchKindLabel(payload.kind)}被齐套拦截，齐套后才放行`,
        );
      }
      kitEvidence = { kitCheckId: fact.id, refreshedAt: fact.refreshedAt };
    }

    const dispatchId = newDispatchOrderId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: DISPATCH_ORDER_AGGREGATE_TYPE,
      aggregateId: dispatchId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 外协取价：未给定单价的行经 baseline 取价端口实时取价（无规则落未定价——补录锚点）。
    let lineInputs: AppendOutsourcingLineInput[] = [];
    if (payload.kind === 'outsourcing') {
      lineInputs = [];
      for (const [index, line] of payload.lines.entries()) {
        const priced = await this.resolveLinePrice(tenant, line);
        lineInputs.push({
          tenant,
          id: newOutsourcingLineId(),
          dispatchId,
          lineNo: index + 1,
          processCode: line.processCode,
          drawingNo: line.drawingNo,
          supplierRef: line.supplierRef,
          supplierName: line.supplierName,
          quantity: line.quantity,
          unitPriceMinor: priced.unitPriceMinor,
          priceSource: priced.priceSource,
          marginPermyriad: priced.marginPermyriad,
          promisedAt: line.promisedAt,
          sourceListingLineId: line.sourceListingLineId,
        });
      }
    }

    const firstSupplier =
      payload.kind === 'outsourcing' ? (payload.lines[0]?.supplierName ?? payload.lines[0]?.supplierRef ?? null) : null;
    const created = await this.orders.create({
      tenant,
      id: dispatchId,
      workOrderId: payload.workOrderId,
      kind: payload.kind,
      flowConfigId: this.options.flowConfig.flowId,
      state: this.options.flowConfig.initial, // draft：初始态落库，无机器事件
      objectVersion: 1,
      title: payload.title ?? this.defaultTitle(payload.kind, payload.drawingNo, payload.operationCode, firstSupplier),
      drawingNo: payload.drawingNo,
      operationCode: payload.operationCode,
      material: payload.material,
      sizeSpec: payload.sizeSpec,
      quantity: payload.quantity,
      assignee: payload.assignee,
      dueAt: payload.dueAt,
      remark: payload.remark,
    });
    const lines =
      lineInputs.length === 0 ? [] : await this.outsourcingLines.appendLines(lineInputs);

    const payloadOut = {
      workOrderId: payload.workOrderId,
      kind: payload.kind,
      title: created.title,
      drawingNo: payload.drawingNo,
      operationCode: payload.operationCode,
      material: payload.material,
      sizeSpec: payload.sizeSpec,
      quantity: payload.quantity,
      dueAt: payload.dueAt,
      kitCheck: kitEvidence,
      outsourcingLines: lines.map((line) => ({
        lineId: line.id,
        lineNo: line.lineNo,
        processCode: line.processCode,
        supplierRef: line.supplierRef,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        priceSource: line.priceSource,
        marginPermyriad: line.marginPermyriad,
        promisedAt: line.promisedAt,
      })),
      objectVersion: 1,
      actor: envelope.issuedBy,
    };
    const event = makeDispatchCreatedEvent(this.domainEventBase(envelope), payloadOut, dispatchId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      dispatchOrder: created,
      ...(lines.length === 0 ? {} : { outsourcingLines: lines }),
    };
  }

  /** 未给定单价的行 → 取价端口实时取价；给定 → 人工单价（manual）。 */
  private async resolveLinePrice(
    tenant: TenantId,
    line: OutsourcingLinePayload,
  ): Promise<{
    readonly unitPriceMinor: number | null;
    readonly priceSource: 'lookup' | 'manual' | null;
    readonly marginPermyriad: number | null;
  }> {
    if (line.unitPriceMinor !== null) {
      return { unitPriceMinor: line.unitPriceMinor, priceSource: 'manual', marginPermyriad: null };
    }
    const quote = await this.ports.priceSource.resolve(tenant, line.processCode);
    if (quote === null) {
      return { unitPriceMinor: null, priceSource: null, marginPermyriad: null };
    }
    return { unitPriceMinor: quote.priceMinor, priceSource: 'lookup', marginPermyriad: quote.marginPermyriad };
  }

  private defaultTitle(
    kind: DispatchKind,
    drawingNo: string | null,
    operationCode: string | null,
    supplier: string | null,
  ): string {
    if (kind === 'part' && drawingNo !== null && operationCode !== null) {
      return `零件派工：${drawingNo} × ${operationCode}`;
    }
    if (kind === 'outsourcing' && supplier !== null) {
      return `外协派工：${supplier}`;
    }
    if (operationCode !== null) {
      return `${dispatchKindLabel(kind)}：${operationCode}`;
    }
    return dispatchKindLabel(kind);
  }

  // ---- dispatch.assign（draft→assigned，派工到人 + 待办） ----

  private async assignOrder(
    envelope: CommandEnvelope<DispatchCommand>,
    dispatchId: string,
  ): Promise<DispatchCommandResult> {
    const payload = parseDispatchAssignPayload(envelope.command.payload);
    const order = await this.loadOrder(envelope.tenantId, dispatchId);
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在派工单 '${dispatchId}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，派工单当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const outcome = runtime.send('ASSIGN', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '派工到人',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 不可派工（ASSIGN 返回 ${outcome.status}——仅草稿可派工）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: DISPATCH_ORDER_AGGREGATE_TYPE,
        aggregateId: dispatchId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        envelope.tenantId,
        dispatchId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { assignee: payload.assignee },
      );

      const payloadOut = {
        assignee: payload.assignee,
        remark: payload.remark,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeDispatchAssignedEvent(this.domainEventBase(envelope), payloadOut, dispatchId);
      await this.domainEvents.append(event);

      // 待办推送执行人（合同 §6：Assigned → 待办）。
      const todo = await this.todos.create({
        tenant: envelope.tenantId,
        assignee: payload.assignee,
        title: `派工待办：${advanced.title}（数量 ${advanced.quantity}）`,
        source: DISPATCH_TODO_SOURCE,
        refType: DISPATCH_TODO_REF_TYPE,
        refId: dispatchId,
      });

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [todo],
        todosCompleted: [],
        dispatchOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- dispatch.start（assigned→executing，开工 + 消待办 + 进度事实） ----

  private async startOrder(
    envelope: CommandEnvelope<DispatchCommand>,
    dispatchId: string,
  ): Promise<DispatchCommandResult> {
    const payload = parseDispatchStartPayload(envelope.command.payload);
    const order = await this.loadOrder(envelope.tenantId, dispatchId);
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在派工单 '${dispatchId}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，派工单当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const outcome = runtime.send('START', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '开工',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 不可开工（START 返回 ${outcome.status}——仅已派工可开工）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: DISPATCH_ORDER_AGGREGATE_TYPE,
        aggregateId: dispatchId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        envelope.tenantId,
        dispatchId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const progress = this.progressFactOf(advanced, 'in_progress');
      const payloadOut = {
        assignee: advanced.assignee,
        progress,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeDispatchStartedEvent(this.domainEventBase(envelope), payloadOut, dispatchId);
      await this.domainEvents.append(event);

      // 开工响应派工待办（执行人名下该单 open 待办完成）。
      const todosCompleted =
        advanced.assignee !== null
          ? await this.completeTodosFor(envelope.tenantId, advanced.assignee, dispatchId)
          : [];

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        dispatchOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- dispatch.complete（executing→done，完工 + 外协回厂触发） ----

  private async completeOrder(
    envelope: CommandEnvelope<DispatchCommand>,
    dispatchId: string,
  ): Promise<DispatchCommandResult> {
    const payload = parseDispatchCompletePayload(envelope.command.payload);
    const order = await this.loadOrder(envelope.tenantId, dispatchId);
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在派工单 '${dispatchId}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，派工单当前 objectVersion=${order.objectVersion}`,
      );
    }
    const doneQty = payload.doneQty ?? order.quantity;
    if (doneQty > order.quantity) {
      return rejected(`完工数量超派工数量：done ${doneQty} > 派工 ${order.quantity}`);
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const outcome = runtime.send('COMPLETE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '完工',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 不可完工（COMPLETE 返回 ${outcome.status}——仅执行中可完工）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: DISPATCH_ORDER_AGGREGATE_TYPE,
        aggregateId: dispatchId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        envelope.tenantId,
        dispatchId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { doneQty },
      );

      // 外协回厂触发（kind=outsourcing：done 联动 inspection 外协质检）：
      // 通知式——回执进事件载荷，未接线（created:false）不阻塞完工落账。
      let intake: InspectionIntakeReceiptPayload | null = null;
      if (order.kind === 'outsourcing') {
        const lines = await this.outsourcingLines.listByDispatch(envelope.tenantId, dispatchId);
        const receipt = await this.ports.inspectionIntake.receiveSourceFact(envelope.tenantId, {
          sourceType: 'dispatch',
          sourceRefId: dispatchId,
          itemId: null,
          drawingNo: lines[0]?.drawingNo ?? null,
          quantity: order.quantity,
          workOrderId: order.workOrderId,
          occurredAt: this.now(),
          triggeredBy: envelope.issuedBy,
        });
        intake = {
          inspectionId: receipt.inspectionId,
          created: receipt.created,
          reason: receipt.reason ?? null,
        };
      }

      const progress = this.progressFactOf(advanced, 'done');
      const payloadOut = {
        doneQty,
        quantity: advanced.quantity,
        assignee: advanced.assignee,
        progress,
        inspectionIntake: intake,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeDispatchCompletedEvent(this.domainEventBase(envelope), payloadOut, dispatchId);
      await this.domainEvents.append(event);

      const todosCompleted =
        advanced.assignee !== null
          ? await this.completeTodosFor(envelope.tenantId, advanced.assignee, dispatchId)
          : [];

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        dispatchOrder: advanced,
        inspectionIntake: intake,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- dispatch.cancel（draft/assigned→cancelled，撤销——reporting 侧禁再报） ----

  private async cancelOrder(
    envelope: CommandEnvelope<DispatchCommand>,
    dispatchId: string,
  ): Promise<DispatchCommandResult> {
    const payload = parseDispatchCancelPayload(envelope.command.payload);
    const order = await this.loadOrder(envelope.tenantId, dispatchId);
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在派工单 '${dispatchId}'`);
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，派工单当前 objectVersion=${order.objectVersion}`,
      );
    }

    const runtime = await this.replayOrder(order);
    try {
      const from = runtime.state();
      const outcome = runtime.send('CANCEL', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '撤销派工',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(
          `状态 '${from}' 不可撤销（CANCEL 返回 ${outcome.status}——仅草稿/已派工可撤，执行中起不可撤）`,
        );
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: DISPATCH_ORDER_AGGREGATE_TYPE,
        aggregateId: dispatchId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const advanced = await this.orders.advance(
        envelope.tenantId,
        dispatchId,
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );

      const payloadOut = {
        fromState: from,
        remark: payload.remark,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeDispatchCancelledEvent(this.domainEventBase(envelope), payloadOut, dispatchId);
      await this.domainEvents.append(event);

      const todosCompleted =
        advanced.assignee !== null
          ? await this.completeTodosFor(envelope.tenantId, advanced.assignee, dispatchId)
          : [];

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        dispatchOrder: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- outsourcing.price.backfill（补录单价 → OutsourcingPriced） ----

  private async backfillPrice(
    envelope: CommandEnvelope<DispatchCommand>,
    lineId: string,
  ): Promise<DispatchCommandResult> {
    const payload = parseOutsourcingPriceBackfillPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const line = await this.outsourcingLines.find(tenant, lineId);
    if (line === null) {
      return rejected(`租户 '${tenant}' 内不存在外协明细 '${lineId}'`);
    }
    if (envelope.expectedRevision !== line.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，外协明细当前 objectVersion=${line.objectVersion}`,
      );
    }

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: OUTSOURCING_LINE_AGGREGATE_TYPE,
      aggregateId: lineId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const updated = await this.outsourcingLines.backfillPrice(tenant, lineId, line.objectVersion, {
      unitPriceMinor: payload.unitPriceMinor,
      priceSource: 'backfill',
      marginPermyriad: null,
      ...(payload.promisedAt === null ? {} : { promisedAt: payload.promisedAt }),
    });
    if (updated === null) {
      return rejected(
        `外协明细 '${lineId}' 版本推进冲突：期望 ${line.objectVersion}（可能存在并发写入，拒绝继续）`,
      );
    }

    const payloadOut = {
      dispatchId: updated.dispatchId,
      lineNo: updated.lineNo,
      processCode: updated.processCode,
      supplierRef: updated.supplierRef,
      previousUnitPriceMinor: line.unitPriceMinor,
      unitPriceMinor: updated.unitPriceMinor as number,
      quantity: updated.quantity,
      objectVersion: updated.objectVersion,
      actor: envelope.issuedBy,
    };
    const event = makeOutsourcingPricedEvent(this.domainEventBase(envelope), payloadOut, lineId);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: updated.objectVersion,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      outsourcingLines: [updated],
    };
  }

  // ---- 查询 ----

  /** 六类派工单列表（可选 kind/状态/工作令/执行人过滤；createdAt 降序）。 */
  async listDispatchOrders(
    tenant: TenantId,
    filter?: ListDispatchOrdersFilter,
  ): Promise<readonly DispatchOrder[]> {
    return this.orders.list(tenant, filter);
  }

  /** 派工单详情：单据头 + 外协明细行（lineNo 升序）+ 机器迁移里程碑。 */
  async dispatchDetail(
    tenant: TenantId,
    dispatchId: string,
  ): Promise<DispatchDetail> {
    const order = await this.orders.find(tenant, dispatchId);
    if (order === null) {
      throw new DispatchNotFoundError(`租户 '${tenant}' 内不存在派工单 '${dispatchId}'`);
    }
    const lines =
      order.kind === 'outsourcing'
        ? await this.outsourcingLines.listByDispatch(tenant, dispatchId)
        : [];
    const page = await this.machineEvents.readByAggregate({
      id: dispatchId,
      type: DISPATCH_ORDER_AGGREGATE_TYPE,
    });
    return { order, outsourcingLines: lines, milestones: machineMilestones(page.events) };
  }

  /** 按人任务视图（执行人名下已派工/执行中的任务集）。 */
  async tasksByAssignee(tenant: TenantId, assignee: string): Promise<readonly DispatchOrder[]> {
    return (await this.orders.list(tenant, { assignee })).filter(
      (order) => order.state === 'assigned' || order.state === 'executing',
    );
  }

  /** 按序任务视图（工作令名下全部派工单，createdAt 降序——与列表同序）。 */
  async tasksByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly DispatchOrder[]> {
    return this.orders.list(tenant, { workOrderId });
  }

  /** 外协单供应商维度（行集 + 派工单投影 join；lineNo 升序）。 */
  async outsourcingBySupplier(
    tenant: TenantId,
    supplierRef: string,
  ): Promise<readonly OutsourcingSupplierRow[]> {
    const lines = await this.outsourcingLines.listBySupplier(tenant, supplierRef);
    const rows: OutsourcingSupplierRow[] = [];
    for (const line of lines) {
      const order = await this.orders.find(tenant, line.dispatchId);
      if (order === null) continue; // 行必有投影行（创建原子落）；缺失 = 数据级异常，跳行不炸查询
      rows.push({
        lineId: line.id,
        dispatchId: line.dispatchId,
        workOrderId: order.workOrderId,
        dispatchState: order.state,
        lineNo: line.lineNo,
        processCode: line.processCode,
        drawingNo: line.drawingNo,
        supplierRef: line.supplierRef,
        supplierName: line.supplierName,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        priceSource: line.priceSource,
        marginPermyriad: line.marginPermyriad,
        promisedAt: line.promisedAt,
        objectVersion: line.objectVersion,
      });
    }
    return rows;
  }

  /** 外协加工单打印数据（结构化——TSPL/pdf 渲染归 integration-print 适配器）。 */
  async outsourcingPrintData(tenant: TenantId, dispatchId: string): Promise<DispatchPrintDocument> {
    const detail = await this.dispatchDetail(tenant, dispatchId);
    if (detail.order.kind !== 'outsourcing') {
      throw new DispatchNotFoundError(`派工单 '${dispatchId}' 不是外协单（kind=${detail.order.kind}），无外协加工单打印数据`);
    }
    const supplier =
      detail.outsourcingLines[0]?.supplierName ?? detail.outsourcingLines[0]?.supplierRef ?? '';
    const promisedAt = detail.outsourcingLines.find((line) => line.promisedAt !== null)?.promisedAt ?? null;
    return {
      dispatchId: detail.order.id,
      kind: detail.order.kind,
      title: `外协加工单（${supplier}）`,
      fields: [
        { label: '派工单号', value: detail.order.id },
        { label: '工作令', value: detail.order.workOrderId ?? '' },
        { label: '供应商', value: supplier },
        { label: '派工数量', value: String(detail.order.quantity) },
        { label: '交期', value: promisedAt === null ? '' : promisedAt.slice(0, 10) },
        { label: '状态', value: dispatchStateLabel(detail.order.state) },
      ],
      lines: detail.outsourcingLines.map((line) => ({
        lineNo: line.lineNo,
        processCode: line.processCode,
        drawingNo: line.drawingNo,
        quantity: line.quantity,
        unitPriceLabel: line.unitPriceMinor === null ? '未定价' : formatMinor(line.unitPriceMinor),
        promisedAt: line.promisedAt,
      })),
    };
  }

  /** 打印提交（查询侧动作：构建打印数据并交打印端口；回执不因未接线失败）。 */
  async printOutsourcingSheet(
    tenant: TenantId,
    dispatchId: string,
  ): Promise<{ readonly document: DispatchPrintDocument; readonly receipt: DispatchPrintReceipt }> {
    const document = await this.outsourcingPrintData(tenant, dispatchId);
    const receipt = await this.ports.print.print(tenant, document);
    return { document, receipt };
  }

  /**
   * 进度事实（workorder 上卷供给侧：零件→machining、装配/电气→assembly；
   * 外协/售后/零工不进上卷）。初版口径：状态映射 done→done / executing→
   * in_progress / 其余→pending；对账阶段按活系统行为校正。
   */
  async progressFacts(tenant: TenantId, workOrderId: string): Promise<readonly DispatchProgressFact[]> {
    const orders = await this.orders.list(tenant, { workOrderId });
    const facts: DispatchProgressFact[] = [];
    for (const order of orders) {
      const fact = this.progressFactOf(order, order.state === 'done' ? 'done' : order.state === 'executing' ? 'in_progress' : 'pending');
      if (fact !== null) facts.push(fact);
    }
    return facts;
  }

  // ---- 私有辅助 ----

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<DispatchCommand>): {
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

  private async loadOrder(tenant: TenantId, dispatchId: string): Promise<DispatchOrder | null> {
    const order = await this.orders.find(tenant, dispatchId);
    if (order === null) return null;
    if (order.flowConfigId !== this.options.flowConfig.flowId) {
      throw new DispatchStateError(
        `派工单 '${dispatchId}' 由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.flowConfig.flowId}' 不符（配置换代，须整体迁移）`,
      );
    }
    return order;
  }

  /** 重放派工单机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayOrder(order: DispatchOrder): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: order.id, type: DISPATCH_ORDER_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.flowConfig,
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
        throw new DispatchStateError(
          `派工单事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== order.state || runtime.objectVersion() !== order.objectVersion) {
      runtime.stop();
      throw new DispatchStateError(
        `派工单事件账本与投影行不一致：投影 ${order.state}@v${order.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 进度事实推导（stage 映射见 dispatch-config；不进上卷的 kind 返回 null）。 */
  private progressFactOf(
    order: DispatchOrder,
    status: 'pending' | 'in_progress' | 'done',
  ): DispatchProgressFactPayload | null {
    const stage = progressStageOfDispatchKind(order.kind);
    if (stage === null || order.operationCode === null) return null;
    return {
      stage,
      drawingNo: order.drawingNo,
      operationId: order.operationCode,
      doneQty: order.doneQty,
      totalQty: order.quantity,
      status,
    };
  }

  /** 完成执行人名下（source=dispatch + refId）的 open 待办。 */
  private async completeTodosFor(
    tenant: TenantId,
    assignee: UserId,
    dispatchId: string,
  ): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, assignee);
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (
        todo.source === DISPATCH_TODO_SOURCE &&
        todo.refType === DISPATCH_TODO_REF_TYPE &&
        todo.refId === dispatchId &&
        todo.status === 'open'
      ) {
        const done = await this.todos.complete(tenant, assignee, todo.id);
        if (done !== null) completed.push(done);
      }
    }
    return completed;
  }
}

// ---- 查询视图形状 ----

export interface DispatchDetail {
  readonly order: DispatchOrder;
  readonly outsourcingLines: readonly OutsourcingLine[];
  readonly milestones: readonly DispatchMachineMilestone[];
}

/** 外协单供应商维度行（明细行 × 派工单投影 join）。 */
export interface OutsourcingSupplierRow {
  readonly lineId: string;
  readonly dispatchId: string;
  readonly workOrderId: string | null;
  readonly dispatchState: string;
  readonly lineNo: number;
  readonly processCode: string;
  readonly drawingNo: string | null;
  readonly supplierRef: string;
  readonly supplierName: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly priceSource: string | null;
  readonly marginPermyriad: number | null;
  readonly promisedAt: string | null;
  readonly objectVersion: number;
}

/** 机器账本迁移史（本地读法，与 workorder/listing milestoneHistory 同构）。 */
function machineMilestones(events: readonly ApprovalEvent[]): readonly DispatchMachineMilestone[] {
  return events.map((event) => ({
    from: event.payload.from,
    to: event.payload.to,
    event: event.payload.event,
    at: event.occurredAt,
    actor: event.payload.actor,
    objectVersion: event.payload.objectVersion,
  }));
}
