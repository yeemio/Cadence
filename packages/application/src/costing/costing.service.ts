/**
 * CostingService —— 项目成本账用例编排（M2-W6，09-costing.md v1.0）。零框架
 * 业务类。账本域无状态机（ADR-0010）：三类成本事实 append-only，口径版本化
 * （supersedes），快照可重算（幂等、版本留痕、口径变更不改历史快照）。
 *
 * 命令三件（合同 §3）：
 *  - costing.model.publish.v1：新口径版本（版本化主数据体例同 baseline——
 *    expectedRevision 'initial' 首发 v1 / N 修订 vN+1，乐观锁 + 并发竞态拒）；
 *  - costing.rebuild.v1：工作令×口径 一键重算——先从三类事实源端口采集并同步
 *    成本条目（幂等：来源 sourceKey 去重；来源重定价追加 delta 条目保净额），
 *    再经口径定义聚合三分类合计落快照（幂等：值未变不追加新版本行）；
 *  - costing.export.v1：快照导出（ExcelPort 端口化——json-tables 内建回声，
 *    ExcelJS 适配器留位；导出为读型命令，不落事实）。
 *
 * 幂等双层防线（口径统一：先解析校验后记账，同 reporting）：信封 operationId
 * 在载荷解析与业务校验全部通过后、首个持久写之前 claim（smes.command.v1 不变量
 * 3）——被拒命令不占用 id，同 id 修正重发可重新评估；每条成本条目再落确定性
 * sourceKey（mat:/lab:/out: 前缀）——同源重采不重复入账。
 * 事件追加失败窗口返回 indeterminate(retrySafe=true)（重放安全，取舍同 hours）。
 *
 * 聚合口径（R6 边界）：材料/外协 = 条目金额直加（金额是来源事实）；工时 =
 * 存量（带符号小时），金额化在口径层（工种时薪 × 净小时，按条目取整）——
 * 换口径版本 = 换时薪表 = 新快照，历史快照不动。
 */
import type {
  BusinessEvent,
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
} from '@smes/business-core';
import { CostingConflictError, CostingNotFoundError } from './costing-errors.js';
import {
  COSTING_EVENT_TYPES,
  makeCostEntryCommittedEvent,
  makeCostingModelPublishedEvent,
  makeCostSnapshotRebuiltEvent,
  type CostingEventProvenance,
} from './costing-events.js';
import {
  parseCostingModelPublishPayload,
  parseWorkOrderSelectorPayload,
  type CostingCommandEnvelope,
} from './costing-input.js';
import {
  DEFAULT_COSTING_MODEL_CODE,
  laborAmountMinor,
  parseCostingModelDefinition,
  type CostCategory,
  type CostSourceType,
  type CostTotals,
  type CostingModelDefinition,
} from './costing-model.js';
import {
  emptyCostingSourcePorts,
  outsourcingSourceRef,
  type CostingSourcePorts,
  type LaborCostLine,
  type MaterialCostLine,
  type OutsourcingCostLine,
} from './costing-ports.js';
import type { ExcelExport } from '../listing/excel-port.js';
import { JsonTablesCostingExcelPort, type CostingExcelPort } from './costing-excel-port.js';
import type {
  CostEntryRow,
  CostSnapshotRow,
  CostingModelRow,
  CostingStores,
} from './costing-stores.js';
import {
  currentVersion,
  effectiveStatus,
  sortByVersion,
  type EffectiveMasterStatus,
} from '../baseline/baseline-versioning.js';

// ---- 结果形状 ----

export interface CostingCommitted extends CommittedOutcome {
  /** costing.model.publish 回执。 */
  readonly model?: CostingModelView;
  /** costing.rebuild 回执。 */
  readonly workOrderId?: string;
  readonly modelCode?: string;
  readonly modelVersion?: number;
  /** 本轮追加的成本条目数（首记 + delta）。 */
  readonly entriesCommitted?: number;
  /** 幂等跳过的来源行数（净额已一致）。 */
  readonly entriesSkipped?: number;
  /** 快照版本（changed=false = 幂等重算，未追加新版本行）。 */
  readonly snapshotVersion?: number;
  readonly snapshotChanged?: boolean;
  readonly totals?: CostTotals;
  /** costing.export 回执（ExcelPort 产物）。 */
  readonly export?: ExcelExport;
}

export type CostingCommandResult = CostingCommitted | RejectedOutcome | IndeterminateOutcome;

export interface CostingServiceOptions {
  /** 时钟注入（事件 occurredAt / rebuiltAt 取时点；测试确定性）。 */
  readonly now?: () => string;
}

// ---- 读视图 ----

/** 口径版本视图（版本链 + 推导态；体例同 baseline 主数据视图）。 */
export interface CostingModelView {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
  readonly objectVersion: number;
  readonly status: EffectiveMasterStatus;
  readonly supersedes: string | null;
  readonly createdAt: string;
  readonly definition: unknown;
}

/** 成本快照视图（current = 该 工作令×口径 的最新快照版本；history = 前任）。 */
export type CostSnapshotView = CostSnapshotRow & { readonly status: 'current' | 'history' };

/** 口径版本对比视图。 */
export interface ModelComparison {
  readonly workOrderId: string;
  readonly modelCode: string;
  readonly versionA: number;
  readonly totalsA: CostTotals;
  readonly versionB: number;
  readonly totalsB: CostTotals;
  readonly deltaMinor: {
    readonly material: number;
    readonly labor: number;
    readonly outsourcing: number;
    readonly grand: number;
  };
}

// ---- 聚合纯函数（三分类合计的唯一实现） ----

/** 成本条目经口径定义聚合（对账口径：材料/外协金额直加、工时口径层换算）。 */
export function aggregateThroughModel(
  entries: readonly CostEntryRow[],
  definition: CostingModelDefinition,
): CostTotals {
  let materialMinor = 0;
  let outsourcingMinor = 0;
  let laborMinor = 0;
  const laborHoursByTrade: Record<string, number> = {};
  const entryCounts: Record<CostCategory, number> = { material: 0, labor: 0, outsourcing: 0 };
  for (const entry of entries) {
    entryCounts[entry.category] += 1;
    if (entry.category === 'material') {
      materialMinor += entry.amountMinor ?? 0;
    } else if (entry.category === 'outsourcing') {
      outsourcingMinor += entry.amountMinor ?? 0;
    } else {
      const hours = entry.quantity ?? 0;
      laborMinor += laborAmountMinor(definition, entry.trade, hours);
      const key = entry.trade ?? '(none)';
      laborHoursByTrade[key] = (laborHoursByTrade[key] ?? 0) + hours;
    }
  }
  return {
    materialMinor,
    laborMinor,
    outsourcingMinor,
    grandMinor: materialMinor + laborMinor + outsourcingMinor,
    laborHoursByTrade,
    entryCounts,
  };
}

/** 合计等值判定（幂等重算的"值未变"依据；工种键并集按 0 补齐比较）。 */
export function sameTotals(a: CostTotals, b: CostTotals): boolean {
  if (
    a.materialMinor !== b.materialMinor ||
    a.laborMinor !== b.laborMinor ||
    a.outsourcingMinor !== b.outsourcingMinor ||
    a.grandMinor !== b.grandMinor ||
    a.entryCounts.material !== b.entryCounts.material ||
    a.entryCounts.labor !== b.entryCounts.labor ||
    a.entryCounts.outsourcing !== b.entryCounts.outsourcing
  ) {
    return false;
  }
  const trades = new Set([...Object.keys(a.laborHoursByTrade), ...Object.keys(b.laborHoursByTrade)]);
  for (const trade of trades) {
    if ((a.laborHoursByTrade[trade] ?? 0) !== (b.laborHoursByTrade[trade] ?? 0)) return false;
  }
  return true;
}

/** 单来源事实的统一同步形状（三类源在服务内折到此形）。 */
interface SourceFactLine {
  readonly baseSourceKey: string;
  readonly sourceRefId: string;
  readonly amountMinor: number | null;
  readonly quantity: number | null;
  readonly trade: string | null;
  readonly workDate: string | null;
  readonly occurredAt: string;
}

// ---- 服务 ----

export class CostingService {
  private readonly now: () => string;

  constructor(
    private readonly stores: CostingStores,
    private readonly sources: CostingSourcePorts = emptyCostingSourcePorts(),
    private readonly excel: CostingExcelPort = new JsonTablesCostingExcelPort(),
    options: CostingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: CostingCommandEnvelope): Promise<CostingCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'costing.model.publish.v1':
          return await this.publishModel(tenant, envelope);
        case 'costing.rebuild.v1':
          return await this.rebuild(tenant, envelope);
        case 'costing.export.v1':
          return await this.exportSnapshot(tenant, envelope);
      }
    } catch (error) {
      if (error instanceof CostingConflictError) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（口径统一：先解析校验后记账）。调用点在各命令 handler 的
   * 载荷解析与业务校验全部通过、首个持久写（或导出效果）之前——被拒命令不
   * 占用 operationId，同 id 修正重发可重新评估；已 committed 的同 id 重发在
   * 此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: CostingCommandEnvelope): Promise<CostingCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: CostingCommandEnvelope): CostingEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** 事件逐条落账；失败 = 中断窗口 → indeterminate（重放安全）。 */
  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<CostingCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<CostingCommandResult> {
    try {
      for (const event of events) {
        await this.stores.events.append(event);
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

  // ---- costing.model.publish.v1 ----

  private async publishModel(tenant: TenantId, envelope: CostingCommandEnvelope): Promise<CostingCommandResult> {
    const payload = parseCostingModelPublishPayload(envelope.command.payload);
    const definition = parseCostingModelDefinition({
      hourlyRates: payload.hourlyRates,
    });
    const versions = await this.stores.models.versions(tenant, payload.code);
    const current = currentVersion(versions);
    if (envelope.expectedRevision === 'initial') {
      if (current !== null) {
        return {
          status: 'rejected',
          reason: `口径 '${payload.code}' 已存在（当前 v${current.objectVersion}），修订请声明 expectedRevision=${current.objectVersion}`,
        };
      }
    } else {
      if (current === null) {
        return {
          status: 'rejected',
          reason: `口径 '${payload.code}' 不存在，无版本可修订（首发请走 expectedRevision='initial'）`,
        };
      }
      if (envelope.expectedRevision !== current.objectVersion) {
        return {
          status: 'rejected',
          reason: `乐观锁冲突：口径 '${payload.code}' 声明 expectedRevision=${String(envelope.expectedRevision)}，当前 objectVersion=${current.objectVersion}（不重试同信封）`,
        };
      }
    }
    // 先解析校验后记账（口径统一）：定义/修订语义守门全过、版本行落账前 claim
    // ——被拒不占用 operationId，同 id 修正重发可重新评估。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const row = await this.stores.models.insert({
      tenant,
      code: payload.code,
      name: payload.name,
      definition,
      status: payload.status,
      objectVersion: current === null ? 1 : current.objectVersion + 1,
      supersedes: current === null ? null : current.id,
      auditStatus: 'published',
      provenance: this.provenanceOf(envelope),
      businessTime: envelope.issuedAt,
    });
    const event = makeCostingModelPublishedEvent(tenant, row, this.provenanceOf(envelope), this.now());
    const view = this.toModelView(row, versions.concat(row));
    return this.commitOutcome([event], { model: view }, '口径版本行已落账但事件追加失败');
  }

  // ---- 口径解析（rebuild/export/查询共用） ----

  private async resolveModel(
    tenant: TenantId,
    selector: { readonly modelCode?: string; readonly modelVersion?: number },
  ): Promise<{ readonly code: string; readonly version: number; readonly definition: CostingModelDefinition } | RejectedOutcome> {
    const code = selector.modelCode ?? DEFAULT_COSTING_MODEL_CODE;
    const versions = await this.stores.models.versions(tenant, code);
    if (versions.length === 0) {
      return {
        status: 'rejected',
        reason: `口径 '${code}' 未发布（costing.rebuild 前先执行 costing.model.publish）`,
      };
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

  // ---- 来源采集与成本条目同步（幂等 + delta） ----

  /** 同步一组来源事实：净额一致跳过；缺失首记；漂移追加 delta（保 append-only）。 */
  private async syncFacts(
    tenant: TenantId,
    workOrderId: string,
    category: CostCategory,
    sourceType: CostSourceType,
    facts: readonly SourceFactLine[],
    actor: string,
    provenance: CostingEventProvenance,
  ): Promise<{ appended: { entry: CostEntryRow; event: BusinessEvent }[]; skipped: number }> {
    const appended: { entry: CostEntryRow; event: BusinessEvent }[] = [];
    let skipped = 0;
    for (const fact of facts) {
      const existing = await this.stores.entries.listByBaseSourceKey(tenant, fact.baseSourceKey);
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
      const claimed = await this.stores.operations.claim(tenant, `costing-ledger-${sourceKey}`, provenance.commandKind);
      if (!claimed) {
        skipped += 1;
        continue; // 同 sourceKey 已联动（重放/并发竞态）
      }
      if ((await this.stores.entries.findBySourceKey(tenant, sourceKey)) !== null) {
        skipped += 1;
        continue;
      }
      let entry: CostEntryRow;
      try {
        entry = await this.stores.entries.insert({
          tenant,
          workOrderId,
          category,
          // delta 条目落**差额**（期望 − 已入净额）；首记落全量
          amountMinor: isDelta ? desiredAmount - netAmount : fact.amountMinor,
          quantity: isDelta ? desiredQty - netQty : fact.quantity,
          trade: fact.trade,
          sourceType,
          sourceRefId: fact.sourceRefId,
          sourceKey,
          deltaOf: isDelta ? fact.baseSourceKey : null,
          workDate: fact.workDate,
          remark: isDelta ? '来源事实变更，净额对齐 delta' : null,
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
      appended.push({
        entry,
        event: makeCostEntryCommittedEvent(tenant, entry, provenance, this.now()),
      });
    }
    return { appended, skipped };
  }

  // ---- costing.rebuild.v1 ----

  private async rebuild(tenant: TenantId, envelope: CostingCommandEnvelope): Promise<CostingCommandResult> {
    const payload = parseWorkOrderSelectorPayload(envelope.command.payload, 'costing.rebuild 载荷');
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `costing.rebuild 的 expectedRevision 须为 'initial'（重算是执行事实），收到 ${String(envelope.expectedRevision)}`,
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

    // 先解析校验后记账（口径统一）：口径解析 + 归集主体校验全过、首条成本条目
    // 落账前 claim——被拒不占用 operationId，主体补建后可同 id 重发。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const actor = String(envelope.issuedBy);
    const events: BusinessEvent[] = [];
    let entriesCommitted = 0;
    let entriesSkipped = 0;

    // 1) 材料金额（inventory 流水金额口径经端口）
    const materialLines: readonly MaterialCostLine[] = await this.sources.material.materialLines(tenant, payload.workOrderId);
    const materialSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      'material',
      'inventory-movement',
      materialLines.map((line) => ({
        baseSourceKey: `mat:${line.movementId}`,
        sourceRefId: line.movementId,
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        trade: null,
        workDate: line.occurredAt.slice(0, 10),
        occurredAt: line.occurredAt,
      })),
      actor,
      provenance,
    );
    entriesCommitted += materialSync.appended.length;
    entriesSkipped += materialSync.skipped;
    events.push(...materialSync.appended.map((result) => result.event));

    // 2) 工时量（hours 劳动条目；金额化在口径层）
    const laborLines: readonly LaborCostLine[] = await this.sources.labor.laborLines(tenant, payload.workOrderId);
    const laborSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      'labor',
      'labor-entry',
      laborLines.map((line) => ({
        baseSourceKey: `lab:${line.laborEntryId}`,
        sourceRefId: line.laborEntryId,
        amountMinor: null, // R6：存工时量，金额化在口径层
        quantity: line.hours,
        trade: line.trade,
        workDate: line.workDate,
        occurredAt: line.workDate,
      })),
      actor,
      provenance,
    );
    entriesCommitted += laborSync.appended.length;
    entriesSkipped += laborSync.skipped;
    events.push(...laborSync.appended.map((result) => result.event));

    // 3) 外协价格（dispatch OutsourcingPriced 口径）
    const outsourcingLines: readonly OutsourcingCostLine[] = await this.sources.outsourcing.outsourcingLines(tenant, payload.workOrderId);
    const outsourcingSync = await this.syncFacts(
      tenant,
      payload.workOrderId,
      'outsourcing',
      'outsourcing-line',
      outsourcingLines.map((line) => ({
        baseSourceKey: `out:${outsourcingSourceRef(line.dispatchId, line.lineNo)}`,
        sourceRefId: outsourcingSourceRef(line.dispatchId, line.lineNo),
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        trade: null,
        workDate: null,
        occurredAt: this.now(),
      })),
      actor,
      provenance,
    );
    entriesCommitted += outsourcingSync.appended.length;
    entriesSkipped += outsourcingSync.skipped;
    events.push(...outsourcingSync.appended.map((result) => result.event));

    // 4) 经口径聚合 → 快照（幂等：值未变不追加新版本行）
    const entries = await this.stores.entries.list(tenant, { workOrderId: payload.workOrderId });
    const totals = aggregateThroughModel(entries, model.definition);
    const chain = await this.stores.snapshots.chain(tenant, payload.workOrderId, model.code, model.version);
    const latest = chain.length > 0 ? chain[chain.length - 1]! : null;
    const snapshotChanged = latest === null || !sameTotals(latest.totals, totals);
    let snapshotRow: CostSnapshotRow;
    if (snapshotChanged) {
      snapshotRow = await this.stores.snapshots.insert({
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
    events.push(makeCostSnapshotRebuiltEvent(tenant, snapshotRow, snapshotChanged, provenance, this.now()));
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
      '成本条目/快照行已落账但事件追加失败',
    );
  }

  // ---- costing.export.v1 ----

  private async exportSnapshot(tenant: TenantId, envelope: CostingCommandEnvelope): Promise<CostingCommandResult> {
    const payload = parseWorkOrderSelectorPayload(envelope.command.payload, 'costing.export 载荷');
    const resolved = await this.resolveModel(tenant, payload);
    if ('status' in resolved && resolved.status === 'rejected') return resolved;
    const model = resolved as { code: string; version: number; definition: CostingModelDefinition };
    // 先解析校验后记账（口径统一）：口径解析守门全过、导出效果前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const entries = await this.stores.entries.list(tenant, { workOrderId: payload.workOrderId });
    const totals = aggregateThroughModel(entries, model.definition);
    const exportOutput = await this.excel.exportWorkbook([
      {
        name: '成本汇总',
        header: ['工作令', '口径', '口径版本', '材料成本(分)', '工时成本(分)', '外协成本(分)', '合计(分)', '工时量(小时)'],
        rows: [
          [
            payload.workOrderId,
            model.code,
            String(model.version),
            String(totals.materialMinor),
            String(totals.laborMinor),
            String(totals.outsourcingMinor),
            String(totals.grandMinor),
            String(Object.values(totals.laborHoursByTrade).reduce((sum, hours) => sum + hours, 0)),
          ],
        ],
      },
      {
        name: '成本明细',
        header: ['类别', '来源类型', '来源单据', '数量', '金额(分)', '工种', '业务日期', '备注'],
        rows: entries.map((entry) => [
          entry.category,
          entry.sourceType,
          entry.sourceRefId,
          entry.quantity === null ? '' : String(entry.quantity),
          entry.amountMinor === null ? '口径层换算' : String(entry.amountMinor),
          entry.trade ?? '',
          entry.workDate ?? '',
          entry.remark ?? '',
        ]),
      },
    ]);
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      workOrderId: payload.workOrderId,
      modelCode: model.code,
      modelVersion: model.version,
      totals,
      export: exportOutput,
    };
  }

  // ---- 查询（读路径） ----

  private toModelView(row: CostingModelRow, chain: readonly CostingModelRow[]): CostingModelView {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      objectVersion: row.objectVersion,
      status: effectiveStatus(row, chain),
      supersedes: row.supersedes,
      createdAt: row.createdAt,
      definition: row.definition,
    };
  }

  /** 口径版本列表（可选码过滤；当前版在前）。 */
  async modelVersions(tenant: TenantId, code?: string): Promise<readonly CostingModelView[]> {
    const rows = code === undefined ? await this.stores.models.listAll(tenant) : await this.stores.models.versions(tenant, code);
    const chain = await this.stores.models.listAll(tenant); // 推导态需全链（同码链即其子集）
    return rows
      .map((row) => this.toModelView(row, chain))
      .sort((a, b) => a.code.localeCompare(b.code) || b.objectVersion - a.objectVersion);
  }

  /** 口径版本详情（含历史版本链）。 */
  async modelDetail(tenant: TenantId, code: string): Promise<{ current: CostingModelView; versions: readonly CostingModelView[] }> {
    const chain = await this.stores.models.versions(tenant, code);
    const current = currentVersion(chain);
    if (current === null) throw new CostingNotFoundError(`租户 '${tenant}' 内不存在口径 '${code}'`);
    const views = sortByVersion(chain).map((row) => this.toModelView(row, chain));
    return { current: this.toModelView(current, chain), versions: views };
  }

  /** 工作令三分类汇总（实时净额，经口径换算；与快照对照构成对账口径）。 */
  async workOrderSummary(
    tenant: TenantId,
    workOrderId: string,
    selector: { readonly modelCode?: string; readonly modelVersion?: number } = {},
  ): Promise<{
    workOrderId: string;
    modelCode: string;
    modelVersion: number;
    totals: CostTotals;
  }> {
    const resolved = await this.resolveModel(tenant, selector);
    if ('status' in resolved && resolved.status === 'rejected') {
      throw new CostingNotFoundError(`租户 '${tenant}' 内口径不可用：${resolved.reason}`);
    }
    const model = resolved as { code: string; version: number; definition: CostingModelDefinition };
    const entries = await this.stores.entries.list(tenant, { workOrderId });
    return {
      workOrderId,
      modelCode: model.code,
      modelVersion: model.version,
      totals: aggregateThroughModel(entries, model.definition),
    };
  }

  /** 成本构成明细下钻（到来源单据：出库单/工时条目/外协明细行）。 */
  async costDetail(
    tenant: TenantId,
    workOrderId: string,
    category?: CostCategory,
  ): Promise<readonly CostEntryRow[]> {
    return this.stores.entries.list(tenant, {
      workOrderId,
      ...(category === undefined ? {} : { category }),
    });
  }

  /** 工作令快照列表（current/history 推导；口径变更不改历史快照——版本并存回看）。 */
  async snapshots(tenant: TenantId, workOrderId: string): Promise<readonly CostSnapshotView[]> {
    const rows = await this.stores.snapshots.listByWorkOrder(tenant, workOrderId);
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

  /** 快照版本链（同口径内重算留痕回看）。 */
  async snapshotChain(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    modelVersion: number,
  ): Promise<readonly CostSnapshotRow[]> {
    return this.stores.snapshots.chain(tenant, workOrderId, modelCode, modelVersion);
  }

  /** 口径版本对比：同码两版本各自实时聚合 + 差额（换口径复盘锚点）。 */
  async compareModels(
    tenant: TenantId,
    workOrderId: string,
    modelCode: string,
    versionA: number,
    versionB: number,
  ): Promise<ModelComparison> {
    const resolveA = await this.resolveModel(tenant, { modelCode, modelVersion: versionA });
    if ('status' in resolveA && resolveA.status === 'rejected') throw new CostingNotFoundError(resolveA.reason);
    const resolveB = await this.resolveModel(tenant, { modelCode, modelVersion: versionB });
    if ('status' in resolveB && resolveB.status === 'rejected') throw new CostingNotFoundError(resolveB.reason);
    const a = resolveA as { code: string; version: number; definition: CostingModelDefinition };
    const b = resolveB as { code: string; version: number; definition: CostingModelDefinition };
    const entries = await this.stores.entries.list(tenant, { workOrderId });
    const totalsA = aggregateThroughModel(entries, a.definition);
    const totalsB = aggregateThroughModel(entries, b.definition);
    return {
      workOrderId,
      modelCode,
      versionA: a.version,
      totalsA,
      versionB: b.version,
      totalsB,
      deltaMinor: {
        material: totalsB.materialMinor - totalsA.materialMinor,
        labor: totalsB.laborMinor - totalsA.laborMinor,
        outsourcing: totalsB.outsourcingMinor - totalsA.outsourcingMinor,
        grand: totalsB.grandMinor - totalsA.grandMinor,
      },
    };
  }

  /** 事件读（审计/调试口径）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }
}
