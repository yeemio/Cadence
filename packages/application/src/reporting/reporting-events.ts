/**
 * reporting 域事件（M2-W7，05-reporting.md §6）。
 *
 * 公开事件 = business-core BusinessEvent 形状（append-only 事件表 + Outbox，
 * 证据七公共列在持久化层补齐）。命名空间：smes.reporting.v1.<过去式动作>；
 * 事件清单（合同词汇 5 个）：
 *   ReportSubmitted / BatchSubmitted（申报：单人/批量）/
 *   ReportCorrected（核查编辑修正版，supersedes 链锚点）/
 *   ReportVerified（→hours 工时归集信号——**事件形状即 hours 消费端口合同**：
 *     verified 工时实时进入工时账，载荷携带工作令维度 + 申报人 + 整数分钟工时）/
 *   ReportRevoked（→hours 冲销信号：撤销后净额口径，已核查撤销需重报）。
 *
 * 与 engine-flow 机器事件账本的分工：机器事件（ApprovalEvent 形状）是报工单
 * 状态机的**重放事实源**（乐观锁与对账口径）；本文件域事件是对外**发布事实**
 * （Outbox / hours 归集冲销 / workorder 进度上卷 / inspection 消费）。两层各自
 * append-only，同一命令产出时先账本后发布。
 *
 * 修正链：audit-edit 不改原单——ReportCorrected 挂**修正版**聚合（新 id），
 * 载荷携带 originalReportId + 字段级前后镜像；链尾读取口径见 WorkReportStore.list
 * 合同（被 supersedes 的行不进活跃视图）。
 */
import {
  EventId,
  TenantId,
  makeBusinessEvent,
  type BusinessEvent,
} from '@smes/business-core';
import type { ReportKind } from './reporting-config.js';

// ---- 聚合类型 ----

export const WORK_REPORT_AGGREGATE_TYPE = 'work-report';
/** 批量报工事件的聚合类型（batch 事件挂批次首单 id + 本类型，不与单据事件混读）。 */
export const REPORT_BATCH_AGGREGATE_TYPE = 'report-batch';

/** 溯源列形状：operationId + 命令动词 + 操作者（evidence-columns provenance 口径）。 */
export interface ReportEventProvenance {
  readonly [key: string]: unknown;
  readonly operationId: string;
  readonly command: string;
  readonly actor: string;
}

function provenanceOf(operationId: string, command: string, actor: string): ReportEventProvenance {
  return { operationId, command, actor };
}

// ---- 事件类型名 ----

export const REPORT_EVENT_TYPES = {
  reportSubmitted: 'smes.reporting.v1.report-submitted',
  batchSubmitted: 'smes.reporting.v1.batch-submitted',
  reportCorrected: 'smes.reporting.v1.report-corrected',
  reportVerified: 'smes.reporting.v1.report-verified',
  reportRevoked: 'smes.reporting.v1.report-revoked',
} as const;

// ---- inspection 来源入口回执的载荷镜像（结构化提取；词汇以 inspection-ports 为准） ----

export interface InspectionIntakeReceiptPayload {
  readonly inspectionId: string | null;
  readonly created: boolean;
  readonly reason: string | null;
}

// ---- 核查编辑的字段级镜像（修正版链的"改了什么"留痕） ----

/** 单字段前后镜像（值形状不限：数量/工时分钟/备注/业务时间）。 */
export interface ReportFieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

// ---- 载荷形状 ----

/** 申报载荷的工艺属性快照（从 dispatch fact 随单快照——上卷与质检键）。 */
export interface ReportCraftSnapshot {
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
}

export interface ReportSubmittedPayload extends ReportCraftSnapshot {
  readonly reportId: string;
  readonly dispatchId: string;
  readonly kind: ReportKind;
  /** 完工数量（正数）。 */
  readonly doneQty: number;
  /** 工时（整数分钟，整数精确——hours 归集同一量纲）。 */
  readonly laborMinutes: number;
  /** 申报人（= 命令签发人；submit 按本人权限）。 */
  readonly reporter: string;
  /** 业务时间（可补录的事后报工口径；缺省 = 申报时刻）。 */
  readonly businessTime: string;
  /** 修正版锚点（audit-edit 产出的修正版为原单 id；直报单为 null）。 */
  readonly supersedes: string | null;
  /** 末道报工触发质检回执（未触发/未接线 = created:false + 原因）。 */
  readonly inspectionIntake: InspectionIntakeReceiptPayload | null;
  readonly objectVersion: number;
  readonly actor: string;
}

export interface BatchSubmittedPayload {
  /** 批内单据数。 */
  readonly count: number;
  readonly reports: readonly {
    readonly reportId: string;
    readonly dispatchId: string;
    readonly kind: ReportKind;
    readonly doneQty: number;
    readonly laborMinutes: number;
    readonly reporter: string;
    readonly objectVersion: number;
  }[];
  readonly actor: string;
}

export interface ReportCorrectedPayload extends ReportCraftSnapshot {
  /** 被修正的原单 id（supersedes 链锚点）。 */
  readonly originalReportId: string;
  /** 修正版 id（本事件聚合）。 */
  readonly correctedReportId: string;
  readonly dispatchId: string;
  readonly kind: ReportKind;
  /** 字段级前后镜像（改了什么——核查留痕的事件通道）。 */
  readonly changes: readonly ReportFieldChange[];
  readonly reason: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

/**
 * ReportVerified 载荷 = hours 工时归集端口的消费合同（合同 §4 被依赖面：
 * "verified 工时直通工时账，事件链携带工作令维度"）。hours 订阅方按本形状消费：
 * 归集主键 = reportId；工时 = laborMinutes（整数分钟）；归属人 = reporter；
 * 归集期次锚点 = businessTime；冲销配对 = ReportRevoked 同 id。
 */
export interface ReportVerifiedPayload extends ReportCraftSnapshot {
  readonly reportId: string;
  readonly dispatchId: string;
  readonly kind: ReportKind;
  readonly reporter: string;
  /** 已核查数量（hours 产量口径的输入之一）。 */
  readonly doneQty: number;
  /** 已核查工时（整数分钟——归集量纲）。 */
  readonly laborMinutes: number;
  readonly businessTime: string;
  /** 修正链锚点（修正版被核查时携带原单 id；冲销-重报净额对账用）。 */
  readonly supersedes: string | null;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
  readonly objectVersion: number;
  readonly actor: string;
}

/** ReportRevoked 载荷 = hours 冲销信号（撤销单的已归集工时/数量冲销）。 */
export interface ReportRevokedPayload extends ReportCraftSnapshot {
  readonly reportId: string;
  readonly dispatchId: string;
  readonly kind: ReportKind;
  readonly reporter: string;
  readonly doneQty: number;
  readonly laborMinutes: number;
  readonly businessTime: string;
  /** 撤销来源态（reported：未入账无需冲销；verified：hours 须冲销）。 */
  readonly fromState: string;
  readonly revokeReason: string | null;
  readonly objectVersion: number;
  readonly actor: string;
}

// ---- 工厂（全部经 makeBusinessEvent 校验 + 深冻结） ----

interface DomainEventInput {
  readonly eventId: EventId;
  readonly tenant: TenantId;
  readonly occurredAt: string;
  readonly provenance: ReportEventProvenance;
}

export function makeReportSubmittedEvent(
  base: DomainEventInput,
  payload: ReportSubmittedPayload,
  reportId: string,
): BusinessEvent<ReportSubmittedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: REPORT_EVENT_TYPES.reportSubmitted,
    tenantId: base.tenant,
    aggregate: { id: reportId, type: WORK_REPORT_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeBatchSubmittedEvent(
  base: DomainEventInput,
  payload: BatchSubmittedPayload,
  batchAnchorId: string,
): BusinessEvent<BatchSubmittedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: REPORT_EVENT_TYPES.batchSubmitted,
    tenantId: base.tenant,
    aggregate: { id: batchAnchorId, type: REPORT_BATCH_AGGREGATE_TYPE, revision: 1 },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeReportCorrectedEvent(
  base: DomainEventInput,
  payload: ReportCorrectedPayload,
  correctedReportId: string,
): BusinessEvent<ReportCorrectedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: REPORT_EVENT_TYPES.reportCorrected,
    tenantId: base.tenant,
    aggregate: { id: correctedReportId, type: WORK_REPORT_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeReportVerifiedEvent(
  base: DomainEventInput,
  payload: ReportVerifiedPayload,
  reportId: string,
): BusinessEvent<ReportVerifiedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: REPORT_EVENT_TYPES.reportVerified,
    tenantId: base.tenant,
    aggregate: { id: reportId, type: WORK_REPORT_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

export function makeReportRevokedEvent(
  base: DomainEventInput,
  payload: ReportRevokedPayload,
  reportId: string,
): BusinessEvent<ReportRevokedPayload> {
  return makeBusinessEvent({
    eventId: base.eventId,
    eventType: REPORT_EVENT_TYPES.reportRevoked,
    tenantId: base.tenant,
    aggregate: { id: reportId, type: WORK_REPORT_AGGREGATE_TYPE, revision: payload.objectVersion },
    occurredAt: base.occurredAt,
    payload,
    provenance: base.provenance,
  });
}

/** 报工单详情视图的里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface ReportMachineMilestone {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly objectVersion: number;
}

export { provenanceOf };
