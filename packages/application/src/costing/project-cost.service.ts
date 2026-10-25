/**
 * ProjectCostService —— U7 项目成本六块用例编排（A5，零框架业务类）。账本域无
 * 状态机（ADR-0010）：段事实 append-only（sourceKey 幂等 + deltaOf 冲销——来源
 * 事实漂移不改原行，追加差额保净额），六块快照可重算（supersedes 链 + 值未变
 * 不追加新版本行），录入价格为运营投影（upsert，写回发料明细经端口单向通知）。
 *
 * 命令两件：
 *  - costing.project.rebuild.v1：工作令×口径 六块重算（命令化跑批——文档 xxl-job
 *    每日 03:00 全量删写的 Cadence 重述：Cadence 沿 costing 既有 supersedes 体例
 *    以版本链取代先删后写，调度归部署期）；
 *  - costing.price.entry.v1：录入价格（非标利库 / 外购设备利库两 Tab 合一命令面；
 *    同 sourceLineId 单价联动 + 默认总金额按各行预占数量重算，amountManual 行
 *    保留手改不联动——文档 §2.1.5 保存逻辑）。
 *
 * 幂等双层防线（口径统一，同 CostingService）：信封 operationId 在载荷解析与业务
 * 校验全过后、首个持久写之前 claim（复用 costing_operations 表——同租户幂等面
 * 统一）；每条段事实再落确定性 sourceKey（pc: 前缀）——同源重采不重复入账。
 * 事件追加失败窗口返回 indeterminate(retrySafe=true)。
 *
 * sourceKey 词汇（段事实幂等锚点）：
 *   pc:isg:<recordId>:<taskLineId>:<segment>   issue 发料行段（reserved/purchase/raw）
 *   pc:eqp:<purchaseOrderId>:<lineNo>          外购设备采购行
 *   pc:aft:<claimId>                           售后报销单
 *   pc:out:<dispatchId>#<lineNo>               外协明细行
 *   pc:lab:<laborEntryId>                      工时条目（block 按 trade 分流）
 */
import type {
  BusinessEvent,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
} from '@smes/business-core';
import { CostingConflictError, CostingNotFoundError } from './costing-errors.js';
import type { CostingEventProvenance } from './costing-events.js';
import {
  currentVersion,
  sortByVersion,
} from '../baseline/baseline-versioning.js';
import {
  aggregateProjectCost,
  laborBlockOfTrade,
  sameProjectTotals,
  type ProjectCostBlock,
  type ProjectCostSegment,
  type ProjectCostTotals,
} from './project-cost-model.js';
import { DEFAULT_COSTING_MODEL_CODE, type CostingModelDefinition } from './costing-model.js';
import {
  makeCostPriceEntryRecordedEvent,
  makeCostProjectEntryCommittedEvent,
  makeCostProjectSnapshotRebuiltEvent,
} from './project-cost-events.js';
import {
  parsePriceEntryPayload,
  parseProjectRebuildPayload,
  type ProjectCostCommandEnvelope,
} from './project-cost-input.js';
import {
  emptyProjectCostSourcePorts,
  type IssuePriceWritebackEntry,
  type ProjectCostSourcePorts,
} from './project-cost-ports.js';
import {
  outsourcingSourceRef,
  type LaborCostLine,
  type OutsourcingCostLine,
} from './costing-ports.js';
import type {
  CostingDomainEventStore,
  CostingModelStore,
  CostingOperationStore,
} from './costing-stores.js';
import type {
  CostPriceEntryRow,
  CostProjectEntryRow,
  CostProjectSnapshotRow,
  ProjectCostStores,
} from './project-cost-stores.js';

/** 与既有 costing 共享的三存储（模块装配传同一实例：口径版本/事件/幂等账本）。 */
export interface ProjectCostSharedStores {
  readonly models: CostingModelStore;
  readonly events: CostingDomainEventStore;
  readonly operations: CostingOperationStore;
}

// ---- 结果形状 ----

export interface ProjectCostCommitted extends CommittedOutcome {
  /** costing.project.rebuild 回执。 */
  readonly workOrderId?: string;
  readonly modelCode?: string;
  readonly modelVersion?: number;
  readonly entriesCommitted?: number;
  readonly entriesSkipped?: number;
  readonly snapshotVersion?: number;
  readonly snapshotChanged?: boolean;
  readonly totals?: ProjectCostTotals;
  /** costing.price.entry 回执。 */
  readonly priceRows?: readonly CostPriceEntryRow[];
  readonly linkedSourceLineIds?: readonly string[];
}

export type ProjectCostCommandResult = ProjectCostCommitted | RejectedOutcome | IndeterminateOutcome;

export interface ProjectCostServiceOptions {
  /** 时钟注入（事件 occurredAt / rebuiltAt 取时点；测试确定性）。 */
  readonly now?: () => string;
  /** 写回端口失败钩子（缺省 console.warn——通知式合同，不回滚）。 */
  readonly onWritebackFailure?: (error: unknown) => void;
}

/** 六块 KPI 行（详情查询面；文档 KPI 7 项的 Cadence 面——保内/保外合一为售后成本）。 */
export interface ProjectKpiRow {
  readonly key: 'material' | 'outsourcing' | 'labor' | 'aftercare' | 'equipment' | 'grand';
  readonly label: string;
  readonly amountMinor: number;
}

/** 段事实统一同步形状（六源在服务内折到此形）。 */
interface ProjectFactLine {
  readonly block: ProjectCostBlock;
  readonly segment: ProjectCostSegment | null;
  readonly lineKind: 'part' | 'standard' | 'electrical' | 'equipment' | null;
  readonly baseSourceKey: string;
  readonly sourceRefId: string;
  readonly sourceType: CostProjectEntryRow['sourceType'];
  readonly amountMinor: number | null;
  readonly quantity: number | null;
  readonly trade: string | null;
  readonly supplierRef: string | null;
  readonly equipmentRef: string | null;
  readonly workDate: string | null;
  readonly occurredAt: string;
  readonly remark: string | null;
}

// ---- 服务 ----

export class ProjectCostService {
  private readonly now: () => string;

  constructor(
    private readonly stores: ProjectCostStores,
    private readonly shared: ProjectCostSharedStores,
    private readonly sources: ProjectCostSourcePorts = emptyProjectCostSourcePorts(),
    options: ProjectCostServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWritebackFailure = options.onWritebackFailure ?? ((error) => console.warn('[costing.price.writeback]', error));
  }

  private readonly onWritebackFailure: (error: unknown) => void;

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: ProjectCostCommandEnvelope): Promise<ProjectCostCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'costing.project.rebuild.v1':
          return await this.rebuild(tenant, envelope);
        case 'costing.price.entry.v1':
          return await this.recordPriceEntries(tenant, envelope);
      }
    } catch (error) {
      if (error instanceof CostingConflictError) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  private async claimEnvelope(tenant: TenantId, envelope: ProjectCostCommandEnvelope): Promise<ProjectCostCommandResult | null> {
    const claimed = await this.shared.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: ProjectCostCommandEnvelope): CostingEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<ProjectCostCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<ProjectCostCommandResult> {
    try {
      for (const event of events) {
        await this.shared.events.append(event);
      }
      return { status: 'committed', newRevision: 1, events, ...extra };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `${failureContext}（${error instanceof Error ? error.message : String(error)}）：retrySafe=true——事实幂等键完整，可安全重发新 operationId 重放`,
        retrySafe: true,
      };
    }
  }

  // ---- 口径解析（rebuild/查询共用；同 CostingService.resolveModel 语义） ----

  private async resolveModel(
    tenant: TenantId,
    selector: { readonly modelCode?: string; readonly modelVersion?: number },
  ): Promise<{ readonly code: string; readonly version: number; readonly definition: CostingModelDefinition } | RejectedOutcome> {
    const code = selector.modelCode ?? DEFAULT_COSTING_MODEL_CODE;
    const versions = await this.shared.models.versions(tenant, code);
    if (versions.length === 0) {
      return { status: 'rejected', reason: `口径 '${code}' 未发布（costing.project.rebuild 前先执行 costing.model.publish）` };
    }
    const current = currentVersion(versions)!;
    const version = selector.modelVersion ?? current.objectVersion;
    const row = versions.find((candidate) => candidate.objectVersion === version);
    if (row === undefined) {
      return {
        status: 'rejected',
        reason: `口径 '${code}' 不存在版本 ${version}（可用版本：${sortByVersion(versions).map((candidate) => candidate.objectVersion).join('/')}）`,
      };
    }
    return { code, version, definition: row.definition as CostingModelDefinition };
  }

  // ---- 段事实同步（幂等 + delta；体例同 CostingService.syncFacts） ----

  private async syncFacts(
    tenant: TenantId,
    workOrderId: string,
    facts: readonly ProjectFactLine[],
    actor: string,
    provenance: CostingEventProvenance,
  ): Promise<{ appended: { entry: CostProjectEntryRow; event: BusinessEvent }[]; skipped: number }> {
    const appended: { entry: CostProjectEntryRow; event: BusinessEvent }[] = [];
    let skipped = 0;
    for (const fact of facts) {
      const existing = await this.stores.projectEntries.listByBaseSourceKey(tenant, fact.baseSourceKey);
      const netAmount = existing.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0);
      const netQty = existing.reduce((sum, row) => sum + (row.quantity ?? 0), 0);
      const desiredAmount = fact.amountMinor ?? 0;
      const desiredQty = fact.quantity ?? 0;
      if (existing.length > 0 && netAmount === desiredAmount && netQty === desiredQty) {
        skipped += 1;
        continue;
      }
      const isDelta = existing.length > 0;
      const sourceKey = isDelta ? `${fact.baseSourceKey}#d${existing.length}` : fact.baseSourceKey;
      const claimed = await this.shared.operations.claim(tenant, `costing-project-${sourceKey}`, provenance.commandKind);
      if (!claimed) {
        skipped += 1;
        continue; // 同 sourceKey 已联动（重放/并发竞态）
      }
      if ((await this.stores.projectEntries.findBySourceKey(tenant, sourceKey)) !== null) {
        skipped += 1;
        continue;
      }
      let entry: CostProjectEntryRow;
      try {
        entry = await this.stores.projectEntries.insert({
          tenant,
          workOrderId,
          block: fact.block,
          segment: fact.segment,
          lineKind: fact.lineKind,
          amountMinor: isDelta ? desiredAmount - netAmount : fact.amountMinor,
          quantity: isDelta ? desiredQty - netQty : fact.quantity,
          trade: fact.trade,
          supplierRef: fact.supplierRef,
          equipmentRef: fact.equipmentRef,
          sourceType: fact.sourceType,
          sourceRefId: fact.sourceRefId,
          sourceKey,
          deltaOf: isDelta ? fact.baseSourceKey : null,
          workDate: fact.workDate,
          remark: isDelta ? '来源事实变更，净额对齐 delta' : fact.remark,
          occurredAt: this.now(),
          recordedBy: actor,
          auditStatus: 'committed',
          provenance,
          ...(fact.workDate === null ? {} : { businessTime: fact.workDate }),
        });
      } catch (error) {
        if (error instanceof CostingConflictError) {
          skipped += 1;
          continue; // 并发竞态下已落账
        }
        throw error;
      }
      appended.push({ entry, event: makeCostProjectEntryCommittedEvent(tenant, entry, provenance, this.now()) });
    }
    return { appended, skipped };
  }

  // ---- costing.project.rebuild.v1 ----

  private async rebuild(tenant: TenantId, envelope: ProjectCostCommandEnvelope): Promise<ProjectCostCommandResult> {
    const payload = parseProjectRebuildPayload(envelope.command.payload);
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `costing.project.rebuild 的 expectedRevision 须为 'initial'（重算是执行事实），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    const resolved = await this.resolveModel(tenant, payload);
    if ('status' in resolved && resolved.status === 'rejected') return resolved;
    const model = resolved as { code: string; version: number; definition: CostingModelDefinition };

    if (!(await this.sources.workOrder.exists(tenant, payload.workOrderId))) {
      return {
        status: 'rejected',
        reason: `工作令 '${payload.workOrderId}' 不存在（归集主体必须有效——workorder 主体端口校验）`,
      };
    }

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    let entriesCommitted = 0;
    let entriesSkipped = 0;

    // 1) issue 发料行段（②材料四类两段/原材料段 + ⑥设备利库段）
    const segments = await this.sources.issueSegments.issueSegments(tenant, payload.workOrderId);
    const priceEntries = await this.stores.priceEntries.listByWorkOrder(tenant, payload.workOrderId);
    const priceByAnchor = new Map(priceEntries.map((row) => [`${row.recordId}|${row.taskLineId}`, row]));
    const issueFacts: ProjectFactLine[] = [];
    for (const segment of segments) {
      const fact = this.issueSegmentFact(segment, priceByAnchor);
      if (fact !== null) issueFacts.push(fact);
    }
    const issueSync = await this.syncFacts(tenant, payload.workOrderId, issueFacts, actor, provenance);
    entriesCommitted += issueSync.appended.length;
    entriesSkipped += issueSync.skipped;
    events.push(...issueSync.appended.map((result) => result.event));

    // 2) 外购设备采购行（⑥采购段）
    const equipmentLines = await this.sources.equipmentPurchases.equipmentPurchases(tenant, payload.workOrderId);
    const equipmentSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      equipmentLines.map((line) => ({
        block: 'equipment' as const,
        segment: 'purchase-order' as const,
        lineKind: 'equipment' as const,
        baseSourceKey: `pc:eqp:${line.purchaseOrderId}:${line.lineNo}`,
        sourceRefId: `${line.purchaseOrderId}:${line.lineNo}`,
        sourceType: 'equipment-purchase' as const,
        amountMinor: line.amountMinor,
        quantity: line.receivedQty,
        trade: null,
        supplierRef: null,
        equipmentRef: line.equipmentRef,
        workDate: null,
        occurredAt: this.now(),
        remark: null,
      })),
      actor,
      provenance,
    );
    entriesCommitted += equipmentSync.appended.length;
    entriesSkipped += equipmentSync.skipped;
    events.push(...equipmentSync.appended.map((result) => result.event));

    // 3) 售后报销（⑤报销段）
    const claims = await this.sources.aftercareClaims.aftercareClaims(tenant, payload.workOrderId);
    const claimSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      claims.map((claim) => ({
        block: 'aftercare' as const,
        segment: 'reimburse' as const,
        lineKind: null,
        baseSourceKey: `pc:aft:${claim.claimId}`,
        sourceRefId: claim.claimId,
        sourceType: 'aftercare-claim' as const,
        amountMinor: claim.reimburseMinor,
        quantity: null,
        trade: null,
        supplierRef: null,
        equipmentRef: null,
        workDate: claim.filedAt.slice(0, 10),
        occurredAt: claim.filedAt,
        remark: null,
      })),
      actor,
      provenance,
    );
    entriesCommitted += claimSync.appended.length;
    entriesSkipped += claimSync.skipped;
    events.push(...claimSync.appended.map((result) => result.event));

    // 4) 外协明细（③）
    const outsourcingLines: readonly OutsourcingCostLine[] = await this.sources.outsourcing.outsourcingLines(tenant, payload.workOrderId);
    const outsourcingSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      outsourcingLines.map((line) => ({
        block: 'outsourcing' as const,
        segment: null,
        lineKind: null,
        baseSourceKey: `pc:out:${outsourcingSourceRef(line.dispatchId, line.lineNo)}`,
        sourceRefId: outsourcingSourceRef(line.dispatchId, line.lineNo),
        sourceType: 'outsourcing-line' as const,
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        trade: null,
        supplierRef: line.supplierRef,
        equipmentRef: null,
        workDate: null,
        occurredAt: this.now(),
        remark: null,
      })),
      actor,
      provenance,
    );
    entriesCommitted += outsourcingSync.appended.length;
    entriesSkipped += outsourcingSync.skipped;
    events.push(...outsourcingSync.appended.map((result) => result.event));

    // 5) 工时条目（④/⑤ 工时段；block 按工种分流，misc 不入六块只留痕）
    const laborLines: readonly LaborCostLine[] = await this.sources.labor.laborLines(tenant, payload.workOrderId);
    const laborFacts: ProjectFactLine[] = [];
    for (const line of laborLines) {
      const block = laborBlockOfTrade(line.trade);
      if (block === null) continue; // misc 零工不入六块账本（差异登记：文档无对应类别；工时留痕归 hours）
      laborFacts.push({
        block,
        segment: 'labor',
        lineKind: null,
        baseSourceKey: `pc:lab:${line.laborEntryId}`,
        sourceRefId: line.laborEntryId,
        sourceType: 'labor-entry',
        amountMinor: null, // 工时金额化在口径层（R6 边界）
        quantity: line.hours,
        trade: line.trade,
        supplierRef: null,
        equipmentRef: null,
        workDate: line.workDate,
        occurredAt: line.workDate,
        remark: null,
      });
    }
    const laborSync = await this.syncFacts(tenant, payload.workOrderId, laborFacts, actor, provenance);
    entriesCommitted += laborSync.appended.length;
    entriesSkipped += laborSync.skipped;
    events.push(...laborSync.appended.map((result) => result.event));

    // 6) 聚合 → 六块快照（幂等：值未变不追加新版本行）
    const entries = await this.stores.projectEntries.list(tenant, { workOrderId: payload.workOrderId });
    const totals = aggregateProjectCost(entries, model.definition);
    const chain = await this.stores.projectSnapshots.chain(tenant, payload.workOrderId, model.code, model.version);
    const latest = chain.length > 0 ? chain[chain.length - 1]! : null;
    const snapshotChanged = latest === null || !sameProjectTotals(latest.totals, totals);
    let snapshotRow: CostProjectSnapshotRow;
    if (snapshotChanged) {
      snapshotRow = await this.stores.projectSnapshots.insert({
        tenant,
        workOrderId: payload.workOrderId,
        modelCode: model.code,
        modelVersion: model.version,
        totals,
        rebuiltBy: actor,
        rebuiltAt: this.now(),
        objectVersion: latest === null ? 1 : latest.objectVersion + 1,
        supersedes: latest === null ? null : latest.id,
        auditStatus: 'rebuilt',
        provenance,
        businessTime: envelope.issuedAt,
      });
    } else {
      snapshotRow = latest!;
    }
    events.push(makeCostProjectSnapshotRebuiltEvent(tenant, snapshotRow, snapshotChanged, provenance, this.now()));
    return this.commitOutcome(
      events,
      {
        workOrderId: payload.workOrderId,
        modelCode: model.code,
        modelVersion: model.version,
        entriesCommitted,
        entriesSkipped,
        snapshotVersion: snapshotRow.objectVersion,
        snapshotChanged,
        totals,
      },
      '段事实/六块快照行已落账但事件追加失败',
    );
  }

  /** issue 段行 → 段事实（part/equipment 利库段金额改读录入价格表——覆盖端口缺省）。 */
  private issueSegmentFact(
    segment: import('./project-cost-ports.js').ProjectIssueSegmentLine,
    priceByAnchor: ReadonlyMap<string, CostPriceEntryRow>,
  ): ProjectFactLine | null {
    const sourceKey = `pc:isg:${segment.recordId}:${segment.taskLineId}:${segment.segment}`;
    const sourceRefId = `${segment.recordId}:${segment.taskLineId}:${segment.segment}`;
    const anchor = `${segment.recordId}|${segment.taskLineId}`;
    if (segment.kind === 'part') {
      if (segment.segment === 'raw') {
        return {
          block: 'material-raw',
          segment: 'raw',
          lineKind: 'part',
          baseSourceKey: sourceKey,
          sourceRefId,
          sourceType: 'issue-segment',
          amountMinor: segment.amountMinor ?? 0,
          quantity: segment.quantity,
          trade: null,
          supplierRef: null,
          equipmentRef: segment.equipmentRef,
          workDate: segment.issuedAt.slice(0, 10),
          occurredAt: segment.issuedAt,
          remark: segment.amountMinor === null ? '关联行无单价，该段不计（待补价）' : null,
        };
      }
      const usePriceTable = segment.segment === 'reserved';
      const priceEntry = priceByAnchor.get(anchor);
      // 利库段金额随数量符号定向（撤销清零行 quantity 0 → 金额 0，价格表不翻活）
      const amountMinor = usePriceTable
        ? Math.sign(segment.quantity) * (priceEntry?.totalMinor ?? 0)
        : segment.amountMinor ?? 0;
      return {
        block: 'material-part',
        segment: segment.segment === 'reserved' ? 'reserved' : 'purchase',
        lineKind: 'part',
        baseSourceKey: sourceKey,
        sourceRefId,
        sourceType: 'issue-segment',
        amountMinor,
        quantity: segment.quantity,
        trade: null,
        supplierRef: null,
        equipmentRef: segment.equipmentRef,
        workDate: segment.issuedAt.slice(0, 10),
        occurredAt: segment.issuedAt,
        remark: usePriceTable && priceEntry === undefined ? '利库段未录入价格，按 0 计（录入价格表）' : null,
      };
    }
    if (segment.kind === 'standard' || segment.kind === 'electrical') {
      return {
        block: segment.kind === 'standard' ? 'material-standard' : 'material-electrical',
        segment: segment.segment === 'reserved' ? 'reserved' : 'purchase',
        lineKind: segment.kind,
        baseSourceKey: sourceKey,
        sourceRefId,
        sourceType: 'issue-segment',
        amountMinor: segment.amountMinor ?? 0,
        quantity: segment.quantity,
        trade: null,
        supplierRef: null,
        equipmentRef: segment.equipmentRef,
        workDate: segment.issuedAt.slice(0, 10),
        occurredAt: segment.issuedAt,
        remark: segment.amountMinor === null ? '无 PO 单价，该段不计（待补价）' : null,
      };
    }
    if (segment.kind === 'equipment') {
      if (segment.segment !== 'reserved') return null; // 设备采购段归 PO 端口；raw 段不适用
      const priceEntry = priceByAnchor.get(anchor);
      return {
        block: 'equipment',
        segment: 'reserved',
        lineKind: 'equipment',
        baseSourceKey: sourceKey,
        sourceRefId,
        sourceType: 'issue-segment',
        amountMinor: Math.sign(segment.quantity) * (priceEntry?.totalMinor ?? 0), // 清零行定向 0
        quantity: segment.quantity,
        trade: null,
        supplierRef: null,
        equipmentRef: segment.equipmentRef,
        workDate: segment.issuedAt.slice(0, 10),
        occurredAt: segment.issuedAt,
        remark: priceEntry === undefined ? '利库段未录入价格，按 0 计（录入价格表）' : null,
      };
    }
    return null;
  }

  // ---- costing.price.entry.v1 ----

  private async recordPriceEntries(tenant: TenantId, envelope: ProjectCostCommandEnvelope): Promise<ProjectCostCommandResult> {
    const payload = parsePriceEntryPayload(envelope.command.payload);
    const segments = await this.sources.issueSegments.issueSegments(tenant, payload.workOrderId);

    // 行锚校验 + 事实回读（未撤销在册行；reserved 段数量 = 默认总金额基数）
    interface AnchorFact {
      readonly kind: 'part' | 'equipment';
      readonly sourceLineId: string | null;
      readonly reservedQty: number;
      readonly amountManualExisting: boolean;
    }
    const anchorFacts = new Map<string, AnchorFact>();
    for (const segment of segments) {
      if (segment.kind !== 'part' && segment.kind !== 'equipment') continue;
      if (segment.segment !== 'reserved') continue;
      if (segment.quantity <= 0) continue; // 清零行（撤销）不进录入范围
      anchorFacts.set(`${segment.recordId}|${segment.taskLineId}`, {
        kind: segment.kind,
        sourceLineId: segment.sourceLineId,
        reservedQty: segment.quantity,
        amountManualExisting: false,
      });
    }
    for (const row of payload.rows) {
      const anchor = `${row.recordId}|${row.taskLineId}`;
      const fact = anchorFacts.get(anchor);
      if (fact === undefined) {
        return {
          status: 'rejected',
          reason: `发料明细行 '${anchor}' 不在录入范围（须为本工作令未撤销发料的 非标件/外购设备 利库段行）`,
        };
      }
      if (row.amountManual && (row.totalMinor === undefined || row.totalMinor === null)) {
        return {
          status: 'rejected',
          reason: `行 '${anchor}' 声明 amountManual=true 但未提交 totalMinor（仅手改总金额须携带总金额）`,
        };
      }
      if (!row.amountManual && row.costUnitPriceMinor === undefined && row.totalMinor !== undefined && row.totalMinor !== null) {
        return {
          status: 'rejected',
          reason: `行 '${anchor}' 未提交单价却手改总金额——须声明 amountManual=true（或改走单价联动）`,
        };
      }
    }

    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);

    // 存量价格行（联动豁免判据：此前 amountManual=true 的行改单价不覆盖）
    const existingEntries = await this.stores.priceEntries.listByWorkOrder(tenant, payload.workOrderId);
    const existingByAnchor = new Map(existingEntries.map((row) => [`${row.recordId}|${row.taskLineId}`, row]));

    // 计算落账行集：提交行（单价/手改总金额）+ 同 sourceLineId 联动行
    interface PendingUpsert {
      readonly recordId: string;
      readonly taskLineId: string;
      readonly kind: 'part' | 'equipment';
      readonly sourceLineId: string | null;
      readonly reservedQty: number;
      readonly unitPriceMinor: number | null;
      readonly totalMinor: number | null;
      readonly amountManual: boolean;
    }
    const pendingByAnchor = new Map<string, PendingUpsert>();
    const linkedSourceLineIds = new Set<string>();

    for (const row of payload.rows) {
      const anchor = `${row.recordId}|${row.taskLineId}`;
      const fact = anchorFacts.get(anchor)!;
      if (row.amountManual) {
        // 仅手改总金额：不改单价、不联动（totalMinor 已在守门段校验非空）
        const manualTotal = row.totalMinor ?? 0;
        const existing = existingByAnchor.get(anchor);
        pendingByAnchor.set(anchor, {
          recordId: row.recordId,
          taskLineId: row.taskLineId,
          kind: fact.kind,
          sourceLineId: fact.sourceLineId,
          reservedQty: fact.reservedQty,
          unitPriceMinor: existing?.unitPriceMinor ?? null,
          totalMinor: manualTotal,
          amountManual: true,
        });
        continue;
      }
      // 提交单价（含清价 null）：默认总金额 = 预占数量 × 单价（单价空按 0——文档口径）
      const unitPriceMinor = row.costUnitPriceMinor ?? null;
      const defaultTotal = Math.round(fact.reservedQty * (unitPriceMinor ?? 0));
      pendingByAnchor.set(anchor, {
        recordId: row.recordId,
        taskLineId: row.taskLineId,
        kind: fact.kind,
        sourceLineId: fact.sourceLineId,
        reservedQty: fact.reservedQty,
        unitPriceMinor,
        totalMinor: row.totalMinor ?? defaultTotal,
        amountManual: false,
      });
      // 同零件/同设备联动：改单价 → 同 sourceLineId 全部有效行写同单价并按各自数量重算
      // （本批已手改总金额的行、以及存量 amountManual=true 的行除外——文档 §2.1.5）
      if (fact.sourceLineId !== null && row.costUnitPriceMinor !== undefined) {
        linkedSourceLineIds.add(fact.sourceLineId);
        for (const [otherAnchor, otherFact] of anchorFacts) {
          if (otherAnchor === anchor) continue;
          if (otherFact.sourceLineId !== fact.sourceLineId) continue;
          if (otherFact.kind !== fact.kind) continue;
          const pendingOther = pendingByAnchor.get(otherAnchor);
          const manualExempt =
            pendingOther?.amountManual === true || existingByAnchor.get(otherAnchor)?.amountManual === true;
          if (manualExempt) continue; // 手改总金额的行不联动
          pendingByAnchor.set(otherAnchor, {
            recordId: otherAnchor.split('|')[0]!,
            taskLineId: otherAnchor.split('|')[1]!,
            kind: otherFact.kind,
            sourceLineId: otherFact.sourceLineId,
            reservedQty: otherFact.reservedQty,
            unitPriceMinor,
            totalMinor: Math.round(otherFact.reservedQty * (unitPriceMinor ?? 0)),
            amountManual: false,
          });
        }
      }
    }

    const rows: CostPriceEntryRow[] = [];
    for (const pending of pendingByAnchor.values()) {
      rows.push(
        await this.stores.priceEntries.upsert({
          tenant,
          workOrderId: payload.workOrderId,
          recordId: pending.recordId,
          taskLineId: pending.taskLineId,
          kind: pending.kind,
          sourceLineId: pending.sourceLineId,
          reservedQty: pending.reservedQty,
          unitPriceMinor: pending.unitPriceMinor,
          totalMinor: pending.totalMinor,
          amountManual: pending.amountManual,
          recordedBy: actor,
        }),
      );
    }

    const event = makeCostPriceEntryRecordedEvent(
      tenant,
      rows,
      [...linkedSourceLineIds],
      provenance,
      this.now(),
    );
    const outcome = await this.commitOutcome([event], { priceRows: rows, linkedSourceLineIds: [...linkedSourceLineIds] }, '录入价格行已落账但事件追加失败');

    // 写回发料明细（单向通知式：失败不回滚、不翻结果——issue 侧接线归后续波）
    if (outcome.status === 'committed') {
      const writebackEntries: IssuePriceWritebackEntry[] = rows.map((row) => ({
        workOrderId: row.workOrderId,
        recordId: row.recordId,
        taskLineId: row.taskLineId,
        kind: row.kind,
        sourceLineId: row.sourceLineId,
        unitPriceMinor: row.unitPriceMinor,
        totalMinor: row.totalMinor,
      }));
      try {
        await this.sources.priceWriteback.writeback(tenant, writebackEntries);
      } catch (error) {
        this.onWritebackFailure(error);
      }
    }
    return outcome;
  }

  // ---- 查询（读路径） ----

  /** 实时六块汇总（本地段事实经口径换算；与快照对照构成对账口径）。 */
  async projectSummary(
    tenant: TenantId,
    workOrderId: string,
    selector: { readonly modelCode?: string; readonly modelVersion?: number } = {},
  ): Promise<{
    workOrderId: string;
    modelCode: string;
    modelVersion: number;
    totals: ProjectCostTotals;
    snapshot: CostProjectSnapshotRow | null;
  }> {
    const resolved = await this.resolveModel(tenant, selector);
    if ('status' in resolved && resolved.status === 'rejected') {
      throw new CostingNotFoundError(`租户 '${tenant}' 内口径不可用：${resolved.reason}`);
    }
    const model = resolved as { code: string; version: number; definition: CostingModelDefinition };
    const entries = await this.stores.projectEntries.list(tenant, { workOrderId });
    const chain = await this.stores.projectSnapshots.chain(tenant, workOrderId, model.code, model.version);
    return {
      workOrderId,
      modelCode: model.code,
      modelVersion: model.version,
      totals: aggregateProjectCost(entries, model.definition),
      snapshot: chain.length > 0 ? chain[chain.length - 1]! : null,
    };
  }

  /** 六块 KPI 行（文档 KPI 7 项的 Cadence 面：保内/保外合一为售后成本）。 */
  static kpiRowsOf(totals: ProjectCostTotals): readonly ProjectKpiRow[] {
    return [
      { key: 'material', label: '材料成本', amountMinor: totals.materialMinor },
      { key: 'outsourcing', label: '外协成本', amountMinor: totals.outsourcingMinor },
      { key: 'labor', label: '人工成本', amountMinor: totals.laborMinor },
      { key: 'aftercare', label: '售后成本', amountMinor: totals.aftercare.totalMinor },
      { key: 'equipment', label: '外购设备成本', amountMinor: totals.equipment.totalMinor },
      { key: 'grand', label: '成本合计', amountMinor: totals.grandMinor },
    ];
  }

  /** 详情查询面（快照冻结值——Web 列表/详情不直连源表，文档口径；无快照 404 语义）。 */
  async projectDetail(
    tenant: TenantId,
    workOrderId: string,
    selector: { readonly modelCode?: string; readonly modelVersion?: number } = {},
  ): Promise<{
    workOrderId: string;
    modelCode: string;
    modelVersion: number;
    snapshot: CostProjectSnapshotRow;
    kpi: readonly ProjectKpiRow[];
    totals: ProjectCostTotals;
  }> {
    const resolved = await this.resolveModel(tenant, selector);
    if ('status' in resolved && resolved.status === 'rejected') {
      throw new CostingNotFoundError(`租户 '${tenant}' 内口径不可用：${resolved.reason}`);
    }
    const model = resolved as { code: string; version: number; definition: CostingModelDefinition };
    const chain = await this.stores.projectSnapshots.chain(tenant, workOrderId, model.code, model.version);
    if (chain.length === 0) {
      throw new CostingNotFoundError(`工作令 '${workOrderId}' 无项目成本快照（先执行 costing.project.rebuild）`);
    }
    const snapshot = chain[chain.length - 1]!;
    return {
      workOrderId,
      modelCode: model.code,
      modelVersion: model.version,
      snapshot,
      kpi: ProjectCostService.kpiRowsOf(snapshot.totals),
      totals: snapshot.totals,
    };
  }

  /** 快照版本链（同口径内重算留痕回看；current/history 推导）。 */
  async projectSnapshots(
    tenant: TenantId,
    workOrderId: string,
  ): Promise<readonly (CostProjectSnapshotRow & { readonly status: 'current' | 'history' })[]> {
    const rows = await this.stores.projectSnapshots.listByWorkOrder(tenant, workOrderId);
    const latestByModel = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.modelCode}|${row.modelVersion}`;
      latestByModel.set(key, Math.max(latestByModel.get(key) ?? 0, row.objectVersion));
    }
    return rows.map((row) => ({
      ...row,
      status: row.objectVersion === latestByModel.get(`${row.modelCode}|${row.modelVersion}`) ? ('current' as const) : ('history' as const),
    }));
  }

  /** 段事实下钻（对账/导出口径）。 */
  async projectEntries(
    tenant: TenantId,
    workOrderId: string,
    filter: { readonly block?: ProjectCostBlock; readonly segment?: ProjectCostSegment } = {},
  ): Promise<readonly CostProjectEntryRow[]> {
    return this.stores.projectEntries.list(tenant, {
      workOrderId,
      ...(filter.block === undefined ? {} : { block: filter.block }),
      ...(filter.segment === undefined ? {} : { segment: filter.segment }),
    });
  }

  /** 录入价格读面（录入价格弹窗列表）。 */
  async priceEntries(tenant: TenantId, workOrderId: string): Promise<readonly CostPriceEntryRow[]> {
    return this.stores.priceEntries.listByWorkOrder(tenant, workOrderId);
  }
}
