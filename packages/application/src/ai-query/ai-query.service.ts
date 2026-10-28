/**
 * AiQueryService —— 问数 ask 管线编排（零框架业务类，CONTRACT v1）。
 *
 * 管线：输入已解析（ai-query-input）→ 意图路由（IntentRouter，v1 规则引擎）
 * → 域权限逐码复核（PermissionResolver，每次查询重新验证；缺码 kind:'denied'
 * 200 回答，不是 403）→ 主体解析（工作令多匹配 → clarify，选项存 session 可
 * 重放）→ 能力执行（capability-*.ts，只读取数经注入端口）→ 结构化回答。
 *
 * 完整性纪律：目标工作令无齐套核对记录 → unavailable（不得按零缺口回答）；
 * 零行是合法 answer；summary 仅由结构化事实模板拼接（v1 无推测）；截断行表
 * completeness 如实标注。会话归属 tenant+userId，跨用户读按不存在处理（404，
 * 同形不泄漏存在性）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import { WorkOrderId } from '@smes/business-core';
import type { WorkOrder } from '../workorder/workorder-stores.js';
import { MaterialGapCapability } from './capability-material-gap.js';
import { QualityInspectionCapability } from './capability-quality-inspection.js';
import { WorkOrderProgressCapability } from './capability-workorder-progress.js';
import {
  AI_QUERY_CAPABILITIES,
  AI_QUERY_TIME_CLARIFY_OPTIONS,
  AI_QUERY_TIME_OPTION_RANGES,
  capabilityInfoOf,
  type AiQueryCapabilityId,
  type AiQueryCapabilityResult,
} from './ai-query.capabilities.js';
import { AiQueryConflictError, AiQueryInputError, AiQueryNotFoundError } from './ai-query-errors.js';
import { newAiQueryAnswerId, newAiQuerySessionId } from './ai-query-ids.js';
import type { AiQueryAskInput } from './ai-query-input.js';
import type {
  AiQueryAnswer,
  AiQueryCapabilityInfo,
  AiQueryDenied,
  AiQueryIntent,
  AiQueryPendingClarify,
  AiQueryPermissionResolver,
  AiQuerySession,
  AiQuerySessionStore,
  AiQuerySessionSummary,
  AiQuerySessionTurn,
  AiQuerySourceStores,
  AiQueryUnsupported,
  AskResponse,
  IntentRouter,
} from './ai-query-ports.js';
import { RuleIntentRouter } from './rule-intent-router.js';

const DEFAULT_NOW = (): string => new Date().toISOString();
const DEFAULT_CLARIFY_OPTION_LIMIT = 5;
const DEFAULT_ROW_LIMIT = 50;

export interface AiQueryServiceOptions {
  /** 时钟注入（测试确定性；时间语义 freeze 见 ai-query-time.ts）。 */
  readonly now?: () => string;
  /** 澄清候选上限（多匹配列前 N 个选项；缺省 5）。 */
  readonly clarifyOptionLimit: number;
  /** 行表截断上限（completeness 如实标注；缺省 50）。 */
  readonly rowLimit: number;
}

/** 会话详情视图（GET /ai-query/sessions/:id 响应形状）。 */
export interface AiQuerySessionDetail {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly turns: readonly AiQuerySessionTurn[];
}

/** 未命中提示（规则引擎模式·未接入 AI 模型）。 */
export const AI_QUERY_CAPABILITY_HINTS: readonly string[] = [
  '工作令进度：如「WO-xxxx 做到哪了」「XX项目 完成多少」',
  '物料缺口：如「WO-xxxx 缺料吗」「XX项目 齐套了吗」',
  '质量检验：如「今天有哪些不合格」「本周返工多少」',
];

export class AiQueryService {
  private readonly options: AiQueryServiceOptions;
  private readonly intentRouter: IntentRouter;
  private readonly workOrderProgress: WorkOrderProgressCapability;
  private readonly materialGap: MaterialGapCapability;
  private readonly qualityInspection: QualityInspectionCapability;

  constructor(
    private readonly stores: AiQuerySourceStores,
    private readonly sessions: AiQuerySessionStore,
    private readonly permissionResolver: AiQueryPermissionResolver,
    intentRouter: IntentRouter = new RuleIntentRouter(),
    options: Partial<AiQueryServiceOptions> = {},
  ) {
    this.intentRouter = intentRouter;
    this.options = {
      clarifyOptionLimit: options.clarifyOptionLimit ?? DEFAULT_CLARIFY_OPTION_LIMIT,
      rowLimit: options.rowLimit ?? DEFAULT_ROW_LIMIT,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.workOrderProgress = new WorkOrderProgressCapability(stores.progressFacts);
    this.materialGap = new MaterialGapCapability(stores.gapChecks, stores.purchaseRequests, stores.purchaseOrders);
    this.qualityInspection = new QualityInspectionCapability(stores.inspectionOrders, stores.nonconforms);
  }

  private now(): string {
    return this.options.now?.() ?? DEFAULT_NOW();
  }

  // ---- 查询面 ----

  /** 能力目录（静态 ready；字段冻结）。 */
  capabilities(): readonly AiQueryCapabilityInfo[] {
    return AI_QUERY_CAPABILITIES;
  }

  async listSessions(tenant: TenantId, userId: UserId, limit: number): Promise<readonly AiQuerySessionSummary[]> {
    return this.sessions.listByOwner(tenant, userId, limit);
  }

  async sessionDetail(tenant: TenantId, userId: UserId, sessionId: string): Promise<AiQuerySessionDetail> {
    const session = await this.mustFindOwnedSession(tenant, userId, sessionId);
    return {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      turns: session.turns,
    };
  }

  // ---- ask 管线 ----

  async ask(tenant: TenantId, userId: UserId, input: AiQueryAskInput): Promise<AskResponse> {
    const queryMoment = this.now();
    if (input.selectedOptionId !== undefined && input.sessionId !== undefined) {
      return this.replayClarify(tenant, userId, input.sessionId, input.selectedOptionId, queryMoment);
    }
    const intent = this.intentRouter.route(input.question);
    const session =
      input.sessionId === undefined
        ? await this.sessions.create({ sessionId: newAiQuerySessionId(), tenant, userId, createdAt: queryMoment })
        : await this.mustFindOwnedSession(tenant, userId, input.sessionId);
    const { response, pending } = await this.dispatchIntent(tenant, userId, session, input.question, intent, queryMoment);
    return this.finishAsk(session, input.question, response, pending, queryMoment);
  }

  /** 澄清回放：selectedOptionId 命中 session 内 pending 选项后续走能力执行。 */
  private async replayClarify(
    tenant: TenantId,
    userId: UserId,
    sessionId: string,
    selectedOptionId: string,
    queryMoment: string,
  ): Promise<AskResponse> {
    const session = await this.mustFindOwnedSession(tenant, userId, sessionId);
    const pending = session.pendingClarify;
    if (pending === undefined) {
      throw new AiQueryConflictError('会话当前没有待澄清问题，不能回传 selectedOptionId');
    }
    if (!pending.options.some((option) => option.id === selectedOptionId)) {
      throw new AiQueryInputError(`selectedOptionId 不在待澄清选项内：${JSON.stringify(selectedOptionId)}`);
    }
    const missing = await this.missingPermissions(tenant, userId, pending.capabilityId);
    if (missing.length > 0) {
      return this.finishAsk(session, pending.question, this.deniedResponse(session.sessionId, missing), undefined, queryMoment);
    }
    let result: AskResponse;
    if (pending.kind === 'time-range') {
      const timeRange = AI_QUERY_TIME_OPTION_RANGES[selectedOptionId];
      if (timeRange === undefined) {
        throw new AiQueryConflictError(`澄清选项映射缺失：${selectedOptionId}`);
      }
      const capability = await this.qualityInspection.execute({
        tenant,
        userId,
        queryMoment,
        rowLimit: this.options.rowLimit,
        timeRange,
      });
      result = this.toAskResponse(session.sessionId, 'quality-inspection', capability, queryMoment);
    } else {
      const order = await this.stores.workOrders.find(tenant, WorkOrderId.create(selectedOptionId));
      result =
        order === null
          ? this.zeroSubjectAnswer(session.sessionId, pending.capabilityId as AiQueryCapabilityId, queryMoment)
          : this.toAskResponse(
              session.sessionId,
              pending.capabilityId as AiQueryCapabilityId,
              await this.executeWorkOrderCapability(tenant, userId, pending.capabilityId as AiQueryCapabilityId, order, queryMoment),
              queryMoment,
            );
    }
    return this.finishAsk(session, pending.question, result, undefined, queryMoment);
  }

  /** 新问题分发：路由 → 权限复核 → 主体/时间解析（歧义 clarify）→ 执行。 */
  private async dispatchIntent(
    tenant: TenantId,
    userId: UserId,
    session: AiQuerySession,
    question: string,
    intent: AiQueryIntent,
    queryMoment: string,
  ): Promise<{ readonly response: AskResponse; readonly pending: AiQueryPendingClarify | undefined }> {
    if (intent.kind === 'unsupported') {
      return { response: this.unsupportedResponse(session.sessionId), pending: undefined };
    }
    const missing = await this.missingPermissions(tenant, userId, intent.capabilityId);
    if (missing.length > 0) {
      return { response: this.deniedResponse(session.sessionId, missing), pending: undefined };
    }
    if (intent.capabilityId === 'quality-inspection') {
      if (intent.timeRange === null) {
        const pending: AiQueryPendingClarify = {
          kind: 'time-range',
          capabilityId: intent.capabilityId,
          question,
          options: AI_QUERY_TIME_CLARIFY_OPTIONS,
        };
        return {
          response: {
            kind: 'clarify',
            sessionId: session.sessionId,
            prompt: '请选择要查询的时间范围：',
            options: pending.options,
          },
          pending,
        };
      }
      const result = await this.qualityInspection.execute({
        tenant,
        userId,
        queryMoment,
        rowLimit: this.options.rowLimit,
        timeRange: intent.timeRange,
      });
      return { response: this.toAskResponse(session.sessionId, 'quality-inspection', result, queryMoment), pending: undefined };
    }
    // workorder-progress / material-gap：主体解析（多匹配 → 候选澄清）。
    const candidates = await this.resolveWorkOrderCandidates(tenant, intent.subjectTokens);
    if (candidates.length === 0) {
      return { response: this.zeroSubjectAnswer(session.sessionId, intent.capabilityId, queryMoment), pending: undefined };
    }
    if (candidates.length === 1) {
      const result = await this.executeWorkOrderCapability(tenant, userId, intent.capabilityId, candidates[0] as WorkOrder, queryMoment);
      return { response: this.toAskResponse(session.sessionId, intent.capabilityId, result, queryMoment), pending: undefined };
    }
    const shown = candidates.slice(0, this.options.clarifyOptionLimit);
    const pending: AiQueryPendingClarify = {
      kind: 'workorder-candidates',
      capabilityId: intent.capabilityId,
      question,
      options: shown.map((order) => ({
        id: String(order.id),
        label: order.projectName || String(order.id),
        description: `工作令 ${String(order.id).length > 20 ? `${String(order.id).slice(0, 8)}…${String(order.id).slice(-4)}` : String(order.id)}`,
      })),
    };
    return {
      response: {
        kind: 'clarify',
        sessionId: session.sessionId,
        prompt:
          candidates.length > shown.length
            ? `匹配到 ${candidates.length} 个工作令，请选择（列前 ${shown.length} 个）或补充更具体的编号/项目名：`
            : `匹配到 ${candidates.length} 个工作令，请选择：`,
        options: pending.options,
      },
      pending,
    };
  }

  // ---- 私有构件 ----

  private async executeWorkOrderCapability(
    tenant: TenantId,
    userId: UserId,
    capabilityId: AiQueryCapabilityId,
    order: WorkOrder,
    queryMoment: string,
  ): Promise<AiQueryCapabilityResult> {
    const context = { tenant, userId, queryMoment, rowLimit: this.options.rowLimit, subjectOrder: order };
    if (capabilityId === 'material-gap') {
      return this.materialGap.execute(context);
    }
    return this.workOrderProgress.execute(context);
  }

  /** 主体解析：token 命中工作令编号或项目名（包含匹配，大小写不敏感）；空 token = 全量候选。 */
  private async resolveWorkOrderCandidates(tenant: TenantId, tokens: readonly string[]): Promise<readonly WorkOrder[]> {
    const orders = await this.stores.workOrders.list(tenant);
    if (tokens.length === 0) return orders;
    return orders.filter((order) =>
      tokens.some(
        (token) => String(order.id).toLowerCase().includes(token) || order.projectName.toLowerCase().includes(token),
      ),
    );
  }

  /** 域权限逐码复核（每次查询重新验证；返回缺码集）。 */
  private async missingPermissions(
    tenant: TenantId,
    userId: UserId,
    capabilityId: string,
  ): Promise<readonly string[]> {
    const codes = capabilityInfoOf(capabilityId as AiQueryCapabilityId).requiredPermissions;
    const results = await Promise.all(
      codes.map((code) => this.permissionResolver.hasPermission(tenant, userId, code).then((ok) => (ok ? null : code))),
    );
    return results.filter((code): code is string => code !== null);
  }

  private deniedResponse(sessionId: string, missing: readonly string[]): AiQueryDenied {
    return {
      kind: 'denied',
      sessionId,
      reason: 'no_permission',
      missingPermissions: missing,
      hint: `缺少权限：${missing.join('、')}——请联系租户管理员授予后重试。`,
    };
  }

  private unsupportedResponse(sessionId: string): AiQueryUnsupported {
    return {
      kind: 'unsupported',
      sessionId,
      hint: '暂不支持该问题（规则引擎模式·未接入 AI 模型）。',
      capabilityHints: AI_QUERY_CAPABILITY_HINTS,
    };
  }

  /** 零主体 answer：查询有效、无记录（零值只能由有效查询产生）。 */
  private zeroSubjectAnswer(sessionId: string, capabilityId: AiQueryCapabilityId, queryMoment: string): AiQueryAnswer {
    return {
      kind: 'answer',
      sessionId,
      answerId: newAiQueryAnswerId(),
      capabilityId,
      summary: '查询有效、无记录：未找到匹配的工作令',
      caliberNotes: [],
      factCards: [],
      createdAt: queryMoment,
    };
  }

  private toAskResponse(
    sessionId: string,
    capabilityId: AiQueryCapabilityId,
    result: AiQueryCapabilityResult,
    queryMoment: string,
  ): AskResponse {
    if ('unavailableDetail' in result) {
      return { kind: 'unavailable', sessionId, reason: 'data_source_not_ready', detail: result.unavailableDetail };
    }
    return {
      kind: 'answer',
      sessionId,
      answerId: newAiQueryAnswerId(),
      capabilityId,
      summary: result.summary,
      caliberNotes: result.caliberNotes,
      factCards: result.factCards,
      createdAt: queryMoment,
    };
  }

  /** 落账会话：追加 turn、刷新 lastActivityAt、写入/清空 pendingClarify。 */
  private async finishAsk(
    session: AiQuerySession,
    question: string,
    response: AskResponse,
    pending: AiQueryPendingClarify | undefined,
    queryMoment: string,
  ): Promise<AskResponse> {
    const turn: AiQuerySessionTurn = {
      question,
      ...(response.kind === 'answer' ? { answerId: response.answerId } : {}),
      kind: response.kind,
      response,
    };
    await this.sessions.save({
      ...session,
      turns: [...session.turns, turn],
      lastActivityAt: queryMoment,
      pendingClarify: pending,
    });
    return response;
  }

  /** 会话归属校验：不存在或非本人一律 NotFound（不泄漏存在性）。 */
  private async mustFindOwnedSession(tenant: TenantId, userId: UserId, sessionId: string): Promise<AiQuerySession> {
    const session = await this.sessions.find(tenant, sessionId);
    if (session === null || session.userId !== userId) {
      throw new AiQueryNotFoundError(`会话不存在：${sessionId}`);
    }
    return session;
  }
}
