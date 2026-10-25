/**
 * InspectionService —— 质检用例编排（M2-W4）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分返回（committed/rejected 为值；indeterminate 由 PG 适配层
 * 在写入失联窗口产出，内存路径不产生）——与 workorder 同一体例。
 *
 * 四件事：
 *
 * 1. 来源触发：四类来源事实（reporting 末道报工 / dispatch 外协回厂 /
 *    listing 收货）经 InspectionIntakePort.receiveSourceFact 自动生成待检单
 *    （同来源对象幂等去重；末道报工与外协回厂同属自制外协类）；手工建单走
 *    inspection.create.v1。
 *
 * 2. 状态机：质检单四态与不合格处置三态均经 engine-flow runtime 驱动（配置
 *    注入可整体替换，ADR-0010 条 2）；判定迁移走 decision 类（判定记录随
 *    迁移事件 payload 留痕 = 检验记录事实）。落账顺序：幂等记账 → 机器事件 →
 *    投影乐观推进 → 域事件发布（BusinessEvent + Outbox）——机器账本是重放
 *    事实源，重放结果与投影行不一致即数据级冲突（InspectionStateError）。
 *
 * 3. 放行咬合：passed（判定或复检合格）发 InspectionReleased 放行事实事件
 *    （inventory 消费锚点）+ StockReleasePort 直连通知（缺省 no-op——合同
 *    §2：passed 后库存方可入库）。
 *
 * 4. 不合格闭环与超时点名：判定不合格自动建不合格明细（open）；dispose 登记
 *    处置（返工/让步/报废）与原因；返工处置须复检合格方可 close；该单全部
 *    明细闭环后质检单推进 closed。闭环超时（closeTimeoutMs 配置）由
 *    scanOverdue 点名：InspectionOverdue 事件 + 待办（TodoStore）+ IM
 *    （NotifyChannel 缺省 no-op），一次点名幂等。
 */
import {
  EventId,
  InspectionId,
  UserId,
  type BusinessEvent,
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
} from '@smes/engine-flow';
import type { TodoItem, TodoStore } from '../workbench/workbench-stores.js';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_INSPECTION_FLOW_CONFIG,
  DEFAULT_NONCONFORM_FLOW_CONFIG,
  NONCONFORM_DISPOSALS,
  kindForSourceFact,
  type InspectionKind,
  type NonconformDisposal,
} from './inspection-config.js';
import {
  INSPECTION_AGGREGATE_TYPE,
  INSPECTION_EVENT_TYPES,
  NONCONFORM_AGGREGATE_TYPE,
  makeInspectionCreatedEvent,
  makeInspectionJudgedEvent,
  makeInspectionOverdueEvent,
  makeInspectionReleasedEvent,
  makeNonconformClosedEvent,
  makeNonconformDisposedEvent,
  provenanceOf,
  type InspectionCreatedPayload,
  type InspectionJudgePhase,
  type InspectionJudgedPayload,
  type InspectionOverduePayload,
  type InspectionReleasedPayload,
  type NonconformClosedPayload,
  type NonconformDisposedPayload,
} from './inspection-events.js';
import { InspectionInputError, InspectionNotFoundError, InspectionStateError } from './inspection-errors.js';
import {
  parseCloseNonconformPayload,
  parseCreateInspectionPayload,
  parseDisposeNonconformPayload,
  parseJudgeInspectionPayload,
  parseOverdueScanPayload,
  parseRecheckInspectionPayload,
  type InspectionCommand,
  type InspectionCommandKind,
  type JudgeInspectionPayload,
} from './inspection-input.js';
import {
  INSPECTION_TODO_SOURCE,
  NOOP_NOTIFY_CHANNEL,
  NOOP_STOCK_RELEASE_PORT,
  type InspectionIntakePort,
  type InspectionIntakeReceipt,
  type InspectionSourceFact,
  type NotifyChannel,
  type StockReleasePort,
} from './inspection-ports.js';
import type {
  InspectionDomainEventStore,
  InspectionOperationStore,
  InspectionOrder,
  InspectionOrderStore,
  JudgmentFields,
  Nonconform,
  NonconformStore,
  OperationRecord,
} from './inspection-stores.js';
import {
  inspectionKindLabel,
  inspectionStateLabel,
} from './inspection-config.js';
import {
  milestoneHistory,
  rollupInspectionSummary,
  type InspectionMilestone,
  type InspectionSummary,
} from './inspection-summary.js';
import {
  newDomainEventId,
  newInspectionId,
  newNonconformId,
} from './inspection-ids.js';

// ---- 结果形状（CommandOutcome 扩展：命令侧联动与聚合视图回执） ----

export interface InspectionCommitted extends CommittedOutcome {
  /** 本次命令派生的待办（超时点名联动）。 */
  readonly todosCreated: readonly TodoItem[];
  /** 本次命令完成的待办（不合格闭环清点名待办）。 */
  readonly todosCompleted: readonly TodoItem[];
  /** 命令目标聚合的提交后视图。 */
  readonly inspection?: InspectionOrder;
  readonly nonconform?: Nonconform;
  /** 逾期点名产出的点名回执行（inspection.overdue.scan.v1）。 */
  readonly notifications?: readonly InspectionOverdueNotification[];
}

export type InspectionCommandResult = InspectionCommitted | RejectedOutcome;

export interface InspectionServiceOptions {
  /** 质检单四态配置（缺省 DEFAULT_INSPECTION_FLOW_CONFIG；可整体替换 = 换合法集）。 */
  readonly inspectionConfig: ApprovalFlowConfig;
  /** 不合格处置三态配置（缺省 DEFAULT_NONCONFORM_FLOW_CONFIG）。 */
  readonly nonconformConfig: ApprovalFlowConfig;
  /** 闭环超时阈值毫秒（缺省 DEFAULT_CLOSE_TIMEOUT_MS=72h；默认配置层，ADR-0010）。 */
  readonly closeTimeoutMs: number;
  /** 处置枚举白名单（缺省 NONCONFORM_DISPOSALS 三枚举；让步接收码对账后增补）。 */
  readonly disposals: readonly NonconformDisposal[];
  /** 闭环超时点名待办的固定经办人（缺省 null = 点名给该单判定人）。 */
  readonly overdueAssignee: UserId | null;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface InspectionCrossModulePorts {
  readonly stockRelease: StockReleasePort;
  readonly notify: NotifyChannel;
}

/** 闭环超时点名回执（scanOverdue 返回行）。 */
export interface InspectionOverdueNotification {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly judgedAt: string;
  readonly dueAt: string;
  readonly eventId: string;
  readonly todoId: string | null;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

export class InspectionService implements InspectionIntakePort {
  private readonly options: InspectionServiceOptions;
  private readonly ports: InspectionCrossModulePorts;

  constructor(
    private readonly orders: InspectionOrderStore,
    private readonly nonconforms: NonconformStore,
    private readonly operations: InspectionOperationStore,
    private readonly domainEvents: InspectionDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    private readonly todos: TodoStore,
    ports: Partial<InspectionCrossModulePorts> = {},
    options: Partial<InspectionServiceOptions> = {},
  ) {
    this.ports = {
      stockRelease: ports.stockRelease ?? NOOP_STOCK_RELEASE_PORT,
      notify: ports.notify ?? NOOP_NOTIFY_CHANNEL,
    };
    this.options = {
      inspectionConfig: options.inspectionConfig ?? DEFAULT_INSPECTION_FLOW_CONFIG,
      nonconformConfig: options.nonconformConfig ?? DEFAULT_NONCONFORM_FLOW_CONFIG,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      disposals: options.disposals ?? NONCONFORM_DISPOSALS,
      overdueAssignee: options.overdueAssignee ?? null,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  /**
   * 执行一条命令信封。pathId = 资源路径参数（judge/recheck 的目标质检单、
   * dispose/close 的目标不合格处置）——提供时即为目标聚合。
   */
  async execute(
    envelope: CommandEnvelope<InspectionCommand>,
    pathId?: string,
  ): Promise<InspectionCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly InspectionCommandKind[] = [
      'inspection.create.v1',
      'inspection.overdue.scan.v1',
    ];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'inspection.create.v1':
        return this.createInspection(envelope);
      case 'inspection.judge.v1':
        return this.judge(envelope, this.requirePathId(pathId, kind));
      case 'inspection.recheck.v1':
        return this.recheck(envelope, this.requirePathId(pathId, kind));
      case 'inspection.overdue.scan.v1':
        return this.scanOverdue(envelope);
      case 'nonconform.dispose.v1':
        return this.dispose(envelope, this.requirePathId(pathId, kind));
      case 'nonconform.close.v1':
        return this.closeNonconform(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: InspectionCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new InspectionInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- 来源触发：receiveSourceFact（InspectionIntakePort 实现） ----

  /**
   * 四类来源事实 → 自动生成待检单（Done-when：四类来源自动生成待检单）。
   * 幂等双保险：来源对象引用（findBySourceRef）+ operationId（intake-<type>-<ref>）。
   */
  async receiveSourceFact(tenant: TenantId, fact: InspectionSourceFact): Promise<InspectionIntakeReceipt> {
    const kind = kindForSourceFact(fact.sourceType, fact.kind);
    if (kind === null) {
      return {
        inspectionId: null,
        created: false,
        reason: `来源 '${fact.sourceType}' 与质检类别 '${String(fact.kind)}' 组合非法（receipt 须三类采购之一）`,
      };
    }
    if (!(fact.quantity > 0) || fact.quantity > 1_000_000_000) {
      return { inspectionId: null, created: false, reason: `送检数量非法：${String(fact.quantity)}` };
    }
    const existing = await this.orders.findBySourceRef(tenant, fact.sourceType, fact.sourceRefId);
    if (existing !== null) {
      return { inspectionId: existing.id as string, created: false, reason: '来源对象已生成待检单（幂等命中）' };
    }

    const actor = UserId.create(fact.triggeredBy);
    const operationId = `intake-${fact.sourceType}-${fact.sourceRefId}`;
    const id = newInspectionId();
    const recorded = await this.operations.record({
      tenant,
      operationId,
      command: 'inspection.create.v1',
      aggregateType: INSPECTION_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      const again = await this.orders.findBySourceRef(tenant, fact.sourceType, fact.sourceRefId);
      return { inspectionId: again === null ? null : (again.id as string), created: false, reason: '来源事实已处理（幂等命中）' };
    }

    const created = await this.orders.create({
      tenant,
      id: InspectionId.create(id),
      flowConfigId: this.options.inspectionConfig.flowId,
      state: this.options.inspectionConfig.initial,
      objectVersion: 1,
      kind,
      sourceType: fact.sourceType,
      sourceRefId: fact.sourceRefId,
      itemId: fact.itemId,
      drawingNo: fact.drawingNo,
      quantity: fact.quantity,
    });

    const payload: InspectionCreatedPayload = {
      inspectionId: id,
      kind,
      sourceType: fact.sourceType,
      sourceRefId: fact.sourceRefId,
      itemId: fact.itemId,
      drawingNo: fact.drawingNo,
      quantity: fact.quantity,
      actor: fact.triggeredBy,
    };
    await this.domainEvents.append(
      makeInspectionCreatedEvent(
        {
          eventId: EventId.create(newDomainEventId()),
          tenant,
          occurredAt: this.now(),
          provenance: provenanceOf(operationId, 'inspection.create.v1', actor),
        },
        payload,
      ),
    );
    return { inspectionId: id, created: true };
  }

  // ---- inspection.create（手工建单） ----

  private async createInspection(
    envelope: CommandEnvelope<InspectionCommand>,
  ): Promise<InspectionCommandResult> {
    const payload = parseCreateInspectionPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    let kind: InspectionKind = payload.kind;
    if (payload.sourceType !== null) {
      const derived = kindForSourceFact(payload.sourceType, payload.kind);
      if (derived === null) {
        return rejected(
          `来源 '${payload.sourceType}' 与质检类别 '${payload.kind}' 组合非法（receipt 须三类采购之一）`,
        );
      }
      kind = derived;
      const existing = await this.orders.findBySourceRef(tenant, payload.sourceType, payload.sourceRefId as string);
      if (existing !== null) {
        return rejected(
          `来源对象 '${payload.sourceType}:${payload.sourceRefId}' 已有待检单 '${existing.id}'（来源幂等）`,
        );
      }
    }

    const id = newInspectionId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: INSPECTION_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const created = await this.orders.create({
      tenant,
      id: InspectionId.create(id),
      flowConfigId: this.options.inspectionConfig.flowId,
      state: this.options.inspectionConfig.initial,
      objectVersion: 1,
      kind,
      sourceType: payload.sourceType,
      sourceRefId: payload.sourceRefId,
      itemId: payload.itemId,
      drawingNo: payload.drawingNo,
      quantity: payload.quantity,
    });

    const eventPayload: InspectionCreatedPayload = {
      inspectionId: id,
      kind,
      sourceType: payload.sourceType,
      sourceRefId: payload.sourceRefId,
      itemId: payload.itemId,
      drawingNo: payload.drawingNo,
      quantity: payload.quantity,
      actor: envelope.issuedBy,
    };
    const event = makeInspectionCreatedEvent(this.domainEventBase(envelope), eventPayload);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: 1,
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      inspection: created,
    };
  }

  // ---- inspection.judge（合格/不合格数量 + 备注） ----

  private async judge(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseJudgeInspectionPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, InspectionId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在质检单 '${id}'`);
    }
    if (order.flowConfigId !== this.options.inspectionConfig.flowId) {
      return rejected(
        `质检单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.inspectionConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，质检单当前 objectVersion=${order.objectVersion}`,
      );
    }
    if (order.state !== 'pending') {
      return rejected(`质检单 '${id}' 已处 '${order.state}'，仅待检单可判定（复检走 inspection.recheck.v1）`);
    }
    const quantityFault = this.validateJudgmentQuantities(payload, order, '判定');
    if (quantityFault !== null) {
      return rejected(quantityFault);
    }

    const failed = payload.failedQty > 0;
    const verb = failed ? 'FAIL' : 'PASS';
    const runtime = await this.replayInspection(order);
    try {
      const from = runtime.state();
      const outcome = runtime.send(verb, {
        by: envelope.issuedBy,
        reason: payload.remark ?? `${failed ? '判定不合格' : '判定合格'} ${payload.passedQty}/${payload.failedQty}`,
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对命令 '${verb}' 返回 ${outcome.status}（配置守卫或规则不一致）`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: INSPECTION_AGGREGATE_TYPE,
        aggregateId: id,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const now = this.now();
      const judgment: JudgmentFields = {
        passedQty: payload.passedQty,
        failedQty: payload.failedQty,
        judgeRemark: payload.remark,
        judgedBy: envelope.issuedBy,
        judgedAt: now,
        closeDueAt: failed ? new Date(Date.parse(now) + this.options.closeTimeoutMs).toISOString() : null,
      };
      const advanced = await this.orders.advance(
        envelope.tenantId,
        InspectionId.create(id),
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        judgment,
      );

      // 不合格分支：自动创建不合格明细（open）——闭环追踪对象。
      const nonconform = failed
        ? await this.nonconforms.create({
            tenant: envelope.tenantId,
            id: newNonconformId(),
            inspectionId: InspectionId.create(id),
            flowConfigId: this.options.nonconformConfig.flowId,
            state: this.options.nonconformConfig.initial,
            objectVersion: 1,
            itemId: order.itemId,
            quantity: payload.failedQty,
          })
        : null;

      const judgedPayload: InspectionJudgedPayload = {
        inspectionId: id,
        kind: advanced.kind,
        phase: 'judge',
        outcome: failed ? 'failed' : 'passed',
        passedQty: payload.passedQty,
        failedQty: payload.failedQty,
        remark: payload.remark,
        nonconformId: nonconform === null ? null : nonconform.id,
        closeDueAt: judgment.closeDueAt,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const events: BusinessEvent[] = [
        makeInspectionJudgedEvent(this.domainEventBase(envelope), judgedPayload),
      ];

      // 合格分支：放行事实（事件 + 直连端口）——passed 后库存方可入库。
      if (!failed) {
        events.push(
          await this.releaseForStock(envelope, advanced, payload.passedQty, 'judge', runtime.objectVersion()),
        );
      }
      for (const event of events) {
        await this.domainEvents.append(event);
      }

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events,
        todosCreated: [],
        todosCompleted: [],
        inspection: advanced,
        ...(nonconform === null ? {} : { nonconform }),
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- inspection.recheck（复检：failed 起；合格放行，仍失败刷新数量与窗口） ----

  private async recheck(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseRecheckInspectionPayload(envelope.command.payload);
    const order = await this.orders.find(envelope.tenantId, InspectionId.create(id));
    if (order === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在质检单 '${id}'`);
    }
    if (order.flowConfigId !== this.options.inspectionConfig.flowId) {
      return rejected(
        `质检单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.inspectionConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== order.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，质检单当前 objectVersion=${order.objectVersion}`,
      );
    }
    if (order.state !== 'failed') {
      return rejected(`质检单 '${id}' 已处 '${order.state}'，仅不合格单可复检`);
    }
    const quantityFault = this.validateJudgmentQuantities(payload, order, '复检');
    if (quantityFault !== null) {
      return rejected(quantityFault);
    }

    const recorded = await this.operations.record({
      tenant: envelope.tenantId,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: INSPECTION_AGGREGATE_TYPE,
      aggregateId: id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const now = this.now();
    const stillFailed = payload.failedQty > 0;
    const events: BusinessEvent[] = [];

    if (!stillFailed) {
      // 复检合格：RECHECK_PASS 迁移 → passed → 放行。
      const runtime = await this.replayInspection(order);
      try {
        const outcome = runtime.send('RECHECK_PASS', {
          by: envelope.issuedBy,
          reason: payload.remark ?? `复检合格 ${payload.passedQty}/${payload.failedQty}`,
          objectVersion: order.objectVersion,
        });
        if (outcome.status !== 'transitioned') {
          return rejected(`状态 '${order.state}' 对 RECHECK_PASS 返回 ${outcome.status}`);
        }
        await this.machineEvents.append(outcome.event);
        const advanced = await this.orders.advance(
          envelope.tenantId,
          InspectionId.create(id),
          order.objectVersion,
          runtime.state(),
          runtime.objectVersion(),
          {
            passedQty: payload.passedQty,
            failedQty: payload.failedQty,
            judgeRemark: payload.remark,
            judgedBy: envelope.issuedBy,
            judgedAt: now,
            closeDueAt: null,
          },
        );
        const judgedEvent = makeInspectionJudgedEvent(this.domainEventBase(envelope), {
          inspectionId: id,
          kind: advanced.kind,
          phase: 'recheck',
          outcome: 'passed',
          passedQty: payload.passedQty,
          failedQty: payload.failedQty,
          remark: payload.remark,
          nonconformId: null,
          closeDueAt: null,
          objectVersion: runtime.objectVersion(),
          actor: envelope.issuedBy,
        });
        const released = await this.releaseForStock(
          envelope,
          advanced,
          payload.passedQty,
          'recheck',
          runtime.objectVersion(),
        );
        events.push(judgedEvent, released);
        for (const event of events) {
          await this.domainEvents.append(event);
        }
        return {
          status: 'committed',
          newRevision: runtime.objectVersion(),
          events,
          todosCreated: [],
          todosCompleted: [],
          inspection: advanced,
        };
      } finally {
        runtime.stop();
      }
    }

    // 复检仍不合格：无迁移（版本不推进），刷新检验记录与闭环窗口（新处置周期）。
    const updated = await this.orders.updateJudgment(envelope.tenantId, InspectionId.create(id), order.objectVersion, {
      passedQty: payload.passedQty,
      failedQty: payload.failedQty,
      judgeRemark: payload.remark,
      judgedBy: envelope.issuedBy,
      judgedAt: now,
      closeDueAt: new Date(Date.parse(now) + this.options.closeTimeoutMs).toISOString(),
    });
    if (updated === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在质检单 '${id}'`);
    }
    const judgedEvent = makeInspectionJudgedEvent(this.domainEventBase(envelope), {
      inspectionId: id,
      kind: updated.kind,
      phase: 'recheck',
      outcome: 'still_failed',
      passedQty: payload.passedQty,
      failedQty: payload.failedQty,
      remark: payload.remark,
      nonconformId: null,
      closeDueAt: updated.closeDueAt,
      objectVersion: updated.objectVersion,
      actor: envelope.issuedBy,
    });
    await this.domainEvents.append(judgedEvent);
    return {
      status: 'committed',
      newRevision: updated.objectVersion,
      events: [judgedEvent],
      todosCreated: [],
      todosCompleted: [],
      inspection: updated,
    };
  }

  // ---- nonconform.dispose（处置 + 原因） ----

  private async dispose(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseDisposeNonconformPayload(envelope.command.payload);
    const nc = await this.nonconforms.find(envelope.tenantId, id);
    if (nc === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在不合格处置 '${id}'`);
    }
    if (nc.flowConfigId !== this.options.nonconformConfig.flowId) {
      return rejected(
        `不合格处置由配置 '${nc.flowConfigId}' 驱动，与当前装配配置 '${this.options.nonconformConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== nc.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，不合格处置当前 objectVersion=${nc.objectVersion}`,
      );
    }
    if (nc.state !== 'open') {
      return rejected(`不合格处置 '${id}' 已处 '${nc.state}'，仅待处置明细可登记处置`);
    }
    if (!(this.options.disposals as readonly string[]).includes(payload.disposal)) {
      return rejected(
        `处置方式 '${payload.disposal}' 不在当前处置枚举白名单（${this.options.disposals.join('/')}）`,
      );
    }

    const runtime = await this.replayNonconform(nc);
    try {
      const from = runtime.state();
      const outcome = runtime.send('DISPOSE', {
        by: envelope.issuedBy,
        reason: payload.reason,
        objectVersion: nc.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${from}' 对 DISPOSE 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: NONCONFORM_AGGREGATE_TYPE,
        aggregateId: id,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const now = this.now();
      const advanced = await this.nonconforms.advance(
        envelope.tenantId,
        id,
        nc.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        {
          disposal: payload.disposal,
          reason: payload.reason,
          disposeRemark: payload.remark,
          disposedBy: envelope.issuedBy,
          disposedAt: now,
        },
      );

      const eventPayload: NonconformDisposedPayload = {
        nonconformId: id,
        inspectionId: nc.inspectionId as string,
        disposal: payload.disposal,
        reason: payload.reason,
        remark: payload.remark,
        recheckRequired: payload.disposal === 'rework',
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeNonconformDisposedEvent(this.domainEventBase(envelope), eventPayload);
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted: [],
        nonconform: advanced,
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- nonconform.close（闭环；全部明细闭环 → 质检单 closed） ----

  private async closeNonconform(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseCloseNonconformPayload(envelope.command.payload);
    const nc = await this.nonconforms.find(envelope.tenantId, id);
    if (nc === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在不合格处置 '${id}'`);
    }
    if (nc.flowConfigId !== this.options.nonconformConfig.flowId) {
      return rejected(
        `不合格处置由配置 '${nc.flowConfigId}' 驱动，与当前装配配置 '${this.options.nonconformConfig.flowId}' 不符`,
      );
    }
    if (envelope.expectedRevision !== nc.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，不合格处置当前 objectVersion=${nc.objectVersion}`,
      );
    }
    if (nc.state !== 'disposed') {
      return rejected(`不合格处置 '${id}' 已处 '${nc.state}'，仅已处置明细可闭环`);
    }

    // 返工处置的必要复检规则：复检合格（质检单 passed）方可闭环。
    const order = await this.orders.find(envelope.tenantId, nc.inspectionId);
    if (order === null) {
      return rejected(`不合格处置 '${id}' 关联的质检单 '${nc.inspectionId}' 不存在（数据不一致）`);
    }
    if (nc.disposal === 'rework' && order.state !== 'passed') {
      return rejected(
        `返工处置须复检合格后闭环：质检单 '${order.id as string}' 当前 '${order.state}'（须 passed）`,
      );
    }

    const runtime = await this.replayNonconform(nc);
    try {
      const outcome = runtime.send('CLOSE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '不合格闭环',
        objectVersion: nc.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${nc.state}' 对 CLOSE 返回 ${outcome.status}`);
      }

      const recorded = await this.operations.record({
        tenant: envelope.tenantId,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: NONCONFORM_AGGREGATE_TYPE,
        aggregateId: id,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const now = this.now();
      const advanced = await this.nonconforms.advance(
        envelope.tenantId,
        id,
        nc.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        {
          closeRemark: payload.remark,
          closedBy: envelope.issuedBy,
          closedAt: now,
        },
      );

      // 联动：该单全部明细闭环且单仍 failed → 质检单推进 closed（一次命令
      // 跨两聚合：幂等记账只记一次，两个机器事件各自 append）。
      let orderClosed = false;
      const orderAfter = await this.orders.find(envelope.tenantId, nc.inspectionId);
      if (orderAfter !== null && orderAfter.state === 'failed') {
        const siblings = await this.nonconforms.list(envelope.tenantId, {
          inspectionId: nc.inspectionId,
        });
        if (siblings.every((row) => row.state === 'closed')) {
          const orderRuntime = await this.replayInspection(orderAfter);
          try {
            const orderOutcome = orderRuntime.send('CLOSE', {
              by: envelope.issuedBy,
              reason: payload.remark ?? '不合格闭环（全部明细已闭环）',
              objectVersion: orderAfter.objectVersion,
            });
            if (orderOutcome.status !== 'transitioned') {
              throw new InspectionStateError(
                `质检单闭环迁移失败：状态 '${orderAfter.state}' 对 CLOSE 返回 ${orderOutcome.status}`,
              );
            }
            await this.machineEvents.append(orderOutcome.event);
            await this.orders.advance(
              envelope.tenantId,
              nc.inspectionId,
              orderAfter.objectVersion,
              orderRuntime.state(),
              orderRuntime.objectVersion(),
            );
            orderClosed = true;
          } finally {
            orderRuntime.stop();
          }
        }
      }

      const eventPayload: NonconformClosedPayload = {
        nonconformId: id,
        inspectionId: nc.inspectionId as string,
        disposal: (nc.disposal ?? 'scrap') as NonconformClosedPayload['disposal'],
        remark: payload.remark,
        orderClosed,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const event = makeNonconformClosedEvent(this.domainEventBase(envelope), eventPayload);
      await this.domainEvents.append(event);

      // 待办联动：闭环清该单的点名待办（点名经办人 = 固定配置 ?? 判定人）。
      const todosCompleted =
        order.overdueNotifiedAt !== null || orderAfter?.overdueNotifiedAt !== null
          ? await this.completeTodosFor(
              envelope.tenantId,
              this.options.overdueAssignee ?? (order.judgedBy as UserId),
              nc.inspectionId as string,
            )
          : [];

      const orderAfterClose = orderClosed
        ? ((await this.orders.find(envelope.tenantId, nc.inspectionId)) ?? undefined)
        : undefined;
      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        todosCreated: [],
        todosCompleted,
        nonconform: advanced,
        ...(orderAfterClose === undefined ? {} : { inspection: orderAfterClose }),
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- 闭环超时点名（InspectionOverdue → 待办 + IM） ----

  /**
   * 扫描闭环超时的不合格单（failed ∧ closeDueAt < now ∧ 未点名），逐单发
   * InspectionOverdue 事件 + 待办 + IM 点名（单级一次点名幂等：overdue-<单id>）。
   * 信封命令 inspection.overdue.scan.v1（体例同 listing 逾期扫描：信封
   * operationId 幂等账 + expectedRevision='initial'）；调用方：质检主管
   * （POST /inspection/overdue-scans）或组合根定时任务组装信封后触发。
   */
  private async scanOverdue(
    envelope: CommandEnvelope<InspectionCommand>,
  ): Promise<InspectionCommandResult> {
    parseOverdueScanPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const now = this.now();
    const nowMs = Date.parse(now);
    const failedOrders = (await this.orders.list(tenant, { state: 'failed' })).filter(
      (order) =>
        order.closeDueAt !== null && order.overdueNotifiedAt === null && Date.parse(order.closeDueAt) < nowMs,
    );

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: INSPECTION_AGGREGATE_TYPE,
      aggregateId: 'overdue-scan',
      occurredAt: now,
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const events: BusinessEvent[] = [];
    const todosCreated: TodoItem[] = [];
    const notifications: InspectionOverdueNotification[] = [];
    for (const order of failedOrders) {
      const operationId = `overdue-${order.id as string}`;
      const perOrder = await this.operations.record({
        tenant,
        operationId,
        command: 'inspection.overdue.scan.v1',
        aggregateType: INSPECTION_AGGREGATE_TYPE,
        aggregateId: order.id as string,
        occurredAt: now,
      });
      if (perOrder === null) continue; // 已点名（幂等命中）

      const payload: InspectionOverduePayload = {
        inspectionId: order.id as string,
        kind: order.kind,
        failedQty: order.failedQty ?? 0,
        judgedAt: order.judgedAt ?? now,
        dueAt: order.closeDueAt as string,
        notifiedAt: now,
        objectVersion: order.objectVersion,
        actor: envelope.issuedBy,
      };
      const event = makeInspectionOverdueEvent(
        {
          eventId: EventId.create(newDomainEventId()),
          tenant,
          occurredAt: now,
          provenance: provenanceOf(operationId, 'inspection.overdue.scan.v1', envelope.issuedBy),
        },
        payload,
      );
      events.push(event);

      // 待办：点名给固定经办人（缺省该单判定人——质检员被点名）。
      const assignee = this.options.overdueAssignee ?? order.judgedBy;
      let todoId: string | null = null;
      if (assignee !== null) {
        const todo = await this.todos.create({
          tenant,
          assignee,
          title: `质检闭环超时点名：${inspectionKindLabel(order.kind)}单 ${order.id as string}（${inspectionStateLabel(order.state)}）`,
          source: INSPECTION_TODO_SOURCE,
          refType: INSPECTION_AGGREGATE_TYPE,
          refId: order.id as string,
        });
        todosCreated.push(todo);
        todoId = todo.id;
      }

      // IM 点名（NotifyChannel 缺省 no-op：无接线时仅待办 + 事件）。
      await this.ports.notify.notify(tenant, {
        title: '质检闭环超时点名',
        body: `质检单 ${order.id as string}（${inspectionKindLabel(order.kind)}）不合格未闭环：判定于 ${order.judgedAt ?? now}，时限 ${order.closeDueAt}`,
        refType: INSPECTION_AGGREGATE_TYPE,
        refId: order.id as string,
      });

      await this.orders.markOverdueNotified(tenant, order.id, now);
      notifications.push({
        inspectionId: order.id as string,
        kind: order.kind,
        judgedAt: order.judgedAt ?? now,
        dueAt: order.closeDueAt as string,
        eventId: event.eventId,
        todoId,
      });
    }
    for (const event of events) {
      await this.domainEvents.append(event);
    }

    return {
      status: 'committed',
      newRevision: 1, // 扫描是事实产出组，不推进质检单状态机版本
      events,
      todosCreated,
      todosCompleted: [],
      notifications,
    };
  }

  // ---- 查询 ----

  /** 四类质检队列（kind/state 筛选；新的在前）。 */
  async queue(
    tenant: TenantId,
    filter?: {
      readonly kind?: InspectionKind | undefined;
      readonly state?: string | undefined;
    },
  ): Promise<readonly InspectionOrder[]> {
    return this.orders.list(tenant, {
      ...(filter?.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter?.state === undefined ? {} : { state: filter.state }),
    });
  }

  /** 质检单详情：主单 + 不合格明细 + 机器迁移史。 */
  async detail(tenant: TenantId, id: string): Promise<InspectionDetail> {
    const order = await this.orders.find(tenant, InspectionId.create(id));
    if (order === null) {
      throw new InspectionNotFoundError(`租户 '${tenant}' 内不存在质检单 '${id}'`);
    }
    const [nonconforms, page] = await Promise.all([
      this.nonconforms.list(tenant, { inspectionId: InspectionId.create(id) }),
      this.machineEvents.readByAggregate({ id, type: INSPECTION_AGGREGATE_TYPE }),
    ]);
    return { order, nonconforms, milestones: milestoneHistory(page.events) };
  }

  /** 不合格明细列表（闭环追踪；state/质检单筛选）。 */
  async nonconformList(
    tenant: TenantId,
    filter?: {
      readonly state?: string | undefined;
      readonly inspectionId?: string | undefined;
    },
  ): Promise<readonly Nonconform[]> {
    return this.nonconforms.list(tenant, {
      ...(filter?.state === undefined ? {} : { state: filter.state }),
      ...(filter?.inspectionId === undefined ? {} : { inspectionId: InspectionId.create(filter.inspectionId) }),
    });
  }

  /** 不合格处置详情：明细 + 机器迁移史 + 关联质检单当前态。 */
  async nonconformDetail(tenant: TenantId, id: string): Promise<NonconformDetail> {
    const nc = await this.nonconforms.find(tenant, id);
    if (nc === null) {
      throw new InspectionNotFoundError(`租户 '${tenant}' 内不存在不合格处置 '${id}'`);
    }
    const [page, order] = await Promise.all([
      this.machineEvents.readByAggregate({ id, type: NONCONFORM_AGGREGATE_TYPE }),
      this.orders.find(tenant, nc.inspectionId),
    ]);
    return {
      nonconform: nc,
      milestones: milestoneHistory(page.events),
      inspectionState: order === null ? null : order.state,
    };
  }

  /** 质检汇总事实（工作台 KPI：待检/合格率/未闭环；只读聚合）。 */
  async summary(tenant: TenantId): Promise<InspectionSummary> {
    const [orders, nonconforms] = await Promise.all([
      this.orders.list(tenant),
      this.nonconforms.list(tenant),
    ]);
    return rollupInspectionSummary(orders, nonconforms, this.now());
  }

  // ---- 私有辅助 ----

  private validateJudgmentQuantities(
    payload: JudgeInspectionPayload,
    order: InspectionOrder,
    what: string,
  ): string | null {
    const total = payload.passedQty + payload.failedQty;
    if (total < 1) {
      return `${what}数量须至少判 1 件（passedQty + failedQty >= 1）`;
    }
    if (total > order.quantity) {
      return `${what}数量 ${total} 超过送检数量 ${order.quantity}`;
    }
    return null;
  }

  /**
   * 放行事实：构造 released 域事件 + StockReleasePort 直连通知（通知式合同：
   * 实现方不抛错）。事件由调用方统一 append（与 judged 事件同一提交批次）。
   */
  private async releaseForStock(
    envelope: CommandEnvelope<InspectionCommand>,
    order: InspectionOrder,
    passedQty: number,
    phase: InspectionJudgePhase,
    objectVersion: number,
  ): Promise<BusinessEvent<InspectionReleasedPayload>> {
    const payload: InspectionReleasedPayload = {
      inspectionId: order.id as string,
      kind: order.kind,
      itemId: order.itemId,
      drawingNo: order.drawingNo,
      quantity: passedQty,
      sourceType: order.sourceType,
      sourceRefId: order.sourceRefId,
      phase,
      objectVersion,
      actor: envelope.issuedBy,
    };
    const event = makeInspectionReleasedEvent(this.domainEventBase(envelope), payload, order.id as string);
    await this.ports.stockRelease.recordRelease(envelope.tenantId, {
      inspectionId: order.id as string,
      kind: order.kind,
      itemId: order.itemId,
      drawingNo: order.drawingNo,
      quantity: passedQty,
      sourceType: order.sourceType,
      sourceRefId: order.sourceRefId,
      releasedAt: this.now(),
    });
    return event;
  }

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<InspectionCommand>): {
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

  /** 重放质检单机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayInspection(order: InspectionOrder): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: order.id as string, type: INSPECTION_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.inspectionConfig,
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
        throw new InspectionStateError(
          `事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== order.state || runtime.objectVersion() !== order.objectVersion) {
      runtime.stop();
      throw new InspectionStateError(
        `事件账本与质检单行不一致：质检单 ${order.state}@v${order.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 重放不合格处置机器事件账本（口径同 replayInspection）。 */
  private async replayNonconform(nc: Nonconform): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: nc.id, type: NONCONFORM_AGGREGATE_TYPE };
    const page = await this.machineEvents.readByAggregate(aggregate);
    const runtime = startApprovalFlow({
      config: this.options.nonconformConfig,
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
        throw new InspectionStateError(
          `不合格账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== nc.state || runtime.objectVersion() !== nc.objectVersion) {
      runtime.stop();
      throw new InspectionStateError(
        `不合格账本与明细行不一致：明细 ${nc.state}@v${nc.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 完成指定经办人名下（source=inspection + refId=质检单）的 open 待办。 */
  private async completeTodosFor(
    tenant: TenantId,
    assignee: UserId,
    inspectionId: string,
  ): Promise<readonly TodoItem[]> {
    const own = await this.todos.listOwn(tenant, assignee);
    const completed: TodoItem[] = [];
    for (const todo of own) {
      if (
        todo.source === INSPECTION_TODO_SOURCE &&
        todo.refType === INSPECTION_AGGREGATE_TYPE &&
        todo.refId === inspectionId &&
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

export interface InspectionDetail {
  readonly order: InspectionOrder;
  readonly nonconforms: readonly Nonconform[];
  readonly milestones: readonly InspectionMilestone[];
}

export interface NonconformDetail {
  readonly nonconform: Nonconform;
  readonly milestones: readonly InspectionMilestone[];
  /** 关联质检单当前态（闭环追踪视图）。 */
  readonly inspectionState: string | null;
}
