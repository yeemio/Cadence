/**
 * maintenance 存储端口（M3，m3-drafts/02-maintenance.md v1.0 §2/§8 差异表 #2；
 * 体例同 payroll-stores：端口在本包定义业务形状，内存实现先行，PG adapter 由
 * business-store 按 `./maintenance` 子路径接入——因 pro-pack-tier-edges，PG 侧
 * 不 import 本包，用结构同形镜像类型实现同一接口，组合根注入时结构校验）。
 *
 * 表形态分工（三域同表各归其位，ADR-0010）：
 *  - maintenance_plans 是 **版本化主数据**（维保计划=数据）：(tenant, planId,
 *    objectVersion) 唯一 + supersedes 自引用修正链——与 payroll_rules 同形态；
 *    改计划 = 发新版本（合同 §3 plan.publish："演进=新版本；记录溯源旧版可解释"）；
 *  - maintenance_tasks 是 **状态机投影行**（scheduled → executing → done /
 *    cancelled，engine-flow 配置承载）：state + objectVersion 乐观版本，
 *    随 start/complete/cancel 迁移行级条件更新——与 inspections / fault_reports
 *    投影体例一致（非事实表，不套证据公共列）；(tenant, sourceKey) 唯一 =
 *    plan-due 任务到期锚点（due:<planId>:<occurrenceKey>，due-scan 幂等去重的
 *    DB 级防线；manual/fault 任务 sourceKey 为空不参与唯一约束）；
 *  - maintenance_activities 是 **append-only 三态记录事实**：证据七公共列（TEXT
 *    口径）+ seq 插入序；kind 判别三态（checkpoint/upkeep/repair，草案形状保持）；
 *    修正走冲销/补录不改原行（合同 §2）；planVersion 快照列 = 记录时点计划
 *    当前版本（计划改版后历史记录溯源旧版可解释的落点，合同 §7 对账）；
 *  - maintenance_operations 是 **幂等账本**（运营表，非业务事实）：smes.command.v1
 *    不变量 3 的持久化锚点，不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - plan.insert 在 (tenant, planId, objectVersion) 或 (tenant, supersedes)
 *    冲突时抛 MaintenanceConflictError（同形类按 name 识别，见 maintenance-errors）；
 *  - task.insert 在 (tenant, sourceKey) 冲突时抛 MaintenanceConflictError
 *    （仅 sourceKey 非空的 plan-due 任务；到期扫描将其解释为"已生成，跳过"）；
 *  - task.advance 按 (tenant, id, expectedObjectVersion) 条件更新——乐观锁失配
 *    返回 null（调用方拒绝并发竞态），不抛错；
 *  - activity.insert 恒为追加（无 UPDATE 面）；id/seq/createdAt 由**实现方生成**
 *    （id 前缀按 kind：ckr-/upr-/rpr-），调用方不传；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId, UserId } from '@smes/business-core';
import type { ResourceRef } from './ports.js';
import type {
  CheckpointRecordId,
  MaintenancePlanId,
  MaintenanceTaskId,
  RepairRecordId,
  UpkeepRecordId,
} from './maintenance-ids.js';
import type {
  MaintenanceCycle,
  MaintenanceTaskKind,
  MaintenanceTaskSource,
  MaintenanceTaskState,
} from './maintenance-config.js';

// ---- 点检项定义（计划内数据；判据是数据不是内核枚举，草案形状保持） ----

/** 点检项：名称 + 描述性判据（计划内唯一；判据由计划作者定义）。 */
export interface CheckpointDef {
  /** kebab-case，计划内唯一 */
  readonly checkpointId: string;
  readonly label: string;
  /** 合同判据描述（如范围/状态期望；§10：v1 人工判定 + expectation 文字描述）。 */
  readonly expectation?: string;
}

// ---- 维保计划（版本化主数据） ----

/** 维保计划版本行（planId 跨版本稳定；演进 = 新版本行 supersedes 前任）。 */
export interface MaintenancePlanRow {
  /** mpl-<uuidv7>（实现方生成；版本行的行 id）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 计划业务身份（kebab 码，跨版本稳定——版本化主数据的 code 位）。 */
  readonly planId: MaintenancePlanId;
  /** 人读备注（可空）。 */
  readonly name: string | null;
  readonly resourceRef: ResourceRef;
  readonly cycle: MaintenanceCycle;
  /** 点检项集（可空：纯保养计划）。 */
  readonly checkpoints: readonly CheckpointDef[];
  /** 保养动作清单（描述性字符串，由计划作者定义）。 */
  readonly upkeepActions: readonly string[];
  /** 版本号（链上第 N 版；首发 1，演进 +1）。 */
  readonly objectVersion: number;
  /** 本行取代的前任行 id（v1 为 null）。 */
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type CreateMaintenancePlanInput = Omit<MaintenancePlanRow, 'id' | 'createdAt'>;

export interface MaintenancePlanStore {
  /** insert；(tenant, planId, objectVersion) / (tenant, supersedes) 冲突抛 MaintenanceConflictError。 */
  insert(input: CreateMaintenancePlanInput): Promise<MaintenancePlanRow>;
  /** 该计划业务身份的全部版本行（objectVersion 升序）。 */
  versions(tenant: TenantId, planId: MaintenancePlanId): Promise<readonly MaintenancePlanRow[]>;
  /** 全部计划的全部版本行（planId 升序 + 版本升序；服务层推导当前版）。 */
  listAll(tenant: TenantId): Promise<readonly MaintenancePlanRow[]>;
}

// ---- 维保任务（状态机投影行） ----

/** 任务迁移补丁（advance 的目标态增量；G2：建单先落 scheduled@v1 再驱动迁移）。 */
export interface MaintenanceTaskAdvance {
  readonly state: MaintenanceTaskState | string;
  /** 目标 objectVersion（= 迁移前 + 1；advance 条件更新锚）。 */
  readonly objectVersion: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

/** 任务列表过滤（全字段 AND；"任务队列（我的/全部）"与 due-scan 去重读共用的面）。 */
export interface ListMaintenanceTasksFilter {
  readonly source?: MaintenanceTaskSource | undefined;
  readonly kind?: MaintenanceTaskKind | undefined;
  readonly state?: MaintenanceTaskState | string | undefined;
  readonly assignee?: UserId | undefined;
  readonly resourceRef?: ResourceRef | undefined;
  readonly planId?: MaintenancePlanId | undefined;
}

/** 维保任务执行单行（安排出来的执行单；source ∈ plan-due/fault/manual，合同 §2）。 */
export interface MaintenanceTaskRow {
  /** mtk-<uuidv7>（实现方生成）。 */
  readonly id: MaintenanceTaskId;
  readonly tenant: TenantId;
  /** 状态机配置标识（配置换代防线：与装配配置 flowId 不符即拒绝迁移）。 */
  readonly flowConfigId: string;
  readonly source: MaintenanceTaskSource;
  readonly kind: MaintenanceTaskKind;
  readonly resourceRef: ResourceRef;
  /** baseline 故障上报 id 形状引用（fault 联动任务必带；形状引用不依赖实现）。 */
  readonly faultRef?: string;
  /** 溯源计划（plan-due 必带；手工任务可带）。 */
  readonly planId?: MaintenancePlanId;
  /** 生成/建单时点计划版本（溯源旧版可解释，合同 §7）。 */
  readonly planVersion?: number;
  /** 到期 occurrence 键（plan-due 专属；dueKey 与 sourceKey 联合唯一去重）。 */
  readonly dueKey?: string;
  /** 到期时刻（ISO 8601；到期日历口径）。 */
  readonly dueAt?: string;
  readonly assignee?: UserId;
  /** 状态机状态（engine-flow 配置承载：scheduled/executing/done/cancelled）。 */
  readonly state: MaintenanceTaskState | string;
  readonly objectVersion: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  /**
   * 到期锚点（plan-due 任务：`due:<planId>:<occurrenceKey>`；(tenant, sourceKey)
   * 唯一 = due-scan 幂等去重 DB 防线；manual/fault 任务为空不参与唯一约束）。
   */
  readonly sourceKey?: string;
}

export type CreateMaintenanceTaskInput = Omit<MaintenanceTaskRow, 'id' | 'createdAt'>;

export interface MaintenanceTaskStore {
  /** insert；(tenant, sourceKey) 冲突（sourceKey 非空时）抛 MaintenanceConflictError。 */
  insert(input: CreateMaintenanceTaskInput): Promise<MaintenanceTaskRow>;
  find(tenant: TenantId, id: MaintenanceTaskId): Promise<MaintenanceTaskRow | null>;
  /** 条件更新（乐观锁）：expectedObjectVersion 失配或行不存在返回 null。 */
  advance(
    tenant: TenantId,
    id: MaintenanceTaskId,
    expectedObjectVersion: number,
    next: MaintenanceTaskAdvance,
  ): Promise<MaintenanceTaskRow | null>;
  /** 队列读（createdAt 升序 + id 升序；createdAt 缺省由实现方生成故恒有值）。 */
  list(tenant: TenantId, filter?: ListMaintenanceTasksFilter): Promise<readonly MaintenanceTaskRow[]>;
}

// ---- 三态记录（append-only 执行留痕事实；kind 判别，草案形状保持） ----

/** 三态记录公共列（证据公共列 TEXT 口径 + seq 游标；修正走冲销/补录不改原行）。 */
interface MaintenanceActivityCommon {
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial——同毫秒决胜）。 */
  readonly seq: number;
  readonly resourceRef: ResourceRef;
  /** 溯源计划（可空：临时点检不挂计划，草案口径保持）。 */
  readonly planId?: MaintenancePlanId;
  /** 记录时点计划当前版本（溯源旧版可解释；无计划为空）。 */
  readonly planVersion?: number;
  /** 关联任务（可空：留痕不强制挂任务）。 */
  readonly taskId?: MaintenanceTaskId;
  readonly performedBy: UserId;
  /** ISO 8601，执行时刻。 */
  readonly performedAt: string;
  readonly note?: string;
  readonly occurredAt: string;
  readonly recordedBy: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

/** 点检记录行：判据比对结果（pass/fail）。 */
export interface CheckpointActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'checkpoint';
  readonly id: CheckpointRecordId;
  readonly checkpointId: string;
  readonly result: 'pass' | 'fail';
}

/** 保养记录行：动作完成留痕。 */
export interface UpkeepActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'upkeep';
  readonly id: UpkeepRecordId;
  /** 本次完成的动作（计划 upkeepActions 的子集引用或自由描述）。 */
  readonly actionsDone?: readonly string[];
}

/** 维修记录行：故障引用 + 是否恢复（故障上报事实在 baseline，这里只引用）。 */
export interface RepairActivityRow extends MaintenanceActivityCommon {
  readonly kind: 'repair';
  readonly id: RepairRecordId;
  /** baseline 故障上报 id 形状引用。 */
  readonly faultRef?: string;
  /** 本次维修是否恢复设备可用。 */
  readonly restored: boolean;
}

/** 三态记录联合：kind 判别（append-only 事实；修正走冲销/补录，不改原行）。 */
export type MaintenanceActivityRow = CheckpointActivityRow | UpkeepActivityRow | RepairActivityRow;

/** 分布式 Omit（Omit 直接套联合会坍缩成公共键——判别联合必须逐成员裁剪）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 追加输入：三态判别联合去实现方生成列（id/seq/objectVersion；availableTime 可传）。 */
export type AppendMaintenanceActivityInput = DistributiveOmit<
  MaintenanceActivityRow,
  'id' | 'seq' | 'objectVersion'
>;

/** 记录读取请求（三态可按 kind/任务/时间窗过滤，合同 §3 查询面）。 */
export interface MaintenanceActivityQuery {
  readonly resourceRef?: ResourceRef;
  readonly kind?: MaintenanceActivityRow['kind'];
  readonly taskId?: MaintenanceTaskId;
  readonly planId?: MaintenancePlanId;
  /** ISO 8601，含 performedAt；缺省无界。 */
  readonly from?: string;
  readonly to?: string;
}

export interface MaintenanceActivityStore {
  /** append（恒为追加，无 UPDATE 面；id 前缀按 kind 由实现方生成）。 */
  insert(input: AppendMaintenanceActivityInput): Promise<MaintenanceActivityRow>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, query?: MaintenanceActivityQuery): Promise<readonly MaintenanceActivityRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * maintenance 域事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方
 * 合同，映射既有通用 event_records / outbox_records——不建新表）；幂等锚点
 * = eventId 自然主键（重复 append 抛 MaintenanceConflictError）。内存实现仅保序
 * 保存。
 */
export interface MaintenanceDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；审计/调试口径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 */
export interface MaintenanceOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（MaintenanceService 构造入参形状）。 */
export interface MaintenanceStores {
  readonly plans: MaintenancePlanStore;
  readonly tasks: MaintenanceTaskStore;
  readonly activities: MaintenanceActivityStore;
  readonly events: MaintenanceDomainEventStore;
  readonly operations: MaintenanceOperationStore;
}
