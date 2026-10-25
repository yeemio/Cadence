/**
 * reporting 存储端口（M2-W7）。体例同 listing/dispatch-stores：端口在本包定义
 * 业务形状，内存实现先行（in-memory-reporting-stores.ts），PG adapter 由
 * business-store 按 `./reporting` 子路径接入（表结构见 prisma/migrations/
 * 20261026010000_reporting_module——组合根接线属总控合流）。
 *
 * 表形态取舍（对齐 workorder/listing/dispatch 既定裁定，依据 evidence-columns.v1
 * + m2-drafts README 纪律 2）：
 *  - work_reports 是**状态机投影**（运营状态，行级 object_version 乐观更新），
 *    按行为需求携带 supersedes（合同 §2 修正版链——append-only 修正纪律）与
 *    business_time（事后补录报工的业务时间）两列；不套完整证据七列（投影
 *    取舍同 dispatch_orders）；
 *  - report_audits 是**核查留痕账**（append-only：编辑/审核/撤销每次动作一行，
 *    合同 §2 ReportAuditId 留痕语义；触发器禁 UPDATE/DELETE）；
 *  - reporting_events 是**状态机事件账本**（engine-flow ApprovalEventStore 形状，
 *    work-report 聚合专用）；
 *  - reporting_operations 是**幂等记账**（运营表，同 outbox 取舍豁免触发器）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建）——本包端口按 BusinessEvent 定形，Outbox 记账随 append 原子产生。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type { ReportKind } from './reporting-config.js';

// ---- 报工单（状态机投影 + 修正链 + 业务时间） ----

/**
 * 报工单（五类一体：零件/装配/电气/售后/零工）。挂 dispatchId；完工数量 + 工时
 * （整数分钟）+ 申报人；工艺属性随单快照（图号×工序×工作令，来自派工单事实，
 * 不回查 dispatch）。修正版 = 新行 + supersedes 锚定原单（原单行不改）。
 */
export interface WorkReport {
  /** wr-<uuidv7>（模块 id 生成器；存储面按不透明串收）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 所挂派工单（DispatchId，跨模块 opaque）。 */
  readonly dispatchId: string;
  readonly kind: ReportKind;
  readonly flowConfigId: string;
  /** pending/reported/verified/revoked。 */
  readonly state: string;
  /** 状态机版本：直报单创建 = 2（pending@v1 投影 + SUBMIT → reported@v2）。 */
  readonly objectVersion: number;
  /** 完工数量（正数）。 */
  readonly doneQty: number;
  /** 工时（整数分钟，整数精确——hours 归集同一量纲）。 */
  readonly laborMinutes: number;
  /** 申报人（= submit 命令签发人；submit 按本人权限）。 */
  readonly reporter: UserId;
  // ---- 工艺属性随单快照（上卷/质检/进度查询键） ----
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  /** 修正链锚点：本单取代的原单 id（直报单为 null）。 */
  readonly supersedes: string | null;
  /** 业务时间（事后补录报工口径；缺省 = 申报时刻）。 */
  readonly businessTime: string;
  // ---- 核查结果回填（verify/revoke 时 advance 写入） ----
  readonly verifiedBy: UserId | null;
  readonly verifiedAt: string | null;
  readonly revokedBy: UserId | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkReportInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly dispatchId: string;
  readonly kind: ReportKind;
  readonly flowConfigId: string;
  /** 初始投影态（pending@v1——submit 命令先落投影再驱动 SUBMIT）。 */
  readonly state: string;
  readonly objectVersion: number;
  readonly doneQty: number;
  readonly laborMinutes: number;
  readonly reporter: UserId;
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly supersedes: string | null;
  readonly businessTime: string;
  readonly remark: string | null;
}

export interface ListWorkReportsFilter {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
  readonly dispatchId?: string | undefined;
  readonly reporter?: string | undefined;
  readonly drawingNo?: string | undefined;
}

/**
 * 报工单存储端口（租户收口 + 乐观 advance）。实现方保证：
 *  - list 只返回**链尾行**（活跃视图：被其他行 supersedes 的行不返回——修正版
 *    链的最终态读取行为等价，合同 §7 对账要点；链全貌经 find/findBySupersedes
 *    组装，见 service.reportDetail）；
 *  - advance 为乐观更新：仅当 objectVersion === expectedObjectVersion 时写状态
 *    +1 版本并回填核查字段；未命中抛 ReportConflictError。
 */
export interface WorkReportStore {
  create(input: CreateWorkReportInput): Promise<WorkReport>;
  find(tenant: TenantId, id: string): Promise<WorkReport | null>;
  /** 取代指定原单的修正版行集（链向下导航；线性链下至多 1 行，防御性返回数组）。 */
  findBySupersedes(tenant: TenantId, supersedesId: string): Promise<readonly WorkReport[]>;
  /** 链尾行列表（createdAt 降序，新的在前；含被修正前已核查/撤销的历史链尾）。 */
  list(tenant: TenantId, filter?: ListWorkReportsFilter): Promise<readonly WorkReport[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly verifiedBy?: UserId;
      readonly verifiedAt?: string;
      readonly revokedBy?: UserId;
      readonly revokedAt?: string;
      readonly revokeReason?: string | null;
    },
  ): Promise<WorkReport>;
}

// ---- 核查留痕（ReportAuditId，append-only） ----

/** 核查动作类型（编辑/审核/撤销——合同 §2 ReportAudit 留痕语义）。 */
export type ReportAuditAction = 'edit' | 'verify' | 'revoke';

/**
 * 核查留痕行：谁、何时、对哪单、改了什么。append-only（每次核查动作一行；
 * edit 携带字段级前后镜像，verify/revoke 镜像为 null）。
 */
export interface ReportAuditRow {
  /** rau-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly reportId: string;
  readonly action: ReportAuditAction;
  readonly actor: UserId;
  readonly reason: string | null;
  /** edit：字段级前后镜像（ReportFieldChange 同形）；verify/revoke = null。 */
  readonly changes: readonly { readonly field: string; readonly from: unknown; readonly to: unknown }[] | null;
  readonly createdAt: string;
}

export interface ReportAuditStore {
  append(row: ReportAuditRow): Promise<ReportAuditRow>;
  /** 指定单据的全部留痕（createdAt 升序——全程留痕的时序读法）。 */
  listByReport(tenant: TenantId, reportId: string): Promise<readonly ReportAuditRow[]>;
}

// ---- 命令幂等记账 ----

export interface ReportOperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（report.* 命名族）。 */
  readonly command: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3）。record 在**命令成功提交前**
 * 调用：已存在 → 返回 null（用例层翻 rejected）；不存在 → 记账并返回记账行。
 */
export interface ReportOperationStore {
  record(entry: ReportOperationRecord): Promise<ReportOperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → ReportConflictError（幂等去重）。PG 侧映射
 * 既有 event_records / outbox_records 两表（M1 已建）。
 */
export interface ReportDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；跨事件类型混排——发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}
