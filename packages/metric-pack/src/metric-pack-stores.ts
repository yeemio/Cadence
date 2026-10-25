/**
 * metric-pack 存储端口（M3，m3-drafts/04-metric-pack.md v1.0 §2；体例同
 * payroll-stores：端口在本包定义业务形状，内存实现先行，PG adapter 由
 * business-store 按 `./metric-pack` 子路径接入——因 pro-pack-tier-edges，PG 侧
 * 不 import 本包，用结构同形镜像类型实现同一接口，组合根注入时结构校验）。
 *
 * 表形态分工（配置装载域，ADR-0010：无状态机，G2 不适用）：
 *  - metric_pack_activations 是 **装载事实**（append-only）：租户×packId@version
 *    一行，(tenant, packId, packVersion) 与 (tenant, supersedes) 唯一；pack
 *    JSONB = 经 defineMetricPack 校验冻结的**完整包定义快照**（升级=新记录
 *    supersedes 前任，历史包按自身快照只读可复算——合同 §6 版本化纪律 1/3）；
 *  - metric_pack_operations 是 **幂等账本**（运营表，非业务事实）：smes.command.v1
 *    不变量 3 的持久化锚点，不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - activation.insert 在 (tenant, packId, packVersion) 或 (tenant, supersedes)
 *    冲突时抛 MetricPackConflictError（装载链线性不变量）；
 *  - id 与 createdAt 由**实现方生成**（PG=uuidv7/库时钟，内存=唯一串/本地时钟），
 *    调用方不传；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId } from '@smes/business-core';

// ---- 装载记录（MetricPackActivation，append-only 配置装载事实） ----

/** 包内口径引用（装载快照的清单位：metricId@version 钉死口径版本）。 */
export interface MetricRef {
  readonly metricId: string;
  readonly version: number;
}

/**
 * 装载记录行：租户×packId@version 的激活事实。
 * pack = 完整包定义快照（MetricPack 的可序列化形状——引擎冻结对象经 JSON 往返
 * 的纯数据；读回方按需 defineMetricPack(pack) 重新校验冻结，行本身不持有类实例）。
 */
export interface MetricPackActivationRow {
  /** mpa-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 包标识（kebab；售卖/装载按此寻址）。 */
  readonly packId: string;
  /** 包版本（整数 >= 1；升级 = 新记录 + packVersion 递增）。 */
  readonly packVersion: number;
  /** 包标题快照（随装载冻结）。 */
  readonly title: string;
  /** 完整包定义快照（schemaVersion/packId/version/title/description/metrics）。 */
  readonly pack: Readonly<Record<string, unknown>>;
  /** 包内口径引用清单（pack.metrics 的清单位投影；事件载荷与装载校验用）。 */
  readonly metricRefs: readonly MetricRef[];
  readonly activatedBy: string;
  readonly activatedAt: string;
  /** 本记录取代的前任装载记录 id（首装为 null；链线性不变量）。 */
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type AppendMetricPackActivationInput = Omit<MetricPackActivationRow, 'id' | 'createdAt'>;

export interface MetricPackActivationStore {
  /** insert；(tenant, packId, packVersion) / (tenant, supersedes) 冲突抛 MetricPackConflictError。 */
  insert(input: AppendMetricPackActivationInput): Promise<MetricPackActivationRow>;
  /** 该包的全部装载记录（packVersion 升序；服务层推导当前激活版）。 */
  chain(tenant: TenantId, packId: string): Promise<readonly MetricPackActivationRow[]>;
  /** 租户内全部装载记录（packId 升序 + packVersion 升序；跨包清单视图用）。 */
  listAll(tenant: TenantId): Promise<readonly MetricPackActivationRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * metric-pack 域事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方
 * 合同，映射既有通用 event_records / outbox_records——不建新表）；幂等锚点
 * = eventId 自然主键（重复 append 抛 MetricPackConflictError）。内存实现仅保序
 * 保存。
 */
export interface MetricPackDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；审计/调试口径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 */
export interface MetricPackOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（MetricPackService 构造入参形状）。 */
export interface MetricPackStores {
  readonly activations: MetricPackActivationStore;
  readonly events: MetricPackDomainEventStore;
  readonly operations: MetricPackOperationStore;
}
