/**
 * hours 存储端口（M2-W6，08-hours.md v1.0 §2；体例同 baseline-stores /
 * inventory-stores：端口在本包定义业务形状，内存实现先行，PG adapter 由
 * business-store 按 `./hours` 子路径接入）。
 *
 * 表形态分工（账本域，ADR-0010：无状态机）：
 *  - labor_entries 是 **append-only 工时事实**：证据七公共列（TEXT 口径——id 为
 *    带前缀 uuidv7，同 stock_movements）+ seq 插入序；撤销/修正不改进原行——
 *    追加方向为 reverse 的冲销条目（reverses 指回原条目）；幂等锚点 =
 *    (tenant, source_key) 唯一（报工联动 sourceKey 确定性派生，重放不重复入账）；
 *  - labor_ledger_months 是 **可重算快照**：证据公共列 + supersedes 自引用链
 *    （口径变更/重算变更 → 新版本行取代前任，ADR-0010"快照可重算 supersedes"）；
 *    重算幂等 = 同基础事实重算两次不追加新版本行（服务层比对待写值）；
 *  - hours_operations 是 **幂等账本**（运营表，非业务事实）：smes.command.v1
 *    不变量 3 的持久化锚点，同 outbox 一类不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - entry.insert 在 (tenant, sourceKey) 唯一冲突时抛 HoursConflictError；
 *  - month.insert 在 (tenant, workerId, month, trade, objectVersion) 或
 *    (tenant, supersedes) 冲突时抛 HoursConflictError（快照链线性不变量）；
 *  - id 与 createdAt/seq 由**实现方生成**（PG=uuidv7/bigserial/库时钟，内存=
 *    唯一串/本地时钟/追加序），调用方不传；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId } from '@smes/business-core';
import type { HoursTrade } from './hours-config.js';

// ---- 工时账目（append-only 事实） ----

/** 条目方向：commit = verified 入账；reverse = 撤销冲销（负向参与汇总）。 */
export type LaborEntryDirection = 'commit' | 'reverse';

/** 工时账目行。 */
export interface LaborEntryRow {
  /** le-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial——同毫秒决胜）。 */
  readonly seq: number;
  /** 工时归属人（报工申报人）。 */
  readonly workerId: string;
  /** 业务日期 'YYYY-MM-DD'（工时归属日，来自报工单）。 */
  readonly workDate: string;
  /** 工种（报工类别经 REPORT_KIND_TO_TRADE 映射）。 */
  readonly trade: HoursTrade;
  /** 工序业务码（随报工单快照；可空）。 */
  readonly processCode: string | null;
  /** 工时（小时，恒正量纲；方向由 direction 推导）。 */
  readonly hours: number;
  /** 完工数量（恒正量纲；可空 = 无产出申报口径）。 */
  readonly outputQty: number | null;
  /** 方向（commit/reverse）。 */
  readonly direction: LaborEntryDirection;
  /** 来源报工单 id（跨模块 opaque）。 */
  readonly sourceReportId: string;
  /** 冲销指向的原条目 id（reverse 条目必填；commit 为 null）。 */
  readonly reverses: string | null;
  /** 工作令 id（事实链携带；可空 = 未关联）。 */
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  /** 来源派工单 id（可空）。 */
  readonly dispatchId: string | null;
  /**
   * 幂等锚点（确定性派生：`report:${reportId}:c${轮次}` / `:r${轮次}`）；
   * (tenant, sourceKey) 唯一。
   */
  readonly sourceKey: string;
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

/** 创建输入（无 id/seq/objectVersion 等实现方生成列）。 */
export type AppendLaborEntryInput = Omit<
  LaborEntryRow,
  'id' | 'seq' | 'objectVersion' | 'supersedes' | 'createdAt' | 'availableTime'
> & { readonly availableTime?: string };

/** 条目查询过滤（全字段 AND；月过滤按 workDate 前缀归属）。 */
export interface ListLaborEntriesFilter {
  readonly workerId?: string | undefined;
  /** 'YYYY-MM'（按 workDate 归属月过滤）。 */
  readonly month?: string | undefined;
  readonly trade?: HoursTrade | undefined;
  readonly workOrderId?: string | undefined;
  readonly sourceReportId?: string | undefined;
  readonly direction?: LaborEntryDirection | undefined;
}

export interface LaborEntryStore {
  /** append；sourceKey 冲突抛 HoursConflictError（实现方合同）。 */
  insert(input: AppendLaborEntryInput): Promise<LaborEntryRow>;
  find(tenant: TenantId, id: string): Promise<LaborEntryRow | null>;
  findBySourceKey(tenant: TenantId, sourceKey: string): Promise<LaborEntryRow | null>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, filter?: ListLaborEntriesFilter): Promise<readonly LaborEntryRow[]>;
}

// ---- 月度归集（可重算快照，supersedes 链） ----

/** 月度归集快照行（人×月×工种一版一行；重算变更 → 新版本行取代前任）。 */
export interface LaborLedgerMonthRow {
  /** hlm-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workerId: string;
  /** 'YYYY-MM'。 */
  readonly month: string;
  readonly trade: HoursTrade;
  /** 净工时（commit − reverse，小时）。 */
  readonly totalHours: number;
  /** 净产出（commit − reverse；null 口径沿条目）。 */
  readonly outputQty: number;
  /** 净条目数（commit 数 − reverse 数）。 */
  readonly entryCount: number;
  readonly firstWorkDate: string | null;
  readonly lastWorkDate: string | null;
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

export type AppendLaborLedgerMonthInput = Omit<LaborLedgerMonthRow, 'id' | 'createdAt'>;

export interface LaborLedgerMonthStore {
  /** append；(tenant, worker, month, trade, objectVersion) 或 (tenant, supersedes) 冲突抛 HoursConflictError。 */
  insert(input: AppendLaborLedgerMonthInput): Promise<LaborLedgerMonthRow>;
  /** 该 (worker, month, trade) 全部版本行（objectVersion 升序；服务层推导当前版）。 */
  chain(tenant: TenantId, workerId: string, month: string, trade: HoursTrade): Promise<readonly LaborLedgerMonthRow[]>;
  /** 该月全部行（可选单人过滤；objectVersion 升序——服务层按 (worker, trade) 分组取当前版）。 */
  listByMonth(tenant: TenantId, month: string, workerId?: string): Promise<readonly LaborLedgerMonthRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * hours 域事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方合同，
 * 映射既有通用 event_records / outbox_records——不建新表）；幂等锚点 = eventId
 * 自然主键（重复 append 抛 HoursConflictError）。内存实现仅保序保存。
 */
export interface HoursDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；审计/调试口径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 * 联动入账的派生 operationId（`hours-ledger-${sourceKey}`）同走本账本。
 */
export interface HoursOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（HoursService 构造入参形状）。 */
export interface HoursStores {
  readonly entries: LaborEntryStore;
  readonly months: LaborLedgerMonthStore;
  readonly events: HoursDomainEventStore;
  readonly operations: HoursOperationStore;
}
