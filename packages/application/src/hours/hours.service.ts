/**
 * HoursService —— 工时账用例编排（M2-W6，08-hours.md v1.0）。零框架业务类
 * （不 import @nestjs/*）。账本域无状态机（ADR-0010）：verified 报工 →
 * append-only 入账；撤销 → 冲销条目（不改原行）；月度归集 → 可重算快照
 * （supersedes 版本链，重算幂等不漂移）。
 *
 * 写路径 = smes.command.v1 命令执行（结果三分）：
 *  - hours.ingest.v1：消费 reporting 订阅端口（ReportVerified/ReportRevoked），
 *    逐事件联动入账/冲销后确认消费位——"报工 verified 即时入账、撤销即时冲销
 *    （无人工干预）"的系统触发面；
 *  - hours.adjust-entry.v1：随报工修正/撤销的联动命令（verify/correct/revoke
 *    三动作；不开放手改单条目——载荷形状即报工快照，无自由编辑面）；
 *  - hours.rebuild-month.v1：月×工种汇总重算（幂等：同基础事实重算不追加新
 *    版本行、汇总值无漂移；变更才追加 supersedes 新行，版本留痕）。
 *
 * 幂等双层防线（口径统一：先解析校验后记账，同 reporting）：信封 operationId
 * 在载荷解析与业务校验全部通过后、首个持久写之前 claim（不变量 3）——被拒命
 * 令不占用 id，同 id 修正载荷可重发重新评估；每条联动条目再落确定性 sourceKey
 * （`report:<id>:c<r>` / `:r<r>`）+ 派生 operationId——同事件重放/批量中断重发
 * 均不重复入账。事件追加失败窗口返回 indeterminate(retrySafe=true)（重放安全，
 * 建立在 sourceKey 幂等上、与 claim 时机解耦；与 baseline 的 retrySafe=false
 * 取舍不同：本模块事实幂等键完整）。
 *
 * 读路径（合同 §3 查询面）：机加工时统计（产出×工时）、工时汇总（月×工种，
 * 下钻明细）、我的工时（本人已审核——条目只来自 verified，天然满足）、按工作令
 * 视图（供 costing/报表；额定对标列经 StandardTime 端口，缺省空）。
 *
 * 汇总对账口径：一切汇总从条目实时净额计算（commit 为正、reverse 为负）；
 * 月度快照仅是重算留痕的读法之一——对账要点"人×工种汇总 = verified 净额"由
 * 快照值与实时净额的一致性测试背书。
 */
import type {
  BusinessEvent,
  CommandOutcome,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
  UserId,
} from '@smes/business-core';
import { HoursConflictError, HoursInputError, HoursNotFoundError } from './hours-errors.js';
import {
  HOURS_EVENT_TYPES,
  makeLaborEntryEvent,
  makeLaborMonthRebuiltEvent,
  type HoursEventProvenance,
} from './hours-events.js';
import {
  parseHoursAdjustEntryPayload,
  parseHoursIngestPayload,
  parseHoursRebuildMonthPayload,
  type HoursCommandEnvelope,
} from './hours-input.js';
import {
  EMPTY_REPORT_EVENT_FEED,
  EMPTY_STANDARD_TIME,
  type ReportEventFeedPort,
  type ReportEventPayloadShape,
  type StandardTimePort,
} from './hours-ports.js';
import {
  HOURS_AUDIT_STATUS_VERIFIED,
  HOURS_MONTH_AUDIT_STATUS_REBUILT,
  REPORT_KINDS,
  REPORT_KIND_TO_TRADE,
  isReportKind,
  type HoursTrade,
} from './hours-config.js';
import type {
  HoursStores,
  LaborEntryDirection,
  LaborEntryRow,
  LaborLedgerMonthRow,
} from './hours-stores.js';

// ---- 结果形状 ----

/** 月度重算的单组（人×月×工种）回执。 */
export interface MonthRebuildGroupResult {
  readonly workerId: string;
  readonly trade: HoursTrade;
  readonly objectVersion: number;
  readonly totalHours: number;
  readonly outputQty: number;
  readonly entryCount: number;
  /** true = 本轮追加了新版本快照行；false = 幂等重算（值未变，未追加）。 */
  readonly changed: boolean;
}

export interface HoursCommitted extends CommittedOutcome {
  /** hours.ingest：新入账条目数（含冲销条目）。 */
  readonly ingested?: number;
  /** hours.ingest：幂等跳过数（sourceKey 已落账或无可冲销）。 */
  readonly skipped?: number;
  /** hours.ingest：确认消费的事件数。 */
  readonly acknowledged?: number;
  /** hours.rebuild-month 回执。 */
  readonly month?: string;
  readonly workerId?: string | null;
  readonly rowsWritten?: number;
  readonly groups?: readonly MonthRebuildGroupResult[];
  /** hours.adjust-entry：本轮追加的条目（冲销 + 重入）。 */
  readonly entries?: readonly LaborEntryRow[];
}

export type HoursCommandResult = HoursCommitted | RejectedOutcome | IndeterminateOutcome;

export interface HoursServiceOptions {
  /** 时钟注入（事件 occurredAt 与快照 rebuiltAt 取时点；测试确定性）。 */
  readonly now?: () => string;
}

/** 跨模块端口集（缺省 = 零接线 boot：空订阅 + 空对标）。 */
export interface HoursCrossModulePorts {
  readonly feed: ReportEventFeedPort;
  readonly standardTime: StandardTimePort;
}

// ---- 读视图 ----

/** 机加工时统计行（产出×工时，按工作令分组；null = 未关联工作令）。 */
export interface MachiningStatRow {
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly totalHours: number;
  readonly totalOutput: number;
}

/** 工时汇总行（月×人×工种实时净额；下钻走 monthDetail）。 */
export interface MonthSummaryRow {
  readonly workerId: string;
  readonly trade: HoursTrade;
  readonly totalHours: number;
  readonly outputQty: number;
  readonly entryCount: number;
}

/** 我的工时视图（本人已审核净额，按日）。 */
export interface MyHoursView {
  readonly workerId: string;
  readonly month: string | null;
  readonly days: readonly { readonly workDate: string; readonly totalHours: number }[];
  readonly totalHours: number;
}

/** 月度归集快照当前版视图（该 人×月×工种 的最新版本行；历史版本经 monthChain 回看）。 */
export type LaborLedgerMonthView = LaborLedgerMonthRow & {
  readonly status: 'current';
};

/** 工作令工时视图（供 costing / engine-reporting）。 */
export interface WorkOrderTradeLine {
  readonly trade: HoursTrade;
  readonly totalHours: number;
  readonly outputQty: number;
  readonly entryCount: number;
}

export interface WorkOrderProcessLine {
  readonly processCode: string | null;
  readonly trade: HoursTrade;
  readonly totalHours: number;
  /** 额定工时（baseline StandardTime 端口；null = 无可用标准——缺省口径）。 */
  readonly standardHours: number | null;
}

export interface WorkOrderHoursView {
  readonly workOrderId: string;
  readonly totalHours: number;
  readonly byTrade: readonly WorkOrderTradeLine[];
  readonly byProcess: readonly WorkOrderProcessLine[];
  readonly entryCount: number;
}

// ---- 纯聚合（净额口径唯一实现） ----

interface EntryAggregate {
  totalHours: number;
  outputQty: number;
  entryCount: number;
  firstWorkDate: string | null;
  lastWorkDate: string | null;
}

const EMPTY_AGGREGATE: EntryAggregate = {
  totalHours: 0,
  outputQty: 0,
  entryCount: 0,
  firstWorkDate: null,
  lastWorkDate: null,
};

function directionSign(direction: LaborEntryDirection): 1 | -1 {
  return direction === 'commit' ? 1 : -1;
}

/** 条目净额聚合（commit 为正、reverse 为负；对账口径的唯一实现）。 */
export function netAggregate(entries: readonly LaborEntryRow[]): EntryAggregate {
  let totalHours = 0;
  let outputQty = 0;
  let entryCount = 0;
  let firstWorkDate: string | null = null;
  let lastWorkDate: string | null = null;
  for (const entry of entries) {
    const sign = directionSign(entry.direction);
    totalHours += sign * entry.hours;
    outputQty += sign * (entry.outputQty ?? 0);
    entryCount += sign;
    if (firstWorkDate === null || entry.workDate < firstWorkDate) firstWorkDate = entry.workDate;
    if (lastWorkDate === null || entry.workDate > lastWorkDate) lastWorkDate = entry.workDate;
  }
  return { totalHours, outputQty, entryCount, firstWorkDate, lastWorkDate };
}

function sameAggregate(a: EntryAggregate, b: EntryAggregate): boolean {
  return (
    a.totalHours === b.totalHours &&
    a.outputQty === b.outputQty &&
    a.entryCount === b.entryCount &&
    a.firstWorkDate === b.firstWorkDate &&
    a.lastWorkDate === b.lastWorkDate
  );
}

/** 联动快照（feed 载荷与 adjust 载荷的公共形状）。 */
interface ReportSnapshot {
  readonly reportId: string;
  readonly kind: string;
  readonly worker: string;
  readonly workDate: string;
  readonly hours: number;
  readonly doneQty: number | null;
  readonly dispatchId: string | null;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly processCode: string | null;
  readonly reason: string | null;
}

function snapshotOfPayload(payload: ReportEventPayloadShape): ReportSnapshot {
  return {
    reportId: payload.reportId,
    kind: payload.kind,
    worker: payload.worker,
    workDate: payload.workDate,
    hours: payload.hours,
    doneQty: payload.doneQty,
    dispatchId: payload.dispatchId,
    workOrderId: payload.workOrderId,
    drawingNo: payload.drawingNo,
    processCode: payload.processCode,
    reason: payload.revokeReason,
  };
}

/** 联动条目的精确入账字段（入账方=事件快照映射；冲销方=账本内末轮 commit 实际值）。 */
interface LinkedEntryFields {
  readonly reportId: string;
  readonly workerId: string;
  readonly workDate: string;
  readonly trade: HoursTrade;
  readonly processCode: string | null;
  readonly hours: number;
  readonly outputQty: number | null;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly dispatchId: string | null;
  readonly reason: string | null;
}

// ---- 服务 ----

export class HoursService {
  private readonly now: () => string;

  constructor(
    private readonly stores: HoursStores,
    private readonly ports: HoursCrossModulePorts = { feed: EMPTY_REPORT_EVENT_FEED, standardTime: EMPTY_STANDARD_TIME },
    options: HoursServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: HoursCommandEnvelope): Promise<HoursCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'hours.ingest.v1':
          return await this.ingest(tenant, envelope);
        case 'hours.rebuild-month.v1':
          return await this.rebuildMonth(tenant, envelope);
        case 'hours.adjust-entry.v1':
          return await this.adjustEntry(tenant, envelope);
      }
    } catch (error) {
      if (error instanceof HoursConflictError) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（口径统一：先解析校验后记账）。调用点在各命令 handler 的
   * 载荷解析与业务校验全部通过、首个持久写之前——被拒命令不占用 operationId，
   * 同 id 修正重发可重新评估；已 committed 的同 id 重发在此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: HoursCommandEnvelope): Promise<HoursCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: HoursCommandEnvelope): HoursEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** 事件落账；失败 = 中断窗口（事实行已落、事件未落）→ indeterminate。重放安全（sourceKey 幂等）。 */
  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<HoursCommitted, keyof CommittedOutcome | 'events'>,
    newRevision: number,
    failureContext: string,
  ): Promise<HoursCommandResult> {
    try {
      for (const event of events) {
        await this.stores.events.append(event);
      }
      return { status: 'committed', newRevision, events, ...extra };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `${failureContext}（${error instanceof Error ? error.message : String(error)}）：retrySafe=true——事实幂等键完整，可安全重发新 operationId 重放`,
        retrySafe: true,
      };
    }
  }

  // ---- 联动入账 / 冲销（feed 消费与 adjust 命令共用内核） ----

  /** 该报工单当前 commit 轮次（已有 commit 数）。 */
  private async commitRoundsOf(tenant: TenantId, reportId: string): Promise<readonly LaborEntryRow[]> {
    const entries = await this.stores.entries.list(tenant, { sourceReportId: reportId });
    return entries.filter((entry) => entry.direction === 'commit');
  }

  /**
   * 追加一条联动条目（commit 或 reverse）。返回 null = 幂等跳过（sourceKey 已
   * 落账或派生 operationId 已claim）。sourceKey 确定性派生：
   * commit 第 r 轮 = `report:<id>:c<r>`；冲销第 r 轮 commit = `report:<id>:r<r>`。
   *
   * 冲销值纪律：reverse 条目的量纲一律取**账本内被冲销 commit 行的实际值**
   * （调用方由 entry 构造 fields）——事件载荷快照与账本不一致时以账本为准，
   * 净额恒等式（Σcommit − Σreverse = 末轮值）不被外部载荷破坏。
   */
  private async appendLinkedEntry(
    tenant: TenantId,
    fields: LinkedEntryFields,
    direction: LaborEntryDirection,
    reverses: string | null,
    round: number,
    actor: string,
    provenance: HoursEventProvenance,
  ): Promise<{ entry: LaborEntryRow; event: BusinessEvent } | null> {
    const sourceKey =
      direction === 'commit' ? `report:${fields.reportId}:c${round}` : `report:${fields.reportId}:r${round}`;
    const claimed = await this.stores.operations.claim(tenant, `hours-ledger-${sourceKey}`, provenance.commandKind);
    if (!claimed) return null; // 同 sourceKey 已联动过（重放）
    if ((await this.stores.entries.findBySourceKey(tenant, sourceKey)) !== null) return null;
    let entry: LaborEntryRow;
    try {
      entry = await this.stores.entries.insert({
        tenant,
        workerId: fields.workerId,
        workDate: fields.workDate,
        trade: fields.trade,
        processCode: fields.processCode,
        hours: fields.hours,
        outputQty: fields.outputQty,
        direction,
        sourceReportId: fields.reportId,
        reverses,
        workOrderId: fields.workOrderId,
        drawingNo: fields.drawingNo,
        dispatchId: fields.dispatchId,
        sourceKey,
        remark: fields.reason,
        occurredAt: this.now(),
        recordedBy: actor,
        auditStatus: HOURS_AUDIT_STATUS_VERIFIED,
        provenance,
        businessTime: fields.workDate,
      });
    } catch (error) {
      if (error instanceof HoursConflictError) return null; // 并发竞态下已落账
      throw error;
    }
    const event = makeLaborEntryEvent(
      tenant,
      entry,
      direction === 'commit' ? HOURS_EVENT_TYPES.laborEntryCommitted : HOURS_EVENT_TYPES.laborEntryReversed,
      provenance,
      this.now(),
    );
    return { entry, event };
  }

  /**
   * 快照 → 入账字段（类别经 REPORT_KIND_TO_TRADE 映射；verified/修正重入用）。
   * 词汇表门禁的末道防线：未知类别显式抛错（ingest 批前置校验与 adjust 载荷
   * 解析层各有一道门，三处同词表 REPORT_KINDS）——禁止静默归类（Wave-4 中危 #2）。
   */
  private commitFieldsOf(snapshot: ReportSnapshot): LinkedEntryFields {
    if (!isReportKind(snapshot.kind)) {
      throw new HoursInputError(
        `未知报工类别 '${snapshot.kind}'：须为 ${REPORT_KINDS.join('/')} 之一——拒绝入账，不静默归类`,
      );
    }
    return {
      reportId: snapshot.reportId,
      workerId: snapshot.worker,
      workDate: snapshot.workDate,
      trade: REPORT_KIND_TO_TRADE[snapshot.kind],
      processCode: snapshot.processCode,
      hours: snapshot.hours,
      outputQty: snapshot.doneQty,
      workOrderId: snapshot.workOrderId,
      drawingNo: snapshot.drawingNo,
      dispatchId: snapshot.dispatchId,
      reason: snapshot.reason,
    };
  }

  /** 账本内末轮 commit → 冲销字段（实际值；reason 取联动载荷）。 */
  private reverseFieldsOf(commit: LaborEntryRow, reason: string | null): LinkedEntryFields {
    return {
      reportId: commit.sourceReportId,
      workerId: commit.workerId,
      workDate: commit.workDate,
      trade: commit.trade,
      processCode: commit.processCode,
      hours: commit.hours,
      outputQty: commit.outputQty,
      workOrderId: commit.workOrderId,
      drawingNo: commit.drawingNo,
      dispatchId: commit.dispatchId,
      reason,
    };
  }

  /** verified 入账（幂等：已有任何 commit 轮 → 跳过）。 */
  private async applyVerified(
    tenant: TenantId,
    snapshot: ReportSnapshot,
    actor: string,
    provenance: HoursEventProvenance,
  ): Promise<{ entry: LaborEntryRow; event: BusinessEvent } | null> {
    const commits = await this.commitRoundsOf(tenant, snapshot.reportId);
    if (commits.length > 0) return null; // 已入账（含修正重入后的链）
    return this.appendLinkedEntry(tenant, this.commitFieldsOf(snapshot), 'commit', null, 1, actor, provenance);
  }

  /** 撤销冲销（幂等：无 commit 可冲或末轮已冲 → 跳过；冲销值取末轮 commit 实际值）。 */
  private async applyRevoked(
    tenant: TenantId,
    snapshot: ReportSnapshot,
    actor: string,
    provenance: HoursEventProvenance,
  ): Promise<{ entry: LaborEntryRow; event: BusinessEvent } | null> {
    const entries = await this.stores.entries.list(tenant, { sourceReportId: snapshot.reportId });
    const commits = entries.filter((entry) => entry.direction === 'commit');
    if (commits.length === 0) return null;
    // 末轮 commit（按 sourceKey 轮次词法序 = c1 < c10 < c2 陷阱规避：按条目 seq）
    const last = commits.reduce((best, row) => (row.seq > best.seq ? row : best), commits[0]!);
    const lastRound = commits.length; // 链不变量：commit 轮连续 1..n，末轮 = 数量
    const alreadyReversed = entries.some(
      (entry) => entry.direction === 'reverse' && entry.sourceKey === `report:${snapshot.reportId}:r${lastRound}`,
    );
    if (alreadyReversed) return null;
    return this.appendLinkedEntry(
      tenant,
      this.reverseFieldsOf(last, snapshot.reason),
      'reverse',
      last.id,
      lastRound,
      actor,
      provenance,
    );
  }

  /** 修正联动：冲销旧值 + 按新值重入（新一轮 commit）。 */
  private async applyCorrected(
    tenant: TenantId,
    snapshot: ReportSnapshot,
    actor: string,
    provenance: HoursEventProvenance,
  ): Promise<{ appended: { entry: LaborEntryRow; event: BusinessEvent }[] }> {
    const appended: { entry: LaborEntryRow; event: BusinessEvent }[] = [];
    const commits = await this.commitRoundsOf(tenant, snapshot.reportId);
    if (commits.length > 0) {
      const last = commits.reduce((best, row) => (row.seq > best.seq ? row : best), commits[0]!);
      const reversal = await this.appendLinkedEntry(
        tenant,
        this.reverseFieldsOf(last, snapshot.reason),
        'reverse',
        last.id,
        commits.length,
        actor,
        provenance,
      );
      if (reversal !== null) appended.push(reversal);
    }
    const recommit = await this.appendLinkedEntry(
      tenant,
      this.commitFieldsOf(snapshot),
      'commit',
      null,
      commits.length + 1,
      actor,
      provenance,
    );
    if (recommit !== null) appended.push(recommit);
    return { appended };
  }

  // ---- hours.ingest.v1 ----

  private async ingest(tenant: TenantId, envelope: HoursCommandEnvelope): Promise<HoursCommandResult> {
    const parsed = parseHoursIngestPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `hours.ingest 的 expectedRevision 须为 'initial'（联动是执行事实，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    const limit = parsed.limit ?? 500;
    const pending = (await this.ports.feed.pending(tenant)).slice(0, limit);
    // 词汇表门禁（不静默归类，Wave-4 中危 #2）：verified 事件类别须在合法集内。
    // 发现未知类别整批 rejected 且零副作用（不入账、不确认消费位、不占用
    // operationId）；修好生产端后可同 operationId 重发（已处理消息经 sourceKey
    // 幂等跳过）。
    const offender = pending.find(
      (message) => message.signal === 'ReportVerified' && !isReportKind(message.payload.kind),
    );
    if (offender !== undefined) {
      return {
        status: 'rejected',
        reason: `未知报工类别 '${offender.payload.kind}'（事件 ${offender.eventId}，报工单 ${offender.payload.reportId}）：须为 ${REPORT_KINDS.join('/')} 之一——整批拒绝入账，不静默归类`,
      };
    }
    // 先解析校验后记账（口径统一）：整批校验（含词汇表门禁）全过、首条联动
    // 条目落账之前才 claim 信封 operationId。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    let ingested = 0;
    let skipped = 0;
    let acknowledged = 0;
    for (const message of pending) {
      const snapshot = snapshotOfPayload(message.payload);
      const applied =
        message.signal === 'ReportVerified'
          ? await this.applyVerified(tenant, snapshot, actor, provenance)
          : await this.applyRevoked(tenant, snapshot, actor, provenance);
      if (applied === null) {
        skipped += 1;
      } else {
        ingested += 1;
        events.push(applied.event);
      }
      await this.ports.feed.acknowledge(message.eventId);
      acknowledged += 1;
    }
    return this.commitOutcome(events, { ingested, skipped, acknowledged }, 1, '联动条目已落账但事件追加失败');
  }

  // ---- hours.adjust-entry.v1（联动命令面；不开放手改） ----

  private async adjustEntry(tenant: TenantId, envelope: HoursCommandEnvelope): Promise<HoursCommandResult> {
    const payload = parseHoursAdjustEntryPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `hours.adjust-entry 的 expectedRevision 须为 'initial'（联动是执行事实），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    // 先解析校验后记账（口径统一）：校验通过、首条联动条目落账之前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const snapshot: ReportSnapshot = {
      reportId: payload.reportId,
      kind: payload.kind,
      worker: payload.worker,
      workDate: payload.workDate,
      hours: payload.hours,
      doneQty: payload.doneQty,
      dispatchId: payload.dispatchId,
      workOrderId: payload.workOrderId,
      drawingNo: payload.drawingNo,
      processCode: payload.processCode,
      reason: payload.reason,
    };
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    let applied: { entry: LaborEntryRow; event: BusinessEvent }[];
    if (payload.action === 'verify') {
      const one = await this.applyVerified(tenant, snapshot, actor, provenance);
      applied = one === null ? [] : [one];
    } else if (payload.action === 'revoke') {
      const one = await this.applyRevoked(tenant, snapshot, actor, provenance);
      applied = one === null ? [] : [one];
    } else {
      applied = (await this.applyCorrected(tenant, snapshot, actor, provenance)).appended;
    }
    const events = applied.map((result) => result.event);
    return this.commitOutcome(events, { entries: applied.map((result) => result.entry) }, 1, '联动条目已落账但事件追加失败');
  }

  // ---- hours.rebuild-month.v1（幂等重算） ----

  private async rebuildMonth(tenant: TenantId, envelope: HoursCommandEnvelope): Promise<HoursCommandResult> {
    const parsed = parseHoursRebuildMonthPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `hours.rebuild-month 的 expectedRevision 须为 'initial'（重算是执行事实），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    // 先解析校验后记账（口径统一）：校验通过、首行快照落账之前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const entries = await this.stores.entries.list(tenant, {
      month: parsed.month,
      ...(parsed.workerId === undefined ? {} : { workerId: parsed.workerId }),
    });
    // 分组：人×工种 → 净额聚合
    const groups = new Map<string, LaborEntryRow[]>();
    for (const entry of entries) {
      const key = `${entry.workerId}|${entry.trade}`;
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [entry]);
      else bucket.push(entry);
    }
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    const results: MonthRebuildGroupResult[] = [];
    let rowsWritten = 0;
    for (const [key, groupEntries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [workerId, trade] = key.split('|') as [string, HoursTrade];
      const aggregate = netAggregate(groupEntries);
      const chain = await this.stores.months.chain(tenant, workerId, parsed.month, trade);
      const latest = chain.length > 0 ? chain[chain.length - 1]! : null;
      const latestAggregate: EntryAggregate | null =
        latest === null
          ? null
          : {
              totalHours: latest.totalHours,
              outputQty: latest.outputQty,
              entryCount: latest.entryCount,
              firstWorkDate: latest.firstWorkDate,
              lastWorkDate: latest.lastWorkDate,
            };
      const unchanged = latestAggregate !== null && sameAggregate(latestAggregate, aggregate);
      if (unchanged) {
        // 幂等重算：值未变不追加新版本行，仅留动作事件（changed=false）
        events.push(makeLaborMonthRebuiltEvent(tenant, latest!, false, provenance, this.now()));
        results.push({
          workerId,
          trade,
          objectVersion: latest!.objectVersion,
          totalHours: aggregate.totalHours,
          outputQty: aggregate.outputQty,
          entryCount: aggregate.entryCount,
          changed: false,
        });
        continue;
      }
      const nextVersion = latest === null ? 1 : latest.objectVersion + 1;
      const row = await this.stores.months.insert({
        tenant,
        workerId,
        month: parsed.month,
        trade,
        totalHours: aggregate.totalHours,
        outputQty: aggregate.outputQty,
        entryCount: aggregate.entryCount,
        firstWorkDate: aggregate.firstWorkDate,
        lastWorkDate: aggregate.lastWorkDate,
        rebuiltBy: actor,
        rebuiltAt: this.now(),
        objectVersion: nextVersion,
        supersedes: latest === null ? null : latest.id,
        auditStatus: HOURS_MONTH_AUDIT_STATUS_REBUILT,
        provenance,
        businessTime: `${parsed.month}-01`,
      });
      rowsWritten += 1;
      events.push(makeLaborMonthRebuiltEvent(tenant, row, true, provenance, this.now()));
      results.push({
        workerId,
        trade,
        objectVersion: row.objectVersion,
        totalHours: row.totalHours,
        outputQty: row.outputQty,
        entryCount: row.entryCount,
        changed: true,
      });
    }
    return this.commitOutcome(
      events,
      {
        month: parsed.month,
        workerId: parsed.workerId ?? null,
        rowsWritten,
        groups: results,
      },
      1,
      '月度快照行已落账但事件追加失败',
    );
  }

  // ---- 查询（读路径） ----

  /** 机加工时统计：机加工种净额，产出×工时按工作令分组。 */
  async machiningStats(
    tenant: TenantId,
    filter: { readonly workOrderId?: string; readonly from?: string; readonly to?: string } = {},
  ): Promise<readonly MachiningStatRow[]> {
    const entries = (await this.stores.entries.list(tenant, { trade: 'machining' })).filter((entry) => {
      if (filter.workOrderId !== undefined && entry.workOrderId !== filter.workOrderId) return false;
      if (filter.from !== undefined && entry.workDate < filter.from) return false;
      if (filter.to !== undefined && entry.workDate > filter.to) return false;
      return true;
    });
    const byWorkOrder = new Map<string, { workOrderId: string | null; drawingNo: string | null; totalHours: number; totalOutput: number }>();
    for (const entry of entries) {
      const key = entry.workOrderId ?? '(none)';
      const bucket = byWorkOrder.get(key) ?? {
        workOrderId: entry.workOrderId,
        drawingNo: entry.drawingNo,
        totalHours: 0,
        totalOutput: 0,
      };
      const sign = directionSign(entry.direction);
      bucket.totalHours += sign * entry.hours;
      bucket.totalOutput += sign * (entry.outputQty ?? 0);
      if (entry.drawingNo !== null) bucket.drawingNo = entry.drawingNo;
      byWorkOrder.set(key, bucket);
    }
    return [...byWorkOrder.values()].sort((a, b) => (a.workOrderId ?? '').localeCompare(b.workOrderId ?? ''));
  }

  /** 工时汇总（月×人×工种实时净额——对账口径）。 */
  async monthSummary(tenant: TenantId, month: string): Promise<readonly MonthSummaryRow[]> {
    const entries = await this.stores.entries.list(tenant, { month });
    const groups = new Map<string, LaborEntryRow[]>();
    for (const entry of entries) {
      const key = `${entry.workerId}|${entry.trade}`;
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [entry]);
      else bucket.push(entry);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, groupEntries]) => {
        const [workerId, trade] = key.split('|') as [string, HoursTrade];
        const aggregate = netAggregate(groupEntries);
        return {
          workerId,
          trade,
          totalHours: aggregate.totalHours,
          outputQty: aggregate.outputQty,
          entryCount: aggregate.entryCount,
        };
      });
  }

  /** 工时汇总下钻：该月条目明细（可选人/工种过滤）。 */
  async monthDetail(
    tenant: TenantId,
    month: string,
    workerId?: string,
    trade?: HoursTrade,
  ): Promise<readonly LaborEntryRow[]> {
    return this.stores.entries.list(tenant, {
      month,
      ...(workerId === undefined ? {} : { workerId }),
      ...(trade === undefined ? {} : { trade }),
    });
  }

  /** 我的工时（本人已审核净额；数据权限"本人"口径——workerId 只取调用方身份）。 */
  async myHours(tenant: TenantId, worker: UserId, month?: string): Promise<MyHoursView> {
    const entries = await this.stores.entries.list(tenant, {
      workerId: worker,
      ...(month === undefined ? {} : { month }),
    });
    const byDate = new Map<string, number>();
    for (const entry of entries) {
      const sign = directionSign(entry.direction);
      byDate.set(entry.workDate, (byDate.get(entry.workDate) ?? 0) + sign * entry.hours);
    }
    const days = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workDate, totalHours]) => ({ workDate, totalHours }));
    return {
      workerId: worker,
      month: month ?? null,
      days,
      totalHours: days.reduce((sum, day) => sum + day.totalHours, 0),
    };
  }

  /** 月度归集快照当前版视图（每 人×月×工种 取最新版本行）。 */
  async monthLedgers(tenant: TenantId, month: string, workerId?: string): Promise<readonly LaborLedgerMonthView[]> {
    const rows = await this.stores.months.listByMonth(tenant, month, workerId);
    const latest = new Map<string, LaborLedgerMonthRow>();
    for (const row of rows) {
      const key = `${row.workerId}|${row.trade}`;
      const current = latest.get(key);
      if (current === undefined || row.objectVersion > current.objectVersion) latest.set(key, row);
    }
    return [...latest.values()]
      .sort((a, b) => a.workerId.localeCompare(b.workerId) || a.trade.localeCompare(b.trade))
      .map((row) => ({ ...row, status: 'current' as const }));
  }

  /** 按工作令工时视图（供 costing / engine-reporting；额定对标经 StandardTime 端口）。 */
  async workOrderHours(tenant: TenantId, workOrderId: string): Promise<WorkOrderHoursView> {
    const entries = await this.stores.entries.list(tenant, { workOrderId });
    const tradeGroups = new Map<HoursTrade, LaborEntryRow[]>();
    const processGroups = new Map<string, LaborEntryRow[]>();
    for (const entry of entries) {
      const tradeBucket = tradeGroups.get(entry.trade) ?? [];
      tradeBucket.push(entry);
      tradeGroups.set(entry.trade, tradeBucket);
      const processKey = entry.processCode ?? '(none)';
      const processBucket = processGroups.get(processKey) ?? [];
      processBucket.push(entry);
      processGroups.set(processKey, processBucket);
    }
    // 额定对标（缺省空端口恒 null；按 图号×工序 去重取一次）
    const standardCache = new Map<string, number | null>();
    const byProcess: WorkOrderProcessLine[] = [];
    for (const [processKey, processEntries] of [...processGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const trade = processEntries[0]!.trade;
      const drawingNo = processEntries.find((entry) => entry.drawingNo !== null)?.drawingNo ?? null;
      const cacheKey = `${drawingNo ?? ''}|${processEntries[0]!.processCode ?? ''}`;
      let standardHours = standardCache.get(cacheKey);
      if (standardHours === undefined) {
        standardHours = await this.ports.standardTime.standardHours(tenant, {
          drawingNo,
          processCode: processEntries[0]!.processCode,
        });
        standardCache.set(cacheKey, standardHours);
      }
      const aggregate = netAggregate(processEntries);
      byProcess.push({
        processCode: processEntries[0]!.processCode,
        trade,
        totalHours: aggregate.totalHours,
        standardHours,
      });
    }
    const byTrade = [...tradeGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([trade, tradeEntries]) => {
        const aggregate = netAggregate(tradeEntries);
        return {
          trade,
          totalHours: aggregate.totalHours,
          outputQty: aggregate.outputQty,
          entryCount: aggregate.entryCount,
        };
      });
    const aggregate = netAggregate(entries);
    return {
      workOrderId,
      totalHours: aggregate.totalHours,
      byTrade,
      byProcess,
      entryCount: entries.length,
    };
  }

  /** 条目详情（下钻读法；来源报工单/派工单引用在行内）。 */
  async entry(tenant: TenantId, entryId: string): Promise<LaborEntryRow> {
    const row = await this.stores.entries.find(tenant, entryId);
    if (row === null) throw new HoursNotFoundError(`租户 '${tenant}' 内不存在工时条目 '${entryId}'`);
    return row;
  }

  /**
   * costing 工时源投影（被依赖面，08-hours.md §4）：该工作令全部条目的带符号
   * 工时行（commit 正 / reverse 负）。形状与 costing LaborCostSourcePort 的行
   * 结构化兼容（createHoursCostSource 适配器直取本方法）——不 import costing
   * 类型，端口两端各自定义、合流时结构校验。
   */
  async costingLines(
    tenant: TenantId,
    workOrderId: string,
  ): Promise<
    readonly {
      readonly laborEntryId: string;
      readonly workOrderId: string;
      readonly workerId: string;
      readonly trade: string;
      readonly hours: number;
      readonly workDate: string;
    }[]
  > {
    const entries = await this.stores.entries.list(tenant, { workOrderId });
    return entries.map((entry) => ({
      laborEntryId: entry.id,
      workOrderId: entry.workOrderId ?? workOrderId,
      workerId: entry.workerId,
      trade: entry.trade,
      hours: directionSign(entry.direction) * entry.hours,
      workDate: entry.workDate,
    }));
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }

  /** 月度快照版本链（历史版本回看——版本留痕口径）。 */
  async monthChain(
    tenant: TenantId,
    workerId: string,
    month: string,
    trade: HoursTrade,
  ): Promise<readonly LaborLedgerMonthRow[]> {
    return this.stores.months.chain(tenant, workerId, month, trade);
  }
}
