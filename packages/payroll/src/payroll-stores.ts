/**
 * payroll 存储端口（M3，m3-drafts/01-payroll.md v1.0 §2；体例同 hours-stores /
 * costing-stores：端口在本包定义业务形状，内存实现先行，PG adapter 由
 * business-store 按 `./payroll` 子路径接入——因 pro-pack-tier-edges，PG 侧
 * 不 import 本包，用结构同形镜像类型实现同一接口，组合根注入时结构校验）。
 *
 * 表形态分工（账本域，ADR-0010：无状态机，G2 不适用）：
 *  - payroll_rules 是 **版本化主数据**（计薪规则=数据）：(tenant, ruleId,
 *    objectVersion) 唯一 + supersedes 自引用修正链——与 costing_models 同
 *    形态；改价=发新版本，历史核算引用旧版本可复算（合同 §1/§3）；
 *  - pay_runs 是 **可重算快照**（人×月核算批次）：(tenant, periodKey,
 *    personId, objectVersion) 与 (tenant, supersedes) 唯一——supersedes 链
 *    线性不变量；重算幂等 = 同规则版本集合同事实重算不追加新版本行（对齐
 *    hours LaborLedgerMonth / costing CostSnapshot，合同 §2）；
 *  - earnings_records 是 **append-only 核算产出事实**：证据七公共列（TEXT
 *    口径）+ seq 插入序；(tenant, sourceKey) 唯一 = 核算行幂等锚点（按核算
 *    批次行确定性派生）；重算 = 逐条重写**新行**、不改原行（costing "delta
 *    条目永不改原行"先例，合同 §3）；现行口径 = 引用当前 PayRun 版本行的
 *    记录集；
 *  - payroll_operations 是 **幂等账本**（运营表，非业务事实）：smes.command.v1
 *    不变量 3 的持久化锚点，不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - rule.insert 在 (tenant, ruleId, objectVersion) 或 (tenant, supersedes)
 *    冲突时抛 PayrollConflictError（同形类按 name 识别，见 payroll-errors）；
 *  - run.insert 在 (tenant, periodKey, personId, objectVersion) 或
 *    (tenant, supersedes) 冲突时抛 PayrollConflictError（快照链线性不变量）；
 *  - record.insert 在 (tenant, sourceKey) 冲突时抛 PayrollConflictError；
 *  - id 与 createdAt/seq 由**实现方生成**（PG=uuidv7/bigserial/库时钟，内存=
 *    唯一串/本地时钟/追加序），调用方不传；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId, UserId } from '@smes/business-core';
import type { EarningsBasis, PayPeriodKind } from './ports.js';
import type { EarningsRecordId, PayRunId, PayrollRuleId } from './payroll-ids.js';
import type { LaborKind } from './payroll-config.js';

// ---- 计薪规则（版本化主数据） ----

/** 规则适用面（不声明 = 周期兜底规则；差异表 #1：新增 personId 按人维度）。 */
export interface PayrollRuleScope {
  /** 按人定价（86 主场景：人员时薪 = scope.personId 规则；匹配优先级最高）。 */
  readonly personId?: UserId;
  /** 工种兜底（值集五词；person 缺省时按工种匹配）。 */
  readonly laborKind?: LaborKind;
  /** 项目引用（工作令/项目 id 形状；引用键不依赖实现）。 */
  readonly projectId?: string;
}

/** 计薪规则版本行（ruleId 跨版本稳定；演进 = 新版本行 supersedes 前任）。 */
export interface PayrollRuleRow {
  /** prl-<uuidv7>（实现方生成；版本行的行 id）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 规则业务身份（kebab 码，跨版本稳定——版本化主数据的 code 位）。 */
  readonly ruleId: PayrollRuleId;
  /** 人读备注（可空）。 */
  readonly name: string | null;
  /** 计量基础（v1 只接 hours；output 发布面拒绝）。 */
  readonly basis: EarningsBasis;
  /** 时薪（分/小时，整数 > 0；量纲冻结 §2）。 */
  readonly rateMinor: number;
  /** 系数（乘数，缺省 1；夜班/加班倍率由规则版本承载）。 */
  readonly coefficient: number;
  /** 适用面（不声明 = 兜底规则）。 */
  readonly scope: PayrollRuleScope;
  /** 版本号（链上第 N 版；首发 1，演进 +1）。 */
  readonly objectVersion: number;
  /** 本行取代的前任行 id（v1 为 null）。 */
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type CreatePayrollRuleInput = Omit<PayrollRuleRow, 'id' | 'createdAt'>;

export interface PayrollRuleStore {
  /** insert；(tenant, ruleId, objectVersion) / (tenant, supersedes) 冲突抛 PayrollConflictError。 */
  insert(input: CreatePayrollRuleInput): Promise<PayrollRuleRow>;
  /** 该规则业务身份的全部版本行（objectVersion 升序）。 */
  versions(tenant: TenantId, ruleId: PayrollRuleId): Promise<readonly PayrollRuleRow[]>;
  /** 全部规则的全部版本行（ruleId 升序 + 版本升序）。 */
  listAll(tenant: TenantId): Promise<readonly PayrollRuleRow[]>;
}

// ---- 核算批次（人×月可重算快照，supersedes 链） ----

/** 本批次使用的规则版本集（人×月内命中的 规则@版本 清单——溯源与对账锚）。 */
export interface PayRunRuleRef {
  readonly ruleId: PayrollRuleId;
  readonly ruleVersion: number;
}

/** 核算批次快照行（人×周期 一版一行；重算变更 → 新版本行取代前任）。 */
export interface PayRunRow {
  /** pr-<uuidv7>（实现方生成）。 */
  readonly id: PayRunId;
  readonly tenant: TenantId;
  /** 核算归属人。 */
  readonly personId: UserId;
  /** 周期键 'YYYY-MM'（v1 锁 month）。 */
  readonly periodKey: string;
  readonly periodKind: PayPeriodKind;
  /** 本批次规则版本集（快照冻结值：按当时规则版本可复算）。 */
  readonly ruleVersions: readonly PayRunRuleRef[];
  /** 净工时合计（小时，不取整）。 */
  readonly totalQuantity: number;
  /** 金额合计（分，整数）。 */
  readonly totalAmountMinor: number;
  /** 薪酬记录行数。 */
  readonly lineCount: number;
  readonly computedBy: string;
  readonly computedAt: string;
  /** 版本号（链上第 N 版；重算变更 +1，幂等重算不新增）。 */
  readonly objectVersion: number;
  /** 本行取代的前任行 id（v1 为 null）。 */
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type AppendPayRunInput = Omit<PayRunRow, 'id' | 'createdAt'>;

export interface PayRunStore {
  /** insert；版本/链冲突抛 PayrollConflictError（快照链线性不变量）。 */
  insert(input: AppendPayRunInput): Promise<PayRunRow>;
  find(tenant: TenantId, id: PayRunId): Promise<PayRunRow | null>;
  /** 该 (periodKey, personId) 全部版本行（objectVersion 升序；服务层推导当前版）。 */
  chain(tenant: TenantId, periodKey: string, personId: UserId): Promise<readonly PayRunRow[]>;
  /** 该周期全部行（可选单人过滤；personId + objectVersion 升序）。 */
  listByPeriod(tenant: TenantId, periodKey: string, personId?: UserId): Promise<readonly PayRunRow[]>;
  /** 该人员全部周期行（我的工资跨周期读法；periodKey + objectVersion 升序）。 */
  listByPerson(tenant: TenantId, personId: UserId): Promise<readonly PayRunRow[]>;
}

// ---- 薪酬记录（append-only 核算产出事实） ----

/** 薪酬记录行：人×周期×规则版本×量×金额 + 来源下钻（append-only，不改原行）。 */
export interface EarningsRecordRow {
  /** ern-<uuidv7>（实现方生成）。 */
  readonly id: EarningsRecordId;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial——同毫秒决胜）。 */
  readonly seq: number;
  readonly personId: UserId;
  /** 周期键 'YYYY-MM'。 */
  readonly periodKey: string;
  /** 口径溯源：本记录按哪个规则版本核算。 */
  readonly ruleId: PayrollRuleId;
  readonly ruleVersion: number;
  readonly basis: EarningsBasis;
  /** 工种（五词；按 (人, 工种) 分组核算的分组键）。 */
  readonly laborKind: LaborKind;
  /** 量（小时，不取整——hours 存储口径）。 */
  readonly quantity: number;
  /** 核算时点时薪快照（分/小时——规则版本值随记录冻结，复算对账锚）。 */
  readonly rateMinor: number;
  /** 核算时点系数快照。 */
  readonly coefficient: number;
  /** 金额（分，整数 = quantity × rateMinor × coefficient half-up）。 */
  readonly amountMinor: number;
  /** 产出本行的核算批次行 id（重算版本 lineage：现行口径 = 当前批次行引用集）。 */
  readonly payRunId: PayRunId;
  /** 来源工时账目引用（下钻到 hours LaborEntry；对账锚点）。 */
  readonly sourceRefs: readonly string[];
  /**
   * 幂等锚点（确定性派生：`run:${payRunId}|${personId}|${laborKind}`）；
   * (tenant, sourceKey) 唯一——同批次重放不重复落行。
   */
  readonly sourceKey: string;
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

export type AppendEarningsRecordInput = Omit<
  EarningsRecordRow,
  'id' | 'seq' | 'objectVersion' | 'availableTime'
> & { readonly availableTime?: string };

/** 薪酬记录查询过滤（全字段 AND）。 */
export interface ListEarningsRecordsFilter {
  readonly periodKey?: string | undefined;
  readonly personId?: UserId | undefined;
  readonly payRunId?: PayRunId | undefined;
  readonly laborKind?: LaborKind | undefined;
  readonly ruleId?: PayrollRuleId | undefined;
}

export interface EarningsRecordStore {
  /** append；(tenant, sourceKey) 冲突抛 PayrollConflictError（实现方合同）。 */
  insert(input: AppendEarningsRecordInput): Promise<EarningsRecordRow>;
  find(tenant: TenantId, id: EarningsRecordId): Promise<EarningsRecordRow | null>;
  findBySourceKey(tenant: TenantId, sourceKey: string): Promise<EarningsRecordRow | null>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, filter?: ListEarningsRecordsFilter): Promise<readonly EarningsRecordRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * payroll 域事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方
 * 合同，映射既有通用 event_records / outbox_records——不建新表）；幂等锚点
 * = eventId 自然主键（重复 append 抛 PayrollConflictError）。内存实现仅保序
 * 保存。
 */
export interface PayrollDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；审计/调试口径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 */
export interface PayrollOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（PayrollService 构造入参形状）。 */
export interface PayrollStores {
  readonly rules: PayrollRuleStore;
  readonly runs: PayRunStore;
  readonly records: EarningsRecordStore;
  readonly events: PayrollDomainEventStore;
  readonly operations: PayrollOperationStore;
}
