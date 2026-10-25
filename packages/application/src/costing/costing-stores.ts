/**
 * costing 存储端口（M2-W6，09-costing.md v1.0 §2；体例同 baseline-stores /
 * hours-stores：端口在本包定义业务形状，内存实现先行，PG adapter 由
 * business-store 按 `./costing` 子路径接入）。
 *
 * 表形态分工（账本域，ADR-0010：无状态机）：
 *  - cost_entries 是 **append-only 成本事实**：证据七公共列（TEXT 口径）+ seq
 *    插入序；幂等锚点 = (tenant, source_key) 唯一（来源单据确定性派生）；
 *    来源重定价不改进原行——追加 delta 条目（deltaOf 指回基准 sourceKey），
 *    净额 = Σ 同基准条目；
 *  - costing_models 是 **版本化主数据**（口径版本）：(tenant, code, objectVersion)
 *    唯一 + supersedes 自引用修正链——与 baseline 版本化主数据同形态；口径变更
 *    不改历史快照（版本并存，合同 §7 Done-when）；
 *  - cost_snapshots 是 **可重算快照**：工作令×口径 的重算结果（supersedes 链；
 *    重算幂等 = 同基础事实重算两次不追加新版本行）；
 *  - costing_operations 是 **幂等账本**（运营表）。
 *
 * 端口合同（实现方保证）：
 *  - entry.insert 在 (tenant, sourceKey) 冲突时抛 CostingConflictError；
 *  - model.insert 在 (tenant, code, objectVersion) 或 (tenant, supersedes) 冲突时
 *    抛 CostingConflictError；
 *  - snapshot.insert 在 (tenant, workOrderId, modelCode, modelVersion,
 *    objectVersion) 或 (tenant, supersedes) 冲突时抛 CostingConflictError；
 *  - id/seq/createdAt 由实现方生成；全部读按租户收口。
 */
import type { BusinessEvent, TenantId } from '@smes/business-core';
import type { StoredMasterStatus, VersionedMasterFields } from '../baseline/baseline-versioning.js';
import type { CostCategory, CostSourceType, CostTotals } from './costing-model.js';

// ---- 成本条目（append-only 事实） ----

/** 成本条目行。 */
export interface CostEntryRow {
  /** ce-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial）。 */
  readonly seq: number;
  /** 归集工作令。 */
  readonly workOrderId: string;
  /** 三分类。 */
  readonly category: CostCategory;
  /**
   * 金额（分，带符号——delta 条目可负）。工时类条目恒 null：存工时量、金额化
   * 在口径层（R6 边界）。
   */
  readonly amountMinor: number | null;
  /** 数量（材料/外协 = 实物量；工时 = 小时；delta 可负）。 */
  readonly quantity: number | null;
  /** 工种（仅工时类条目；时薪表键）。 */
  readonly trade: string | null;
  /** 事实源类型。 */
  readonly sourceType: CostSourceType;
  /** 来源单据引用（inventory 流水 id / hours 劳动条目 id / dispatchId#lineNo）。 */
  readonly sourceRefId: string;
  /** 幂等锚点（确定性派生；delta = `${基准}#d${序}`）；(tenant, sourceKey) 唯一。 */
  readonly sourceKey: string;
  /** delta 条目指回的基准 sourceKey（非 delta 为 null）。 */
  readonly deltaOf: string | null;
  /** 业务日期（来源事实发生日；可空）。 */
  readonly workDate: string | null;
  readonly remark: string | null;
  readonly occurredAt: string;
  readonly recordedBy: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export type AppendCostEntryInput = Omit<
  CostEntryRow,
  'id' | 'seq' | 'objectVersion' | 'supersedes' | 'availableTime'
> & { readonly availableTime?: string };

export interface ListCostEntriesFilter {
  readonly workOrderId?: string | undefined;
  readonly category?: CostCategory | undefined;
  readonly sourceType?: CostSourceType | undefined;
}

export interface CostEntryStore {
  /** append；(tenant, sourceKey) 冲突抛 CostingConflictError。 */
  insert(input: AppendCostEntryInput): Promise<CostEntryRow>;
  find(tenant: TenantId, id: string): Promise<CostEntryRow | null>;
  findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostEntryRow | null>;
  /** 同基准（sourceKey = 基准 或 deltaOf = 基准）全部条目——净额计算口径。 */
  listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostEntryRow[]>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, filter?: ListCostEntriesFilter): Promise<readonly CostEntryRow[]>;
}

// ---- 口径版本（版本化主数据） ----

/** 口径版本行（定义段 JSONB；体例同 baseline 版本化主数据）。 */
export interface CostingModelRow extends VersionedMasterFields {
  /** 口径名（人读备注；可空）。 */
  readonly name: string | null;
  /** 声明式定义段（类别映射/时薪表/分摊规则）。 */
  readonly definition: unknown;
}

export type CreateCostingModelInput = Omit<CostingModelRow, 'id' | 'createdAt'>;

export interface CostingModelStore {
  /** insert；(tenant, code, objectVersion) / (tenant, supersedes) 冲突抛 CostingConflictError。 */
  insert(input: CreateCostingModelInput): Promise<CostingModelRow>;
  /** 该口径码全部版本行（objectVersion 升序）。 */
  versions(tenant: TenantId, code: string): Promise<readonly CostingModelRow[]>;
  /** 全部行（code 升序 + 版本升序）。 */
  listAll(tenant: TenantId): Promise<readonly CostingModelRow[]>;
}

/** 口径写入态别名（draft/active；superseded 推导——同 baseline-versioning）。 */
export type CostingModelStatus = StoredMasterStatus;

// ---- 成本快照（可重算） ----

/** 成本快照行（工作令×口径版本 的重算结果；重算变更 → 新版本行取代前任）。 */
export interface CostSnapshotRow {
  /** cs-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string;
  readonly modelCode: string;
  readonly modelVersion: number;
  /** 三分类合计 + 工时量基础（快照冻结值——口径变更不改历史快照）。 */
  readonly totals: CostTotals;
  readonly rebuiltBy: string;
  readonly rebuiltAt: string;
  /** 版本号（链上第 N 版；重算变更 +1，幂等重算不新增）。 */
  readonly objectVersion: number;
  /** 本行取代的前任行 id（v1 为 null）。 */
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type AppendCostSnapshotInput = Omit<CostSnapshotRow, 'id' | 'createdAt'>;

export interface CostSnapshotStore {
  /** insert；版本/链冲突抛 CostingConflictError。 */
  insert(input: AppendCostSnapshotInput): Promise<CostSnapshotRow>;
  /** 该 (工作令, 口径码, 口径版本) 全部快照版本行（objectVersion 升序）。 */
  chain(tenant: TenantId, workOrderId: string, modelCode: string, modelVersion: number): Promise<readonly CostSnapshotRow[]>;
  /** 该工作令全部快照行（跨口径版本；口径+版本+链序）。 */
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostSnapshotRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * costing 域事件端口：append = 事件行 + Outbox 行同事务落账（PG 侧映射既有
 * 通用 event_records / outbox_records）；幂等锚点 = eventId（重复 append 抛
 * CostingConflictError）。
 */
export interface CostingDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/** 命令幂等账本（smes.command.v1 不变量 3）。 */
export interface CostingOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（CostingService 构造入参形状）。 */
export interface CostingStores {
  readonly entries: CostEntryStore;
  readonly models: CostingModelStore;
  readonly snapshots: CostSnapshotStore;
  readonly events: CostingDomainEventStore;
  readonly operations: CostingOperationStore;
}
