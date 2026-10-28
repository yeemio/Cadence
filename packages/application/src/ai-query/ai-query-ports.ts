/**
 * ai-query 端口与 Wire 类型（AI 问数首版，CONTRACT v1 · 2026-10-28）。
 *
 * 三组端点（capabilities / ask / sessions）的响应形状按合同 §Wire 合同逐字段
 * 冻结——apps/web 按同一合同并行开发，字段名不得偏移。本模块是只读消费面
 * （不写业务 store，非目标：任何生产写能力），取数一律经注入的兄弟域 store
 * 端口（WorkOrderStore / GapCheckStore / PurchaseRequestStore /
 * PurchaseOrderStore / InspectionOrderStore / NonconformStore）与进度事实只读
 * 端口（ProgressFactPort，与 WorkOrderModule 同一端口形状）。
 *
 * 端口（IntentRouter / PermissionResolver / AiQuerySessionStore）：
 *  - IntentRouter：v1 为确定性规则实现（rule-intent-router.ts）；DSH 真实模型
 *    接入时替换此层（能力执行与权限留在 Cadence，合同 §意图路由）；
 *  - PermissionResolver：能力执行前逐码复核域权限（每次查询重新验证——
 *    proposal §5-3；缺码走回答通道 denied，不是 403）；
 *  - AiQuerySessionStore：会话线程持久化；session 归属 tenant+userId，
 *    跨用户读按不存在处理（不泄漏存在性）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { GapCheckStore, PurchaseOrderStore, PurchaseRequestStore } from '../listing/listing-stores.js';
import type { InspectionOrderStore, NonconformStore } from '../inspection/inspection-stores.js';
import type { ProgressFactPort } from '../workorder/workorder-ports.js';
import type { WorkOrderStore } from '../workorder/workorder-stores.js';

// ---- Wire：能力目录 ----

/** 事实主体类别（能力目录与 FactCard subject 共用词汇）。 */
export type AiQuerySubjectKind = 'workorder' | 'material' | 'inspection';

/** 能力目录条目（GET /ai-query/capabilities 的 items 元素形状，字段冻结）。 */
export interface AiQueryCapabilityInfo {
  readonly capabilityId: string;
  readonly version: string;
  readonly subjectKind: AiQuerySubjectKind;
  readonly title: string;
  readonly description: string;
  readonly requiredPermissions: readonly string[];
  readonly status: 'ready';
}

// ---- Wire：FactCard ----

export interface AiQueryFactCardSubject {
  readonly kind: AiQuerySubjectKind;
  readonly id: string;
  readonly label: string;
}

export interface AiQueryMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit?: string;
}

/** 行表（可选：纯指标卡不带 rows；rowCount 完整性口径 = 行表行数）。 */
export interface AiQueryFactCardRows {
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly values: readonly (readonly (string | number | null)[])[];
}

export interface AiQueryTimeBasis {
  readonly kind: 'point' | 'range';
  readonly label: string;
  readonly from?: string;
  readonly to?: string;
}

/** 来源引用（ref 为不透明定位串；queryMoment = 取数时刻 ISO）。 */
export interface AiQuerySourceRef {
  readonly ref: string;
  readonly queryMoment: string;
}

/** 完整性：截断/分页如实（totalKnown=false 时 summary 不得总结为全量）。 */
export interface AiQueryCompleteness {
  readonly status: 'complete' | 'truncated';
  readonly rowCount: number;
  readonly totalKnown: boolean;
  readonly note?: string;
}

export interface AiQueryFactCard {
  readonly subject: AiQueryFactCardSubject;
  readonly title: string;
  readonly metrics: readonly AiQueryMetric[];
  readonly rows?: AiQueryFactCardRows;
  readonly timeBasis: AiQueryTimeBasis;
  readonly sourceRefs: readonly AiQuerySourceRef[];
  readonly completeness: AiQueryCompleteness;
}

// ---- Wire：AskResponse（discriminated kind） ----

/** 零行是合法 answer（summary 明示「查询有效、无记录」；零值只能由有效查询产生）。 */
export interface AiQueryAnswer {
  readonly kind: 'answer';
  readonly sessionId: string;
  readonly answerId: string;
  readonly capabilityId: string;
  readonly summary: string;
  readonly caliberNotes: readonly string[];
  readonly factCards: readonly AiQueryFactCard[];
  readonly createdAt: string;
}

export interface AiQueryClarifyOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** 歧义澄清：pending 选项存 session，selectedOptionId 回传续走；选项 id 稳定可重放。 */
export interface AiQueryClarify {
  readonly kind: 'clarify';
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: readonly AiQueryClarifyOption[];
}

/** 域权限缺码（HTTP 200，回答通道内明示；不是 403）。 */
export interface AiQueryDenied {
  readonly kind: 'denied';
  readonly sessionId: string;
  readonly reason: 'no_permission';
  readonly missingPermissions: readonly string[];
  readonly hint: string;
}

export interface AiQueryUnsupported {
  readonly kind: 'unsupported';
  readonly sessionId: string;
  readonly hint: string;
  readonly capabilityHints: readonly string[];
}

/** 数据源未就绪（如目标工作令无齐套核对记录——不得按零缺口回答）。 */
export interface AiQueryUnavailable {
  readonly kind: 'unavailable';
  readonly sessionId: string;
  readonly reason: 'data_source_not_ready';
  readonly detail: string;
}

export type AskResponse =
  | AiQueryAnswer
  | AiQueryClarify
  | AiQueryDenied
  | AiQueryUnsupported
  | AiQueryUnavailable;

// ---- 时间语义（freeze：今日/本周/最近N天；Asia/Shanghai 本地周一起点） ----

/** 解析后的时间范围意图（quality-inspection 的窗口选择）。 */
export type AiQueryTimeRange =
  | { readonly kind: 'today' }
  | { readonly kind: 'this-week' }
  | { readonly kind: 'last-n-days'; readonly days: number };

/** 求值后的时间窗（from 含 / to 不含；label 展示用）。 */
export interface AiQueryTimeWindow {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

// ---- IntentRouter 端口 ----

/** 路由产物：命中能力（含主体线索/时间范围）或未命中。 */
export type AiQueryIntent =
  | {
      readonly kind: 'routed';
      readonly capabilityId: 'workorder-progress' | 'material-gap';
      /** 主体线索 token（编号片段/项目名词）；空 = 泛主体（服务层回落全量候选）。 */
      readonly subjectTokens: readonly string[];
    }
  | {
      readonly kind: 'routed';
      readonly capabilityId: 'quality-inspection';
      /** null = 命中质检意图但无时间词——服务层发澄清选项。 */
      readonly timeRange: AiQueryTimeRange | null;
    }
  | { readonly kind: 'unsupported' };

/** 意图路由端口：纯函数语义（question -> intent，不触存储、无副作用）。 */
export interface IntentRouter {
  route(question: string): AiQueryIntent;
}

// ---- PermissionResolver 端口 ----

/**
 * 域权限逐码复核端口（每次查询重新验证，服务端不复用历史结论）。实现方提供
 * admin bypass 与租户收口语义（组合根用 core/auth PermissionService.authorize
 * 适配——admin 凭 '*' bypass 自动覆盖新码，合同 §三域能力）。
 */
export interface AiQueryPermissionResolver {
  hasPermission(tenant: TenantId, user: UserId, code: string): Promise<boolean>;
}

// ---- 会话存储端口 ----

export interface AiQuerySessionTurn {
  readonly question: string;
  readonly answerId?: string;
  readonly kind: AskResponse['kind'];
  readonly response: AskResponse;
}

/** 待澄清（存 session；kind 区分工作令候选与时间范围两类澄清）。 */
export interface AiQueryPendingClarify {
  readonly kind: 'workorder-candidates' | 'time-range';
  readonly capabilityId: string;
  readonly question: string;
  readonly options: readonly AiQueryClarifyOption[];
}

/** 会话线程（归属 tenant+userId；跨用户读按不存在处理）。 */
export interface AiQuerySession {
  readonly sessionId: string;
  readonly tenant: TenantId;
  readonly userId: UserId;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly turns: readonly AiQuerySessionTurn[];
  readonly pendingClarify?: AiQueryPendingClarify | undefined;
}

/** 会话摘要（GET /ai-query/sessions 的 items 元素形状）。 */
export interface AiQuerySessionSummary {
  readonly sessionId: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
}

/**
 * 会话存储端口：find/listByOwner 按租户收口且 listByOwner 按 userId 收口
 * （"仅本人"数据权限边界，先例 reporting 我的报工双键）；save 全量覆写
 * （turns 追加 + lastActivityAt/pendingClarify 更新由调用方组装）。
 */
export interface AiQuerySessionStore {
  create(input: { readonly sessionId: string; readonly tenant: TenantId; readonly userId: UserId; readonly createdAt: string }): Promise<AiQuerySession>;
  find(tenant: TenantId, sessionId: string): Promise<AiQuerySession | null>;
  /** lastActivityAt 降序（新的在前），截取前 limit 条。 */
  listByOwner(tenant: TenantId, userId: UserId, limit: number): Promise<readonly AiQuerySessionSummary[]>;
  save(session: AiQuerySession): Promise<void>;
}

// ---- 取数端口束（register 注入；共享实例由组合根供给，先例 MODULE_DEFINITIONS） ----

/** ai-query 取数端口束：三域能力的只读数据源（形状以各域 *-stores.ts 为准）。 */
export interface AiQuerySourceStores {
  /** workorder 域：工作令投影（主体解析 + 项目进度事实）。 */
  readonly workOrders: WorkOrderStore;
  /** workorder 域：进度事实只读订阅（与 WorkOrderModule 同端口；上卷用纯函数复用）。 */
  readonly progressFacts: ProgressFactPort;
  /** listing 域：缺口核查快照（material-gap 的数据源；无记录 = unavailable）。 */
  readonly gapChecks: GapCheckStore;
  /** listing 域：采购申请（缺口一键采购关联）。 */
  readonly purchaseRequests: PurchaseRequestStore;
  /** listing 域：采购订单（缺口的在途供给关联）。 */
  readonly purchaseOrders: PurchaseOrderStore;
  /** inspection 域：质检单（failed 且 judgedAt 落窗）。 */
  readonly inspectionOrders: InspectionOrderStore;
  /** inspection 域：不合格处置。 */
  readonly nonconforms: NonconformStore;
}
