/**
 * ReportingService —— 五类报工与核查用例编排（M2-W7，05-reporting.md v1.0）。
 *
 * 零框架业务类（不 import @nestjs/*）。命令一律走 smes.command.v1
 * CommandEnvelope（operationId 幂等 + expectedRevision 乐观锁），结果按
 * CommandOutcome 三分（committed/rejected 为值；indeterminate 内存路径不产生）。
 *
 * 五件事：
 *
 * 1. 申报（report.submit / report.submit-batch）：挂派工单（经 dispatch 有效单
 *    读端口校验：单在且状态可报（初版 assigned/executing，配置化）且 kind 在
 *    五类报工面（外协单不报工）；工艺属性随单快照不回查）；submit 按本人——
 *    申报人 = 命令签发人，载荷不带 reporter；批量整批校验先于落账（一单非法
 *    整批 rejected，不部分落账），上限配置化；工序合法性经 baseline 端口复检
 *    （缺省恒合法 fail-open）；超报闸门（fix-wave-4 W4-1）：按派工单累计
 *    有效报工量 + 本次 ≤ 派工数量（累计口径 = 链尾行除撤销外合计；批量按
 *    派工单合并计本次量、任一单超量整批拒；S14 精算上限属 PRD 待实现差异，
 *    不在本闸门）；末道报工（kind ∈ 末道质检集 && 工艺路线末道
 *    判定真）通知式触发 InspectionIntakePort（回执进事件载荷，未接线不阻塞）；
 * 2. 状态机（engine-flow 配置驱动，ADR-0010）：submit = 建单先落 pending@v1
 *    初始投影（无机器事件）再驱动 SUBMIT → reported@v2（listing purchase.order.
 *    submit 同构）；verify（reported→verified，发 ReportVerified——hours 工时
 *    归集信号）；revoke（reported/verified→revoked 终态旁支，仅核查权限命令面；
 *    已核查撤销需重报，发 ReportRevoked——hours 冲销信号）；
 * 3. 核查编辑（report.audit-edit）：不改原单——生成修正版（新聚合行，supersedes
 *    锚定原单，append-only 修正链；修正版走同一 pending→reported 路径成为新链尾
 *    待核查）；字段级前后镜像进留痕账与 ReportCorrected 事件；仅链尾 reported
 *    态可编辑（verified 走撤销重报，revoked 终态不可动）；
 * 4. 留痕（ReportAuditId）：编辑/审核/撤销每次动作一行（谁、何时、对哪单、
 *    改了什么），append-only 全程留痕；
 * 5. 查询：五类列表/详情（链全貌 + 留痕 + 里程碑）、我的报工（(tenant,
 *    reporter) 双键——M1 Todo 双键先例的"仅本人完成"数据权限边界）、图号×
 *    工序进度（净报工/已核查聚合）、待核查队列（reported 链尾先进先核）、
 *    产出趋势事实（日产出/日均/峰值——reported+verified 计产出、revoked 不计、
 *    business_time 日期口径，供工作台与报表）。
 *
 * 落账顺序（与 workorder/listing/dispatch 同取舍）：先解析校验（后幂等记账）→
 * 幂等记账 → 初始投影（pending@v1）→ 机器事件账本（SUBMIT）→ 投影乐观推进 →
 * 端口联动（末道质检，通知式）→ 域事件发布（BusinessEvent + Outbox）。投影行
 * 先在是机器事件 append 的前置（PG 账本按投影行解析租户，孤儿聚合拒写）。
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
import {
  DEFAULT_FINAL_INSPECTION_KINDS,
  DEFAULT_REPORT_BATCH_LIMIT,
  DEFAULT_REPORT_FLOW_CONFIG,
  DEFAULT_REPORTABLE_DISPATCH_STATES,
  REPORT_KINDS,
  REPORT_OUTPUT_STATES,
  reportKindLabel,
  reportStateLabel,
} from './reporting-config.js';
import {
  REPORT_BATCH_AGGREGATE_TYPE,
  WORK_REPORT_AGGREGATE_TYPE,
  makeBatchSubmittedEvent,
  makeReportCorrectedEvent,
  makeReportRevokedEvent,
  makeReportSubmittedEvent,
  makeReportVerifiedEvent,
  provenanceOf,
  type ReportFieldChange,
  type ReportMachineMilestone,
} from './reporting-events.js';
import {
  ReportInputError,
  ReportNotFoundError,
  ReportStateError,
} from './reporting-errors.js';
import {
  parseReportAuditEditPayload,
  parseReportRevokePayload,
  parseReportSubmitBatchPayload,
  parseReportSubmitPayload,
  parseReportVerifyPayload,
  type BatchReportLinePayload,
  type ReportCommand,
  type ReportCommandKind,
} from './reporting-input.js';
import {
  ALL_OPERATIONS_VALID,
  EMPTY_VALID_DISPATCH_SOURCE,
  NEVER_FINAL_OPERATION,
  REPORTING_NOOP_INSPECTION_INTAKE,
  type DispatchFactForReport,
  type FinalOperationJudgePort,
  type InspectionIntakePort,
  type InspectionIntakeReceipt,
  type OperationValidityPort,
  type ValidDispatchSource,
} from './reporting-ports.js';
import type {
  CreateWorkReportInput,
  ListWorkReportsFilter,
  ReportAuditRow,
  ReportAuditStore,
  ReportDomainEventStore,
  ReportOperationStore,
  WorkReport,
  WorkReportStore,
} from './reporting-stores.js';
import { newDomainEventId, newReportAuditId, newWorkReportId } from './reporting-ids.js';

// ---- 结果形状 ----

export interface ReportCommitted extends CommittedOutcome {
  /** 单据申报（submit/audit-edit/verify/revoke）的目标单视图。 */
  readonly report?: WorkReport;
  /** 批量申报的单据集（submit-batch）。 */
  readonly reports?: readonly WorkReport[];
  /** 本命令产出的核查留痕行（audit-edit/verify/revoke；submit 无留痕）。 */
  readonly audits?: readonly ReportAuditRow[];
  /** 修正版的原单 id（audit-edit）。 */
  readonly correctedFrom?: string;
}

export type ReportCommandResult = ReportCommitted | RejectedOutcome | IndeterminateOutcome;

export interface ReportingServiceOptions {
  /** 报工状态机配置（缺省 DEFAULT_REPORT_FLOW_CONFIG；整体替换 = 换合法集）。 */
  readonly flowConfig: ApprovalFlowConfig;
  /** 可报派工单状态集（缺省 DEFAULT_REPORTABLE_DISPATCH_STATES：assigned/executing）。 */
  readonly reportableDispatchStates: readonly string[];
  /** 末道报工触发质检的 kind 集（缺省 DEFAULT_FINAL_INSPECTION_KINDS：part）。 */
  readonly finalInspectionKinds: readonly string[];
  /** 批量报工单次上限（缺省 DEFAULT_REPORT_BATCH_LIMIT）。 */
  readonly batchLimit: number;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => string;
}

export interface ReportingCrossModulePorts {
  /** dispatch 有效派工单校验读（submit 前置 + 工艺属性快照来源）。 */
  readonly validDispatch: ValidDispatchSource;
  /** baseline 工序合法性复检（缺省恒合法 fail-open）。 */
  readonly operationValidity: OperationValidityPort;
  /** baseline 工艺路线末道判定（末道报工触发自制质检）。 */
  readonly finalOperation: FinalOperationJudgePort;
  /** inspection 末道报工触发待检单（通知式）。 */
  readonly inspectionIntake: InspectionIntakePort;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

function rejected(reason: string): RejectedOutcome {
  return { status: 'rejected', reason };
}

/** yyyy-mm-dd 日期键（UTC 口径——趋势聚合粒度）。 */
function dateKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

export class ReportingService {
  private readonly options: ReportingServiceOptions;
  private readonly ports: ReportingCrossModulePorts;

  constructor(
    private readonly reports: WorkReportStore,
    private readonly audits: ReportAuditStore,
    private readonly operations: ReportOperationStore,
    private readonly domainEvents: ReportDomainEventStore,
    private readonly machineEvents: ApprovalEventStore,
    ports: Partial<ReportingCrossModulePorts> = {},
    options: Partial<ReportingServiceOptions> = {},
  ) {
    this.ports = {
      validDispatch: ports.validDispatch ?? EMPTY_VALID_DISPATCH_SOURCE,
      operationValidity: ports.operationValidity ?? ALL_OPERATIONS_VALID,
      finalOperation: ports.finalOperation ?? NEVER_FINAL_OPERATION,
      inspectionIntake: ports.inspectionIntake ?? REPORTING_NOOP_INSPECTION_INTAKE,
    };
    this.options = {
      flowConfig: options.flowConfig ?? DEFAULT_REPORT_FLOW_CONFIG,
      reportableDispatchStates: options.reportableDispatchStates ?? DEFAULT_REPORTABLE_DISPATCH_STATES,
      finalInspectionKinds: options.finalInspectionKinds ?? DEFAULT_FINAL_INSPECTION_KINDS,
      batchLimit: options.batchLimit ?? DEFAULT_REPORT_BATCH_LIMIT,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 命令入口（smes.command.v1 分发） ----

  async execute(
    envelope: CommandEnvelope<ReportCommand>,
    pathId?: string,
  ): Promise<ReportCommandResult> {
    const kind = envelope.command.kind;
    const createKinds: readonly ReportCommandKind[] = ['report.submit.v1', 'report.submit-batch.v1'];
    if (createKinds.includes(kind) && envelope.expectedRevision !== 'initial') {
      return rejected(`命令 ${kind} 是创建命令：expectedRevision 须为 'initial'`);
    }
    if (!createKinds.includes(kind) && envelope.expectedRevision === 'initial') {
      return rejected(`命令 ${kind} 作用于既有对象：expectedRevision 须为当前 objectVersion 数字`);
    }
    switch (kind) {
      case 'report.submit.v1':
        return this.submitOne(envelope);
      case 'report.submit-batch.v1':
        return this.submitBatch(envelope);
      case 'report.audit-edit.v1':
        return this.auditEdit(envelope, this.requirePathId(pathId, kind));
      case 'report.verify.v1':
        return this.verifyReport(envelope, this.requirePathId(pathId, kind));
      case 'report.revoke.v1':
        return this.revokeReport(envelope, this.requirePathId(pathId, kind));
    }
  }

  private requirePathId(pathId: string | undefined, kind: ReportCommandKind): string {
    if (pathId === undefined || pathId.trim().length === 0) {
      throw new ReportInputError(`命令 ${kind} 需要路径参数目标 id（控制器装配缺口）`);
    }
    return pathId.trim();
  }

  // ---- 申报前置：派工单校验 + 工艺属性快照 + 工序合法性 ----

  /**
   * 派工单校验（submit 前置）：单在（端口空实现 = 恒无单，fail-closed）、状态
   * 可报（初版 assigned/executing——默认配置层，客户口径整体替换）、kind 在
   * 五类报工面（outsourcing 不报工——外协完工走 dispatch 回厂质检链路）。
   */
  private async resolveReportableDispatch(
    tenant: TenantId,
    dispatchId: string,
  ): Promise<DispatchFactForReport | RejectedOutcome> {
    const fact = await this.ports.validDispatch.findDispatch(tenant, dispatchId);
    if (fact === null) {
      return rejected(
        `派工单 '${dispatchId}' 不存在或派工读端口未接线（reporting submit 前置校验 fail-closed）`,
      );
    }
    if (!this.options.reportableDispatchStates.includes(fact.state)) {
      return rejected(
        `派工单 '${dispatchId}' 状态 '${fact.state}' 不可报工（须处于 ${this.options.reportableDispatchStates.join('/')}）`,
      );
    }
    if (!(REPORT_KINDS as readonly string[]).includes(fact.kind)) {
      return rejected(
        `派工单 '${dispatchId}' kind '${fact.kind}' 不在五类报工面（零件/装配/电气/售后/零工——外协单不报工）`,
      );
    }
    if (fact.operationCode !== null) {
      const known = await this.ports.operationValidity.isKnownOperation(tenant, fact.operationCode);
      if (!known) {
        return rejected(`工序 '${fact.operationCode}' 不在 baseline 工序库中（报工工序合法性复检拒绝）`);
      }
    }
    return fact;
  }

  /**
   * 派工单累计有效报工量（超报闸门的累计口径，fix-wave-4 W4-1）：该派工单
   * 链尾行（被修正取代的链中段不计——store.list 端口合同即链尾口径）除撤销
   * （revoked，冲销不计）外的 doneQty 合计；reported/verified 均计。
   */
  private async effectiveReportedQty(tenant: TenantId, dispatchId: string): Promise<number> {
    const tails = await this.reports.list(tenant, { dispatchId });
    let total = 0;
    for (const row of tails) {
      if (row.state === 'revoked') continue; // 撤销冲销不计（撤销后重报走新单）
      total += row.doneQty;
    }
    return total;
  }

  /**
   * 超报闸门：累计有效报工量 + 本次 ≤ 派工数量（incoming = 单次提交量或批量
   * 内该派工单合计量）。超量返回 rejected（理由含数量对比）；未超返回 null。
   * 校验先于幂等记账（rejected 不吞 operationId）。
   */
  private async checkOverReport(
    tenant: TenantId,
    fact: DispatchFactForReport,
    incoming: number,
    incomingLabel: string,
  ): Promise<RejectedOutcome | null> {
    const accumulated = await this.effectiveReportedQty(tenant, fact.dispatchId);
    if (accumulated + incoming <= fact.quantity) return null;
    return rejected(
      `派工单 '${fact.dispatchId}' 报工超量：累计有效报工 ${accumulated}+${incomingLabel} ${incoming} 超过派工数量 ${fact.quantity}`,
    );
  }

  /** 末道报工质检触发（通知式——回执进事件载荷，未接线 created:false 不阻塞）。 */
  private async maybeTriggerInspection(
    tenant: TenantId,
    fact: DispatchFactForReport,
    reportId: string,
    doneQty: number,
    triggeredBy: UserId,
  ): Promise<InspectionIntakeReceipt> {
    if (
      !this.options.finalInspectionKinds.includes(fact.kind) ||
      fact.drawingNo === null ||
      fact.operationCode === null
    ) {
      return {
        inspectionId: null,
        created: false,
        reason: '非末道质检覆盖面（kind 不在末道触发集或无图号×工序键）',
      };
    }
    const isFinal = await this.ports.finalOperation.isFinalOperation(tenant, fact.drawingNo, fact.operationCode);
    if (!isFinal) {
      return { inspectionId: null, created: false, reason: '非工艺路线末道工序（不触发自制质检）' };
    }
    return this.ports.inspectionIntake.receiveSourceFact(tenant, {
      sourceType: 'report',
      sourceRefId: reportId,
      itemId: null,
      drawingNo: fact.drawingNo,
      quantity: doneQty,
      workOrderId: fact.workOrderId,
      occurredAt: this.now(),
      triggeredBy,
    });
  }

  /**
   * 单据申报落账管线（submit 单/批量/修正版共用）：
   * pending@v1 初始投影 → SUBMIT 机器事件 → reported@v2 乐观推进 → 末道质检
   * 触发（通知式）→ ReportSubmitted 域事件。幂等记账由调用方先行（reportId 由
   * 调用方生成并与记账锚一致；批量一次 operationId 落一条记账挂批次锚）。
   */
  private async appendSubmittedReport(
    envelope: CommandEnvelope<ReportCommand>,
    line: BatchReportLinePayload,
    fact: DispatchFactForReport,
    supersedes: string | null,
    reportId: string,
  ): Promise<{ readonly report: WorkReport; readonly event: ReturnType<typeof makeReportSubmittedEvent> }> {
    const tenant = envelope.tenantId;
    const businessTime = line.businessTime ?? this.now();
    const created = await this.reports.create({
      tenant,
      id: reportId,
      dispatchId: fact.dispatchId,
      kind: fact.kind as WorkReport['kind'],
      flowConfigId: this.options.flowConfig.flowId,
      state: this.options.flowConfig.initial, // pending：初始态落库，无机器事件
      objectVersion: 1,
      doneQty: line.doneQty,
      laborMinutes: line.laborMinutes,
      reporter: envelope.issuedBy,
      workOrderId: fact.workOrderId,
      drawingNo: fact.drawingNo,
      operationCode: fact.operationCode,
      supersedes,
      businessTime,
      remark: line.remark,
    });

    const runtime = startApprovalFlow({
      config: this.options.flowConfig,
      subject: { aggregate: { id: reportId, type: WORK_REPORT_AGGREGATE_TYPE }, initialObjectVersion: 1 },
      now: () => this.now(),
    });
    try {
      const outcome = runtime.send('SUBMIT', {
        by: envelope.issuedBy,
        reason: `${reportKindLabel(fact.kind)}申报`,
        objectVersion: 1,
      });
      if (outcome.status !== 'transitioned') {
        throw new ReportStateError(
          `报工单初始迁移失败：SUBMIT 返回 ${outcome.status}（配置无 pending→reported 规则，配置换代）`,
        );
      }
      await this.machineEvents.append(outcome.event);
      const advanced = await this.reports.advance(
        tenant,
        reportId,
        1,
        runtime.state(),
        runtime.objectVersion(),
      );

      const intake = await this.maybeTriggerInspection(tenant, fact, reportId, line.doneQty, envelope.issuedBy);
      const event = makeReportSubmittedEvent(
        this.domainEventBase(envelope),
        {
          reportId,
          dispatchId: fact.dispatchId,
          kind: advanced.kind,
          workOrderId: advanced.workOrderId,
          drawingNo: advanced.drawingNo,
          operationCode: advanced.operationCode,
          doneQty: advanced.doneQty,
          laborMinutes: advanced.laborMinutes,
          reporter: advanced.reporter,
          businessTime: advanced.businessTime,
          supersedes,
          inspectionIntake: {
            inspectionId: intake.inspectionId,
            created: intake.created,
            reason: intake.reason ?? null,
          },
          objectVersion: runtime.objectVersion(),
          actor: envelope.issuedBy,
        },
        reportId,
      );
      await this.domainEvents.append(event);
      return { report: advanced, event };
    } finally {
      runtime.stop();
    }
  }

  // ---- report.submit（单人单工序申报） ----

  private async submitOne(envelope: CommandEnvelope<ReportCommand>): Promise<ReportCommandResult> {
    const payload = parseReportSubmitPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const factOrRejected = await this.resolveReportableDispatch(tenant, payload.dispatchId);
    if ('status' in factOrRejected) return factOrRejected;
    const fact = factOrRejected;

    const overReport = await this.checkOverReport(tenant, fact, payload.doneQty, '本次');
    if (overReport !== null) return overReport;

    const reportId = newWorkReportId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: WORK_REPORT_AGGREGATE_TYPE,
      aggregateId: reportId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const { report, event } = await this.appendSubmittedReport(envelope, payload, fact, null, reportId);
    return {
      status: 'committed',
      newRevision: report.objectVersion,
      events: [event],
      report,
    };
  }

  // ---- report.submit-batch（批量申报；整批校验先于落账） ----

  private async submitBatch(envelope: CommandEnvelope<ReportCommand>): Promise<ReportCommandResult> {
    const payload = parseReportSubmitBatchPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    if (payload.lines.length > this.options.batchLimit) {
      return rejected(
        `批量报工超上限：${payload.lines.length} 行 > 配置上限 ${this.options.batchLimit}（弱网分片口径见合同 §8）`,
      );
    }

    // 先解析校验后幂等记账：任何一行非法 → 整批 rejected，不部分落账。
    const facts: DispatchFactForReport[] = [];
    for (const [index, line] of payload.lines.entries()) {
      const factOrRejected = await this.resolveReportableDispatch(tenant, line.dispatchId);
      if ('status' in factOrRejected) {
        return rejected(`批量第 ${index + 1} 行被拒：${factOrRejected.reason}`);
      }
      facts.push(factOrRejected);
    }

    // 超报闸门（整批口径）：同一派工单多行合并计本次量；任一单累计+本次 >
    // 派工数量 → 整批 rejected 零落账（对齐"任何一行非法整批拒"，先于幂等记账）。
    const incomingByDispatch = new Map<string, { total: number; firstIndex: number }>();
    for (const [index, line] of payload.lines.entries()) {
      const entry = incomingByDispatch.get(line.dispatchId);
      if (entry === undefined) {
        incomingByDispatch.set(line.dispatchId, { total: line.doneQty, firstIndex: index });
      } else {
        entry.total += line.doneQty;
      }
    }
    for (const { total, firstIndex } of incomingByDispatch.values()) {
      const overReport = await this.checkOverReport(
        tenant,
        facts[firstIndex] as DispatchFactForReport,
        total,
        '本次批量合计',
      );
      if (overReport !== null) {
        return rejected(`批量第 ${firstIndex + 1} 行被拒：${overReport.reason}`);
      }
    }

    const anchorId = newWorkReportId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: REPORT_BATCH_AGGREGATE_TYPE,
      aggregateId: anchorId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    const submitted: WorkReport[] = [];
    const events: ReturnType<typeof makeReportSubmittedEvent>[] = [];
    for (const [index, line] of payload.lines.entries()) {
      const { report, event } = await this.appendSubmittedReport(
        envelope,
        line,
        facts[index] as DispatchFactForReport,
        null,
        newWorkReportId(),
      );
      submitted.push(report);
      events.push(event);
    }
    const batchEvent = makeBatchSubmittedEvent(
      this.domainEventBase(envelope),
      {
        count: submitted.length,
        reports: submitted.map((report) => ({
          reportId: report.id,
          dispatchId: report.dispatchId,
          kind: report.kind,
          doneQty: report.doneQty,
          laborMinutes: report.laborMinutes,
          reporter: report.reporter,
          objectVersion: report.objectVersion,
        })),
        actor: envelope.issuedBy,
      },
      anchorId,
    );
    await this.domainEvents.append(batchEvent);

    return {
      status: 'committed',
      newRevision: 1,
      events: [...events, batchEvent],
      reports: submitted,
    };
  }

  // ---- report.audit-edit（核查编辑 → 修正版，不改原单） ----

  private async auditEdit(
    envelope: CommandEnvelope<ReportCommand>,
    reportId: string,
  ): Promise<ReportCommandResult> {
    const payload = parseReportAuditEditPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const original = await this.loadActiveTail(tenant, reportId);
    if (original === null) {
      return rejected(`租户 '${tenant}' 内不存在报工单 '${reportId}'（或已被修正版取代——请对链尾单执行核查命令）`);
    }
    if (envelope.expectedRevision !== original.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，报工单当前 objectVersion=${original.objectVersion}`,
      );
    }
    if (original.state !== 'reported') {
      return rejected(
        `状态 '${reportStateLabel(original.state)}' 不可编辑（仅已报待核查可编辑；已核查走撤销重报口径，已撤销终态）`,
      );
    }

    // 字段级前后镜像（改了什么——留痕与事件同载荷口径）。
    const changes: ReportFieldChange[] = [];
    if (payload.doneQty !== null && payload.doneQty !== original.doneQty) {
      changes.push({ field: 'doneQty', from: original.doneQty, to: payload.doneQty });
    }
    if (payload.laborMinutes !== null && payload.laborMinutes !== original.laborMinutes) {
      changes.push({ field: 'laborMinutes', from: original.laborMinutes, to: payload.laborMinutes });
    }
    if (payload.businessTime !== null && payload.businessTime !== original.businessTime) {
      changes.push({ field: 'businessTime', from: original.businessTime, to: payload.businessTime });
    }
    if (payload.remark !== null && payload.remark !== original.remark) {
      changes.push({ field: 'remark', from: original.remark, to: payload.remark });
    }

    const correctedId = newWorkReportId();
    const recorded = await this.operations.record({
      tenant,
      operationId: envelope.operationId,
      command: envelope.command.kind,
      aggregateType: WORK_REPORT_AGGREGATE_TYPE,
      aggregateId: correctedId,
      occurredAt: this.now(),
    });
    if (recorded === null) {
      return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
    }

    // 修正版落账：继承原单申报面 + 编辑字段覆盖，走同一 pending→reported 管线
    // （成为新链尾，仍待核查——audit-edit 与 verify 是两步）。fact 形状取原单
    // 快照（修正版不再回查派工单状态——原单 submit 落账时已证）。
    const { report: corrected } = await this.appendSubmittedReport(
      envelope,
      {
        dispatchId: original.dispatchId,
        doneQty: payload.doneQty ?? original.doneQty,
        laborMinutes: payload.laborMinutes ?? original.laborMinutes,
        businessTime: payload.businessTime ?? original.businessTime,
        remark: payload.remark ?? original.remark,
      },
      {
        dispatchId: original.dispatchId,
        kind: original.kind,
        state: 'executing', // 占位（appendSubmittedReport 不校验派工单状态；校验在 submit 入口）
        workOrderId: original.workOrderId,
        drawingNo: original.drawingNo,
        operationCode: original.operationCode,
        quantity: original.doneQty,
        assignee: null,
      },
      original.id,
      correctedId,
    );

    const audit = await this.appendAudit(tenant, {
      reportId: original.id,
      action: 'edit',
      actor: envelope.issuedBy,
      reason: payload.reason,
      changes,
    });
    const event = makeReportCorrectedEvent(
      this.domainEventBase(envelope),
      {
        originalReportId: original.id,
        correctedReportId: corrected.id,
        dispatchId: corrected.dispatchId,
        kind: corrected.kind,
        workOrderId: corrected.workOrderId,
        drawingNo: corrected.drawingNo,
        operationCode: corrected.operationCode,
        changes,
        reason: payload.reason,
        objectVersion: corrected.objectVersion,
        actor: envelope.issuedBy,
      },
      corrected.id,
    );
    await this.domainEvents.append(event);

    return {
      status: 'committed',
      newRevision: corrected.objectVersion,
      events: [event],
      report: corrected,
      audits: [audit],
      correctedFrom: original.id,
    };
  }

  // ---- report.verify（reported→verified，发 hours 归集信号） ----

  private async verifyReport(
    envelope: CommandEnvelope<ReportCommand>,
    reportId: string,
  ): Promise<ReportCommandResult> {
    parseReportVerifyPayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const report = await this.loadActiveTail(tenant, reportId);
    if (report === null) {
      return rejected(`租户 '${tenant}' 内不存在报工单 '${reportId}'（或已被修正版取代——请对链尾单执行核查命令）`);
    }
    if (envelope.expectedRevision !== report.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，报工单当前 objectVersion=${report.objectVersion}`,
      );
    }

    const runtime = await this.replayReport(report);
    try {
      const from = runtime.state();
      const outcome = runtime.send('VERIFY', {
        by: envelope.issuedBy,
        reason: '报工核查通过',
        objectVersion: report.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(
          `状态 '${reportStateLabel(from)}' 不可核查（VERIFY 返回 ${outcome.status}——仅已报可核查）`,
        );
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: WORK_REPORT_AGGREGATE_TYPE,
        aggregateId: reportId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const verifiedAt = this.now();
      const advanced = await this.reports.advance(
        tenant,
        reportId,
        report.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { verifiedBy: envelope.issuedBy, verifiedAt },
      );

      const audit = await this.appendAudit(tenant, {
        reportId,
        action: 'verify',
        actor: envelope.issuedBy,
        reason: null,
        changes: null,
      });
      const event = makeReportVerifiedEvent(
        this.domainEventBase(envelope),
        {
          reportId,
          dispatchId: advanced.dispatchId,
          kind: advanced.kind,
          workOrderId: advanced.workOrderId,
          drawingNo: advanced.drawingNo,
          operationCode: advanced.operationCode,
          reporter: advanced.reporter,
          doneQty: advanced.doneQty,
          laborMinutes: advanced.laborMinutes,
          businessTime: advanced.businessTime,
          supersedes: advanced.supersedes,
          verifiedBy: envelope.issuedBy,
          verifiedAt,
          objectVersion: runtime.objectVersion(),
          actor: envelope.issuedBy,
        },
        reportId,
      );
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        report: advanced,
        audits: [audit],
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- report.revoke（reported/verified→revoked，发 hours 冲销信号） ----

  private async revokeReport(
    envelope: CommandEnvelope<ReportCommand>,
    reportId: string,
  ): Promise<ReportCommandResult> {
    const payload = parseReportRevokePayload(envelope.command.payload);
    const tenant = envelope.tenantId;
    const report = await this.loadActiveTail(tenant, reportId);
    if (report === null) {
      return rejected(`租户 '${tenant}' 内不存在报工单 '${reportId}'（或已被修正版取代——请对链尾单执行核查命令）`);
    }
    if (envelope.expectedRevision !== report.objectVersion) {
      return rejected(
        `乐观锁冲突：expectedRevision=${envelope.expectedRevision}，报工单当前 objectVersion=${report.objectVersion}`,
      );
    }

    const runtime = await this.replayReport(report);
    try {
      const from = runtime.state();
      const outcome = runtime.send('REVOKE', {
        by: envelope.issuedBy,
        reason: payload.reason ?? '报工撤销',
        objectVersion: report.objectVersion,
      });
      if (outcome.status !== 'transitioned') {
        return rejected(
          `状态 '${reportStateLabel(from)}' 不可撤销（REVOKE 返回 ${outcome.status}——已报/已核查可撤，撤销后需重报）`,
        );
      }

      const recorded = await this.operations.record({
        tenant,
        operationId: envelope.operationId,
        command: envelope.command.kind,
        aggregateType: WORK_REPORT_AGGREGATE_TYPE,
        aggregateId: reportId,
        occurredAt: this.now(),
      });
      if (recorded === null) {
        return rejected(`操作幂等冲突：operationId '${envelope.operationId}' 已落账，拒绝重复执行`);
      }

      await this.machineEvents.append(outcome.event);
      const revokedAt = this.now();
      const advanced = await this.reports.advance(
        tenant,
        reportId,
        report.objectVersion,
        runtime.state(),
        runtime.objectVersion(),
        { revokedBy: envelope.issuedBy, revokedAt, revokeReason: payload.reason },
      );

      const audit = await this.appendAudit(tenant, {
        reportId,
        action: 'revoke',
        actor: envelope.issuedBy,
        reason: payload.reason,
        changes: null,
      });
      const event = makeReportRevokedEvent(
        this.domainEventBase(envelope),
        {
          reportId,
          dispatchId: advanced.dispatchId,
          kind: advanced.kind,
          workOrderId: advanced.workOrderId,
          drawingNo: advanced.drawingNo,
          operationCode: advanced.operationCode,
          reporter: advanced.reporter,
          doneQty: advanced.doneQty,
          laborMinutes: advanced.laborMinutes,
          businessTime: advanced.businessTime,
          fromState: from,
          revokeReason: payload.reason,
          objectVersion: runtime.objectVersion(),
          actor: envelope.issuedBy,
        },
        reportId,
      );
      await this.domainEvents.append(event);

      return {
        status: 'committed',
        newRevision: runtime.objectVersion(),
        events: [event],
        report: advanced,
        audits: [audit],
      };
    } finally {
      runtime.stop();
    }
  }

  // ---- 查询 ----

  /** 五类报工列表（可选 kind/状态/派工单/申报人/图号过滤；链尾行，createdAt 降序）。 */
  async listReports(tenant: TenantId, filter?: ListWorkReportsFilter): Promise<readonly WorkReport[]> {
    return this.reports.list(tenant, filter);
  }

  /** 报工单详情：指定行 + 修正链全貌（链头→链尾）+ 全链核查留痕 + 该行迁移里程碑。 */
  async reportDetail(tenant: TenantId, reportId: string): Promise<ReportDetail> {
    const report = await this.reports.find(tenant, reportId);
    if (report === null) {
      throw new ReportNotFoundError(`租户 '${tenant}' 内不存在报工单 '${reportId}'`);
    }
    const chain = await this.chainOf(tenant, report);
    const audits: ReportAuditRow[] = [];
    for (const member of chain) {
      audits.push(...(await this.audits.listByReport(tenant, member.id)));
    }
    audits.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const page = await this.machineEvents.readByAggregate({ id: reportId, type: WORK_REPORT_AGGREGATE_TYPE });
    return { report, chain, audits, milestones: machineMilestones(page.events) };
  }

  /** 我的报工（(tenant, reporter) 双键收口——"仅本人完成"数据权限边界）。 */
  async myReports(tenant: TenantId, reporter: UserId): Promise<readonly WorkReport[]> {
    return this.reports.list(tenant, { reporter });
  }

  /** 待核查队列（reported 链尾，createdAt 升序——先进先核）。 */
  async pendingVerificationQueue(tenant: TenantId): Promise<readonly WorkReport[]> {
    const rows = await this.reports.list(tenant, { state: 'reported' });
    return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 图号×工序进度（净报工聚合）：链尾行按 (drawingNo, operationCode) 归集——
   * 净产出 = reported+verified 链尾合计（revoked 不计、被修正行不计）；
   * 已核查口径单列。对账要点："同报工集合的已核查工时×数量汇总与活系统一致"。
   */
  async drawingOperationProgress(
    tenant: TenantId,
    drawingNo: string,
  ): Promise<readonly DrawingOperationProgressRow[]> {
    const rows = await this.reports.list(tenant, { drawingNo });
    interface Accum {
      netDoneQty: number;
      verifiedQty: number;
      netLaborMinutes: number;
      verifiedLaborMinutes: number;
      reportCount: number;
      lastAt: string | null;
    }
    const groups = new Map<string, { readonly operationCode: string | null } & Accum>();
    for (const row of rows) {
      if (!REPORT_OUTPUT_STATES.has(row.state)) continue; // revoked 不计净额
      const key = row.operationCode ?? '';
      const agg = groups.get(key);
      const verified = row.state === 'verified';
      const previousAt = agg?.lastAt ?? null;
      groups.set(key, {
        operationCode: row.operationCode,
        netDoneQty: (agg?.netDoneQty ?? 0) + row.doneQty,
        verifiedQty: (agg?.verifiedQty ?? 0) + (verified ? row.doneQty : 0),
        netLaborMinutes: (agg?.netLaborMinutes ?? 0) + row.laborMinutes,
        verifiedLaborMinutes: (agg?.verifiedLaborMinutes ?? 0) + (verified ? row.laborMinutes : 0),
        reportCount: (agg?.reportCount ?? 0) + 1,
        lastAt: previousAt !== null && previousAt > row.createdAt ? previousAt : row.createdAt,
      });
    }
    return [...groups.entries()]
      .map(([key, agg]) => ({
        drawingNo,
        operationCode: key === '' ? null : key,
        netDoneQty: agg.netDoneQty,
        verifiedQty: agg.verifiedQty,
        netLaborMinutes: agg.netLaborMinutes,
        verifiedLaborMinutes: agg.verifiedLaborMinutes,
        reportCount: agg.reportCount,
        lastReportedAt: agg.lastAt,
      }))
      .sort((a, b) => (a.operationCode ?? '').localeCompare(b.operationCode ?? ''));
  }

  /**
   * 产出趋势事实（日产出/日均/峰值，供工作台与报表）：净产出 = reported+verified
   * 链尾合计（revoked 冲销不计——撤销后重报的净额口径与对账要点一致）；
   * 日期粒度 = business_time 的 UTC 日期（补录报工计入业务当天）；窗口 = 含今日
   * 的近 days 个自然日（缺日补 0）；峰值 = 窗口内单日最大净产出（全 0 → null）。
   */
  async outputTrend(tenant: TenantId, days = 12): Promise<OutputTrendFact> {
    const windowDays = Math.max(1, Math.min(366, Math.trunc(days)));
    const rows = await this.reports.list(tenant);
    const byDate = new Map<string, { doneQty: number; laborMinutes: number }>();
    for (const row of rows) {
      if (!REPORT_OUTPUT_STATES.has(row.state)) continue;
      const key = dateKeyOf(row.businessTime);
      const agg = byDate.get(key) ?? { doneQty: 0, laborMinutes: 0 };
      agg.doneQty += row.doneQty;
      agg.laborMinutes += row.laborMinutes;
      byDate.set(key, agg);
    }

    const today = new Date(`${dateKeyOf(this.now())}T00:00:00.000Z`);
    const daily: OutputTrendDailyPoint[] = [];
    for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getTime() - offset * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      const agg = byDate.get(key) ?? { doneQty: 0, laborMinutes: 0 };
      daily.push({ date: key, doneQty: agg.doneQty, laborMinutes: agg.laborMinutes });
    }
    const totalQty = daily.reduce((sum, point) => sum + point.doneQty, 0);
    const totalMinutes = daily.reduce((sum, point) => sum + point.laborMinutes, 0);
    const peak = daily.reduce<OutputTrendDailyPoint | null>(
      (best, point) => (best === null || point.doneQty > best.doneQty ? point : best),
      null,
    );
    return {
      days: windowDays,
      from: daily[0]?.date ?? dateKeyOf(this.now()),
      to: daily[daily.length - 1]?.date ?? dateKeyOf(this.now()),
      daily,
      avgDoneQtyPerDay: Math.round((totalQty / windowDays) * 100) / 100,
      avgLaborMinutesPerDay: Math.round(totalMinutes / windowDays),
      peak: peak !== null && peak.doneQty > 0 ? peak : null,
    };
  }

  // ---- 私有辅助 ----

  /** 域事件公共基（eventId/时刻/溯源——全部命令产出共用）。 */
  private domainEventBase(envelope: CommandEnvelope<ReportCommand>): {
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

  /** 核查留痕落账（append-only：编辑/审核/撤销每次动作一行）。 */
  private async appendAudit(
    tenant: TenantId,
    input: {
      readonly reportId: string;
      readonly action: ReportAuditRow['action'];
      readonly actor: UserId;
      readonly reason: string | null;
      readonly changes: readonly ReportFieldChange[] | null;
    },
  ): Promise<ReportAuditRow> {
    return this.audits.append({
      id: newReportAuditId(),
      tenant,
      reportId: input.reportId,
      action: input.action,
      actor: input.actor,
      reason: input.reason,
      changes: input.changes,
      createdAt: this.now(),
    });
  }

  /**
   * 载入链尾单：指定行不存在 → null；已被修正版取代 → null（对修正版核查——
   * 原单是历史链环节，不再接受核查命令）。不校验 flowConfigId 之外的配置换代
   * （loadReportForCommand 之外的读路径直接 find）。
   */
  private async loadActiveTail(tenant: TenantId, reportId: string): Promise<WorkReport | null> {
    const report = await this.reports.find(tenant, reportId);
    if (report === null) return null;
    if (report.flowConfigId !== this.options.flowConfig.flowId) {
      throw new ReportStateError(
        `报工单 '${reportId}' 由配置 '${report.flowConfigId}' 驱动，与当前装配配置 '${this.options.flowConfig.flowId}' 不符（配置换代，须整体迁移）`,
      );
    }
    const successors = await this.reports.findBySupersedes(tenant, reportId);
    if (successors.length > 0) return null; // 已被修正版取代——对链尾单核查
    return report;
  }

  /** 重放报工单机器事件账本；重放结果必须与投影行一致（事实源 ↔ 投影对账）。 */
  private async replayReport(report: WorkReport): Promise<ApprovalFlowRuntime> {
    const aggregate = { id: report.id, type: WORK_REPORT_AGGREGATE_TYPE };
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
        throw new ReportStateError(
          `报工单事件账本与配置不一致：重放 ${event.eventType} 得 ${outcome.status}（配置已换代或账本损坏）`,
        );
      }
    }
    if (runtime.state() !== report.state || runtime.objectVersion() !== report.objectVersion) {
      runtime.stop();
      throw new ReportStateError(
        `报工单事件账本与投影行不一致：投影 ${report.state}@v${report.objectVersion}，重放 ${runtime.state()}@v${runtime.objectVersion()}（可能存在中断写入，拒绝继续）`,
      );
    }
    return runtime;
  }

  /** 组装修正链全貌（链头→链尾：沿 supersedes 向上找链头，再向下收集全部后继）。 */
  private async chainOf(tenant: TenantId, member: WorkReport): Promise<readonly WorkReport[]> {
    let head = member;
    for (let guard = 0; guard < 100 && head.supersedes !== null; guard += 1) {
      const previous = await this.reports.find(tenant, head.supersedes);
      if (previous === null) break; // 链断（数据级异常）——以可达段收口，不炸查询
      head = previous;
    }
    const chain: WorkReport[] = [head];
    let current = head;
    for (let guard = 0; guard < 100; guard += 1) {
      const successors = await this.reports.findBySupersedes(tenant, current.id);
      const next = successors[successors.length - 1] ?? null;
      if (next === null) break;
      chain.push(next);
      current = next;
    }
    return chain;
  }
}

// ---- 查询视图形状 ----

export interface ReportDetail {
  readonly report: WorkReport;
  /** 修正链全貌（链头→链尾；链尾即活跃视图行）。 */
  readonly chain: readonly WorkReport[];
  /** 全链核查留痕（createdAt 升序）。 */
  readonly audits: readonly ReportAuditRow[];
  readonly milestones: readonly ReportMachineMilestone[];
}

/** 图号×工序进度行（净报工聚合——revoked 不计、被修正行不计）。 */
export interface DrawingOperationProgressRow {
  readonly drawingNo: string;
  readonly operationCode: string | null;
  readonly netDoneQty: number;
  readonly verifiedQty: number;
  readonly netLaborMinutes: number;
  readonly verifiedLaborMinutes: number;
  readonly reportCount: number;
  readonly lastReportedAt: string | null;
}

export interface OutputTrendDailyPoint {
  readonly date: string;
  readonly doneQty: number;
  readonly laborMinutes: number;
}

/** 产出趋势事实（日产出/日均/峰值——供工作台与报表）。 */
export interface OutputTrendFact {
  readonly days: number;
  readonly from: string;
  readonly to: string;
  readonly daily: readonly OutputTrendDailyPoint[];
  readonly avgDoneQtyPerDay: number;
  readonly avgLaborMinutesPerDay: number;
  readonly peak: OutputTrendDailyPoint | null;
}

/** 机器账本迁移史（本地读法，与 workorder/listing/dispatch milestoneHistory 同构）。 */
function machineMilestones(events: readonly ApprovalEvent[]): readonly ReportMachineMilestone[] {
  return events.map((event) => ({
    from: event.payload.from,
    to: event.payload.to,
    event: event.payload.event,
    at: event.occurredAt,
    actor: event.payload.actor,
    objectVersion: event.payload.objectVersion,
  }));
}
