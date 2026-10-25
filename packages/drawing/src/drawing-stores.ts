/**
 * drawing 存储端口（M3，m3-drafts/03-drawing.md v1.0 §2；体例同 payroll-stores：
 * 端口在本包定义业务形状，内存实现先行，PG adapter 由 business-store 按
 * `./drawing` 子路径接入——因 pro-pack-tier-edges，PG 侧不 import 本包，用
 * 结构同形镜像类型实现同一接口，组合根注入时结构校验）。
 *
 * 表形态分工（版本化文档域，ADR-0010：无状态机，修订链=append-only 发布事实）：
 *  - drawing_revisions 是 **版本化文档修订链**：(tenant, drawingId, version) 与
 *    (tenant, supersedes) 唯一；version=链尾+1（服务层推导，客户端不传）；
 *    supersedes=前任**行 id**（证据列口径）；supersedesVersion=version−1 由
 *    链连续性派生（mappers 计算，不落列）；append-only 不改原修订——发布 v4
 *    后 v3 引用读回仍 v3（钉版引用不漂移，合同 §7 对账锚）；
 *  - drawing_change_notices 是 **发布联动通知事实**：(tenant, drawingId,
 *    toVersion) 唯一；from→to+changeNote 供消费方轮询/对账（sinceVersion 游标）；
 *  - drawing_view_trails 是 **查看留痕 append-only 审计事实**：每次查看一行
 *    （谁/何时/哪修订/当时保密等级快照），seq 游标同毫秒决胜；保密审计的
 *    最低门槛（合同 §2）；
 *  - drawing_operations 是 **幂等账本**（运营表，非业务事实）：smes.command.v1
 *    不变量 3 的持久化锚点，不套证据列/触发器。
 *
 * 端口合同（实现方保证）：
 *  - revision.insert 在 (tenant, drawingId, version) 或 (tenant, supersedes)
 *    冲突时抛 DrawingConflictError（同形类按 name 识别，见 drawing-errors）；
 *  - notice.publish 在 (tenant, drawingId, toVersion) 冲突时抛 DrawingConflictError；
 *  - id 与 createdAt/seq 由**实现方生成**（PG=uuidv7/bigserial/库时钟，内存=
 *    唯一串/本地时钟/追加序），调用方不传；
 *  - 全部读操作按租户收口（跨租户不可见）。
 */
import type { BusinessEvent, TenantId, UserId } from '@smes/business-core';
import type { DrawingId, DrawingRevisionId } from './drawing-ids.js';
import type { DrawingChangeNoticePort } from './ports.js';

// ---- 图纸修订（版本化文档 append-only 链） ----

/**
 * 图纸修订行：一次修订 = 一行（append-only，不改原修订）。
 * drawingId + version 唯一定位；fileRef 由实施层解释（存储键/URL）。
 */
export interface DrawingRevisionRow {
  /** dr-<uuidv7>（实现方生成；修订行 id）。 */
  readonly id: DrawingRevisionId;
  readonly tenant: TenantId;
  /** 图纸标识（opaque 锚；"图号"编码规则=数据约定）。 */
  readonly drawingId: DrawingId;
  /** 修订号（链上第 N 版；首发 1，链尾+1）。 */
  readonly version: number;
  /** 文件引用（存储键 / URL；本包只保字符串引用形状——内容指针，查看必留痕）。 */
  readonly fileRef: string;
  /** 变更说明：本次修订改了什么（数据，供变更通知与追溯）。 */
  readonly changeNote: string;
  /** 保密等级（值集=默认配置两级公开/受限，数据值）。 */
  readonly classification: string;
  readonly changedBy: UserId;
  /** ISO 8601（发布时点）。 */
  readonly changedAt: string;
  /** 本行取代的前任行 id（证据列 supersedes 口径；首发 null）。 */
  readonly supersedes: string | null;
  /** 取代的上一修订号（version−1 派生；首发缺省）。 */
  readonly supersedesVersion?: number;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

export type CreateDrawingRevisionInput = Omit<DrawingRevisionRow, 'id' | 'createdAt' | 'supersedesVersion'>;

export interface DrawingRevisionStore {
  /** append；(tenant, drawingId, version) / (tenant, supersedes) 冲突抛 DrawingConflictError。 */
  insert(input: CreateDrawingRevisionInput): Promise<DrawingRevisionRow>;
  find(tenant: TenantId, drawingId: DrawingId, version: number): Promise<DrawingRevisionRow | null>;
  /** 该图纸全部修订行（version 升序；链尾=当前版）。 */
  chain(tenant: TenantId, drawingId: DrawingId): Promise<readonly DrawingRevisionRow[]>;
}

// ---- 查看留痕（append-only 审计事实） ----

/** 查看留痕行：每次查看一行（保密审计最低门槛；谁、何时、哪修订、当时等级）。 */
export interface DrawingViewTrailRow {
  /** dvt-<uuidv7>（实现方生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 插入序游标（内存 = 追加序；PG = bigserial——同毫秒决胜）。 */
  readonly seq: number;
  readonly drawingId: DrawingId;
  readonly version: number;
  readonly viewedBy: UserId;
  /** ISO 8601（查看时点）。 */
  readonly viewedAt: string;
  /** 查看时点修订保密等级快照（事后等级调整不追溯改写留痕——审计对账锚）。 */
  readonly classification: string;
  // ---- 证据公共列（evidence-columns.v1；留痕为终端事实，supersedes 恒缺省） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export type AppendDrawingViewInput = Omit<DrawingViewTrailRow, 'id' | 'seq' | 'objectVersion'> & {
  readonly availableTime?: string;
};

/** 留痕查询过滤（全字段 AND；保密管理员审计面）。 */
export interface ListDrawingViewsFilter {
  readonly drawingId?: DrawingId | undefined;
  readonly viewedBy?: UserId | undefined;
}

export interface DrawingViewTrailStore {
  /** append（append-only；无业务性唯一键——每次查看都是新事实）。 */
  insert(input: AppendDrawingViewInput): Promise<DrawingViewTrailRow>;
  /** 按插入序（seq）升序。 */
  list(tenant: TenantId, filter?: ListDrawingViewsFilter): Promise<readonly DrawingViewTrailRow[]>;
}

// ---- 事件（append-only + Outbox）与幂等账本 ----

/**
 * drawing 域事件端口：append = 事件行 + Outbox 行**同事务**落账（PG 实现方
 * 合同，映射既有通用 event_records / outbox_records——不建新表）；幂等锚点
 * = eventId 自然主键（重复 append 抛 DrawingConflictError）。内存实现仅保序
 * 保存。
 */
export interface DrawingDomainEventStore {
  append(event: BusinessEvent): Promise<void>;
  /** 按租户读全部事件（occurredAt 升序；审计/调试口径）。 */
  list(tenant: TenantId): Promise<readonly BusinessEvent[]>;
}

/**
 * 命令幂等账本（smes.command.v1 不变量 3）：claim 返回 true = 首次落账，
 * false = 该 operationId 已执行过（调用方拒绝重复执行，不重试同信封）。
 */
export interface DrawingOperationStore {
  claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean>;
}

/** 服务层依赖的端口全集（DrawingService 构造入参形状）。 */
export interface DrawingStores {
  readonly revisions: DrawingRevisionStore;
  /** 变更通知存储端口（合同 §4 DrawingChangeNoticePort 定稿形状，见 ports.ts）。 */
  readonly notices: DrawingChangeNoticePort;
  readonly views: DrawingViewTrailStore;
  readonly events: DrawingDomainEventStore;
  readonly operations: DrawingOperationStore;
}
