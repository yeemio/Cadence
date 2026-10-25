/**
 * AftercareClaimService —— 售后报销用例编排（U5 A12，文档《售后派工》§2.4/§3.4
 * 的 Cadence 重述）。零框架业务类（不 import @nestjs/*）。
 *
 * 命令族（smes.command.v1 信封：operationId 幂等 + expectedRevision 乐观锁，
 * 结果 CommandOutcome 三分）：
 *  - aftercare.claim.save.v1   新增（expectedRevision='initial'）：挂售后派工单、
 *    仅审批通过报工后可填报、一单一报销、明细行 = 通过报工集恰合、四费默认 0；
 *  - aftercare.claim.update.v1 编辑（expectedRevision=报销单 objectVersion）：
 *    只重写四费/备注（报工日期/售后人/审批工时只读 = 行身份冻结），行集须与
 *    既有行一一对应。
 *
 * 落账顺序（与 dispatch 既有取舍一致）：幂等记账 → 报销单落库（create /
 * updateFees 乐观推进）→ 域事件发布（AftercareClaimFiled / AftercareClaimUpdated，
 * A5 售后成本块取数信号）。
 *
 * 查询面（文档 §3.4 #1/#2 口径）：
 *  - claimByDispatch：无报销或派工单不存在均返回 null（文档 data=null，不抛
 *    「数据不存在」）；
 *  - claimContext：派工单不存在抛 NotFound（文档 context/prefill 口径）；返回
 *    派工只读面 + 可报销明细行 + 已有报销 + reimbursable 判定事实（「无审批
 *    通过报工不可报销」的硬规则在 save 命令面拒绝，查询面给判定事实不硬抛——
 *    requireCompletable 的通用化取舍）。
 */
import {
  EventId,
  type CommandEnvelope,
  type CommittedOutcome,
  type IndeterminateOutcome,
  type RejectedOutcome,
  type TenantId,
} from '@smes/business-core';
import { DispatchConflictError, DispatchInputError, DispatchNotFoundError } from './dispatch-errors.js';
import { newDomainEventId } from './dispatch-ids.js';
import { provenanceOf } from './dispatch-events.js';
import type { DispatchDomainEventStore, DispatchOperationStore, DispatchOrder, DispatchOrderStore } from './dispatch-stores.js';
import {
  AFTERCARE_CLAIM_AGGREGATE_TYPE,
  AFTERCARE_CLAIM_EVENT_TYPES,
  makeAftercareClaimFiledEvent,
  makeAftercareClaimUpdatedEvent,
} from './aftercare-claim-events.js';
import {
  parseAftercareClaimSavePayload,
  parseAftercareClaimUpdatePayload,
  type AftercareClaimCommand,
  type AftercareClaimCommandKind,
  type AftercareClaimPersonLinePayload,
} from './aftercare-claim-input.js';
import {
  EMPTY_AFTERCARE_REPORT_PORT,
  type AftercareApprovedReportLine,
  type AftercareApprovedReportPort,
} from './aftercare-claim-ports.js';
import {
  aftercareClaimTotalMinor,
  aftercareLineTotalMinor,
  type AftercareClaim,
  type AftercareClaimFeeUpdate,
  type AftercareClaimLine,
  type AftercareClaimStore,
} from './aftercare-claim-stores.js';
import { newAftercareClaimId, newAftercareClaimLineId } from './aftercare-claim-ids.js';

// ---- 结果形状 ----

/** 报销单读面（含行小计/报销合计——读面计算，不落冗余列）。 */
export interface AftercareClaimLineView {
  readonly lineNo: number;
  readonly reportId: string;
  readonly reportDate: string;
  readonly worker: string;
  readonly approvedBy: string | null;
  readonly approvedMinutes: number;
  readonly lodgingMinor: number;
  readonly trafficMinor: number;
  readonly overtimeMinor: number;
  readonly otherMinor: number;
  readonly remark: string | null;
  /** 行小计（四费之和）。 */
  readonly totalMinor: number;
}

export interface AftercareClaimView {
  readonly id: string;
  readonly dispatchId: string;
  readonly objectVersion: number;
  readonly lines: readonly AftercareClaimLineView[];
  /** 报销合计（各行小计之和）。 */
  readonly totalMinor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AftercareClaimCommitted extends CommittedOutcome {
  readonly claim: AftercareClaimView;
}

export type AftercareClaimCommandResult =
  | AftercareClaimCommitted
  | RejectedOutcome
  | IndeterminateOutcome;

/** 报销上下文（文档 §3.4 #2 context 的 Cadence 口径）。 */
export interface AftercareClaimContext {
  /** 派工单只读面（文档 §2.4.2 派工单信息的模块内子集）。 */
  readonly order: {
    readonly id: string;
    readonly kind: string;
    readonly state: string;
    readonly title: string;
    readonly workOrderId: string | null;
    readonly assignee: string | null;
    readonly objectVersion: number;
  };
  /** 可报销明细行（审批通过报工集，按端口读；未接线 = 空）。 */
  readonly claimableLines: readonly AftercareApprovedReportLine[];
  /** 已有报销（一单一报销；无 = null）。 */
  readonly claim: AftercareClaimView | null;
  /** 可否新增报销（= claim 为空 且 有审批通过报工）。 */
  readonly reimbursable: boolean;
  /** 不可新增的原因（可新增 = null）。 */
  readonly blockedReason: string | null;
}

export interface AftercareClaimServiceOptions {
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

/**
 * 行集 reportId 键恰合校验：submitted 与 expected 双向无缺漏（重复键已在解析层
 * 拒绝）。返回 rejected 结果值或 null（通过）。
 */
function assertReportIdSetMatches(
  submitted: readonly AftercareClaimPersonLinePayload[],
  expected: readonly string[],
  expectedWhat: string,
): RejectedOutcome | null {
  const submittedIds = submitted.map((line) => line.reportId);
  const expectedSet = new Set(expected);
  const unknown = submittedIds.filter((id) => !expectedSet.has(id));
  if (unknown.length > 0) {
    return rejected(`报销明细含未知行：reportId ${unknown.join('/')} 不在${expectedWhat}集内（明细须与${expectedWhat}一致）`);
  }
  const submittedSet = new Set(submittedIds);
  const missing = expected.filter((id) => !submittedSet.has(id));
  if (missing.length > 0) {
    return rejected(`报销明细缺行：reportId ${missing.join('/')} 未填报（明细须与${expectedWhat}一致）`);
  }
  return null;
}

export class AftercareClaimService {
  private readonly options: AftercareClaimServiceOptions;

  constructor(
    private readonly orders: DispatchOrderStore,
    private readonly claims: AftercareClaimStore,
    private readonly operations: DispatchOperationStore,
    private readonly domainEvents: DispatchDomainEventStore,
    private readonly reports: AftercareApprovedReportPort = EMPTY_AFTERCARE_REPORT_PORT,
    options: AftercareClaimServiceOptions = {},
  ) {
    this.options = options;
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(
    envelope: CommandEnvelope<AftercareClaimCommand>,
    pathId?: string,
  ): Promise<AftercareClaimCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly AftercareClaimCommandKind[] = ['aftercare.claim.save.v1'];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'aftercare.claim.save.v1':
        return this.saveClaim(envelope);
      case 'aftercare.claim.update.v1':
        return this.updateClaim(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: AftercareClaimCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new DispatchInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  /** 装载售后派工单（kind=aftermarket 收口；不存在/非售后单 = rejected 语义）。 */
  private async loadAftermarketOrder(
    tenant: TenantId,
    dispatchId: string,
  ): Promise<{ readonly order: DispatchOrder } | { readonly rejected: string }> {
    const order = await this.orders.find(tenant, dispatchId);
    if (order === null) {
      return { rejected: `租户 '${tenant}' 内不存在派工单 '${dispatchId}'` };
    }
    if (order.kind !== 'aftermarket') {
      return { rejected: `派工单 '${dispatchId}' 不是售后派工单（kind=${order.kind}），无报销面` };
    }
    return { order };
  }

  // ---- aftercare.claim.save（新增：仅审批通过后可填报 + 一单一报销） ----

  private async saveClaim(
    envelope: CommandEnvelope<AftercareClaimCommand>,
  ): Promise<AftercareClaimCommandResult> {
    const payload = parseAftercareClaimSavePayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    const loaded = await this.loadAftermarketOrder(tenant, payload.dispatchOrderId);
    if ('rejected' in loaded) return rejected(loaded.rejected);

    const approved = await this.reports.listApproved(tenant, payload.dispatchOrderId);
    if (approved.length === 0) {
      return rejected(`该派工单尚无审批通过的报工记录，无法报销（'${payload.dispatchOrderId}'）`);
    }
    const existing = await this.claims.findByDispatch(tenant, payload.dispatchOrderId);
    if (existing !== null) {
      return rejected(`该派工单已存在报销记录，请直接编辑（报销单 '${existing.id}'）`);
    }
    const mismatch = assertReportIdSetMatches(payload.personLines, approved.map((row) => row.reportId), '通过报工');
    if (mismatch !== null) return mismatch;

    const claimId = newAftercareClaimId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: AFTERCARE_CLAIM_AGGREGATE_TYPE,
      aggregateId: claimId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const approvedByReport = new Map(approved.map((row) => [row.reportId, row] as const));
    let created: AftercareClaim;
    try {
      created = await this.claims.create({
        tenant,
        id: claimId,
        dispatchId: payload.dispatchOrderId,
        lines: payload.personLines.map((line) => {
          const fact = approvedByReport.get(line.reportId)!;
          return {
            id: newAftercareClaimLineId(),
            reportId: line.reportId,
            reportDate: fact.reportDate,
            worker: fact.worker,
            approvedBy: fact.approvedBy,
            approvedMinutes: fact.approvedMinutes,
            lodgingMinor: line.lodgingMinor,
            trafficMinor: line.trafficMinor,
            overtimeMinor: line.overtimeMinor,
            otherMinor: line.otherMinor,
            remark: line.remark,
          };
        }),
      });
    } catch (error) {
      if (error instanceof DispatchConflictError) {
        // 并发窗口：另一 save 已抢先落单（(tenant, dispatchId) 唯一兜底）。
        return rejected(`该派工单已存在报销记录，请直接编辑（并发写入被拒：${error.message}）`);
      }
      throw error;
    }

    const event = makeAftercareClaimFiledEvent(this.domainEventBase(envelope), created);
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: created.objectVersion,
      events: [event],
      claim: toAftercareClaimView(created),
    };
  }

  // ---- aftercare.claim.update（编辑：四费/备注重写，行身份冻结） ----

  private async updateClaim(
    envelope: CommandEnvelope<AftercareClaimCommand>,
    dispatchId: string,
  ): Promise<AftercareClaimCommandResult> {
    const payload = parseAftercareClaimUpdatePayload(envelope.command.payload);
    const tenant = envelope.tenantId;

    const loaded = await this.loadAftermarketOrder(tenant, dispatchId);
    if ('rejected' in loaded) return rejected(loaded.rejected);

    const claim = await this.claims.findByDispatch(tenant, dispatchId);
    if (claim === null) {
      return rejected(`派工单 '${dispatchId}' 尚无报销记录，无法编辑（请先新增）`);
    }
    if (envelope.expectedRevision !== claim.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，报销单当前 objectVersion=${claim.objectVersion}`,
      );
    }
    const mismatch = assertReportIdSetMatches(
      payload.personLines,
      claim.lines.map((line) => line.reportId),
      '既有报销行',
    );
    if (mismatch !== null) return mismatch;

    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: AFTERCARE_CLAIM_AGGREGATE_TYPE,
      aggregateId: claim.id,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const previousTotal = aftercareClaimTotalMinor(claim);
    const updates: AftercareClaimFeeUpdate[] = payload.personLines.map((line) => ({
      reportId: line.reportId,
      lodgingMinor: line.lodgingMinor,
      trafficMinor: line.trafficMinor,
      overtimeMinor: line.overtimeMinor,
      otherMinor: line.otherMinor,
      remark: line.remark,
    }));
    const updated = await this.claims.updateFees(tenant, claim.id, claim.objectVersion, updates);
    if (updated === null) {
      return rejected(
        `报销单 '${claim.id}' 版本推进冲突：期望 ${claim.objectVersion}（可能存在并发写入，拒绝继续）`,
      );
    }

    const event = makeAftercareClaimUpdatedEvent(
      this.domainEventBase(envelope),
      updated,
      previousTotal,
    );
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: updated.objectVersion,
      events: [event],
      claim: toAftercareClaimView(updated),
    };
  }

  // ---- 查询 ----

  /** 按派工单查报销（文档 §3.4 #1：无报销/派工单不存在均 null，不抛「数据不存在」）。 */
  async claimByDispatch(tenant: TenantId, dispatchId: string): Promise<AftercareClaimView | null> {
    const claim = await this.claims.findByDispatch(tenant, dispatchId);
    return claim === null ? null : toAftercareClaimView(claim);
  }

  /** 报销上下文（文档 §3.4 #2：派工单不存在抛 NotFound；否则给判定事实）。 */
  async claimContext(tenant: TenantId, dispatchId: string): Promise<AftercareClaimContext> {
    const order = await this.orders.find(tenant, dispatchId);
    if (order === null) {
      throw new DispatchNotFoundError(`派工单不存在（租户 '${tenant}' 内无 '${dispatchId}'）`);
    }
    const claimable =
      order.kind === 'aftermarket' ? await this.reports.listApproved(tenant, dispatchId) : [];
    const claim = await this.claims.findByDispatch(tenant, dispatchId);
    let blockedReason: string | null = null;
    if (order.kind !== 'aftermarket') {
      blockedReason = `派工单 '${dispatchId}' 不是售后派工单（kind=${order.kind}），无报销面`;
    } else if (claim !== null) {
      blockedReason = `该派工单已存在报销记录，请直接编辑（报销单 '${claim.id}'）`;
    } else if (claimable.length === 0) {
      blockedReason = '该派工单尚无审批通过的报工记录，无法报销';
    }
    return {
      order: {
        id: order.id,
        kind: order.kind,
        state: order.state,
        title: order.title,
        workOrderId: order.workOrderId,
        assignee: order.assignee === null ? null : `${order.assignee}`,
        objectVersion: order.objectVersion,
      },
      claimableLines: claimable,
      claim: claim === null ? null : toAftercareClaimView(claim),
      reimbursable: blockedReason === null,
      blockedReason,
    };
  }

  // ---- 私有辅助 ----

  /** 域事件公共基（eventId/时刻/溯源——与 DispatchService.domainEventBase 同构）。 */
  private domainEventBase(envelope: CommandEnvelope<AftercareClaimCommand>): {
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
}

/** 存储形状 → 读面视图（行小计/报销合计读面计算）。 */
export function toAftercareClaimView(claim: AftercareClaim): AftercareClaimView {
  const lines: AftercareClaimLineView[] = claim.lines.map((line: AftercareClaimLine) => ({
    lineNo: line.lineNo,
    reportId: line.reportId,
    reportDate: line.reportDate,
    worker: `${line.worker}`,
    approvedBy: line.approvedBy === null ? null : `${line.approvedBy}`,
    approvedMinutes: line.approvedMinutes,
    lodgingMinor: line.lodgingMinor,
    trafficMinor: line.trafficMinor,
    overtimeMinor: line.overtimeMinor,
    otherMinor: line.otherMinor,
    remark: line.remark,
    totalMinor: aftercareLineTotalMinor(line),
  }));
  return {
    id: claim.id,
    dispatchId: claim.dispatchId,
    objectVersion: claim.objectVersion,
    lines,
    totalMinor: aftercareClaimTotalMinor(claim),
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}
