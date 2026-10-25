/**
 * U7 项目成本存储端口（体例同 costing-stores：端口在本包定义业务形状，内存
 * 实现先行，PG adapter 由 business-store 按 `./costing` 子路径追加）。
 *
 * 表形态分工（沿 costing 既有 supersedes/幂等体例，合同 U7）：
 *  - cost_project_entries 是 **append-only 段事实**：证据七公共列 + seq 插入序；
 *    幂等锚点 = (tenant, source_key) 唯一；来源事实漂移（改价/改量/撤销重发）不
 *    改原行——追加 delta 条目（deltaOf 指回基准 sourceKey），净额 = Σ 同基准；
 *  - cost_project_snapshots 是 **可重算快照**：工作令×口径 的六块重算结果
 *    （supersedes 链；重算幂等 = 同基础事实重算两次不追加新版本行）；
 *  - cost_price_entries 是 **录入价格投影**（文档 §2.1.5 录入价格弹窗的 Cadence
 *    落点——运营表可 UPDATE：一行 = 一条发料明细行的录入价格，重录覆盖；不套
 *    证据公共列，取舍同 issue_records 投影）。
 */
import type { TenantId } from '@smes/business-core';
import type { ProjectCostBlock, ProjectCostSegment, ProjectCostTotals } from './project-cost-model.js';

// ---- 段事实（append-only） ----

/** 项目成本段事实行。 */
export interface CostProjectEntryRow {
  /** cpe-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial）。 */
  readonly seq: number;
  readonly workOrderId: string;
  /** 六块 block（材料四类各占一块）。 */
  readonly block: ProjectCostBlock;
  /** 段（reserved/purchase/raw/purchase-order/reimburse/labor；null = 块级整行）。 */
  readonly segment: ProjectCostSegment | null;
  /** issue 行类别（材料/设备块；其余 null）。 */
  readonly lineKind: 'part' | 'standard' | 'electrical' | 'equipment' | null;
  /** 金额（分，带符号——delta 可负）。labor 段恒 null（金额化在口径层）。 */
  readonly amountMinor: number | null;
  /** 数量（段数量 / 工时小时；delta 可负）。 */
  readonly quantity: number | null;
  /** 工种（工时段；时薪表键）。 */
  readonly trade: string | null;
  /** 供应商（③外协块聚合键；其余 null）。 */
  readonly supplierRef: string | null;
  /** 工作令设备维（②/⑥ 设备归属；整线 null）。 */
  readonly equipmentRef: string | null;
  /** 事实源类型。 */
  readonly sourceType: 'issue-segment' | 'equipment-purchase' | 'aftercare-claim' | 'outsourcing-line' | 'labor-entry';
  /** 来源单据引用（段锚 / PO 行 / 报销单 / dispatchId#lineNo / 劳动条目 id）。 */
  readonly sourceRefId: string;
  /** 幂等锚点（确定性派生，见 service 头注；delta = `${基准}#d${序}`）。 */
  readonly sourceKey: string;
  /** delta 条目指回的基准 sourceKey（非 delta 为 null）。 */
  readonly deltaOf: string | null;
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

export type AppendCostProjectEntryInput = Omit<
  CostProjectEntryRow,
  'id' | 'seq' | 'objectVersion' | 'supersedes' | 'availableTime'
> & { readonly availableTime?: string };

export interface ListCostProjectEntriesFilter {
  readonly workOrderId?: string | undefined;
  readonly block?: ProjectCostBlock | undefined;
  readonly segment?: ProjectCostSegment | undefined;
}

export interface CostProjectEntryStore {
  /** append；(tenant, sourceKey) 冲突抛 CostingConflictError。 */
  insert(input: AppendCostProjectEntryInput): Promise<CostProjectEntryRow>;
  find(tenant: TenantId, id: string): Promise<CostProjectEntryRow | null>;
  findBySourceKey(tenant: TenantId, sourceKey: string): Promise<CostProjectEntryRow | null>;
  /** 同基准（sourceKey = 基准 或 deltaOf = 基准）全部条目——净额计算口径。 */
  listByBaseSourceKey(tenant: TenantId, baseSourceKey: string): Promise<readonly CostProjectEntryRow[]>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, filter?: ListCostProjectEntriesFilter): Promise<readonly CostProjectEntryRow[]>;
}

// ---- 六块快照（可重算，supersedes 链） ----

/** 项目成本快照行（工作令×口径版本 的六块重算结果）。 */
export interface CostProjectSnapshotRow {
  /** cps-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string;
  readonly modelCode: string;
  readonly modelVersion: number;
  /** 六块合计 + 块明细（JSONB 冻结值——口径变更不改历史快照）。 */
  readonly totals: ProjectCostTotals;
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

export type AppendCostProjectSnapshotInput = Omit<CostProjectSnapshotRow, 'id' | 'createdAt'>;

export interface CostProjectSnapshotStore {
  /** insert；版本/链冲突抛 CostingConflictError。 */
  insert(input: AppendCostProjectSnapshotInput): Promise<CostProjectSnapshotRow>;
  /** 该 (工作令, 口径码, 口径版本) 全部快照版本行（objectVersion 升序）。 */
  chain(tenant: TenantId, workOrderId: string, modelCode: string, modelVersion: number): Promise<readonly CostProjectSnapshotRow[]>;
  /** 该工作令全部快照行（跨口径版本）。 */
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostProjectSnapshotRow[]>;
}

// ---- 录入价格（运营投影，可 UPDATE） ----

/**
 * 录入价格行（文档 §2.1.5 两 Tab 的 Cadence 合一锚点：一行 = 一条发料明细行；
 * kind ∈ {part=非标件利库, equipment=外购设备利库}）。Cadence 回执无成品/半成品
 * 分列 → 单价单列（文档 成品/半成品双单价的差异登记）；总金额可手改（amountManual
 * 联动豁免标记）。重录覆盖（upsert 语义），不改发料明细（写回经端口单向）。
 */
export interface CostPriceEntryRow {
  /** cpr-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string;
  /** 发料记录 id。 */
  readonly recordId: string;
  /** 任务明细行 id（行身份锚点）。 */
  readonly taskLineId: string;
  /** 录入 Tab 类别（part / equipment）。 */
  readonly kind: 'part' | 'equipment';
  /** 同零件联动键（来源清单行）。 */
  readonly sourceLineId: string | null;
  /** 利库段数量快照（重算默认总金额的数量基数；撤销后数量为 0 仍保留行）。 */
  readonly reservedQty: number;
  /** 成本单价（分；null = 未录入）。 */
  readonly unitPriceMinor: number | null;
  /** 总金额（分；null = 未录入；未手改时 = 预占数量 × 单价）。 */
  readonly totalMinor: number | null;
  /** 总金额手改标记（true = 改单价不覆盖总金额、不参与联动重算）。 */
  readonly amountManual: boolean;
  readonly recordedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type UpsertCostPriceEntryInput = Omit<CostPriceEntryRow, 'id' | 'createdAt' | 'updatedAt'>;

export interface CostPriceEntryStore {
  /** upsert：同 (tenant, workOrderId, recordId, taskLineId) 覆盖更新；返回落账行。 */
  upsert(input: UpsertCostPriceEntryInput): Promise<CostPriceEntryRow>;
  find(tenant: TenantId, workOrderId: string, recordId: string, taskLineId: string): Promise<CostPriceEntryRow | null>;
  /** 该工作令全部录入价格行（recordId/taskLineId 升序）。 */
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly CostPriceEntryRow[]>;
}

/** 服务层依赖的 U7 存储端口全集（ProjectCostService 构造入参形状）。 */
export interface ProjectCostStores {
  readonly projectEntries: CostProjectEntryStore;
  readonly projectSnapshots: CostProjectSnapshotStore;
  readonly priceEntries: CostPriceEntryStore;
}
