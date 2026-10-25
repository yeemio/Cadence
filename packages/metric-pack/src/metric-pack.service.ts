/**
 * MetricPackService —— 口径包装载与求值用例编排（M3，m3-drafts/04-metric-pack.md
 * v1.0 §3/§6）。零框架业务类（不 import @nestjs/*；注册面/组合根接线归总控）。
 * 配置装载域无状态机（ADR-0010；G2 建单序不适用）：装载=append-only 事实，
 * 升级=新记录 supersedes 前任（历史包按自身定义快照只读可复算——"口径演进后
 * 历史版本报表可复算"合同 §9）。
 *
 * 命令两件（合同 §3，G1 口径：先解析校验后记账——被拒命令不占用 operationId）：
 *  - metric-pack.activate.v1：装载/升级口径包（packId@version；经 defineMetricPack
 *    逐条校验冻结后落装载记录；升级须包版本严格递增，旧版本只读可复算）；
 *  - metric-pack.export.v1：报表导出（求值即重算——更新数据重算口径＋导出，
 *    无缓存；导出端口化，读型命令不落事实不发事件）。
 *
 * 查询（读路径，不走信封）：
 *  - evaluate：口径求值（metricId+version 钉死定义 + 时间窗/维度切片/查询
 *    过滤；结果携口径溯源——引擎 MetricResult）；
 *  - activePacks / packVersions：装载包清单与版本（历史只读）。
 *
 * 可见性纪律（合同 §6 #3）：未装载则六张口径不可见——evaluate/export 对
 * 未装载的 metricId 抛 MetricPackNotFoundError（与"不存在"同形呈现）；标准
 * 4 张报表走 M2 基础层定义，不受本包装载状态影响。
 *
 * 正确性归属（合同 §4）：求值走引擎 evaluateMetric 纯函数——引擎对取回行
 * 重复施加全部谓词；数据源 read 只是取行接缝（下推优化非正确性依赖）。
 */
import type {
  CommittedOutcome,
  IndeterminateOutcome,
  RejectedOutcome,
  TenantId,
} from '@smes/business-core';
import {
  buildSourceRequest,
  defineMetricPack,
  evaluateMetric,
  findMetric,
  type MetricDefinition,
  type MetricPack,
  type MetricQuery,
  type MetricResult,
  type MetricSource,
} from '@smes/engine-reporting';
import { MetricPackNotFoundError, isMetricPackConflict } from './metric-pack-errors.js';
import {
  METRIC_PACK_EVENT_TYPES,
  makeMetricPackActivatedEvent,
  type MetricPackEventProvenance,
} from './metric-pack-events.js';
import {
  parseMetricPackActivatePayload,
  parseMetricPackExportPayload,
  type MetricPackCommandEnvelope,
} from './metric-pack-input.js';
import { EMPTY_METRIC_SOURCE_SET, routingMetricSource, type MetricSourceSet } from './metric-pack-source.js';
import type { BusinessEvent } from '@smes/business-core';
import type { MetricRef, MetricPackActivationRow, MetricPackStores } from './metric-pack-stores.js';
import {
  JsonTablesMetricPackExportPort,
  type MetricPackExportOutput,
  type MetricPackExportPort,
  type MetricPackExportSheet,
} from './metric-pack-export.js';

// ---- 结果形状 ----

/** 装载记录视图（版本链 + 推导态）。 */
export interface MetricPackActivationView {
  /** 装载记录行 id（mpa-<uuidv7>）。 */
  readonly id: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly title: string;
  /** 包内口径引用清单（metricId@version）。 */
  readonly metrics: readonly MetricRef[];
  readonly activatedBy: string;
  readonly activatedAt: string;
  /** current = 该 packId 当前激活版本；superseded = 历史版本（只读可复算）。 */
  readonly status: 'current' | 'superseded';
  readonly supersedes: string | null;
  readonly createdAt: string;
}

export interface MetricPackCommitted extends CommittedOutcome {
  /** metric-pack.activate 回执。 */
  readonly activation?: MetricPackActivationView;
  /** metric-pack.export 回执（导出端口产物）。 */
  readonly export?: MetricPackExportOutput;
}

export type MetricPackCommandResult = MetricPackCommitted | RejectedOutcome | IndeterminateOutcome;

export interface MetricPackServiceOptions {
  /** 时钟注入（事件 occurredAt 取时点；测试确定性）。 */
  readonly now?: () => string;
}

/** 定义定位结果（装载快照重新冻结 + 命中定义；溯源视图用）。 */
export interface ResolvedMetric {
  /** 命中装载记录（历史版本=当时的装载行——按其快照复算）。 */
  readonly activation: MetricPackActivationView;
  /** 重新校验冻结的包定义快照。 */
  readonly pack: MetricPack;
  readonly definition: MetricDefinition;
}

// ---- 服务 ----

export class MetricPackService {
  private readonly now: () => string;
  private readonly sources: MetricSource;

  constructor(
    private readonly stores: MetricPackStores,
    sourceSet: MetricSourceSet = EMPTY_METRIC_SOURCE_SET,
    private readonly exportPort: MetricPackExportPort = new JsonTablesMetricPackExportPort(),
    options: MetricPackServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sources = routingMetricSource(sourceSet);
  }

  // ---- 命令执行（写路径） ----

  async execute(tenant: TenantId, envelope: MetricPackCommandEnvelope): Promise<MetricPackCommandResult> {
    const kind = envelope.command.kind;
    try {
      switch (kind) {
        case 'metric-pack.activate.v1':
          return await this.activate(tenant, envelope);
        case 'metric-pack.export.v1':
          return await this.exportMetric(tenant, envelope);
      }
    } catch (error) {
      if (isMetricPackConflict(error)) {
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
    return { status: 'rejected', reason: `未知命令 kind '${kind}'` };
  }

  /**
   * 信封幂等 claim（G1：先解析校验后记账）。调用点在载荷解析与业务校验全部
   * 通过、首个持久写（或导出效果）之前——被拒命令不占用 operationId，同 id
   * 修正重发可重新评估；已 committed 的同 id 重发在此被拒（不变量 3）。
   */
  private async claimEnvelope(tenant: TenantId, envelope: MetricPackCommandEnvelope): Promise<MetricPackCommandResult | null> {
    const claimed = await this.stores.operations.claim(tenant, String(envelope.operationId), envelope.command.kind);
    if (claimed) return null;
    return {
      status: 'rejected',
      reason: `操作幂等冲突：operationId '${String(envelope.operationId)}' 已落账，不重试同信封（可改后重发新 operationId）`,
    };
  }

  private provenanceOf(envelope: MetricPackCommandEnvelope): MetricPackEventProvenance {
    return {
      operationId: String(envelope.operationId),
      issuedBy: String(envelope.issuedBy),
      commandKind: envelope.command.kind,
      contract: 'smes.command.v1',
    };
  }

  /** 事件逐条落账；失败 = 中断窗口 → indeterminate（重放安全：装载幂等键完整）。 */
  private async commitOutcome(
    events: readonly BusinessEvent[],
    extra: Omit<MetricPackCommitted, keyof CommittedOutcome | 'events'>,
    failureContext: string,
  ): Promise<MetricPackCommandResult> {
    try {
      for (const event of events) {
        await this.stores.events.append(event);
      }
      return { status: 'committed', newRevision: 1, events, ...extra };
    } catch (error) {
      return {
        status: 'indeterminate',
        reason: `${failureContext}（${error instanceof Error ? error.message : String(error)}）：retrySafe=true——装载幂等键完整，可安全重发新 operationId 重放`,
        retrySafe: true,
      };
    }
  }

  // ---- metric-pack.activate.v1（装载/升级口径包） ----

  private async activate(tenant: TenantId, envelope: MetricPackCommandEnvelope): Promise<MetricPackCommandResult> {
    const payload = parseMetricPackActivatePayload(envelope.command.payload);
    // 1) 逐条校验冻结（引擎 fail-fast；非法包 rejected——被拒不占用 operationId）。
    let pack: MetricPack;
    try {
      pack = defineMetricPack(payload.pack);
    } catch (error) {
      return {
        status: 'rejected',
        reason: `口径包定义非法（${error instanceof Error ? error.message : String(error)}）——逐条校验未通过，不装载`,
      };
    }
    if (envelope.expectedRevision !== 'initial') {
      return {
        status: 'rejected',
        reason: `metric-pack.activate 的 expectedRevision 须为 'initial'（装载是配置事实，版本语义在 packId@version 上，无目标版本可锁），收到 ${String(envelope.expectedRevision)}`,
      };
    }
    // 2) 装载版本规则：首装任意合法版本；升级须 packVersion 严格递增
    //    （历史版本只读可复算=读旧装载记录，不降级重激活）。
    const chain = await this.stores.activations.chain(tenant, pack.packId);
    const current = chain.length > 0 ? chain[chain.length - 1]! : null;
    if (current !== null && pack.version <= current.packVersion) {
      return {
        status: 'rejected',
        reason: `口径包 '${pack.packId}' 当前已装载 v${current.packVersion}，升级须包版本严格递增（收到 v${pack.version}；历史版本按装载记录只读可复算，不重复装载）`,
      };
    }
    // 3) G1：口径守门全过、装载记录落账前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const provenance = this.provenanceOf(envelope);
    const row = await this.stores.activations.insert({
      tenant,
      packId: pack.packId,
      packVersion: pack.version,
      title: pack.title,
      pack: pack as unknown as Readonly<Record<string, unknown>>,
      metricRefs: pack.metrics.map((metric) => ({ metricId: metric.metricId, version: metric.version })),
      activatedBy: String(envelope.issuedBy),
      activatedAt: this.now(),
      supersedes: current === null ? null : current.id,
      auditStatus: 'activated',
      provenance,
      businessTime: this.now(),
    });
    const event = makeMetricPackActivatedEvent(tenant, row, provenance, this.now());
    return this.commitOutcome([event], { activation: this.toView(row, true) }, '装载记录已落账但事件追加失败');
  }

  // ---- metric-pack.export.v1（报表导出：求值即重算 + 端口化导出） ----

  private async exportMetric(tenant: TenantId, envelope: MetricPackCommandEnvelope): Promise<MetricPackCommandResult> {
    const query = parseMetricPackExportPayload(envelope.command.payload);
    // 前置校验：口径须已装载（未装载不可见）；求值失败 = 口径/数据形状问题，拒绝。
    let resolved: ResolvedMetric;
    let result: MetricResult;
    try {
      resolved = await this.resolveMetric(tenant, query.metricId, query.version);
      result = await this.evaluateWith(tenant, resolved.definition, query);
    } catch (error) {
      return { status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.rows.length === 0) {
      return {
        status: 'rejected',
        reason: `口径 '${query.metricId}@v${query.version}' 在该查询窗内无数据行（先核对时间窗/切片/事实源装载，空导出拒绝——显式优于空回声）`,
      };
    }
    // G1：口径守门全过、导出效果前 claim。
    const claimed = await this.claimEnvelope(tenant, envelope);
    if (claimed !== null) return claimed;
    const output = await this.exportPort.exportWorkbook([this.toSheet(resolved, result)]);
    return {
      status: 'committed',
      newRevision: 1,
      events: [],
      export: output,
    };
  }

  // ---- 查询（读路径） ----

  /**
   * 口径求值：定位装载定义 → 组装源请求取行 → 引擎纯函数求值（口径溯源随
   * MetricResult.metric 返回）。未装载口径抛 MetricPackNotFoundError。
   */
  async evaluate(tenant: TenantId, query: MetricQuery): Promise<MetricResult> {
    const resolved = await this.resolveMetric(tenant, query.metricId, query.version);
    return this.evaluateWith(tenant, resolved.definition, query);
  }

  /** 定义定位 + 溯源视图（激活优先，历史装载记录次之——复算旧报表的锚点）。 */
  async resolveMetric(tenant: TenantId, metricId: string, version: number): Promise<ResolvedMetric> {
    const rows = await this.stores.activations.listAll(tenant);
    if (rows.length === 0) {
      throw new MetricPackNotFoundError(
        `租户 '${tenant}' 未装载任何口径包（报表中心六张口径报表不可见；装载走 metric-pack.activate）`,
      );
    }
    // 查找序取舍（写明）：每 packId 当前激活版本优先（packVersion 降序取首个），
    // 再历史装载记录（packVersion 降序——"历史版本报表可复算"走装载快照）；
    // 同 metricId@version 跨包并存时取先命中（同 id 同版本语义上同一口径）。
    const ordered = this.orderByLookup(rows);
    for (const row of ordered) {
      let pack: MetricPack;
      try {
        pack = defineMetricPack(row.pack);
      } catch {
        continue; // 装载快照损坏（理论不可达——装载时已校验冻结）：跳过该记录
      }
      const definition = findMetric(pack, metricId, version);
      if (definition !== undefined) {
        return { activation: this.toView(row, this.isCurrent(rows, row)), pack, definition };
      }
    }
    throw new MetricPackNotFoundError(
      `口径 '${metricId}@v${version}' 未装载（租户 '${tenant}' 装载的口径清单：${[
        ...new Set(ordered.flatMap((row) => row.metricRefs.map((ref) => `${ref.metricId}@v${ref.version}`))),
      ].join('/')}）`,
    );
  }

  /** 装载包清单（每 packId 当前激活版本视图；含包内口径清单）。 */
  async activePacks(tenant: TenantId): Promise<readonly MetricPackActivationView[]> {
    const rows = await this.stores.activations.listAll(tenant);
    return this.toViews(rows).filter((view) => view.status === 'current');
  }

  /** 装载版本链（可选 packId 过滤；packVersion 降序——当前版在前）。 */
  async packVersions(tenant: TenantId, packId?: string): Promise<readonly MetricPackActivationView[]> {
    const rows =
      packId === undefined
        ? await this.stores.activations.listAll(tenant)
        : await this.stores.activations.chain(tenant, packId);
    return [...this.toViews(rows)].sort(
      (a: MetricPackActivationView, b: MetricPackActivationView) =>
        b.packVersion - a.packVersion || a.packId.localeCompare(b.packId),
    );
  }

  /** 事件读（审计/调试口径，occurredAt 升序）。 */
  async listEvents(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    return this.stores.events.list(tenant);
  }

  // ---- 内部：定位序 / 视图组装 / 求值 / 导出表 ----

  /** 定义查找序：当前激活（packVersion 降序）在前，历史装载记录（降序）在后。 */
  private orderByLookup(rows: readonly MetricPackActivationRow[]): readonly MetricPackActivationRow[] {
    return [...rows].sort((a, b) => {
      const aCurrent = this.isCurrent(rows, a) ? 0 : 1;
      const bCurrent = this.isCurrent(rows, b) ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      return b.packVersion - a.packVersion || a.packId.localeCompare(b.packId);
    });
  }

  /** 该记录是否其 packId 的当前激活版（装载链末位）。 */
  private isCurrent(rows: readonly MetricPackActivationRow[], row: MetricPackActivationRow): boolean {
    let latest = row;
    for (const candidate of rows) {
      if (candidate.packId !== row.packId) continue;
      if (candidate.packVersion > latest.packVersion) latest = candidate;
    }
    return latest.id === row.id;
  }

  private toViews(rows: readonly MetricPackActivationRow[]): readonly MetricPackActivationView[] {
    return rows.map((row) => this.toView(row, this.isCurrent(rows, row)));
  }

  private toView(row: MetricPackActivationRow, isCurrent: boolean): MetricPackActivationView {
    return {
      id: row.id,
      packId: row.packId,
      packVersion: row.packVersion,
      title: row.title,
      metrics: row.metricRefs,
      activatedBy: row.activatedBy,
      activatedAt: row.activatedAt,
      status: isCurrent ? 'current' : 'superseded',
      supersedes: row.supersedes,
      createdAt: row.createdAt,
    };
  }

  /** 取行 + 引擎求值（行集与谓词的正确性归属引擎——本层零重复实现）。 */
  private async evaluateWith(
    _tenant: TenantId,
    definition: MetricDefinition,
    query: MetricQuery,
  ): Promise<MetricResult> {
    const request = buildSourceRequest(definition, query);
    const rows = await this.sources.read(request);
    return evaluateMetric(definition, query, rows);
  }

  /** 求值结果 → 导出表（表名携口径溯源；行 = 维度键 + 度量值）。 */
  private toSheet(resolved: ResolvedMetric, result: MetricResult): MetricPackExportSheet {
    const header = [...result.dimensionFields, ...result.measureIds];
    const rows = result.rows.map((row) => [
      ...result.dimensionFields.map((field) => {
        const value = row.key[field];
        return value === null || value === undefined ? '' : String(value);
      }),
      ...result.measureIds.map((measureId) => {
        const value = row.values[measureId];
        return value === null || value === undefined ? '' : String(value);
      }),
    ]);
    return {
      name: `${resolved.definition.display}（${resolved.definition.metricId}@v${resolved.definition.version}）`,
      header,
      rows,
    };
  }
}
