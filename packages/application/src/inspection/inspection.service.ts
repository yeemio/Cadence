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
 *
 * 5. fix-wave-6 6a-2 三件（17 册 RQ-035/036/037）：
 *    特采确认（inspection.concession.v1，S5——与既有 concession 处置的并存
 *    取舍见 inspection-events.ts 头注）；批量质检（inspection.judge-batch.v1，
 *    整批校验先于落账——reporting 先例）；撤销质检（inspection.revoke.v1，
 *    判定回退 + 不合格明细作废 + 特采清零，三项跨域闸门经 revokeGuard 端口）。
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
  DEFAULT_INSPECTION_BATCH_LIMIT,
  DEFAULT_INSPECTION_FLOW_CONFIG,
  DEFAULT_NONCONFORM_FLOW_CONFIG,
  NONCONFORM_DISPOSALS,
  kindForSourceFact,
  type InspectionKind,
  type NonconformDisposal,
} from './inspection-config.js';
import {
  INSPECTION_AGGREGATE_TYPE,
  INSPECTION_BATCH_AGGREGATE_TYPE,
  INSPECTION_EVENT_TYPES,
  NONCONFORM_AGGREGATE_TYPE,
  makeInspectionConcessionConfirmedEvent,
  makeInspectionCreatedEvent,
  makeInspectionJudgedBatchEvent,
  makeInspectionJudgedEvent,
  makeInspectionOverdueEvent,
  makeInspectionReleasedEvent,
  makeInspectionRevokedEvent,
  makeNonconformClosedEvent,
  makeNonconformDisposedEvent,
  provenanceOf,
  type InspectionConcessionConfirmedPayload,
  type InspectionCreatedPayload,
  type InspectionJudgePhase,
  type InspectionJudgedBatchPayload,
  type InspectionJudgedPayload,
  type InspectionOverduePayload,
  type InspectionReleasedPayload,
  type InspectionRevokedPayload,
  type NonconformClosedPayload,
  type NonconformDisposedPayload,
} from './inspection-events.js';
import { InspectionInputError, InspectionNotFoundError, InspectionStateError } from './inspection-errors.js';
import {
  parseCloseNonconformPayload,
  parseConcessionInspectionPayload,
  parseCreateInspectionPayload,
  parseDisposeNonconformPayload,
  parseJudgeBatchPayload,
  parseJudgeInspectionPayload,
  parseOverdueScanPayload,
  parseRecheckInspectionPayload,
  parseRevokeInspectionPayload,
  type InspectionCommand,
  type InspectionCommandKind,
  type JudgeBatchLine,
  type JudgeInspectionPayload,
} from './inspection-input.js';
import {
  FAIL_CLOSED_INSPECTION_REVOKE_GUARD,
  INSPECTION_TODO_SOURCE,
  NOOP_NOTIFY_CHANNEL,
  NOOP_STOCK_RELEASE_PORT,
  type InspectionIntakePort,
  type InspectionIntakeReceipt,
  type InspectionRevokeGuardPort,
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
  newInspectionBatchId,
  newInspectionId,
  newNonconformId,
} from './inspection-ids.js';

// ---- 结果形状（CommandOutcome 扩展：命令侧联动与聚合视图回执） ----

export interface InspectionCommitted extends CommittedOutcome {
  /** 本次命令派生的待办（超时点名联动）。 */
  readonly todosCreated: readonly TodoItem[];
  /** 本次命令完成的待办（不合格闭环清点名待办 / 撤销质检清点名待办）。 */
  readonly todosCompleted: readonly TodoItem[];
  /** 命令目标聚合的提交后视图。 */
  readonly inspection?: InspectionOrder;
  readonly nonconform?: Nonconform;
  /** 批量质检（inspection.judge-batch.v1）逐单提交后视图（按行序）。 */
  readonly inspections?: readonly InspectionOrder[];
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
  /** 批量质检单次上限（缺省 DEFAULT_INSPECTION_BATCH_LIMIT=50；RQ-036 配置层）。 */
  readonly batchLimit: number;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface InspectionCrossModulePorts {
  readonly stockRelease: StockReleasePort;
  readonly notify: NotifyChannel;
  /** 撤销质检前置闸门（缺省 fail-closed：未接线拒绝撤销；RQ-037 接缝）。 */
  readonly revokeGuard: InspectionRevokeGuardPort;
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
      revokeGuard: ports.revokeGuard ?? FAIL_CLOSED_INSPECTION_REVOKE_GUARD,
    };
    this.options = {
      inspectionConfig: options.inspectionConfig ?? DEFAULT_INSPECTION_FLOW_CONFIG,
      nonconformConfig: options.nonconformConfig ?? DEFAULT_NONCONFORM_FLOW_CONFIG,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      disposals: options.disposals ?? NONCONFORM_DISPOSALS,
      overdueAssignee: options.overdueAssignee ?? null,
      batchLimit: options.batchLimit ?? DEFAULT_INSPECTION_BATCH_LIMIT,
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
    // 创建类/事实产出组命令（无单一既有聚合目标）：expectedRevision 须 'initial'
    // ——judge-batch 与 overdue.scan 同体例（逐单版本在载荷行内）。
    const createKinds: readonly InspectionCommandKind[] = [
      'inspection.create.v1',
      'inspection.judge-batch.v1',
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
      case 'inspection.judge-batch.v1':
        return this.judgeBatch(envelope);
      case 'inspection.recheck.v1':
        return this.recheck(envelope, this.requirePathId(pathId, kind));
      case 'inspection.concession.v1':
        return this.concession(envelope, this.requirePathId(pathId, kind));
      case 'inspection.revoke.v1':
        return this.revoke(envelope, this.requirePathId(pathId, kind));
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

      // 合格分支（判定与批量质检共用提交路径）：judged + released + 放行端口。
      if (!failed) {
        return await this.passJudgmentSideEffects(envelope, order, runtime, payload.passedQty, payload.remark, 'judge');
      }

      // 不合格分支：判定字段落投影 + 自动创建不合格明细（open）——闭环追踪对象。
      const now = this.now();
      const judgment: JudgmentFields = {
        passedQty: payload.passedQty,
        failedQty: payload.failedQty,
        judgeRemark: payload.remark,
        judgedBy: envelope.issuedBy,
        judgedAt: now,
        closeDueAt: new Date(Date.parse(now) + this.options.closeTimeoutMs).toISOString(),
      };
      const advanced = await this.orders.advance(
        envelope.tenantId,
        InspectionId.create(id),
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        judgment,
      );

      const nonconform = await this.nonconforms.create({
        tenant: envelope.tenantId,
        id: newNonconformId(),
        inspectionId: InspectionId.create(id),
        flowConfigId: this.options.nonconformConfig.flowId,
        state: this.options.nonconformConfig.initial,
        objectVersion: 1,
        itemId: order.itemId,
        quantity: payload.failedQty,
      });

      const judgedPayload: InspectionJudgedPayload = {
        inspectionId: id,
        kind: advanced.kind,
        phase: 'judge',
        outcome: 'failed',
        passedQty: payload.passedQty,
        failedQty: payload.failedQty,
        remark: payload.remark,
        nonconformId: nonconform.id,
        closeDueAt: judgment.closeDueAt,
        objectVersion: runtime.objectVersion(),
        actor: envelope.issuedBy,
      };
      const events: BusinessEvent[] = [
        makeInspectionJudgedEvent(this.domainEventBase(envelope), judgedPayload),
      ];
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
        nonconform,
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

  // ---- inspection.concession（fix-wave-6 6a-2 / RQ-035 特采确认，S5） ----

  /**
   * 特采确认（S5 让步接收入库语义；与既有 concession 处置枚举的关系见
   * inspection-events.ts 头注——并存不互斥、不推翻闭环）：
   *  - 面向非标件采购质检单（kind=nonstandard_purchase；源=非标件采购质检 3.8）；
   *  - 前置：已质检不合格（state=failed ∧ failedQty>0）∧ 剩余可特采>0；
   *  - 数量边界：1 ≤ quantity ≤ failedQty − 已特采（已特采 = 事件账本折叠值，
   *    见 concessionLedgerOf——累加记账在 append-only 域事件账本，不扩投影列
   *    【扩列涉 business-store 迁移，本波写入面外；纯读侧折叠两形态一致】）；
   *  - 效果：累加已特采 + 发 InspectionConcessionConfirmed（待入库行另建事实，
   *    与合格放行分立不合并；inventory 消费联动未接线——开放问题）；
   *  - 无迁移无版本推进（源"已质检→已质检（特采）"）；无独立撤销特采——
   *    撤销质检整体回退清零（revoke 事件承载）。
   *  - 源差异不实施项：已确认退货不可特采（return_quantity，LP 域退货状态本
   *    域不可见，未接线）、外购加工不走特采（receipt 行加工类型不在本域模型，
   *    由来源侧过滤——两项登记开放问题）。
   */
  private async concession(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseConcessionInspectionPayload(envelope.command.payload);
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
    if (order.kind !== 'nonstandard_purchase') {
      return rejected(
        `特采确认面向非标件采购质检单（当前 '${order.kind}'）；其余质检类别不走特采`,
      );
    }
    if (order.state === 'pending') {
      return rejected(`质检单 '${id}' 未质检，无不合格量可特采`);
    }
    if (order.state === 'closed') {
      return rejected(`质检单 '${id}' 已闭环（closed 终态），不可特采确认`);
    }
    const concessionQty = await this.concessionLedgerOf(order);
    const failedQty = order.failedQty ?? 0;
    const remaining = Math.max(0, failedQty - concessionQty);
    if (remaining <= 0) {
      return rejected(
        `质检单 '${id}' 无可特采数量（不合格 ${failedQty} − 已特采 ${concessionQty} = 0）`,
      );
    }
    if (payload.quantity > remaining) {
      return rejected(
        `特采数量 ${payload.quantity} 超剩余可特采（不合格 ${failedQty} − 已特采 ${concessionQty} = ${remaining}）`,
      );
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

    const confirmedQty = concessionQty + payload.quantity;
    const eventPayload: InspectionConcessionConfirmedPayload = {
      inspectionId: id,
      kind: order.kind,
      itemId: order.itemId,
      drawingNo: order.drawingNo,
      quantity: payload.quantity,
      concessionQuantity: confirmedQty,
      remainingConcessionQty: Math.max(0, failedQty - confirmedQty),
      failedQty,
      sourceType: order.sourceType,
      sourceRefId: order.sourceRefId,
      objectVersion: order.objectVersion,
      actor: envelope.issuedBy,
    };
    const event = makeInspectionConcessionConfirmedEvent(this.domainEventBase(envelope), eventPayload);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: order.objectVersion, // 特采无迁移不推进版本（源：已质检→已质检）
      events: [event],
      todosCreated: [],
      todosCompleted: [],
      inspection: order,
    };
  }

  /** 特采视图（弹窗打开前置读：已特采/剩余可特采；RQ-035 弹窗字段口径）。 */
  async concessionView(tenant: TenantId, id: string): Promise<InspectionConcessionView> {
    const order = await this.orders.find(tenant, InspectionId.create(id));
    if (order === null) {
      throw new InspectionNotFoundError(`租户 '${tenant}' 内不存在质检单 '${id}'`);
    }
    const concessionQty = await this.concessionLedgerOf(order);
    const failedQty = order.failedQty ?? 0;
    return {
      inspectionId: id,
      kind: order.kind,
      state: order.state,
      failedQty,
      concessionQuantity: concessionQty,
      remainingConcessionQty: Math.max(0, failedQty - concessionQty),
    };
  }

  /**
   * 已特采数量（事件账本折叠）：concession-confirmed 累加、revoked 清零（撤销
   * 质检整体回退——无独立撤销特采，源口径）。账本 append-only，折叠即可重放。
   */
  private async concessionLedgerOf(order: InspectionOrder): Promise<number> {
    const events = await this.domainEvents.byAggregate({
      id: order.id as string,
      type: INSPECTION_AGGREGATE_TYPE,
    });
    let total = 0;
    for (const event of events) {
      if (event.eventType === INSPECTION_EVENT_TYPES.concessionConfirmed) {
        total += (event.payload as InspectionConcessionConfirmedPayload).quantity;
      } else if (event.eventType === INSPECTION_EVENT_TYPES.revoked) {
        total = 0;
      }
    }
    return total;
  }

  // ---- inspection.judge-batch（fix-wave-6 6a-2 / RQ-036 批量质检） ----

  /**
   * 批量质检（整批"全部合格"）：勾选多张待检单按同一判定值（合格=送检量、
   * 不合格=0）提交。**整批口径（按 17 册 RQ-036 定义 + 仓内 reporting
   * submit-batch 先例选定）：整批校验先于落账**——任何一行校验失败（不存在/
   * 非待检/乐观锁过期/重复勾选/超上限）整批 rejected 零落账；校验全过后逐单
   * 走与单条判定完全相同的联动（PASS 迁移 + judged/released 事件 + 放行端口，
   * 共用 passJudgmentSideEffects），批次锚事件挂整批（体例同 BatchSubmitted）。
   * 源差异：源对每条独立提交（质检模块 三、4），我方取整批原子——对齐仓内
   * 批量语义先例（reporting RQ-005），防半批落账的对账歧义。
   */
  private async judgeBatch(envelope: CommandEnvelope<InspectionCommand>): Promise<InspectionCommandResult> {
    const payload = parseJudgeBatchPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    if (payload.lines.length > this.options.batchLimit) {
      return rejected(
        `批量质检超上限：${payload.lines.length} 行 > 配置上限 ${this.options.batchLimit}`,
      );
    }

    // 整批校验先于落账：逐行前置检查 + 重复勾选检查（同 id 二行必然乐观锁相撞，
    // 提前以明确文案拒绝）。
    const orders: InspectionOrder[] = [];
    const seen = new Set<string>();
    for (const [index, line] of payload.lines.entries()) {
      const fault = await this.validateBatchLine(tenant, line, index, seen);
      if (fault !== null) {
        return rejected(fault);
      }
      const order = await this.orders.find(tenant, InspectionId.create(line.inspectionId));
      orders.push(order as InspectionOrder);
    }

    const anchorId = newInspectionBatchId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: INSPECTION_BATCH_AGGREGATE_TYPE,
      aggregateId: anchorId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const events: BusinessEvent[] = [];
    const committedOrders: InspectionOrder[] = [];
    for (const [index, line] of payload.lines.entries()) {
      const order = orders[index] as InspectionOrder;
      const one = await this.applyBatchPassJudgment(envelope, order, line);
      events.push(...one.events);
      committedOrders.push(one.inspection as InspectionOrder);
    }
    const batchPayload: InspectionJudgedBatchPayload = {
      batchId: anchorId,
      count: committedOrders.length,
      results: committedOrders.map((order) => ({
        inspectionId: order.id as string,
        kind: order.kind,
        passedQty: order.quantity,
        objectVersion: order.objectVersion,
      })),
      actor: envelope.issuedBy,
    };
    const batchEvent = makeInspectionJudgedBatchEvent(this.domainEventBase(envelope), batchPayload);
    await this.domainEvents.append(batchEvent);
    events.push(batchEvent);

    return {
      status: 'committed',
      newRevision: 1, // 批次是事实产出组（锚聚合 v1），逐单版本在 events/results 内
      events,
      todosCreated: [],
      todosCompleted: [],
      inspections: committedOrders,
    };
  }

  /** 批量行前置校验（整批口径：返回 reason 字符串 = 整批拒绝文案）。 */
  private async validateBatchLine(
    tenant: TenantId,
    line: JudgeBatchLine,
    index: number,
    seen: Set<string>,
  ): Promise<string | null> {
    const at = `批量第 ${index + 1} 行（${line.inspectionId}）`;
    if (seen.has(line.inspectionId)) {
      return `${at}被拒：同一质检单在批内重复勾选`;
    }
    seen.add(line.inspectionId);
    const order = await this.orders.find(tenant, InspectionId.create(line.inspectionId));
    if (order === null) {
      return `${at}被拒：租户 '${tenant}' 内不存在该质检单`;
    }
    if (order.flowConfigId !== this.options.inspectionConfig.flowId) {
      return `${at}被拒：质检单由配置 '${order.flowConfigId}' 驱动，与当前装配配置 '${this.options.inspectionConfig.flowId}' 不符`;
    }
    if (line.expectedRevision !== order.objectVersion) {
      return `${at}被拒：乐观锁冲突 expectedRevision=${line.expectedRevision}，当前 objectVersion=${order.objectVersion}`;
    }
    if (order.state !== 'pending') {
      return `${at}被拒：质检单已处 '${order.state}'，仅待检单可判定（复检走 inspection.recheck.v1）`;
    }
    return null;
  }

  /** 批量单行落账：PASS 迁移 + 合格联动（与单条判定共用提交路径）。 */
  private async applyBatchPassJudgment(
    envelope: CommandEnvelope<InspectionCommand>,
    order: InspectionOrder,
    line: JudgeBatchLine,
  ): Promise<InspectionCommitted> {
    const runtime = await this.replayInspection(order);
    try {
      const outcome = runtime.send('PASS', {
        by: envelope.issuedBy,
        reason: line.remark ?? `批量判定合格 ${order.quantity}/0`,
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        throw new InspectionStateError(
          `批量质检迁移失败：状态 '${order.state}' 对 PASS 返回 ${outcome.status}（整批校验后仍被拒——配置守卫或账本不一致）`,
        );
      }
      await this.machineEvents.append(outcome.event);
      return await this.passJudgmentSideEffects(
        envelope,
        order,
        runtime,
        order.quantity, // 全部合格：合格=送检量、不合格=0（源 batchSubmitInspection 口径）
        line.remark,
        'judge',
      );
    } finally {
      runtime.stop();
    }
  }

  // ---- inspection.revoke（fix-wave-6 6a-2 / RQ-037 撤销质检） ----

  /**
   * 撤销质检（判定回退）：已质检单（passed/failed）撤销回待检态，清空合格/
   * 不合格/质检人/时间（revertJudgment 投影清理）+ 点名标记；failed 单随判定
   * 作废其不合格明细（open/disposed → voided，已结案 closed 保留）；特采累计
   * 随整体回退清零（concessionLedgerOf 折叠口径）；发布 InspectionRevoked
   * （放行收回 + 特采清零 + 作废明细的对外事实，inventory/报表消费锚点）。
   * 口径（17 册 RQ-037 / 源质检模块 三、5 映射）：
   *  - 回待检（非作废）：源"撤销→回待质检，清空结果字段"同构；重判走原管线；
   *  - 三项跨域闸门（关联入库未完成/下一道工序已报工或已质检/工时已审核）
   *    经 InspectionRevokeGuardPort（缺省 fail-closed 未接线拒绝；组合根接线
   *    后由 IV/reporting+baseline/HC 实现放行判定）；
   *  - closed 终态不可撤（闭环已结案，与源无闭环态的差异取舍——破坏已结事实）；
   *  - 投影清理依赖存储 revertJudgment（可选方法；未实现的适配器上 fail-closed
   *    拒绝——PG 适配器补齐为纯 UPDATE 无迁移）；
   *  - 工时已审禁撤的级联清空归 19 HC（guard 拦截面；本域不清审核字段）。
   */
  private async revoke(
    envelope: CommandEnvelope<InspectionCommand>,
    id: string,
  ): Promise<InspectionCommandResult> {
    const payload = parseRevokeInspectionPayload(envelope.command.payload);
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
    if (order.state === 'pending') {
      return rejected(`质检单 '${id}' 未质检，无可撤销的判定`);
    }
    if (order.state === 'closed') {
      return rejected(`质检单 '${id}' 已闭环（closed 终态），判定回退破坏已结案事实，不可撤销`);
    }
    if (typeof this.orders.revertJudgment !== 'function') {
      return rejected(
        `存储适配器未实现 revertJudgment（撤销投影清理），fail-closed 拒绝——PG 适配器补齐后开放`,
      );
    }
    const gateFault = await this.ports.revokeGuard.assertRevokable(envelope.tenantId, {
      inspectionId: id,
      kind: order.kind,
      sourceType: order.sourceType,
      sourceRefId: order.sourceRefId,
    });
    if (gateFault !== null) {
      return rejected(`撤销质检闸门拦截：质检单 '${id}' ${gateFault}`);
    }

    // 不合格明细随判定作废（open/disposed → voided；closed 已结案保留）。
    const voidedIds: string[] = [];
    const nonconforms = await this.nonconforms.list(envelope.tenantId, {
      inspectionId: InspectionId.create(id),
    });
    for (const nc of nonconforms) {
      if (nc.state !== 'open' && nc.state !== 'disposed') continue;
      const ncRuntime = await this.replayNonconform(nc);
      try {
        const ncOutcome = ncRuntime.send('VOID', {
          by: envelope.issuedBy,
          reason: payload.remark ?? '撤销质检：判定回退，不合格明细随判定作废',
          objectVersion: nc.objectVersion,
        });
        if (ncOutcome.status !== 'transitioned') {
          throw new InspectionStateError(
            `不合格明细作废迁移失败：状态 '${nc.state}' 对 VOID 返回 ${ncOutcome.status}`,
          );
        }
        await this.machineEvents.append(ncOutcome.event);
        await this.nonconforms.advance(
          envelope.tenantId,
          nc.id,
          nc.objectVersion,
          ncRuntime.state(),
          ncRuntime.objectVersion(),
        );
        voidedIds.push(nc.id);
      } finally {
        ncRuntime.stop();
      }
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

    const concessionCleared = await this.concessionLedgerOf(order);
    const runtime = await this.replayInspection(order);
    let advanced: InspectionOrder | null = null;
    try {
      const outcome = runtime.send('REVOKE', {
        by: envelope.issuedBy,
        reason: payload.remark ?? '撤销质检：判定回退待检',
        objectVersion: order.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(`状态 '${order.state}' 对 REVOKE 返回 ${outcome.status}（配置守卫或规则不一致）`);
      }
      await this.machineEvents.append(outcome.event);
      advanced = await (this.orders.revertJudgment as NonNullable<
        InspectionOrderStore['revertJudgment']
      >)(
        envelope.tenantId,
        InspectionId.create(id),
        order.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
      );
    } finally {
      runtime.stop();
    }
    if (advanced === null) {
      return rejected(`租户 '${envelope.tenantId}' 内不存在质检单 '${id}'`);
    }

    const revokedPayload: InspectionRevokedPayload = {
      inspectionId: id,
      kind: order.kind,
      fromState: order.state,
      releasedQtyRetracted: order.state === 'passed' ? (order.passedQty ?? 0) : 0,
      concessionQuantityCleared: concessionCleared,
      nonconformIdsVoided: voidedIds,
      remark: payload.remark,
      objectVersion: runtime.objectVersion(),
      actor: envelope.issuedBy,
    };
    const event = makeInspectionRevokedEvent(this.domainEventBase(envelope), revokedPayload);
    await this.domainEvents.append(event);

    // 点名待办随撤销完成（闭环追踪对象已不存在）。
    const todosCompleted =
      order.overdueNotifiedAt !== null && order.judgedBy !== null
        ? await this.completeTodosFor(
            envelope.tenantId,
            this.options.overdueAssignee ?? order.judgedBy,
            id,
          )
        : [];

    return {
      status: 'committed',
      newRevision: runtime.objectVersion(),
      events: [event],
      todosCreated: [],
      todosCompleted,
      inspection: advanced,
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
   * 合格判定提交路径（单条 judge 与批量 judge-batch 共用；调用方已完成：
   * 状态前置校验 + PASS 迁移 + 幂等记账 + 机器事件 append）：判定字段落投影
   * → judged 事件 → released 放行（事件 + 直连端口）。runtime 生命周期归调用方。
   */
  private async passJudgmentSideEffects(
    envelope: CommandEnvelope<InspectionCommand>,
    order: InspectionOrder,
    runtime: ApprovalFlowRuntime,
    passedQty: number,
    remark: string | null,
    phase: InspectionJudgePhase,
  ): Promise<InspectionCommitted> {
    const judgment: JudgmentFields = {
      passedQty,
      failedQty: 0,
      judgeRemark: remark,
      judgedBy: envelope.issuedBy,
      judgedAt: this.now(),
      closeDueAt: null,
    };
    const advanced = await this.orders.advance(
      envelope.tenantId,
      order.id,
      order.objectVersion,
      runtime.state(),
      runtime.objectVersion(),
      judgment,
    );
    const judgedPayload: InspectionJudgedPayload = {
      inspectionId: order.id as string,
      kind: advanced.kind,
      phase,
      outcome: 'passed',
      passedQty,
      failedQty: 0,
      remark,
      nonconformId: null,
      closeDueAt: null,
      objectVersion: runtime.objectVersion(),
      actor: envelope.issuedBy,
    };
    const judgedEvent = makeInspectionJudgedEvent(this.domainEventBase(envelope), judgedPayload);
    const releasedEvent = await this.releaseForStock(
      envelope,
      advanced,
      passedQty,
      phase,
      runtime.objectVersion(),
    );
    const events: BusinessEvent[] = [judgedEvent, releasedEvent];
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

/** 特采视图（RQ-035 特采弹窗：不合格/已特采/剩余可特采）。 */
export interface InspectionConcessionView {
  readonly inspectionId: string;
  readonly kind: InspectionKind;
  readonly state: string;
  readonly failedQty: number;
  readonly concessionQuantity: number;
  readonly remainingConcessionQty: number;
}
